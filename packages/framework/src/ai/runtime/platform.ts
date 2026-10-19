// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto';
import type { ApplicationContext } from '../../runtime/container';
import { HttpError } from '../../runtime/http';
import type { Logger } from '../../runtime/logger';
import {
  TERMINAL_STATUSES,
  RunConflictError,
  type AgentBehavior,
  type AgentDefinition,
  type AgentInfo,
  type AgentPlatform,
  type ChatMessage,
  type ConversationStore,
  type JsonValue,
  type RunEvent,
  type RunRecord,
  type RunStore,
  type StartRunRequest,
  type Thread,
  type ToolCallOutcome,
  type ToolDefinition,
  type UiPart,
} from '../types';
import { memorySubject } from './agent-loop';
import type { RunEventHub } from './event-hub';
import { RunJournal } from './journal';
import { sealMessages } from './messages';
import type { AgentRunner } from './runner';
import type { MemoryService } from './services';
import type { AiSettings } from './settings';
import { boundOutput, toolFailure, ToolInputError, type ToolCatalog } from './tools';
import { KeyedMutex } from '../stores/file-run-store';

export interface PlatformDeps {
  readonly context: ApplicationContext;
  readonly runs: RunStore;
  readonly conversations: ConversationStore;
  readonly hub: RunEventHub;
  readonly catalog: ToolCatalog;
  readonly agents: ReadonlyMap<string, AgentDefinition>;
  readonly runner: AgentRunner;
  readonly memory: () => MemoryService;
  readonly settings: AiSettings;
  readonly logger: Logger;
}

const now = (): string => new Date().toISOString();
const ENDS_STREAM: ReadonlySet<string> = new Set(['run.completed', 'run.failed']);

/** The run has nothing more to stream right now (finished, or waiting for a person). */
function endsLiveStream(e: RunEvent): boolean {
  if (ENDS_STREAM.has(e.type)) return true;
  const status = e.type === 'run.status' ? (e.data as { status?: string }).status : undefined;
  return status === 'cancelled' || status === 'awaiting_approval' || status === 'completed' || status === 'failed';
}

/**
 * Default AgentPlatform (Facade): starts runs, streams their events, takes approval decisions
 * and cancellations, and calls tools directly for MCP. Every protocol goes through it, so rules
 * like "one active run per thread" hold everywhere.
 */
export class DefaultAgentPlatform implements AgentPlatform {
  private readonly threadLocks = new KeyedMutex();
  constructor(private readonly deps: PlatformDeps) {}

  agents(): AgentInfo[] {
    return [...this.deps.agents.values()]
      .filter((a) => this.deps.context.isEnabled(a.beanId))
      .map((a) => ({ name: a.name, description: a.description, tools: a.tools, examples: a.examples }));
  }

  agent(name: string): AgentDefinition | undefined {
    const def = this.deps.agents.get(name);
    return def && this.deps.context.isEnabled(def.beanId) ? def : undefined;
  }

  tool(name: string): ToolDefinition | undefined {
    const def = this.deps.catalog.definition(name);
    return def && this.deps.context.isEnabled(def.beanId) ? def : undefined;
  }

  tools(): ToolDefinition[] {
    return this.deps.catalog.all().filter((t) => this.deps.context.isEnabled(t.beanId));
  }

  async callTool(name: string, input: unknown, options: { principal?: JsonValue; owner: string; signal?: AbortSignal }): Promise<ToolCallOutcome> {
    const tool = this.deps.catalog.beanTool(name);
    if (!tool) throw new HttpError(404, `No tool named '${name}'`);
    let clean: unknown;
    try {
      clean = tool.validate(input);
    } catch (err) {
      if (err instanceof ToolInputError) throw new HttpError(400, 'Invalid tool arguments', { error: 'Invalid tool arguments', details: err.details });
      throw err;
    }
    const ui: UiPart[] = [];
    const signal = options.signal ?? new AbortController().signal;
    const memory = this.deps.memory().for(memorySubject({ principal: options.principal, owner: options.owner }));
    try {
      const output = await tool.run(clean, {
        runId: `direct-${randomUUID()}`,
        callId: `call_${randomUUID()}`,
        threadId: '',
        agent: '',
        principal: options.principal,
        signal,
        memory,
        emitUi: (p) => ui.push(p),
        ui: (component, props) => ui.push({ type: 'ui', id: randomUUID(), component, props }),
        progress: () => undefined,
        step: async (_key, fn) => fn(),
      });
      return { output: boundOutput(output, this.deps.settings.maxToolOutputChars), isError: false, ui };
    } catch (err) {
      return { output: toolFailure(err, name, this.deps.settings.production, this.deps.logger), isError: true, ui };
    }
  }

