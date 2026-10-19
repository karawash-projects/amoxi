// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto';
import type { ChatMessage, ConversationStore, Metadata, Thread } from '../types';
import { clampLimit, DEFAULT_THREAD_LIST_LIMIT, MAX_THREAD_LIST_LIMIT, stampMessages } from '../stores/memory-conversation-store';
import { checkTablePrefix, once, type PgQueryable } from './pg-loader';

export interface PgConversationStoreOptions {
  readonly db: PgQueryable;
  /** Prefix of table names. Default 'amoxi_'. */
  readonly tablePrefix?: string;
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function parseJson<T>(value: unknown): T {
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

/**
 * ConversationStore on PostgreSQL: `<prefix>threads` and `<prefix>messages` (ordered by a
 * bigserial, deleted with their thread), created on first use.
 */
export class PgConversationStore implements ConversationStore {
  private readonly db: PgQueryable;
  private readonly threads: string;
  private readonly messages: string;
  private readonly init: () => Promise<void>;

  constructor(options: PgConversationStoreOptions) {
    this.db = options.db;
    const prefix = checkTablePrefix(options.tablePrefix ?? 'amoxi_');
    this.threads = `${prefix}threads`;
    this.messages = `${prefix}messages`;
    this.init = once(() => this.createTables());
  }

  async createThread(input: { owner: string; agent: string; title?: string; metadata?: Metadata }): Promise<Thread> {
    await this.init();
    const now = new Date().toISOString();
    const { rows } = await this.db.query(
      `INSERT INTO ${this.threads} (id, owner, agent, title, created_at, updated_at, metadata)
       VALUES ($1, $2, $3, $4, $5::timestamptz, $5::timestamptz, $6::jsonb) RETURNING *`,
      [randomUUID(), input.owner, input.agent, input.title ?? null, now, input.metadata ? JSON.stringify(input.metadata) : null],
    );
    return this.toThread(rows[0]);
  }

  async getThread(id: string): Promise<Thread | undefined> {
    await this.init();
    const { rows } = await this.db.query(`SELECT * FROM ${this.threads} WHERE id = $1`, [id]);
    return rows.length ? this.toThread(rows[0]) : undefined;
  }

  async listThreads(owner: string, options: { agent?: string; limit?: number } = {}): Promise<Thread[]> {
    await this.init();
    const limit = clampLimit(options.limit, DEFAULT_THREAD_LIST_LIMIT, MAX_THREAD_LIST_LIMIT);
    const { rows } = await this.db.query(
      `SELECT * FROM ${this.threads} WHERE owner = $1 AND ($2::text IS NULL OR agent = $2::text)
       ORDER BY updated_at DESC, id LIMIT $3`,
      [owner, options.agent ?? null, limit],
    );
    return rows.map((r) => this.toThread(r));
  }

  async updateThread(id: string, patch: { title?: string; metadata?: Metadata }): Promise<void> {
    await this.init();
    const { rowCount } = await this.db.query(
      `UPDATE ${this.threads} SET
         title = CASE WHEN $2::boolean THEN $3::text ELSE title END,
         metadata = CASE WHEN $4::boolean THEN $5::jsonb ELSE metadata END,
         updated_at = now()
       WHERE id = $1`,
      [id, patch.title !== undefined, patch.title ?? null, patch.metadata !== undefined, patch.metadata ? JSON.stringify(patch.metadata) : null],
    );
    if (!rowCount) throw new Error(`Thread '${id}' not found`);
  }

  async deleteThread(id: string): Promise<void> {
    await this.init();
    await this.db.query(`DELETE FROM ${this.messages} WHERE thread_id = $1`, [id]);
    await this.db.query(`DELETE FROM ${this.threads} WHERE id = $1`, [id]);
  }

  async appendMessages(threadId: string, messages: readonly ChatMessage[]): Promise<ChatMessage[]> {
    await this.init();
    const stamped = stampMessages(messages);
    const { rowCount } = await this.db.query(`UPDATE ${this.threads} SET updated_at = now() WHERE id = $1`, [threadId]);
    if (!rowCount) throw new Error(`Thread '${threadId}' not found`);
    if (stamped.length) {
      await this.db.query(
        `INSERT INTO ${this.messages} (thread_id, message)
         SELECT $1, x.e FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS x(e, n) ORDER BY x.n`,
        [threadId, JSON.stringify(stamped)],
      );
    }
    return stamped;
  }

  async getMessages(threadId: string, options: { limit?: number } = {}): Promise<ChatMessage[]> {
    await this.init();
    const limit = options.limit === undefined || !Number.isFinite(options.limit) ? null : Math.max(0, Math.floor(options.limit));
    const { rows } = await this.db.query(
      `SELECT message FROM (
         SELECT seq, message FROM ${this.messages} WHERE thread_id = $1 ORDER BY seq DESC LIMIT $2
       ) recent ORDER BY seq`,
      [threadId, limit],
    );
    return rows.map((r) => parseJson<ChatMessage>(r.message));
  }

  private toThread(r: any): Thread {
    const md = r.metadata == null ? undefined : parseJson<Metadata>(r.metadata);
    return {
      id: String(r.id),
      owner: String(r.owner),
      agent: String(r.agent),
      ...(r.title != null ? { title: String(r.title) } : {}),
      createdAt: iso(r.created_at),
      updatedAt: iso(r.updated_at),
      ...(md ? { metadata: md } : {}),
    };
  }

  private async createTables(): Promise<void> {
    const ddl = async () => {
      await this.db.query(
        `CREATE TABLE IF NOT EXISTS ${this.threads} (
           id text PRIMARY KEY,
           owner text NOT NULL,
           agent text NOT NULL,
           title text,
           created_at timestamptz NOT NULL,
           updated_at timestamptz NOT NULL,
           metadata jsonb
         )`,
      );
      await this.db.query(`CREATE INDEX IF NOT EXISTS ${this.threads}_owner_idx ON ${this.threads} (owner, updated_at DESC)`);
      await this.db.query(
        `CREATE TABLE IF NOT EXISTS ${this.messages} (
           seq bigserial PRIMARY KEY,
           thread_id text NOT NULL,
           message jsonb NOT NULL
         )`,
      );
      await this.db.query(`CREATE INDEX IF NOT EXISTS ${this.messages}_thread_idx ON ${this.messages} (thread_id, seq)`);
    };
    try {
      await ddl();
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== '23505' && code !== '42P07') throw err;
      await ddl();
    }
  }
}
