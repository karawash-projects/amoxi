// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import type { Embedder, KnowledgeDocument, KnowledgeHit, Metadata, VectorRecord, VectorStore } from '../types';

export interface ChunkOptions {
  /** Target maximum characters per chunk. Default 1200. */
  readonly size?: number;
  /** Characters of the previous chunk repeated at the start of the next one. Default 150. */
  readonly overlap?: number;
}

/** Upper bound of chunks per document; re-ingest and remove rely on it to find old chunks. */
export const MAX_CHUNKS_PER_DOCUMENT = 2000;
const EMBED_BATCH = 64;

/** Splits text longer than `max` at sentence ends, then at word boundaries, then hard. */
function splitLong(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const sentences = text.split(/(?<=[.!?。！？])\s+/u).filter(Boolean);
  if (sentences.length > 1) return packPieces(sentences, max, ' ');
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length > 1) return packPieces(words, max, ' ');
  const out: string[] = [];
  for (let i = 0; i < text.length; i += max) out.push(text.slice(i, i + max));
  return out;
}

/** Greedily joins pieces (each split further when too long) into strings of at most `max`. */
function packPieces(pieces: string[], max: number, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (const piece of pieces) {
    for (const p of piece.length > max ? splitLong(piece, max) : [piece]) {
      if (!cur) cur = p;
      else if (cur.length + sep.length + p.length <= max) cur += sep + p;
      else {
        out.push(cur);
        cur = p;
      }
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** The last `overlap` characters of `text`, starting at a word boundary. */
function tail(text: string, overlap: number): string {
  if (overlap <= 0 || text.length <= overlap) return overlap <= 0 ? '' : text;
  const t = text.slice(text.length - overlap);
  const ws = t.search(/\s/);
  return ws < 0 ? '' : t.slice(ws).trim();
}

/**
 * Splits a document into chunks of at most `size` characters for embedding. Paragraph
 * boundaries (blank lines) are preferred, then sentence ends, then word boundaries. Each chunk
 * after the first starts with up to `overlap` characters from the end of the previous one, so a
 * fact cut across a boundary is still found.
 */
export function chunkText(text: string, options: ChunkOptions = {}): string[] {
  const size = Math.max(50, Math.floor(options.size ?? 1200));
  const overlap = Math.max(0, Math.min(Math.floor(options.overlap ?? 150), Math.floor(size / 2)));
  const paragraphs = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n+/)
    .map((p) => p.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean);
  // Units never exceed size - overlap, so a unit always fits after the overlap.
  const unitMax = Math.max(1, size - overlap);
  const units: Array<{ text: string; para: boolean }> = [];
  for (const p of paragraphs) {
    const parts = p.length <= unitMax ? [p] : splitLong(p, unitMax);
    parts.forEach((t, i) => units.push({ text: t, para: i === 0 }));
  }
  const chunks: string[] = [];
  let cur = '';
  for (const u of units) {
    const sep = u.para ? '\n\n' : ' ';
    if (!cur) cur = u.text;
    else if (cur.length + sep.length + u.text.length <= size) {
      cur += sep + u.text;
    } else {
      chunks.push(cur);
      const t = tail(cur, overlap);
      cur = t && t.length + sep.length + u.text.length <= size ? `${t}${sep}${u.text}` : u.text;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/** Reserved metadata keys of chunks. */
const DOC = '_doc';
const TITLE = '_title';
const URL_KEY = '_url';
const CHUNK = '_chunk';

/**
 * A searchable collection of documents (retrieval-augmented generation). Documents are split
 * with `chunkText`, embedded and stored in the namespace `kb:<name>@<embedder model>`, so changing
 * the embedder starts a fresh index instead of mixing vectors.
 */
export class KnowledgeBase {
  readonly namespace: string;

  constructor(
    readonly name: string,
    private readonly store: VectorStore,
    private readonly embedder: Embedder,
    private readonly chunking: ChunkOptions = {},
  ) {
    if (!name) throw new TypeError('A knowledge base needs a name');
    this.namespace = `kb:${name}@${embedder.model}`;
  }

  /** Adds or replaces documents. Re-ingesting a document id replaces all its old chunks. */
  async ingest(docs: readonly KnowledgeDocument[], signal?: AbortSignal): Promise<{ documents: number; chunks: number }> {
    let total = 0;
    for (const doc of docs) {
      if (typeof doc.id !== 'string' || !doc.id) throw new TypeError('Every knowledge document needs a non-empty string id');
      const chunks = chunkText(doc.text, this.chunking);
      if (chunks.length > MAX_CHUNKS_PER_DOCUMENT) {
        throw new RangeError(`Document '${doc.id}' has ${chunks.length} chunks (max ${MAX_CHUNKS_PER_DOCUMENT}); split it into several documents.`);
      }
      const base: Record<string, string | number | boolean> = { ...doc.metadata, [DOC]: doc.id };
      if (doc.title) base[TITLE] = doc.title;
      if (doc.url) base[URL_KEY] = doc.url;
      for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
        const batch = chunks.slice(i, i + EMBED_BATCH);
        // Title is embedded with each chunk: it often carries the topic the chunk lacks.
        const vectors = await this.embedder.embed(
          batch.map((c) => (doc.title ? `${doc.title}\n\n${c}` : c)),
          signal,
        );
        const records: VectorRecord[] = batch.map((text, j) => ({
          id: `${doc.id}#${i + j}`,
          text,
          vector: vectors[j],
          metadata: { ...base, [CHUNK]: i + j },
        }));
        await this.store.upsert(this.namespace, records);
      }
      await this.deleteChunks(doc.id, chunks.length);
      total += chunks.length;
    }
    return { documents: docs.length, chunks: total };
  }

  /** The chunks most similar to the query, best first. */
  async search(query: string, options: { limit?: number; minScore?: number; filter?: Metadata; signal?: AbortSignal } = {}): Promise<KnowledgeHit[]> {
    const q = String(query ?? '').trim();
    if (!q) return [];
    const [vector] = await this.embedder.embed([q], options.signal);
    const matches = await this.store.query(this.namespace, vector, {
      limit: options.limit ?? 5,
      ...(options.minScore !== undefined ? { minScore: options.minScore } : {}),
      ...(options.filter ? { filter: options.filter } : {}),
    });
    return matches.map((m) => {
      const md = m.metadata ?? {};
      const documentId = typeof md[DOC] === 'string' ? (md[DOC] as string) : m.id.replace(/#\d+$/, '');
      return {
        documentId,
        ...(typeof md[TITLE] === 'string' ? { title: md[TITLE] as string } : {}),
        ...(typeof md[URL_KEY] === 'string' ? { url: md[URL_KEY] as string } : {}),
        text: m.text,
        score: m.score,
      };
    });
  }

  /** Removes a document and all its chunks. */
  async remove(documentId: string): Promise<void> {
    await this.deleteChunks(documentId, 0);
  }

  /** Removes everything in this knowledge base. */
  async clear(): Promise<void> {
    await this.store.clear(this.namespace);
  }

  /**
   * Deletes chunk ids `${docId}#from` .. `#MAX-1`. Works with any VectorStore (the interface has no
   * "list ids"), and deleting ids that don't exist is a no-op.
   */
  private async deleteChunks(docId: string, from: number): Promise<void> {
    const ids: string[] = [];
    for (let n = from; n < MAX_CHUNKS_PER_DOCUMENT; n++) ids.push(`${docId}#${n}`);
    if (ids.length) await this.store.delete(this.namespace, ids);
  }
}
