// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes } from 'node:crypto';
import { appendFile, link, mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readFileRetry, withFileLock, writeAtomic } from './fs-retry';
import { matchesCondition, RunConflictError, TERMINAL_STATUSES, type RunEvent, type RunRecord, type RunStore, type RunUpdateCondition } from '../types';
import { isClaimable, parseStaleBefore } from './memory-run-store';

/** A file name for an id: the id itself when safe, else a hash (no path traversal). */
function safeName(id: string): string {
  if (typeof id !== 'string' || id === '') throw new TypeError('Run and thread ids must be non-empty strings');
  return /^[A-Za-z0-9_-]{1,100}$/.test(id) ? id : `h_${createHash('sha256').update(id).digest('hex').slice(0, 40)}`;
}

/** Writes via a temporary file and rename, so readers never see a partial file. */
function isCode(err: unknown, code: string): boolean {
  return (err as NodeJS.ErrnoException)?.code === code;
}

/** Serialises async work per key inside one process. */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => next);
    this.tails.set(key, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

interface EventCache {
  /** Bytes of the events file already parsed. */
  offset: number;
  events: RunEvent[];
}

export interface FileRunStoreOptions {
  /** Runs whose event logs are cached in memory (least recently used evicted). Default 64. */
  readonly eventCacheSize?: number;
  /** A claim lock older than this is considered abandoned by a crashed process. Default 10 s. */
  readonly lockTimeoutMs?: number;
}

/**
 * RunStore on the local file system, safe for several processes on one machine (Amoxi runs one
 * worker per CPU core).
 *
 * Layout of `dir`:
 *   <run>.json            the record, replaced atomically (temporary file + rename)
 *   <run>.events.jsonl    append-only event log
 *   <run>.lock            short-lived claim lock (created with flag 'wx'; holds the worker id)
 *   active/<time>_<run>   marker of every unfinished run, so claim() scans only those
 *   by-thread/<thread>.txt run ids per thread (append-only)
 *
 * claim() takes the oldest claimable run whose lock it can create exclusively, re-reads the record
 * under the lock and only then marks it running, so two processes never take the same run.
 */
export class FileRunStore implements RunStore {
  private readonly mutex = new KeyedMutex();
  private readonly eventCache = new Map<string, EventCache>();
  private readonly cacheSize: number;
  private readonly lockTimeoutMs: number;
  private ready?: Promise<void>;

  constructor(
    private readonly dir: string,
    options: FileRunStoreOptions = {},
  ) {
    this.cacheSize = options.eventCacheSize ?? 64;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 10_000;
  }

  async createIfIdle(run: RunRecord): Promise<RunRecord | undefined> {
    await this.init();
    // A lock file per thread makes check-and-create atomic across processes sharing the folder.
    return withFileLock(join(this.dir, 'by-thread', `${safeName(run.threadId)}.lock`), async () => {
      const busy = (await this.listByThread(run.threadId)).find((r) => !TERMINAL_STATUSES.has(r.status));
      if (busy) return busy;
      await this.create(run);
      return undefined;
    });
  }

  async create(run: RunRecord): Promise<void> {
    await this.init();
    const name = safeName(run.id);
    await this.mutex.run(name, async () => {
      try {
        // 'wx' first: refuses duplicates even across processes.
        const fh = await open(this.runFile(name), 'wx');
        await fh.close();
      } catch (err) {
        if (isCode(err, 'EEXIST')) throw new Error(`Run '${run.id}' already exists`);
        throw err;
      }
      await writeAtomic(this.runFile(name), JSON.stringify(run));
      await appendFile(join(this.dir, 'by-thread', `${safeName(run.threadId)}.txt`), `${run.id}\n`, 'utf8');
      if (!TERMINAL_STATUSES.has(run.status)) await writeFile(this.activeMarker(run), run.id, 'utf8');
    });
  }

  async get(id: string): Promise<RunRecord | undefined> {
    await this.init();
    return this.read(safeName(id));
  }

  async update(id: string, patch: Partial<Omit<RunRecord, 'id'>>, condition?: RunUpdateCondition): Promise<RunRecord> {
    await this.init();
    const name = safeName(id);
    const apply = (): Promise<RunRecord> =>
      this.mutex.run(name, async () => {
        const run = await this.read(name);
        if (!run) throw new Error(`Run '${id}' not found`);
        if (!matchesCondition(run, condition)) throw new RunConflictError(id);
        const next: RunRecord = { ...run, ...patch, id: run.id, updatedAt: patch.updatedAt ?? new Date().toISOString(), revision: (run.revision ?? 0) + 1 };
        await writeAtomic(this.runFile(name), JSON.stringify(next));
        if (TERMINAL_STATUSES.has(next.status)) await unlink(this.activeMarker(next)).catch(() => undefined);
        return next;
      });
    if (!condition) return apply();
    // A compare-and-set must also exclude other processes sharing the directory: take the run's lock file.
    return this.withLock(name, apply);
  }

  /** Runs `fn` holding the run's cross-process lock file (the one claim() uses), waiting up to ~2 s for it. */
  private async withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const lock = join(this.dir, `${name}.lock`);
    const token = `update ${process.pid} ${randomBytes(6).toString('hex')} ${Date.now()}`;
    for (let attempt = 0; ; attempt++) {
      try {
        await writeFile(lock, token, { encoding: 'utf8', flag: 'wx' });
        break;
      } catch (err) {
        if (!isCode(err, 'EEXIST')) throw err;
        if (attempt >= 200) throw new RunConflictError(name);
        await this.breakAbandonedLock(lock);
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    try {
      return await fn();
    } finally {
      const current = await readFile(lock, 'utf8').catch(() => undefined);
      if (current === token) await unlink(lock).catch(() => undefined);
    }
  }

  async listByThread(threadId: string): Promise<RunRecord[]> {
    await this.init();
    let text: string;
    try {
      text = await readFileRetry(join(this.dir, 'by-thread', `${safeName(threadId)}.txt`));
    } catch (err) {
      if (isCode(err, 'ENOENT')) return [];
      throw err;
    }
    const ids = [...new Set(text.split('\n').filter(Boolean))];
    const runs = await Promise.all(ids.map((id) => this.read(safeName(id))));
    return runs
      .filter((r): r is RunRecord => !!r && r.threadId === threadId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async appendEvents(runId: string, events: readonly RunEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.init();
    // One write call with O_APPEND, so concurrent appenders don't interleave lines.
    const body = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
    await appendFile(this.eventsFile(safeName(runId)), body, 'utf8');
  }

  async events(runId: string, afterSeq: number): Promise<RunEvent[]> {
    await this.init();
    const name = safeName(runId);
    const cache = this.eventCache.get(name) ?? { offset: 0, events: [] };
    // Re-insert to mark as most recently used.
    this.eventCache.delete(name);
    this.eventCache.set(name, cache);
    while (this.eventCache.size > this.cacheSize) this.eventCache.delete(this.eventCache.keys().next().value!);
    await this.mutex.run(`ev:${name}`, () => this.readNewEvents(name, cache));
    return cache.events.filter((e) => e.seq > afterSeq);
  }

  async claim(workerId: string, staleBefore: string): Promise<RunRecord | undefined> {
    await this.init();
    const staleMs = parseStaleBefore(staleBefore);
    // Markers are named <zero-padded createdAt ms>_<run>, so sorting by name is oldest first.
    const markers = (await readdir(join(this.dir, 'active'))).filter((f) => !f.endsWith('.tmp')).sort();
    for (const marker of markers) {
      const name = marker.slice(marker.indexOf('_') + 1);
      const run = await this.read(name);
      if (!run) {
        await unlink(join(this.dir, 'active', marker)).catch(() => undefined);
        continue;
      }
      if (TERMINAL_STATUSES.has(run.status)) {
        await unlink(join(this.dir, 'active', marker)).catch(() => undefined);
        continue;
      }
      if (!isClaimable(run, staleMs)) continue;
      const claimed = await this.tryClaim(name, workerId, staleMs);
      if (claimed) return claimed;
    }
    return undefined;
  }

  /** Takes the run's lock, re-checks the record from disk, marks it running, releases the lock. */
  private async tryClaim(name: string, workerId: string, staleMs: number): Promise<RunRecord | undefined> {
    const lock = join(this.dir, `${name}.lock`);
    const token = `${workerId} ${process.pid} ${randomBytes(6).toString('hex')} ${Date.now()}`;
    try {
      await writeFile(lock, token, { encoding: 'utf8', flag: 'wx' });
    } catch (err) {
      if (!isCode(err, 'EEXIST')) throw err;
      await this.breakAbandonedLock(lock);
      return undefined;
    }
    try {
      return await this.mutex.run(name, async () => {
        const run = await this.read(name);
        if (!run || !isClaimable(run, staleMs)) return undefined;
        const now = new Date().toISOString();
        const next: RunRecord = { ...run, status: 'running', workerId, heartbeatAt: now, updatedAt: now, startedAt: run.startedAt ?? now, revision: (run.revision ?? 0) + 1 };
        await writeAtomic(this.runFile(name), JSON.stringify(next));
        return next;
      });
    } finally {
      // Only remove the lock if it is still ours.
      const current = await readFile(lock, 'utf8').catch(() => undefined);
      if (current === token) await unlink(lock).catch(() => undefined);
    }
  }

  /**
   * A lock left by a process that crashed inside claim() would block a run forever. Locks are held
   * for milliseconds, so one older than lockTimeoutMs is abandoned: move it aside (rename is
   * atomic, so only one process wins), check it is the one we judged stale, and delete it.
   */
  private async breakAbandonedLock(lock: string): Promise<void> {
    let seen: string;
    try {
      const info = await stat(lock);
      if (Date.now() - info.mtimeMs < this.lockTimeoutMs) return;
      seen = await readFile(lock, 'utf8');
    } catch {
      return;
    }
    const aside = `${lock}.${randomBytes(4).toString('hex')}.stale`;
    try {
      await rename(lock, aside);
    } catch {
      return;
    }
    const moved = await readFile(aside, 'utf8').catch(() => undefined);
    if (moved !== seen) {
      // We moved a fresh lock taken in between: put it back unless someone took a new one.
      await link(aside, lock).catch(() => undefined);
    }
    await unlink(aside).catch(() => undefined);
  }

  private async readNewEvents(name: string, cache: EventCache): Promise<void> {
    let fh;
    try {
      fh = await open(this.eventsFile(name), 'r');
    } catch (err) {
      if (isCode(err, 'ENOENT')) return;
      throw err;
    }
    try {
      const { size } = await fh.stat();
      if (size < cache.offset) {
        cache.offset = 0;
        cache.events = [];
      }
      if (size === cache.offset) return;
      const buf = Buffer.alloc(size - cache.offset);
      const { bytesRead } = await fh.read(buf, 0, buf.length, cache.offset);
      const chunk = buf.subarray(0, bytesRead);
      // Consume complete lines only; a line being appended right now is read next time.
      const end = chunk.lastIndexOf(0x0a);
      if (end < 0) return;
      for (const line of chunk.subarray(0, end).toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          cache.events.push(JSON.parse(line) as RunEvent);
        } catch {
          /* skip a corrupt line rather than failing the whole stream */
        }
      }
      cache.offset += end + 1;
      cache.events.sort((a, b) => a.seq - b.seq);
    } finally {
      await fh.close();
    }
  }

  private async read(name: string): Promise<RunRecord | undefined> {
    let text: string;
    try {
      text = await readFileRetry(this.runFile(name));
    } catch (err) {
      if (isCode(err, 'ENOENT')) return undefined;
      throw err;
    }
    if (!text) return undefined; // placeholder of a create() in progress
    return JSON.parse(text) as RunRecord;
  }

  private init(): Promise<void> {
    return (this.ready ??= (async () => {
      await mkdir(join(this.dir, 'active'), { recursive: true });
      await mkdir(join(this.dir, 'by-thread'), { recursive: true });
    })());
  }

  private runFile(name: string): string {
    return join(this.dir, `${name}.json`);
  }

  private eventsFile(name: string): string {
    return join(this.dir, `${name}.events.jsonl`);
  }

  private activeMarker(run: RunRecord): string {
    const ms = Date.parse(run.createdAt);
    const key = String(Number.isNaN(ms) ? 0 : ms).padStart(15, '0');
    return join(this.dir, 'active', `${key}_${safeName(run.id)}`);
  }
}
