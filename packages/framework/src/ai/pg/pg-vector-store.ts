// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import type { Metadata, VectorMatch, VectorQuery, VectorRecord, VectorStore } from '../types';
import { checkTablePrefix, once, type PgQueryable } from './pg-loader';

export interface PgVectorStoreOptions {
  readonly db: PgQueryable;
  /** Prefix of table names. Default 'amoxi_'. */
  readonly tablePrefix?: string;
  /** Expected vector size; vectors of another size are rejected. Optional: tables are per size. */
  readonly dimensions?: number;
}

/** pgvector's HNSW index supports up to 2000 dimensions for the `vector` type. */
const HNSW_MAX_DIMS = 2000;
const MAX_DIMS = 16_000;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 1000;
const UPSERT_BATCH = 500;

function vectorLiteral(v: readonly number[]): string {
  for (const x of v) if (typeof x !== 'number' || !Number.isFinite(x)) throw new TypeError('Vectors must contain finite numbers only');
  return `[${v.join(',')}]`;
}

/**
 * VectorStore on PostgreSQL with the pgvector extension. One table per vector size
 * (`<prefix>vectors_<dims>`, e.g. amoxi_vectors_1536) with an HNSW cosine index, created on first
 * use. Score = 1 - cosine distance. Metadata is jsonb and filtered with `@>`.
 *
 * Note: HNSW applies the namespace and metadata filter after the index scan, so very selective
 * filters can return fewer than `limit` rows. With pgvector >= 0.8 set
 * `ALTER DATABASE <db> SET hnsw.iterative_scan = relaxed_order` to avoid that.
 */
export class PgVectorStore implements VectorStore {
  private readonly db: PgQueryable;
  private readonly prefix: string;
  private readonly dimensions?: number;
  private readonly ensureExtension: () => Promise<void>;
  private readonly tables = new Map<number, () => Promise<void>>();

  constructor(options: PgVectorStoreOptions) {
    this.db = options.db;
    this.prefix = checkTablePrefix(options.tablePrefix ?? 'amoxi_');
    if (options.dimensions !== undefined && options.dimensions !== 0) this.dimensions = this.checkDims(options.dimensions);
    this.ensureExtension = once(() => this.createExtension());
  }

  async upsert(namespace: string, records: readonly VectorRecord[]): Promise<void> {
    if (records.length === 0) return;
    const dims = this.checkDims(records[0].vector.length);
    for (const r of records) {
      if (typeof r.id !== 'string' || !r.id) throw new TypeError('Vector records need a non-empty string id');
      if (r.vector.length !== dims) throw new Error(`Vector '${r.id}' has ${r.vector.length} dimensions, expected ${dims}`);
    }
    const table = await this.table(dims);
    for (let i = 0; i < records.length; i += UPSERT_BATCH) {
      const rows = records.slice(i, i + UPSERT_BATCH).map((r) => ({ id: r.id, text: r.text, metadata: r.metadata ?? {}, embedding: vectorLiteral(r.vector) }));
      await this.db.query(
        `INSERT INTO ${table} (namespace, id, text, metadata, embedding)
         SELECT $1, x.id, x.text, x.metadata, x.embedding::vector
         FROM jsonb_to_recordset($2::jsonb) AS x(id text, text text, metadata jsonb, embedding text)
         ON CONFLICT (namespace, id) DO UPDATE SET text = EXCLUDED.text, metadata = EXCLUDED.metadata, embedding = EXCLUDED.embedding`,
        [namespace, JSON.stringify(rows)],
      );
    }
  }

