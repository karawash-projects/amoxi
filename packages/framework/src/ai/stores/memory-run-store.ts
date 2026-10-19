// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import { matchesCondition, RunConflictError, TERMINAL_STATUSES, type RunEvent, type RunRecord, type RunStore, type RunUpdateCondition } from '../types';

export interface MemoryRunStoreOptions {
  /** Runs kept; the oldest finished runs are evicted beyond it. Default 10 000. */
  readonly maxRuns?: number;
  /** Events kept per run (the oldest are dropped beyond it). Default 50 000. */
  readonly maxEventsPerRun?: number;
}

/** True when the run can be taken by a worker (shared by every RunStore implementation). */
export function isClaimable(run: RunRecord, staleBeforeMs: number): boolean {
  if (run.status === 'queued') return true;
  if (run.status !== 'running') return false;
  const hb = run.heartbeatAt ? Date.parse(run.heartbeatAt) : NaN;
  return Number.isNaN(hb) || hb < staleBeforeMs;
}

/** Parses `staleBefore` (ISO time) into epoch milliseconds, with a clear error. */
export function parseStaleBefore(staleBefore: string): number {
  const ms = Date.parse(staleBefore);
  if (Number.isNaN(ms)) throw new TypeError(`claim(): staleBefore must be an ISO date, got '${staleBefore}'`);
  return ms;
}

/**
 * In-process RunStore for tests and single-process development. Runs vanish on restart. Records
 * are copied in and out so callers can't mutate stored state by accident.
 */
export class MemoryRunStore implements RunStore {
  private readonly runs = new Map<string, RunRecord>();
  private readonly log = new Map<string, RunEvent[]>();
  private readonly maxRuns: number;
  private readonly maxEvents: number;

  constructor(options: MemoryRunStoreOptions = {}) {
    this.maxRuns = options.maxRuns ?? 10_000;
    this.maxEvents = options.maxEventsPerRun ?? 50_000;
  }

  async create(run: RunRecord): Promise<void> {
    if (this.runs.has(run.id)) throw new Error(`Run '${run.id}' already exists`);
    this.runs.set(run.id, structuredClone(run));
    this.evict();
  }

  async createIfIdle(run: RunRecord): Promise<RunRecord | undefined> {
    // Synchronous from check to write: atomic within the process.
    for (const other of this.runs.values()) {
      if (other.threadId === run.threadId && !TERMINAL_STATUSES.has(other.status)) return structuredClone(other);
    }
    if (this.runs.has(run.id)) throw new Error(`Run '${run.id}' already exists`);
    this.runs.set(run.id, structuredClone(run));
    this.evict();
    return undefined;
  }

    async get(id: string): Promise<RunRecord | undefined> {
    const run = this.runs.get(id);
    return run ? structuredClone(run) : undefined;
  }

  async update(id: string, patch: Partial<Omit<RunRecord, 'id'>>, condition?: RunUpdateCondition): Promise<RunRecord> {
    const run = this.runs.get(id);
    if (!run) throw new Error(`Run '${id}' not found`);
    if (!matchesCondition(run, condition)) throw new RunConflictError(id);
    const next: RunRecord = { ...run, ...structuredClone(patch), id, updatedAt: patch.updatedAt ?? new Date().toISOString(), revision: (run.revision ?? 0) + 1 };
    this.runs.set(id, next);
    return structuredClone(next);
  }

  async listByThread(threadId: string): Promise<RunRecord[]> {
    return [...this.runs.values()]
      .filter((r) => r.threadId === threadId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((r) => structuredClone(r));
  }

  async appendEvents(runId: string, events: readonly RunEvent[]): Promise<void> {
    let list = this.log.get(runId);
    if (!list) this.log.set(runId, (list = []));
    for (const e of events) list.push(structuredClone(e));
    if (list.length > this.maxEvents) list.splice(0, list.length - this.maxEvents);
  }

  async events(runId: string, afterSeq: number): Promise<RunEvent[]> {
    return (this.log.get(runId) ?? []).filter((e) => e.seq > afterSeq).map((e) => structuredClone(e));
  }

  async claim(workerId: string, staleBefore: string): Promise<RunRecord | undefined> {
    const staleMs = parseStaleBefore(staleBefore);
    let best: RunRecord | undefined;
    for (const run of this.runs.values()) {
      if (isClaimable(run, staleMs) && (!best || run.createdAt < best.createdAt)) best = run;
    }
    if (!best) return undefined;
    // Synchronous from check to write: atomic within the process.
    const now = new Date().toISOString();
    const next: RunRecord = { ...best, status: 'running', workerId, heartbeatAt: now, updatedAt: now, startedAt: best.startedAt ?? now, revision: (best.revision ?? 0) + 1 };
    this.runs.set(next.id, next);
    return structuredClone(next);
  }

  private evict(): void {
    if (this.runs.size <= this.maxRuns) return;
    // Map keeps insertion order: drop the oldest finished runs first.
    for (const [id, run] of this.runs) {
      if (this.runs.size <= this.maxRuns) break;
      if (TERMINAL_STATUSES.has(run.status)) {
        this.runs.delete(id);
        this.log.delete(id);
      }
    }
  }
}
