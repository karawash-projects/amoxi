// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto';
import type { AgentMemory, Embedder, MemoryItem, Metadata, VectorQuery, VectorStore } from '../types';

/** Reserved metadata key holding the creation time. */
const CREATED_AT = '_createdAt';
/** Bounds one memory: facts are short; this stops a model from saving a whole document. */
const MAX_MEMORY_CHARS = 8_000;

/**
 * Long-term memory of one subject (usually one user), stored as embeddings in a VectorStore.
 * `recall` returns the facts most similar to the query.
 *
 * Use `VectorAgentMemory.namespace(subject, embedder)` to build the namespace: it includes the
 * embedder model, so switching embedders never compares vectors from different models (old
 * memories simply stop being recalled until re-embedded).
 */
export class VectorAgentMemory implements AgentMemory {
  /** `memory:<subject>@<embedder model>`. */
  static namespace(subject: string, embedder: Pick<Embedder, 'model'>): string {
    return `memory:${subject}@${embedder.model}`;
  }

  constructor(
    private readonly store: VectorStore,
    private readonly embedder: Embedder,
    private readonly ns: string,
  ) {}

  async remember(text: string, metadata?: Metadata): Promise<MemoryItem> {
    const clean = String(text ?? '').trim();
    if (!clean) throw new TypeError('Cannot remember an empty text');
    if (clean.length > MAX_MEMORY_CHARS) throw new RangeError(`A memory is limited to ${MAX_MEMORY_CHARS} characters; store documents in a knowledge base instead`);
    const [vector] = await this.embedder.embed([clean]);
    const item: MemoryItem = { id: randomUUID(), text: clean, createdAt: new Date().toISOString(), ...(metadata ? { metadata: { ...metadata } } : {}) };
    await this.store.upsert(this.ns, [{ id: item.id, text: clean, vector, metadata: { ...metadata, [CREATED_AT]: item.createdAt } }]);
    return item;
  }

  async recall(query: string, options: VectorQuery = {}): Promise<MemoryItem[]> {
    const q = String(query ?? '').trim();
    if (!q) return [];
    const [vector] = await this.embedder.embed([q]);
    const matches = await this.store.query(this.ns, vector, { limit: 5, ...options });
    return matches.map((m) => {
      const { [CREATED_AT]: createdAt, ...rest } = m.metadata ?? {};
      return {
        id: m.id,
        text: m.text,
        createdAt: typeof createdAt === 'string' ? createdAt : '',
        ...(Object.keys(rest).length ? { metadata: rest } : {}),
        score: m.score,
      };
    });
  }

  async forget(id: string): Promise<void> {
    await this.store.delete(this.ns, [id]);
  }

  /** Forgets everything about this subject (e.g. on account deletion / GDPR erasure). */
  async forgetAll(): Promise<void> {
    await this.store.clear(this.ns);
  }
}