  async query(namespace: string, vector: readonly number[], query: VectorQuery = {}): Promise<VectorMatch[]> {
    const dims = this.checkDims(vector.length);
    const limit = Math.max(0, Math.min(MAX_LIMIT, Math.floor(query.limit ?? DEFAULT_LIMIT)));
    if (limit === 0) return [];
    const table = await this.table(dims);
    const params: unknown[] = [vectorLiteral(vector), namespace, limit];
    let where = 'namespace = $2';
    if (query.filter && Object.keys(query.filter).length) {
      params.push(JSON.stringify(query.filter));
      where += ` AND metadata @> $${params.length}::jsonb`;
    }
    const { rows } = await this.db.query(
      `SELECT id, text, metadata, 1 - (embedding <=> $1::vector) AS score
       FROM ${table} WHERE ${where}
       ORDER BY embedding <=> $1::vector LIMIT $3`,
      params,
    );
    const min = query.minScore ?? -Infinity;
    return rows
      .map((r) => {
        const md = (typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata) as Metadata | null;
        const score = Number(r.score);
        return { id: String(r.id), text: String(r.text), ...(md && Object.keys(md).length ? { metadata: md } : {}), score: Number.isNaN(score) ? 0 : score };
      })
      .filter((m) => m.score >= min);
  }

  async delete(namespace: string, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    for (const table of await this.existingTables()) {
      await this.db.query(`DELETE FROM ${table} WHERE namespace = $1 AND id = ANY($2::text[])`, [namespace, [...ids]]);
    }
  }

  async clear(namespace: string): Promise<void> {
    for (const table of await this.existingTables()) {
      await this.db.query(`DELETE FROM ${table} WHERE namespace = $1`, [namespace]);
    }
  }

  private checkDims(dims: number): number {
    if (!Number.isInteger(dims) || dims < 1 || dims > MAX_DIMS) throw new RangeError(`Vector size must be an integer between 1 and ${MAX_DIMS}, got ${dims}`);
    if (this.dimensions !== undefined && dims !== this.dimensions) {
      throw new Error(`This PgVectorStore is configured for ${this.dimensions}-dimensional vectors but got ${dims}. Check ai.embeddings.dimensions.`);
    }
    return dims;
  }

  private tableName(dims: number): string {
    return `${this.prefix}vectors_${dims}`;
  }

  /** Vector tables of this prefix that exist (any size), for delete/clear. */
  private async existingTables(): Promise<string[]> {
    const { rows } = await this.db.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name LIKE $1`,
      [`${this.prefix.replace(/_/g, '\\_')}vectors\\_%`],
    );
    const pattern = new RegExp(`^${this.prefix}vectors_\\d+$`);
    return rows.map((r) => String(r.table_name)).filter((t) => pattern.test(t));
  }

  private async table(dims: number): Promise<string> {
    let init = this.tables.get(dims);
    if (!init) this.tables.set(dims, (init = once(() => this.createTable(dims))));
    await init();
    return this.tableName(dims);
  }

  private async createExtension(): Promise<void> {
    const { rows } = await this.db.query(`SELECT 1 FROM pg_extension WHERE extname = 'vector'`);
    if (rows.length) return;
    try {
      await this.db.query('CREATE EXTENSION IF NOT EXISTS vector');
    } catch (err) {
      throw new Error(
        `PgVectorStore needs the pgvector extension, and it could not be enabled (${(err as Error).message}). ` +
          'Install pgvector on the database server (e.g. the pgvector/pgvector Docker image or your provider\'s "vector" extension), ' +
          'then run `CREATE EXTENSION IF NOT EXISTS vector;` as a user allowed to create extensions, or use ai.store=file.',
      );
    }
  }

  private async createTable(dims: number): Promise<void> {
    await this.ensureExtension();
    const t = this.tableName(dims);
    const ddl = async () => {
      await this.db.query(
        `CREATE TABLE IF NOT EXISTS ${t} (
           namespace text NOT NULL,
           id text NOT NULL,
           text text NOT NULL,
           metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
           embedding vector(${dims}) NOT NULL,
           PRIMARY KEY (namespace, id)
         )`,
      );
      if (dims <= HNSW_MAX_DIMS) {
        await this.db.query(`CREATE INDEX IF NOT EXISTS ${t}_hnsw ON ${t} USING hnsw (embedding vector_cosine_ops)`);
      }
    };
    try {
      await ddl();
    } catch (err) {
      // Two servers creating the same table at once can hit a unique violation: retry once.
      const code = (err as { code?: string }).code;
      if (code !== '23505' && code !== '42P07') throw err;
      await ddl();
    }
  }
}
