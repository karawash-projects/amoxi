// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto';
import type { ChatMessage, ConversationStore, Metadata, Thread } from '../types';

export const DEFAULT_THREAD_LIST_LIMIT = 50;
export const MAX_THREAD_LIST_LIMIT = 1000;

/** Clamps a requested list size. */
export function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.max(0, Math.min(max, Math.floor(limit)));
}

/** Assigns id and createdAt to messages that lack them (shared by every ConversationStore). */
export function stampMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.map((m) => ({ ...m, id: m.id ?? randomUUID(), createdAt: m.createdAt ?? new Date().toISOString() }));
}

/** Keeps the most recent `limit` messages (all when undefined), oldest first. */
export function lastMessages(messages: ChatMessage[], limit: number | undefined): ChatMessage[] {
  if (limit === undefined || !Number.isFinite(limit)) return messages;
  const n = Math.max(0, Math.floor(limit));
  return n === 0 ? [] : messages.slice(-n);
}

export interface MemoryConversationStoreOptions {
  /** Threads kept; the least recently updated are evicted beyond it. Default 10 000. */
  readonly maxThreads?: number;
  /** Messages kept per thread (oldest dropped). Default 10 000. */
  readonly maxMessagesPerThread?: number;
}

/** In-process ConversationStore for tests and development. History vanishes on restart. */
export class MemoryConversationStore implements ConversationStore {
  private readonly threads = new Map<string, Thread>();
  private readonly messages = new Map<string, ChatMessage[]>();
  private readonly maxThreads: number;
  private readonly maxMessages: number;

  constructor(options: MemoryConversationStoreOptions = {}) {
    this.maxThreads = options.maxThreads ?? 10_000;
    this.maxMessages = options.maxMessagesPerThread ?? 10_000;
  }

  async createThread(input: { owner: string; agent: string; title?: string; metadata?: Metadata }): Promise<Thread> {
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
    this.threads.set(thread.id, thread);
    this.messages.set(thread.id, []);
    while (this.threads.size > this.maxThreads) {
      const oldest = this.threads.keys().next().value!;
      this.threads.delete(oldest);
      this.messages.delete(oldest);
    }
    return { ...thread };
  }

  async getThread(id: string): Promise<Thread | undefined> {
    const t = this.threads.get(id);
    return t ? { ...t } : undefined;
  }

  async listThreads(owner: string, options: { agent?: string; limit?: number } = {}): Promise<Thread[]> {
    const limit = clampLimit(options.limit, DEFAULT_THREAD_LIST_LIMIT, MAX_THREAD_LIST_LIMIT);
    return [...this.threads.values()]
      .filter((t) => t.owner === owner && (options.agent === undefined || t.agent === options.agent))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit)
      .map((t) => ({ ...t }));
  }

  async updateThread(id: string, patch: { title?: string; metadata?: Metadata }): Promise<void> {
    const t = this.threads.get(id);
    if (!t) throw new Error(`Thread '${id}' not found`);
    this.touch({
      ...t,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.metadata !== undefined ? { metadata: { ...patch.metadata } } : {}),
    });
  }

  async deleteThread(id: string): Promise<void> {
    this.threads.delete(id);
    this.messages.delete(id);
  }

  async appendMessages(threadId: string, messages: readonly ChatMessage[]): Promise<ChatMessage[]> {
    const t = this.threads.get(threadId);
    const list = this.messages.get(threadId);
    if (!t || !list) throw new Error(`Thread '${threadId}' not found`);
    const stamped = stampMessages(messages);
    for (const m of stamped) list.push(structuredClone(m));
    if (list.length > this.maxMessages) list.splice(0, list.length - this.maxMessages);
    this.touch(t);
    return stamped;
  }

  async getMessages(threadId: string, options: { limit?: number } = {}): Promise<ChatMessage[]> {
    return lastMessages(this.messages.get(threadId) ?? [], options.limit).map((m) => structuredClone(m));
  }

  /** Saves with a new updatedAt and moves the thread to the end (most recently used). */
  private touch(t: Thread): void {
    this.threads.delete(t.id);
    this.threads.set(t.id, { ...t, updatedAt: new Date().toISOString() });
  }
}
