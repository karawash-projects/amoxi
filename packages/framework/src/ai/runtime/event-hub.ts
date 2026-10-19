// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import type { RunEvent } from '../types';

type Listener = (event: RunEvent) => void;

/**
 * Live run events for subscribers in this process (Observer). Durable events also go to the
 * RunStore; token deltas are live-only, so a client that reconnects later gets the completed
 * messages instead of every token.
 */
export class RunEventHub {
  private readonly listeners = new Map<string, Set<Listener>>();
  /** Recent events of active runs, so a subscriber that arrives mid-run misses nothing. */
  private readonly recent = new Map<string, RunEvent[]>();
  private static readonly RECENT_LIMIT = 2000;
  /** Runs whose events are kept at most; the oldest without subscribers are dropped first. */
  private static readonly MAX_RUNS = 2000;
  private readonly releasing = new Set<string>();

  constructor(private readonly graceMs = 60_000) {}

  publish(event: RunEvent): void {
    let buf = this.recent.get(event.runId);
    if (!buf) {
      this.recent.set(event.runId, (buf = []));
      if (this.recent.size > RunEventHub.MAX_RUNS) this.evict();
    }
    buf.push(event);
    if (buf.length > RunEventHub.RECENT_LIMIT) buf.splice(0, buf.length - RunEventHub.RECENT_LIMIT);
    // A run that finished or paused needs its buffer only briefly (its durable events are in the store).
    if (isRestingEvent(event)) this.release(event.runId);
    for (const fn of this.listeners.get(event.runId) ?? []) {
      try {
        fn(event);
      } catch {
        /* a broken subscriber must not break the run */
      }
    }
  }

  /** Events of this run still in memory with seq > afterSeq. */
  recentEvents(runId: string, afterSeq: number): RunEvent[] {
    return (this.recent.get(runId) ?? []).filter((e) => e.seq > afterSeq);
  }

  subscribe(runId: string, fn: Listener): () => void {
    let set = this.listeners.get(runId);
    if (!set) this.listeners.set(runId, (set = new Set()));
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (set!.size === 0) this.listeners.delete(runId);
    };
  }

  /** Forget a run's buffered events after a grace period for late subscribers (retried while some remain). */
  release(runId: string, afterMs = this.graceMs): void {
    if (this.releasing.has(runId)) return;
    this.releasing.add(runId);
    const t = setTimeout(() => {
      this.releasing.delete(runId);
      if (!this.recent.has(runId)) return;
      if (this.listeners.has(runId)) this.release(runId, afterMs);
      else this.recent.delete(runId);
    }, afterMs);
    t.unref?.();
  }

  /** Number of runs with buffered events (for monitoring and tests). */
  get bufferedRuns(): number {
    return this.recent.size;
  }

  private evict(): void {
    for (const runId of this.recent.keys()) {
      if (this.recent.size <= RunEventHub.MAX_RUNS) return;
      if (!this.listeners.has(runId)) this.recent.delete(runId);
    }
  }
}

const RESTING_STATUSES = new Set(['completed', 'failed', 'cancelled', 'awaiting_approval']);

/** The run ended or paused for approval. */
function isRestingEvent(event: RunEvent): boolean {
  if (event.type === 'run.completed' || event.type === 'run.failed') return true;
  return event.type === 'run.status' && typeof event.data.status === 'string' && RESTING_STATUSES.has(event.data.status);
}