  async startRun(request: StartRunRequest): Promise<RunRecord> {
    const { runs, conversations, settings } = this.deps;
    const def = this.agent(request.agent);
    if (!def) throw new HttpError(404, `No agent named '${request.agent}'`);
    const input = request.input.trim();
    if (!input) throw new HttpError(400, 'input must not be empty');
    if (input.length > settings.maxInputLength) throw new HttpError(413, `input is longer than ${settings.maxInputLength} characters`);

    const busyError = (busy: RunRecord): HttpError =>
      new HttpError(409, busy.status === 'awaiting_approval' ? 'This conversation is waiting for an approval decision; approve, decline or cancel first.' : 'This conversation is already working on a request.', {
        error: 'busy',
        runId: busy.id,
        status: busy.status,
      });
    let thread: Thread | undefined;
    if (request.threadId) {
      thread = await conversations.getThread(request.threadId);
      if (!thread || thread.owner !== request.owner || thread.agent !== def.name) throw new HttpError(404, 'Conversation not found');
      const busy = (await runs.listByThread(thread.id)).find((r) => !TERMINAL_STATUSES.has(r.status));
      if (busy) throw busyError(busy);
    } else {
      thread = await conversations.createThread({ owner: request.owner, agent: def.name, title: input.replace(/\s+/g, ' ').slice(0, 80) });
    }

    const id = randomUUID();
    const run: RunRecord = {
      id,
      agent: def.name,
      threadId: thread.id,
      owner: request.owner,
      status: 'queued',
      input,
      principal: request.principal,
      createdAt: now(),
      updatedAt: now(),
      turns: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
      ...(request.metadata ? { metadata: request.metadata } : {}),
    };
    // Two requests for one conversation at once (a double click, two tabs): only one run may start.
    // The check above answers most of them early; this one is atomic.
    const busy = await this.threadLocks.run(thread.id, async () => {
      if (runs.createIfIdle) return runs.createIfIdle(run);
      const active = (await runs.listByThread(run.threadId)).find((r) => !TERMINAL_STATUSES.has(r.status));
      if (active) return active;
      await runs.create(run);
      return undefined;
    });
    if (busy) throw busyError(busy);
    // Written after the run exists, so a refused request leaves nothing in the conversation. A worker
    // that claims the run before this lands adds the input itself (see AgentLoop).
    await conversations.appendMessages(thread.id, [{ role: 'user', content: [{ type: 'text', text: input }], runId: id }]);
    const journal = await RunJournal.open(id, runs, this.deps.hub, this.deps.logger);
    journal.emit('run.status', { status: 'queued', runId: id, threadId: thread.id });
    await journal.flush();
    this.deps.runner.wake();
    return run;
  }

  getRun(id: string): Promise<RunRecord | undefined> {
    return this.deps.runs.get(id);
  }

