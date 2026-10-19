// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import type { Logger } from '../../runtime/logger';
import type { RunEvent, RunEventType, RunStore } from '../types';
import type { RunEventHub } from './event-hub';

/** Events that are only streamed live, never stored. */
const LIVE_ONLY: ReadonlySet<RunEventType> = new Set(['message.delta']);

/**
 * Numbers, publishes and stores the events of one run.
 *
 * Durable events get integer sequence numbers and are appended to the RunStore in order.
 * Token deltas are live-only and numbered between durable events (5.000001, 5.000002, ...):
 * a client that reconnects with Last-Event-ID 5.000002 is sent every durable event after 5,
 * including the `message.completed` that carries the full text.
 */
export class RunJournal {
  private seq: number;
  private deltaCount = 0;
  private chain: Promise<void> = Promise.resolve();

  private constructor(
    private readonly runId: string,
    private readonly store: RunStore,
    private readonly hub: RunEventHub,
    private readonly logger: Logger,
    lastSeq: number,
  ) {
    this.seq = Math.floor(lastSeq);
  }

  /** Continues the numbering of an existing run (after a restart, or on another worker). */
  static async open(runId: string, store: RunStore, hub: RunEventHub, logger: Logger): Promise<RunJournal> {
    // This worker's hub only knows the events it saw itself. With several workers another one may have
    // written later events (for example, before an approval handed the run to this worker), so continue
    // after whichever is higher: the hub's last number or the store's.
    const recent = hub.recentEvents(runId, 0);
    const seen = recent.length ? recent[recent.length - 1].seq : 0;
    const newer = await store.events(runId, seen);
    let last = seen;
    for (const e of newer) if (e.seq > last) last = e.seq;
    return new RunJournal(runId, store, hub, logger, last);
  }

  /**
   * Stores a durable event without announcing it yet; call `publish()` once the run's record reflects it.
   * Used for final events, so a client that sees the final status can always also read the final event.
   */
  async record(type: RunEventType, data: Record<string, unknown>): Promise<RunEvent> {
    this.deltaCount = 0;
    const event: RunEvent = { seq: ++this.seq, runId: this.runId, type, data, at: new Date().toISOString() };
    this.chain = this.chain
      .then(() => this.store.appendEvents(this.runId, [event]))
      .catch((err) => this.logger.error('Failed to store a run event', { runId: this.runId, type, err }));
    await this.chain;
    return event;
  }

  /** Announces an event stored with `record()` to live subscribers. */
  publish(event: RunEvent): void {
    this.hub.publish(event);
  }

  emit(type: RunEventType, data: Record<string, unknown>): RunEvent {
    const live = LIVE_ONLY.has(type);
    let seq: number;
    if (live) {
      this.deltaCount = Math.min(this.deltaCount + 1, 999_999);
      seq = this.seq + this.deltaCount / 1_000_000;
    } else {
      this.deltaCount = 0;
      seq = ++this.seq;
    }
    const event: RunEvent = { seq, runId: this.runId, type, data, at: new Date().toISOString() };
    this.hub.publish(event);
    if (!live) {
      this.chain = this.chain
        .then(() => this.store.appendEvents(this.runId, [event]))
        .catch((err) => this.logger.error('Failed to store a run event', { runId: this.runId, type, err }));
    }
    return event;
  }

  /** Waits until every durable event so far is stored. */
  flush(): Promise<void> {
    return this.chain;
  }
}
