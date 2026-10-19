// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import { mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Metadata, VectorMatch, VectorQuery, VectorRecord, VectorStore } from '../types';
import { norm } from './math';
import { readFileRetry, retryOnWindows, withFileLock } from '../stores/fs-retry';

export interface LocalVectorStoreOptions {
  /** JSON file to persist to (loaded lazily, written atomically). In-memory only when omitted. */
  readonly file?: string;
  /** Upper bound per namespace, to bound memory. Default 200 000. */
  readonly maxRecordsPerNamespace?: number;
  /** Debounce of persistence writes. Default 200 ms. */
  readonly writeDelayMs?: number;
}

interface Entry {
  readonly text: string;
  readonly metadata?: Metadata;
  /** Unit-length copy of the vector (Float32 to halve memory; scores are computed in Float64). */
  readonly unit: Float32Array;
}

interface FileFormat {
  readonly version: 1;
  readonly namespaces: Record<string, Array<{ id: string; text: string; metadata?: Metadata; v: string }>>;
}

/** A change not yet written to the file. */
type Op =
  | { readonly t: 'upsert'; readonly ns: string; readonly entries: ReadonlyArray<readonly [string, Entry]> }
  | { readonly t: 'delete'; readonly ns: string; readonly ids: readonly string[] }
  | { readonly t: 'clear'; readonly ns: string };

type Data = Map<string, Map<string, Entry>>;

function apply(data: Data, op: Op): void {
  if (op.t === 'clear') {
    data.delete(op.ns);
    return;
  }
  let ns = data.get(op.ns);
  if (op.t === 'upsert') {
    if (!ns) data.set(op.ns, (ns = new Map()));
    for (const [id, e] of op.entries) ns.set(id, e);
  } else if (ns) {
    for (const id of op.ids) ns.delete(id);
    if (ns.size === 0) data.delete(op.ns);
  }
}

/** Identifies a version of the file (changes whenever any process rewrites it). */
async function fileStamp(file: string): Promise<string | undefined> {
  try {
    const st = await stat(file);
    return `${st.mtimeMs}:${st.size}:${st.ino}`;
  } catch {
    return undefined;
  }
}

/** How often a reader checks whether another process changed the file. */
const REFRESH_MS = 250;

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 1000;

function toUnit(vector: readonly number[]): Float32Array {
  const n = norm(vector);
  const out = new Float32Array(vector.length);
  if (n > 0) for (let i = 0; i < vector.length; i++) out[i] = vector[i] / n;
  return out;
}

/** Exact match on every key of `filter`. */
export function matchesFilter(metadata: Metadata | undefined, filter: Metadata | undefined): boolean {
  if (!filter) return true;
  for (const key of Object.keys(filter)) {
    if (!metadata || metadata[key] !== filter[key]) return false;
  }
  return true;
}

/**
 * Zero-setup vector store: brute-force cosine search over vectors kept in memory, optionally
 * persisted to one JSON file. Fast enough for tens of thousands of chunks per namespace; use
 * PgVectorStore (pgvector, HNSW index) beyond that or when several servers share the data.
 *
 * Persistence: the file is read on first use, and every change schedules a debounced atomic
 * write (temporary file + rename), so a crash never leaves a half-written file. Call `flush()`
 * (or `close()`) before exiting to write pending changes.
 *
 * Several processes (cluster workers) may share the file: a write takes a lock file, re-reads
 * what the others saved and applies only this process's own changes on top, so no one's changes
 * are lost; readers reload the file when another process has changed it.
 */
export class LocalVectorStore implements VectorStore {
  /** What searches see: the file's content plus this process's unsaved changes. */
  private data: Data = new Map();
  /** The file's content as this process last read or wrote it. */
  private base: Data = new Map();
  /** Changes made here and not yet written, in order. */
  private pending: Op[] = [];
  /** Version of the file this process last read or wrote. */
  private stamp: string | undefined;
  private lastRefresh = 0;
  private readonly maxRecords: number;
  private readonly writeDelay: number;
  private loading?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private writing: Promise<void> = Promise.resolve();
  private dirty = false;

  constructor(private readonly options: LocalVectorStoreOptions = {}) {
    this.maxRecords = options.maxRecordsPerNamespace ?? 200_000;
    this.writeDelay = options.writeDelayMs ?? 200;
  }

  async upsert(namespace: string, records: readonly VectorRecord[]): Promise<void> {
    await this.ready();
    if (records.length === 0) return;
    let ns = this.data.get(namespace);
    const existingDims = ns && ns.size > 0 ? ns.values().next().value!.unit.length : undefined;
    const dims = existingDims ?? records[0].vector.length;
    const added = records.filter((r) => !ns?.has(r.id)).length;
    if ((ns?.size ?? 0) + added > this.maxRecords) {
      throw new Error(
        `Vector namespace '${namespace}' would exceed ${this.maxRecords} records. Raise maxRecordsPerNamespace or use the postgres store (ai.store=postgres).`,
      );
    }
    for (const r of records) {
      if (typeof r.id !== 'string' || r.id === '') throw new TypeError('Vector records need a non-empty string id');
      if (r.vector.length !== dims || dims === 0) {
        throw new Error(`Vector '${r.id}' has ${r.vector.length} dimensions but namespace '${namespace}' uses ${dims}. Don't mix embedders in one namespace.`);
      }
    }
    const op: Op = { t: 'upsert', ns: namespace, entries: records.map((r) => [r.id, { text: r.text, metadata: r.metadata ? { ...r.metadata } : undefined, unit: toUnit(r.vector) }] as const) };
    apply(this.data, op);
    this.changed(op);
  }

