// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import { RunConflictError, TERMINAL_STATUSES, type RunEvent, type RunRecord, type RunStore, type RunUpdateCondition } from '../types';
import { checkTablePrefix, once, type PgQueryable } from './pg-loader';

export interface PgRunStoreOptions {
  readonly db: PgQueryable;
  /** Prefix of table names. Default 'amoxi_'. */
  readonly tablePrefix?: string;
}

function parseJson<T>(value: unknown): T {
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

/**
 * RunStore on PostgreSQL: runs are jsonb records with indexed status/heartbeat columns, events
 * an append-only table keyed by (run_id, seq). `claim` is a single
 * `UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED)`, so any number of servers can share
 * one queue without double-processing a run.
 */
export class PgRunStore implements RunStore {
  private readonly db: PgQueryable;
  private readonly runs: string;
  private readonly events_: string;
  private readonly init: () => Promise<void>;

  constructor(options: PgRunStoreOptions) {
    this.db = options.db;
    const prefix = checkTablePrefix(options.tablePrefix ?? 'amoxi_');
    this.runs = `${prefix}runs`;
    this.events_ = `${prefix}run_events`;
    this.init = once(() => this.createTables());
  }

  async create(run: RunRecord): Promise<void> {
    await this.init();
    try {
      await this.db.query(
        `INSERT INTO ${this.runs} (id, thread_id, status, created_at, heartbeat_at, record)
         VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6::jsonb)`,
        [run.id, run.threadId, run.status, run.createdAt, run.heartbeatAt ?? null, JSON.stringify(run)],
      );
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new Error(`Run '${run.id}' already exists`);
      throw err;
    }
  }

  async createIfIdle(run: RunRecord): Promise<RunRecord | undefined> {
    await this.init();
    try {
      // The partial unique index (one unfinished run per thread) makes this atomic across servers.
      await this.db.query(
        `INSERT INTO ${this.runs} (id, thread_id, status, created_at, heartbeat_at, record)
         VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6::jsonb)`,
        [run.id, run.threadId, run.status, run.createdAt, run.heartbeatAt ?? null, JSON.stringify(run)],
      );
      return undefined;
    } catch (err) {
      const e = err as { code?: string; constraint?: string };
      if (e.code !== '23505') throw err;
      if (e.constraint !== `${this.runs}_one_active_idx`) throw new Error(`Run '${run.id}' already exists`);
      const busy = (await this.listByThread(run.threadId)).find((r) => !TERMINAL_STATUSES.has(r.status));
      if (busy) return busy;
      // Finished in the meantime: try once more.
      return this.createIfIdle(run);
    }
  }

  async get(id: string): Promise<RunRecord | undefined> {
    await this.init();
    const { rows } = await this.db.query(`SELECT record FROM ${this.runs} WHERE id = $1`, [id]);
    return rows.length ? parseJson<RunRecord>(rows[0].record) : undefined;
  }

  async update(id: string, patch: Partial<Omit<RunRecord, 'id'>>, condition?: RunUpdateCondition): Promise<RunRecord> {
    await this.init();
    const merged = { ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() } as Record<string, unknown>;
    delete merged.id;
    delete merged.revision;
    // jsonb || jsonb is a shallow merge, done in one statement (no lost updates); a condition makes
    // it a compare-and-set in the same statement.
    const params: unknown[] = [id, JSON.stringify(merged)];
    let where = 'id = $1';
    if (condition?.status) {
      params.push([...condition.status]);
      where += ` AND status = ANY($${params.length}::text[])`;
    }
    if (condition?.workerId !== undefined) {
      params.push(condition.workerId);
      where += ` AND record->>'workerId' = $${params.length}::text`;
    }
    if (condition?.revision !== undefined) {
      params.push(condition.revision);
      where += ` AND COALESCE((record->>'revision')::bigint, 0) = $${params.length}::bigint`;
    }
    const { rows } = await this.db.query(
      `UPDATE ${this.runs} SET
         record = record || $2::jsonb || jsonb_build_object('revision', COALESCE((record->>'revision')::bigint, 0) + 1),
         status = (record || $2::jsonb)->>'status',
         thread_id = (record || $2::jsonb)->>'threadId',
         heartbeat_at = ((record || $2::jsonb)->>'heartbeatAt')::timestamptz
       WHERE ${where} RETURNING record`,
      params,
    );
    if (!rows.length) {
      if (condition && (await this.get(id))) throw new RunConflictError(id);
      throw new Error(`Run '${id}' not found`);
    }
    return parseJson<RunRecord>(rows[0].record);
  }

  async listByThread(threadId: string): Promise<RunRecord[]> {
    await this.init();
    const { rows } = await this.db.query(`SELECT record FROM ${this.runs} WHERE thread_id = $1 ORDER BY created_at, id`, [threadId]);
    return rows.map((r) => parseJson<RunRecord>(r.record));
  }

  async appendEvents(runId: string, events: readonly RunEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.init();
    await this.db.query(
      `INSERT INTO ${this.events_} (run_id, seq, event)
       SELECT $1, (e->>'seq')::bigint, e FROM jsonb_array_elements($2::jsonb) AS e
       ON CONFLICT (run_id, seq) DO NOTHING`,
      [runId, JSON.stringify(events)],
    );
  }

  async events(runId: string, afterSeq: number): Promise<RunEvent[]> {
    await this.init();
    const { rows } = await this.db.query(`SELECT event FROM ${this.events_} WHERE run_id = $1 AND seq > $2 ORDER BY seq`, [runId, Math.floor(afterSeq)]);
    return rows.map((r) => parseJson<RunEvent>(r.event));
  }

  async claim(workerId: string, staleBefore: string): Promise<RunRecord | undefined> {
    await this.init();
    if (Number.isNaN(Date.parse(staleBefore))) throw new TypeError(`claim(): staleBefore must be an ISO date, got '${staleBefore}'`);
    const now = new Date().toISOString();
    const { rows } = await this.db.query(
      `UPDATE ${this.runs} SET
         status = 'running',
         heartbeat_at = $2::timestamptz,
         record = record || jsonb_build_object(
           'status', 'running', 'workerId', $1::text, 'heartbeatAt', $3::text, 'updatedAt', $3::text,
           'startedAt', COALESCE(record->'startedAt', to_jsonb($3::text)),
           'revision', COALESCE((record->>'revision')::bigint, 0) + 1)
       WHERE id = (
         SELECT id FROM ${this.runs}
         WHERE status = 'queued' OR (status = 'running' AND (heartbeat_at IS NULL OR heartbeat_at < $4::timestamptz))
         ORDER BY created_at, id
         LIMIT 1
         FOR UPDATE SKIP LOCKED)
       RETURNING record`,
      [workerId, now, now, staleBefore],
    );
    return rows.length ? parseJson<RunRecord>(rows[0].record) : undefined;
  }

  private async createTables(): Promise<void> {
    const ddl = async () => {
      await this.db.query(
        `CREATE TABLE IF NOT EXISTS ${this.runs} (
           id text PRIMARY KEY,
           thread_id text NOT NULL,
           status text NOT NULL,
           created_at timestamptz NOT NULL,
           heartbeat_at timestamptz,
           record jsonb NOT NULL
         )`,
      );
      await this.db.query(`CREATE INDEX IF NOT EXISTS ${this.runs}_claim_idx ON ${this.runs} (status, created_at)`);
      await this.db.query(`CREATE INDEX IF NOT EXISTS ${this.runs}_thread_idx ON ${this.runs} (thread_id, created_at)`);
      // At most one unfinished run per conversation (see createIfIdle). A database written by an older
      // version may already hold two unfinished runs of one thread; the index is then left out (and
      // created on a later start, once they have finished) rather than stopping the app.
      await this.db
        .query(`CREATE UNIQUE INDEX IF NOT EXISTS ${this.runs}_one_active_idx ON ${this.runs} (thread_id) WHERE status NOT IN ('completed', 'failed', 'cancelled')`)
        .catch((err: { code?: string }) => {
          if (err.code !== '23505') throw err;
        });
      await this.db.query(
        `CREATE TABLE IF NOT EXISTS ${this.events_} (
           run_id text NOT NULL,
           seq bigint NOT NULL,
           event jsonb NOT NULL,
           PRIMARY KEY (run_id, seq)
         )`,
      );
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