  /**
   * Replays stored events after `afterSeq`, then follows the run live: from this process's event
   * hub when it executes here, otherwise by polling the store (another worker runs it). Ends when
   * the run finishes or pauses for approval.
   */
  async *subscribe(runId: string, afterSeq: number, signal?: AbortSignal): AsyncGenerator<RunEvent> {
    const { runs, hub } = this.deps;
    if (!(await runs.get(runId))) return;
    const queue: RunEvent[] = [];
    let wake: (() => void) | undefined;
    const unsubscribe = hub.subscribe(runId, (e) => {
      queue.push(e);
      wake?.();
    });
    const onAbort = (): void => wake?.();
    signal?.addEventListener('abort', onAbort);
    let last = afterSeq;
    try {
      for (const e of await runs.events(runId, last)) {
        yield e;
        last = e.seq;
        if (ENDS_STREAM.has(e.type) || (e.type === 'run.status' && (e.data as { status?: string }).status === 'cancelled')) return;
      }
      for (const e of hub.recentEvents(runId, last)) {
        yield e;
        last = e.seq;
        if (ENDS_STREAM.has(e.type)) return;
      }
      const current = await runs.get(runId);
      if (!current || TERMINAL_STATUSES.has(current.status) || current.status === 'awaiting_approval') {
        // Finished (or paused) while we replayed: send what arrived meanwhile, then end.
        const live = queue.splice(0);
        const stored = await runs.events(runId, last);
        const rest = [...stored, ...live.filter((e) => !stored.some((s) => s.seq === e.seq))].sort((a, b) => a.seq - b.seq);
        for (const e of rest) {
          if (e.seq <= last) continue;
          yield e;
          last = e.seq;
        }
        return;
      }

      while (!signal?.aborted) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve;
            const t = setTimeout(resolve, 1000);
            t.unref?.();
          });
          wake = undefined;
        }
        if (signal?.aborted) return;
        let batch = queue.splice(0);
        if (batch.length === 0 && !this.deps.runner.isActive(runId)) {
          // Executed by another process: poll the stored (durable) events.
          batch = await runs.events(runId, last);
          if (batch.length === 0) {
            const run = await runs.get(runId);
            if (!run || TERMINAL_STATUSES.has(run.status) || run.status === 'awaiting_approval') return;
          }
        }
        for (const e of batch) {
          if (e.seq <= last) continue;
          yield e;
          last = e.seq;
          if (endsLiveStream(e)) return;
        }
      }
    } finally {
      unsubscribe();
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async decide(runId: string, callId: string, decision: { approved: boolean; note?: string }): Promise<RunRecord> {
    const { runs } = this.deps;
    // Read, check, then compare-and-set: a concurrent approve, decline or cancel of the same run
    // makes the write fail, and the decision is re-checked against the new state.
    for (let attempt = 0; ; attempt++) {
      const run = await runs.get(runId);
      if (!run) throw new HttpError(404, 'Run not found');
      if (run.status !== 'awaiting_approval') throw new HttpError(409, `The run is ${run.status.replace('_', ' ')}, not waiting for approval`);
      const pending = run.pending ?? [];
      const item = pending.find((p) => p.callId === callId);
      if (!item) throw new HttpError(404, 'No such pending approval');
      if (item.decision) throw new HttpError(409, 'This action was already decided');
      const note = decision.note?.slice(0, 1000);
      const updated = pending.map((p) => (p.callId === callId ? { ...p, decision: { approved: decision.approved, ...(note ? { note } : {}), decidedAt: now() } } : p));
      const allDecided = updated.every((p) => p.decision);
      let next: RunRecord;
      try {
        // Record the decision; the run stays paused (no worker can claim it) until its events are saved.
        next = await runs.update(runId, { pending: updated }, { status: ['awaiting_approval'], revision: run.revision ?? 0 });
      } catch (err) {
        if (err instanceof RunConflictError) {
          if (attempt < 5) continue;
          throw new HttpError(409, 'The run changed at the same time; try again');
        }
        throw err;
      }
      const journal = await RunJournal.open(runId, runs, this.deps.hub, this.deps.logger);
      journal.emit('progress', { message: decision.approved ? `Approved: ${item.tool.replace(/_/g, ' ')}` : `Declined: ${item.tool.replace(/_/g, ' ')}` });
      if (allDecided) journal.emit('run.status', { status: 'queued' });
      await journal.flush();
      if (allDecided) {
        // Only now may a worker (on any process) claim the run and continue its event numbering.
        try {
          next = await runs.update(runId, { status: 'queued', workerId: undefined }, { status: ['awaiting_approval'], revision: next.revision ?? 0 });
        } catch (err) {
          if (!(err instanceof RunConflictError)) throw err;
          return (await runs.get(runId)) ?? next; // cancelled meanwhile: the cancellation wins
        }
        this.deps.runner.wake();
      }
      return next;
    }
  }

  async cancel(runId: string): Promise<RunRecord> {
    const { runs, conversations, hub, logger } = this.deps;
    for (let attempt = 0; ; attempt++) {
      const run = await runs.get(runId);
      if (!run) throw new HttpError(404, 'Run not found');
      if (TERMINAL_STATUSES.has(run.status)) return run;
      if (this.deps.runner.cancel(runId)) return run; // executing here: the loop records it
      if (run.status === 'running') return runs.update(runId, { cancelRequested: true }); // executing on another worker
      // Queued or waiting for approval: nobody executes it, so cancel it here, but only if it is
      // still in that state (an approval or a worker may have taken it meanwhile).
      let cancelled: RunRecord;
      try {
        cancelled = await runs.update(
          runId,
          { status: 'cancelled', checkpoint: [], pending: [], finishedAt: now(), cancelRequested: true },
          { status: ['queued', 'awaiting_approval'], revision: run.revision ?? 0 },
        );
      } catch (err) {
        if (err instanceof RunConflictError) {
          if (attempt < 5) continue;
          throw new HttpError(409, 'The run changed at the same time; try again');
        }
        throw err;
      }
      const sealed = sealMessages(run.checkpoint ?? [], 'Cancelled by the person');
      if (sealed.length > 0) await conversations.appendMessages(run.threadId, sealed.map((m: ChatMessage) => ({ ...m, runId })));
      const journal = await RunJournal.open(runId, runs, hub, logger);
      journal.emit('run.status', { status: 'cancelled' });
      await journal.flush();
      const def = this.deps.agents.get(run.agent);
      if (def) {
        try {
          await this.deps.context.get<AgentBehavior>(def.beanId).onRunFinished?.(cancelled);
        } catch (err) {
          logger.error('onRunFinished failed', { runId, err });
        }
      }
      return cancelled;
    }
  }

  async thread(id: string): Promise<{ thread: Thread; messages: ChatMessage[] } | undefined> {
    const thread = await this.deps.conversations.getThread(id);
    if (!thread) return undefined;
    return { thread, messages: await this.deps.conversations.getMessages(id) };
  }

  /** Sequence number of the run's last durable event (0 when none). */
  async lastSeq(runId: string): Promise<number> {
    const live = this.deps.hub.recentEvents(runId, 0).filter((e) => Number.isInteger(e.seq));
    if (live.length) return live[live.length - 1].seq;
    const stored = await this.deps.runs.events(runId, 0);
    return stored.length ? stored[stored.length - 1].seq : 0;
  }

  /** Runs of a thread, oldest first. */
  async runs(threadId: string): Promise<RunRecord[]> {
    return (await this.deps.runs.listByThread(threadId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  threads(owner: string, agent?: string): Promise<Thread[]> {
    return this.deps.conversations.listThreads(owner, { agent, limit: 50 });
  }
}
