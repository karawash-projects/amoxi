// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import type { Logger } from '../../runtime/logger';
import { RunConflictError, type RunRecord, type RunStore } from '../types';
import type { AgentLoop, StopReason } from './agent-loop';
import type { AiSettings } from './settings';

/**
 * Background worker that executes agent runs outside HTTP requests, so a run can take minutes
 * (multi-step reasoning, slow tools) with no request timeout.
 *
 * Runs are claimed from the RunStore: queued runs, and running runs whose worker stopped sending
 * heartbeats (crashed or redeployed). With the file store that coordinates the processes of one
 * machine (`amoxi start` runs one per CPU core); with the PostgreSQL store any number of servers
 * share one queue, and instances started with `ai.runs.worker=false` only serve HTTP.
 */
export class AgentRunner {
  private readonly active = new Map<string, { controller: AbortController; done: Promise<unknown> }>();
  private timer?: ReturnType<typeof setInterval>;
  private claiming = false;
  private again = false;
  private stopping = false;

  constructor(
    private readonly deps: { runs: RunStore; loop: AgentLoop; settings: AiSettings; logger: Logger; workerId: string },
  ) {}

  get workerId(): string {
    return this.deps.workerId;
  }

  start(): void {
    if (!this.deps.settings.worker || this.timer) return;
    this.timer = setInterval(() => this.wake(), this.deps.settings.pollMs);
    this.timer.unref?.();
    this.wake(); // resume runs interrupted by the last shutdown
  }

  /** Looks for work now (called when a run is queued or approved). */
  wake(): void {
    if (!this.deps.settings.worker || this.stopping) return;
    if (this.claiming) {
      this.again = true;
      return;
    }
    this.claiming = true;
    void this.fill()
      .catch((err) => this.deps.logger.error('Claiming agent runs failed', { err }))
      .finally(() => {
        this.claiming = false;
        if (this.again) {
          this.again = false;
          this.wake();
        }
      });
  }

  isActive(runId: string): boolean {
    return this.active.has(runId);
  }

  /** Cancels a run executing in this process; returns false if it isn't here. */
  cancel(runId: string): boolean {
    const entry = this.active.get(runId);
    if (!entry) return false;
    entry.controller.abort('cancel' satisfies StopReason);
    return true;
  }

  /** Stops claiming, hands active runs back to the queue (checkpointed) and waits for them. */
  async stop(timeoutMs = 5000): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    for (const { controller } of this.active.values()) controller.abort('shutdown' satisfies StopReason);
    const all = Promise.allSettled([...this.active.values()].map((a) => a.done));
    await Promise.race([all, new Promise((r) => setTimeout(r, timeoutMs).unref?.())]);
  }

  private async fill(): Promise<void> {
    const { runs, settings, workerId } = this.deps;
    while (!this.stopping && this.active.size < settings.concurrency) {
      const staleBefore = new Date(Date.now() - settings.leaseMs).toISOString();
      const run = await runs.claim(workerId, staleBefore);
      if (!run) return;
      if (run.cancelRequested) {
        // Cancelled while nobody held it: let the loop record the cancellation.
        this.launch(run, 'cancel');
        continue;
      }
      this.launch(run);
    }
  }

  private launch(run: RunRecord, abortWith?: StopReason): void {
    const { runs, loop, settings, logger } = this.deps;
    const controller = new AbortController();
    if (abortWith) controller.abort(abortWith);
    const heartbeat = setInterval(() => {
      runs
        // Only while this worker still holds the run (it may have been taken over after a stall).
        .update(run.id, { heartbeatAt: new Date().toISOString() }, { status: ['running'], workerId: run.workerId })
        .then((current) => {
          if (current.cancelRequested && !controller.signal.aborted) controller.abort('cancel' satisfies StopReason);
        })
        .catch((err) => {
          if (err instanceof RunConflictError) {
            // Paused, finished, or taken over by another worker: stop executing here.
            if (!controller.signal.aborted) controller.abort('lost' satisfies StopReason);
            return;
          }
          logger.warn('Run heartbeat failed', { runId: run.id, err });
        });
    }, Math.max(1000, Math.floor(settings.leaseMs / 3)));
    heartbeat.unref?.();
    const done = loop
      .execute(run, controller.signal)
      .catch((err) => logger.error('Agent run crashed', { runId: run.id, err }))
      .finally(() => {
        clearInterval(heartbeat);
        this.active.delete(run.id);
        this.wake();
      });
    this.active.set(run.id, { controller, done });
  }
}
