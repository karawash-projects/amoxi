// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readFileRetry, writeAtomic } from './fs-retry';
import type { ChatMessage, ConversationStore, Metadata, Thread } from '../types';
import { clampLimit, DEFAULT_THREAD_LIST_LIMIT, lastMessages, MAX_THREAD_LIST_LIMIT, stampMessages } from './memory-conversation-store';

/** A file name for an id: the id itself when safe, else a hash (no path traversal). */
function safeName(id: string): string {
  if (typeof id !== 'string' || id === '') throw new TypeError('Thread ids and owners must be non-empty strings');
  return /^[A-Za-z0-9_-]{1,100}$/.test(id) ? id : `h_${createHash('sha256').update(id).digest('hex').slice(0, 40)}`;
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFileRetry(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/**
 * ConversationStore on the local file system. Layout of `dir`:
 *   <thread>.json            thread metadata (atomic replace)
 *   <thread>.messages.jsonl  messages, append-only
 *   by-owner/<owner>.txt     thread ids per owner (append-only index for listThreads)
 * Appends use one O_APPEND write, so several processes can add to the same thread safely.
 */
export class FileConversationStore implements ConversationStore {
  private ready?: Promise<void>;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly dir: string) {}

  async createThread(input: { owner: string; agent: string; title?: string; metadata?: Metadata }): Promise<Thread> {
    await this.init();
    const now = new Date().toISOString();
    const thread: Thread = {
      id: randomUUID(),
      owner: input.owner,
      agent: input.agent,
      ...(input.title !== undefined ? { title: input.title } : {}),
      createdAt: now,
      updatedAt: now,
      ...(input.metadata ? { metadata: { ...input.metadata } } : {}),
    };
    await writeAtomic(this.threadFile(thread.id), JSON.stringify(thread));
    await appendFile(this.ownerIndex(thread.owner), `${thread.id}\n`, 'utf8');
    return thread;
  }

  async getThread(id: string): Promise<Thread | undefined> {
    await this.init();
    const text = await readText(this.threadFile(id));
    return text ? (JSON.parse(text) as Thread) : undefined;
  }

  async listThreads(owner: string, options: { agent?: string; limit?: number } = {}): Promise<Thread[]> {
    await this.init();
    const limit = clampLimit(options.limit, DEFAULT_THREAD_LIST_LIMIT, MAX_THREAD_LIST_LIMIT);
    const index = (await readText(this.ownerIndex(owner))) ?? '';
    const ids = [...new Set(index.split('\n').filter(Boolean))];
    const threads = await Promise.all(ids.map((id) => this.getThread(id)));
    return threads
      .filter((t): t is Thread => !!t && t.owner === owner && (options.agent === undefined || t.agent === options.agent))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }

  async updateThread(id: string, patch: { title?: string; metadata?: Metadata }): Promise<void> {
    await this.serial(id, async () => {
      const t = await this.getThread(id);
      if (!t) throw new Error(`Thread '${id}' not found`);
      await this.save({
        ...t,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.metadata !== undefined ? { metadata: { ...patch.metadata } } : {}),
      });
    });
  }

  async deleteThread(id: string): Promise<void> {
    await this.init();
    await this.serial(id, async () => {
      await unlink(this.threadFile(id)).catch(() => undefined);
      await unlink(this.messagesFile(id)).catch(() => undefined);
    });
  }

  async appendMessages(threadId: string, messages: readonly ChatMessage[]): Promise<ChatMessage[]> {
    return this.serial(threadId, async () => {
      const t = await this.getThread(threadId);
      if (!t) throw new Error(`Thread '${threadId}' not found`);
      const stamped = stampMessages(messages);
      if (stamped.length) {
        await appendFile(this.messagesFile(threadId), stamped.map((m) => JSON.stringify(m)).join('\n') + '\n', 'utf8');
      }
      await this.save(t);
      return stamped;
    });
  }

  async getMessages(threadId: string, options: { limit?: number } = {}): Promise<ChatMessage[]> {
    await this.init();
    const text = (await readText(this.messagesFile(threadId))) ?? '';
    const all: ChatMessage[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        all.push(JSON.parse(line) as ChatMessage);
      } catch {
        /* a partially written last line: skip */
      }
    }
    return lastMessages(all, options.limit);
  }

  private async save(t: Thread): Promise<void> {
    await writeAtomic(this.threadFile(t.id), JSON.stringify({ ...t, updatedAt: new Date().toISOString() }));
  }

  /** Serialises read-modify-write per thread inside this process. */
  private async serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    await this.init();
    const prev = this.locks.get(id) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    this.locks.set(id, run);
    try {
      return await run;
    } finally {
      if (this.locks.get(id) === run) this.locks.delete(id);
    }
  }

  private init(): Promise<void> {
    return (this.ready ??= mkdir(join(this.dir, 'by-owner'), { recursive: true }).then(() => undefined));
  }

  private threadFile(id: string): string {
    return join(this.dir, `${safeName(id)}.json`);
  }

  private messagesFile(id: string): string {
    return join(this.dir, `${safeName(id)}.messages.jsonl`);
  }

  private ownerIndex(owner: string): string {
    return join(this.dir, 'by-owner', `${safeName(owner)}.txt`);
  }
}