  async query(namespace: string, vector: readonly number[], query: VectorQuery = {}): Promise<VectorMatch[]> {
    await this.ready();
    const ns = this.data.get(namespace);
    if (!ns || ns.size === 0) return [];
    const limit = Math.max(0, Math.min(MAX_LIMIT, Math.floor(query.limit ?? DEFAULT_LIMIT)));
    if (limit === 0) return [];
    const qn = norm(vector);
    if (qn === 0) return [];
    const minScore = query.minScore ?? -Infinity;
    const hits: VectorMatch[] = [];
    for (const [id, e] of ns) {
      if (!matchesFilter(e.metadata, query.filter)) continue;
      const u = e.unit;
      if (u.length !== vector.length) continue;
      let d = 0;
      for (let i = 0; i < u.length; i++) d += u[i] * vector[i];
      const score = Math.max(-1, Math.min(1, d / qn));
      if (score < minScore) continue;
      hits.push({ id, text: e.text, metadata: e.metadata, score });
    }
    hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    return hits.slice(0, limit);
  }

  async delete(namespace: string, ids: readonly string[]): Promise<void> {
    await this.ready();
    const ns = this.data.get(namespace);
    if (!ns) return;
    if (!ids.some((id) => ns.has(id))) return;
    const op: Op = { t: 'delete', ns: namespace, ids: [...ids] };
    apply(this.data, op);
    this.changed(op);
  }

  async clear(namespace: string): Promise<void> {
    await this.ready();
    if (!this.data.has(namespace)) return;
    const op: Op = { t: 'clear', ns: namespace };
    apply(this.data, op);
    this.changed(op);
  }

  /** Writes pending changes now. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.schedulePersist();
    }
    await this.writing;
  }

  /** Flushes pending changes; the store stays usable. */
  async close(): Promise<void> {
    await this.flush();
  }

  private async ready(): Promise<void> {
    if (!this.options.file) return;
    await (this.loading ??= this.load().then((data) => {
      this.base = data;
      this.data = this.withPending(data);
    }));
    await this.refresh();
  }

  /** Picks up what other processes saved (at most every REFRESH_MS), keeping this process's unsaved changes. */
  private async refresh(): Promise<void> {
    const now = Date.now();
    if (now - this.lastRefresh < REFRESH_MS) return;
    this.lastRefresh = now;
    const current = await fileStamp(this.options.file!);
    if (current === undefined || current === this.stamp) return;
    this.base = await this.load();
    this.data = this.withPending(this.base);
  }

  /** A copy of `base` with the unsaved changes applied (namespace maps are copied; entries are shared). */
  private withPending(base: Data): Data {
    const out: Data = new Map();
    for (const [k, ns] of base) out.set(k, new Map(ns));
    for (const op of this.pending) apply(out, op);
    return out;
  }

  private async load(): Promise<Data> {
    const data: Data = new Map();
    const stampBefore = await fileStamp(this.options.file!);
    let text: string;
    try {
      text = await readFileRetry(this.options.file!);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.stamp = undefined;
        return data;
      }
      throw err;
    }
    let parsed: FileFormat;
    try {
      parsed = JSON.parse(text) as FileFormat;
    } catch (err) {
      throw new Error(`Vector store file ${this.options.file} is not valid JSON (${(err as Error).message}). Restore it from a backup or delete it to start empty.`);
    }
    for (const [namespace, rows] of Object.entries(parsed.namespaces ?? {})) {
      const ns = new Map<string, Entry>();
      for (const row of rows.slice(0, this.maxRecords)) {
        const buf = Buffer.from(row.v, 'base64');
        const unit = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
        ns.set(row.id, { text: row.text, metadata: row.metadata, unit });
      }
      data.set(namespace, ns);
    }
    this.stamp = stampBefore;
    return data;
  }

  private changed(op: Op): void {
    if (!this.options.file) return;
    this.pending.push(op);
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.schedulePersist();
    }, this.writeDelay);
    this.timer.unref?.();
  }

  /** Chains a write after any write in progress, so writes never overlap. */
  private schedulePersist(): void {
    this.writing = this.writing
      .catch(() => undefined)
      .then(() => (this.dirty ? this.persist() : undefined))
      .catch((err) => {
        this.dirty = true;
        // Surface the failure on the next flush() instead of an unhandled rejection.
        throw err;
      });
    this.writing.catch(() => undefined);
  }

  private async persist(): Promise<void> {
    this.dirty = false;
    const file = this.options.file!;
    await mkdir(dirname(file), { recursive: true });
    await withFileLock(`${file}.lock`, async () => {
      const ops = this.pending.slice();
      // Start from what is on disk now (another process may have written since), then add our changes.
      const unchanged = (await fileStamp(file)) === this.stamp;
      const next: Data = new Map();
      for (const [k, ns] of unchanged ? this.base : await this.load()) next.set(k, new Map(ns));
      for (const op of ops) apply(next, op);
      await this.write(file, next);
      this.stamp = await fileStamp(file);
      this.base = next;
      // Changes made while writing stay pending (and visible here) until the next write.
      this.pending = this.pending.slice(ops.length);
      this.data = this.withPending(next);
    });
  }

  private async write(file: string, data: Data): Promise<void> {
    const out: FileFormat['namespaces'] = {};
    for (const [namespace, ns] of data) {
      out[namespace] = [...ns].map(([id, e]) => ({
        id,
        text: e.text,
        ...(e.metadata ? { metadata: e.metadata } : {}),
        v: Buffer.from(e.unit.buffer, e.unit.byteOffset, e.unit.byteLength).toString('base64'),
      }));
    }
    const body = JSON.stringify({ version: 1, namespaces: out } satisfies FileFormat);
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await writeFile(tmp, body, 'utf8');
      await retryOnWindows(() => rename(tmp, file));
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      throw err;
    }
  }
}
