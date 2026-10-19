// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto';
import type { ApplicationContext } from '../../runtime/container';
import { HttpError } from '../../runtime/http';
import type { Logger } from '../../runtime/logger';
import {
  RunConflictError,
  ModelError,
  type AgentBehavior,
  type AgentDefinition,
  type AgentMemory,
  type ChatMessage,
  type ChatModel,
  type ConversationStore,
  type JsonValue,
  type MemoryItem,
  type PendingApproval,
  type RunRecord,
  type RunStore,
  type ToolCallPart,
  type ToolResultPart,
  type UiComponentDefinition,
  type UiPart,
  type Usage,
} from '../types';
import type { RunEventHub } from './event-hub';
import { RunJournal } from './journal';
import { recentHistory, sealMessages, unansweredCalls } from './messages';
import type { MemoryService } from './services';
import type { AiSettings } from './settings';
import { boundOutput, toolFailure, ToolInputError, type ExecutableTool, type ToolCatalog, type ToolRuntimeContext } from './tools';

/** Why a run's execution was interrupted. */
/** Why a run stops early: cancelled, server shutting down, or taken over by another worker ('lost'). */
export type StopReason = 'cancel' | 'shutdown' | 'lost';

export interface AgentLoopDeps {
  readonly context: ApplicationContext;
  readonly runs: RunStore;
  readonly conversations: ConversationStore;
  readonly hub: RunEventHub;
  readonly model: () => ChatModel;
  readonly memory: () => MemoryService;
  readonly catalog: ToolCatalog;
  readonly agents: ReadonlyMap<string, AgentDefinition>;
  readonly components: ReadonlyMap<string, UiComponentDefinition>;
  readonly settings: AiSettings;
  readonly logger: Logger;
}

const STARTED = (callId: string): string => `__started:${callId}`;
const now = (): string => new Date().toISOString();

/** Runs started by other agents (MCP, A2A) have no screen: generative UI is skipped, the model gets the data. */
export function isHeadless(principal: JsonValue | undefined): boolean {
  return !!principal && typeof principal === 'object' && !Array.isArray(principal) && (principal.channel === 'mcp' || principal.channel === 'a2a');
}

/** Memory is about a person, shared by the app's agents: keyed by the principal, else the owner. */
export function memorySubject(run: Pick<RunRecord, 'principal' | 'owner'>): string {
  const p = run.principal;
  if (typeof p === 'string' || typeof p === 'number') return `principal:${p}`;
  if (p && typeof p === 'object' && !Array.isArray(p) && (typeof p.id === 'string' || typeof p.id === 'number')) return `principal:${p.id}`;
  return `owner:${run.owner}`;
}

/**
 * Executes one run to its next stop: completion, failure, a pause for approval, cancellation or
 * shutdown (Template Method: the agent class supplies instructions and optional hooks).
 *
 * Every model turn and every tool result is checkpointed to the RunStore, so a run interrupted by
 * a crash or a deploy is resumed by another worker from its last step. Tools with side effects
 * that were started but never finished are not repeated automatically: the model is told and
 * asks the person, unless the tool used ctx.step() to make its side effect idempotent.
 */
export class AgentLoop {
  constructor(private readonly deps: AgentLoopDeps) {}

  async execute(claimed: RunRecord, signal: AbortSignal): Promise<RunRecord> {
    const { logger } = this.deps;
    // Every write below requires that this worker still holds the run: if it stalled and another
    // worker took the run over, the write fails (RunConflictError) and this worker stops quietly.
    const runs = ownedBy(this.deps.runs, claimed.workerId);
    const journal = await RunJournal.open(claimed.id, runs, this.deps.hub, logger);
    let run = claimed;
    let checkpoint: ChatMessage[] = [...(run.checkpoint ?? [])];
    try {
      if (signal.aborted) throw new StopSignal(stopReasonOf(signal));
      const def = this.deps.agents.get(run.agent);
      if (!def) throw new Error(`Unknown agent '${run.agent}'`);
      const behavior = this.deps.context.get<AgentBehavior>(def.beanId);
      if (!run.startedAt) run = await runs.update(run.id, { startedAt: now() });
      journal.emit('run.status', { status: 'running', runId: run.id, threadId: run.threadId });

      const memory = this.deps.memory().for(memorySubject(run));
      const memories: MemoryItem[] = def.recall > 0 ? await memory.recall(run.input, { limit: def.recall, minScore: 0.25 }).catch(() => []) : [];
      const tools = this.deps.catalog.forAgent(def);
      if (isHeadless(run.principal)) for (const name of [...tools.keys()]) if (name.startsWith('show_')) tools.delete(name);
      const system = await this.systemPrompt(def, behavior, run, memories, tools);
      const history = recentHistory(await this.deps.conversations.getMessages(run.threadId, { limit: this.deps.settings.historyLimit * 2 }), this.deps.settings.historyLimit);
      // startRun writes the person's message just after creating the run: a worker that claimed the
      // run in between adds it here.
      if (!history.some((m) => m.role === 'user' && m.runId === run.id)) history.push({ role: 'user', content: [{ type: 'text', text: run.input }], runId: run.id });
      const steps: Record<string, JsonValue> = { ...(run.steps ?? {}) };
      let usage: Usage = run.usage;
      let turns = run.turns;
      let lastText = '';

      const save = async (patch: Partial<RunRecord> = {}): Promise<void> => {
        run = await runs.update(run.id, { checkpoint, steps, usage, turns, heartbeatAt: now(), ...patch });
      };

      for (;;) {
        if (signal.aborted) throw new StopSignal(stopReasonOf(signal));

        // 1. Answer tool calls of the last model turn (also after a resume or an approval).
        const open = unansweredCalls(checkpoint);
        if (open.length > 0) {
          const outcome = await this.answer(open, { run, def, behavior, tools, memory, steps, journal, signal, save });
          if (outcome.results.length > 0) {
            checkpoint.push({ role: 'tool', content: [...outcome.results, ...outcome.ui] });
          }
          if (outcome.pending.length > 0) {
            const fresh = outcome.pending.filter((p) => !run.pending?.some((o) => o.callId === p.callId));
            await save({ status: 'awaiting_approval', pending: outcome.pending, workerId: undefined });
            for (const p of fresh) {
              journal.emit('approval.required', { callId: p.callId, tool: p.tool, input: p.input as JsonValue, reason: p.reason ?? null });
            }
            journal.emit('run.status', { status: 'awaiting_approval' });
            await journal.flush();
            return run;
          }
          await save({ pending: [] });
          continue;
        }

        // 2. Ask the model.
        const maxTurns = def.maxTurns ?? this.deps.settings.maxTurns;
        if (turns >= maxTurns) {
          throw new RunFailure(`The agent stopped after ${maxTurns} steps without finishing. Try a more specific request.`, 'max_turns');
        }
        const model = this.deps.model();
        let text = '';
        const calls: ToolCallPart[] = [];
        let finish = 'stop';
        for await (const ev of model.stream({
          system,
          messages: [...history, ...checkpoint],
          tools: [...tools.values()].map((t) => t.spec),
          model: def.model,
          signal,
        })) {
          if (ev.type === 'text') {
            text += ev.delta;
            journal.emit('message.delta', { text: ev.delta });
          } else if (ev.type === 'tool_call') {
            calls.push({ type: 'tool_call', id: ev.id || `call_${randomUUID()}`, name: ev.name, input: ev.input });
          } else if (ev.type === 'usage') {
            usage = { inputTokens: usage.inputTokens + ev.inputTokens, outputTokens: usage.outputTokens + ev.outputTokens };
          } else if (ev.type === 'finish') {
            finish = ev.reason;
          }
        }
        if (signal.aborted) throw new StopSignal(stopReasonOf(signal));
        turns++;
        const content: ChatMessage['content'] = [...(text ? [{ type: 'text' as const, text }] : []), ...calls];
        if (content.length > 0) checkpoint.push({ role: 'assistant', content });
        if (text) {
          lastText = text;
          journal.emit('message.completed', { text });
        }
        await save();
        if (calls.length > 0) continue;
        if (finish === 'refusal' && !text) throw new RunFailure('The model declined to answer this request.', 'refusal');

        // 3. Done.
        return await this.complete(runs, run, checkpoint, lastText || text, usage, journal, behavior);
      }
    } catch (caught) {
      // Aborting makes the model client (or a tool) throw its own error, such as an AbortError from fetch:
      // once the signal has fired, that is a stop (cancel, shutdown or takeover), not a failure.
      const err = signal.aborted && !(caught instanceof StopSignal) && !(caught instanceof RunConflictError) ? new StopSignal(stopReasonOf(signal)) : caught;
      try {
        return await this.stop(runs, run, checkpoint, err, journal);
      } catch (stopErr) {
        if (!(stopErr instanceof RunConflictError)) throw stopErr;
        // Another worker took this run over (this one missed its heartbeats): leave it to that worker.
        logger.warn('Run was taken over by another worker; stopping here without writing', { runId: run.id });
        return (await this.deps.runs.get(run.id)) ?? run;
      }
    }
  }

  private async systemPrompt(def: AgentDefinition, behavior: AgentBehavior, run: RunRecord, memories: MemoryItem[], tools: Map<string, ExecutableTool>): Promise<string> {
    const parts = [String(await behavior.instructions({ run, principal: run.principal, memories, now: new Date() })).trim()];
    if (memories.length > 0) {
      parts.push(`What you remember about this person (use when relevant; never invent memories):\n${memories.map((m) => `- ${m.text}`).join('\n')}`);
    }
    if ([...tools.keys()].some((n) => n.startsWith('show_'))) {
      parts.push('When information is easier to take in visually (options, comparisons, summaries, forms), show it with a show_* tool, then add a short sentence instead of repeating what the component shows.');
    }
    if ([...tools.values()].some((t) => t.approval)) {
      parts.push('Some actions need the person\'s approval before they run; the system asks them for you. If they decline, acknowledge it and don\'t retry unless they ask.');
    }
    return parts.filter(Boolean).join('\n\n');
  }

  /** Runs (or pauses for approval) the given tool calls, in order. */
  private async answer(
    calls: ToolCallPart[],
    env: {
      run: RunRecord;
      def: AgentDefinition;
      behavior: AgentBehavior;
      tools: Map<string, ExecutableTool>;
      memory: AgentMemory;
      steps: Record<string, JsonValue>;
      journal: RunJournal;
      signal: AbortSignal;
      save: (patch?: Partial<RunRecord>) => Promise<void>;
    },
  ): Promise<{ results: ToolResultPart[]; ui: UiPart[]; pending: PendingApproval[] }> {
    const results: ToolResultPart[] = [];
    const ui: UiPart[] = [];
    const pending: PendingApproval[] = [];
    for (const call of calls) {
      if (env.signal.aborted) throw new StopSignal(stopReasonOf(env.signal));
      const tool = env.tools.get(call.name);
      const result = (output: unknown, isError = false): ToolResultPart => ({ type: 'tool_result', callId: call.id, name: call.name, output: boundOutput(output, this.deps.settings.maxToolOutputChars), isError });
      if (!tool) {
        results.push(result({ error: `There is no tool named '${call.name}'. Available: ${[...env.tools.keys()].join(', ') || 'none'}` }, true));
        continue;
      }
      const isUi = call.name.startsWith('show_');
      if (env.steps[STARTED(call.id)] === true && !tool.readOnly && !tool.idempotent) {
        // Started before a crash or deploy and never finished: don't repeat a side effect blindly.
        // (Idempotent tools are simply run again; their completed ctx.step() calls are replayed.)
        results.push(result({ error: 'This action was interrupted by a server restart and may or may not have completed. Check its effect, or ask the person before trying again.' }, true));
        env.journal.emit('tool.completed', { callId: call.id, tool: call.name, output: null, isError: true });
        continue;
      }
      if (tool.approval) {
        const prior = env.run.pending?.find((p) => p.callId === call.id);
        if (!prior?.decision) {
          let input: unknown = call.input;
          try {
            input = tool.validate(call.input);
          } catch (err) {
            if (err instanceof ToolInputError) {
              results.push(result({ error: err.message, details: err.details }, true));
              continue;
            }
            throw err;
          }
          // Guardrails run before a person is asked: never ask to approve something that would be refused.
          if (!prior && env.def.hooks.beforeToolCall && env.behavior.beforeToolCall) {
            const refusal = await env.behavior.beforeToolCall({ tool: call.name, input, ctx: this.toolContext(call, env, []) });
            if (refusal) {
              results.push(result({ error: refusal }, true));
              env.journal.emit('tool.started', { callId: call.id, tool: call.name, input: input as JsonValue });
              env.journal.emit('tool.completed', { callId: call.id, tool: call.name, output: { error: refusal }, isError: true });
              continue;
            }
          }
          pending.push(prior ?? { callId: call.id, tool: call.name, input, reason: describeApproval(call.name), requestedAt: now() });
          continue;
        }
        if (!prior.decision.approved) {
          results.push(result({ error: 'The person declined this action.', note: prior.decision.note ?? null }, true));
          env.journal.emit('tool.completed', { callId: call.id, tool: call.name, output: { declined: true }, isError: true });
          continue;
        }
      }
      if (!isUi) env.journal.emit('tool.started', { callId: call.id, tool: call.name, input: call.input as JsonValue });
      const out = await this.invoke(tool, call, env, ui);
      results.push(result(out.output, out.isError));
      if (!isUi) env.journal.emit('tool.completed', { callId: call.id, tool: call.name, output: results[results.length - 1].output as JsonValue, isError: out.isError });
    }
    return { results, ui, pending };
  }

  private async invoke(
    tool: ExecutableTool,
    call: ToolCallPart,
    env: { run: RunRecord; def: AgentDefinition; behavior: AgentBehavior; memory: AgentMemory; steps: Record<string, JsonValue>; journal: RunJournal; signal: AbortSignal; save: (patch?: Partial<RunRecord>) => Promise<void> },
    ui: UiPart[],
  ): Promise<{ output: unknown; isError: boolean }> {
    let input: unknown;
    try {
      input = tool.validate(call.input);
    } catch (err) {
      if (err instanceof ToolInputError) return { output: { error: 'Invalid arguments; fix them and call again.', details: err.details }, isError: true };
      throw err;
    }
    const ctx = this.toolContext(call, env, ui);
    if (env.def.hooks.beforeToolCall && env.behavior.beforeToolCall) {
      const refusal = await env.behavior.beforeToolCall({ tool: call.name, input, ctx });
      if (refusal) return { output: { error: refusal }, isError: true };
    }
    if (!tool.readOnly) {
      env.steps[STARTED(call.id)] = true;
      await env.save();
    }
    try {
      const output = await raceAbort(tool.run(input, ctx), env.signal);
      return { output, isError: false };
    } catch (err) {
      if (err instanceof StopSignal) throw err;
      if (env.signal.aborted) throw new StopSignal(stopReasonOf(env.signal));
      if (err instanceof ToolInputError) return { output: { error: err.message, details: err.details }, isError: true };
      return { output: toolFailure(err, call.name, this.deps.settings.production, this.deps.logger, { runId: env.run.id }), isError: true };
    }
  }

  private toolContext(
    call: ToolCallPart,
    env: { run: RunRecord; memory: AgentMemory; steps: Record<string, JsonValue>; journal: RunJournal; signal: AbortSignal; save: (patch?: Partial<RunRecord>) => Promise<void> },
    ui: UiPart[],
  ): ToolRuntimeContext {
    const headless = isHeadless(env.run.principal);
    const emitUi = (part: UiPart): void => {
      if (headless) return;
      ui.push(part);
      env.journal.emit('ui', { id: part.id, component: part.component, props: part.props as Record<string, JsonValue> });
    };
    return {
      runId: env.run.id,
      callId: call.id,
      threadId: env.run.threadId,
      agent: env.run.agent,
      principal: env.run.principal,
      signal: env.signal,
      memory: env.memory,
      emitUi,
      ui: (component, props) => {
        const def = this.deps.components.get(component);
        if (!def) throw new Error(`ctx.ui('${component}'): no @generative island named '${component}' in src/islands/`);
        let clean: unknown;
        try {
          clean = def.validate(props);
        } catch (err) {
          const details = err instanceof HttpError ? JSON.stringify((err.body as { details?: unknown })?.details) : String(err);
          throw new Error(`ctx.ui('${component}'): props don't match the component's props type: ${details}`);
        }
        emitUi({ type: 'ui', id: randomUUID(), component, props: clean as Record<string, unknown> });
      },
      progress: (message) => void env.journal.emit('progress', { message: String(message).slice(0, 500) }),
      step: async <T extends JsonValue>(key: string, fn: () => Promise<T> | T): Promise<T> => {
        const k = `${call.id}:${key}`;
        if (k in env.steps) return env.steps[k] as T;
        const value = await fn();
        env.steps[k] = (value === undefined ? null : value) as JsonValue;
        await env.save();
        return value;
      },
    };
  }

  private async complete(runs: RunStore, run: RunRecord, checkpoint: ChatMessage[], output: string, usage: Usage, journal: RunJournal, behavior: AgentBehavior): Promise<RunRecord> {
    await this.deps.conversations.appendMessages(run.threadId, checkpoint.map((m) => ({ ...m, runId: run.id })));
    // The final event is stored before the status changes and announced after it, so whoever sees
    // 'completed' can read run.completed, and whoever receives run.completed sees 'completed'.
    const event = await journal.record('run.completed', { output, usage: { ...usage } });
    const done = await runs.update(run.id, { status: 'completed', output, usage, checkpoint: [], pending: [], finishedAt: now(), workerId: undefined });
    journal.publish(event);
    await this.finished(done, behavior);
    return done;
  }

  /** Cancellation, shutdown or failure. */
  private async stop(runs: RunStore, run: RunRecord, checkpoint: ChatMessage[], err: unknown, journal: RunJournal): Promise<RunRecord> {
    const { logger, settings } = this.deps;
    // Taken over by another worker: write nothing (see execute()).
    if (err instanceof RunConflictError || (err instanceof StopSignal && err.reason === 'lost')) throw new RunConflictError(run.id);
    if (err instanceof StopSignal && err.reason === 'shutdown') {
      // Hand the run back to the queue: another worker (or this one after restart) resumes it.
      const released = await runs.update(run.id, { status: 'queued', workerId: undefined, checkpoint });
      await journal.flush();
      return released;
    }
    const cancelled = err instanceof StopSignal;
    const failure = err instanceof RunFailure ? err : undefined;
    if (!cancelled && !failure) logger.error('Agent run failed', { runId: run.id, agent: run.agent, err });
    const message = cancelled
      ? 'Cancelled'
      : failure
        ? failure.message
        : err instanceof ModelError
          ? settings.production
            ? 'The AI service is unavailable right now. Please try again.'
            : err.message
          : settings.production
            ? 'Something went wrong while working on this. Please try again.'
            : err instanceof Error
              ? err.message
              : String(err);
    try {
      const sealed = sealMessages(checkpoint, cancelled ? 'Cancelled by the person' : 'The run failed before this finished');
      if (sealed.length > 0) await this.deps.conversations.appendMessages(run.threadId, sealed.map((m) => ({ ...m, runId: run.id })));
    } catch (e) {
      logger.error('Failed to save the transcript of a stopped run', { runId: run.id, err: e });
    }
    const status = cancelled ? 'cancelled' : 'failed';
    const event = cancelled ? await journal.record('run.status', { status: 'cancelled' }) : await journal.record('run.failed', { error: message });
    const final = await runs.update(run.id, {
      status,
      checkpoint: [],
      pending: [],
      finishedAt: now(),
      workerId: undefined,
      ...(cancelled ? {} : { error: { message, code: failure?.code ?? (err instanceof ModelError ? 'model_error' : 'error') } }),
    });
    journal.publish(event);
    const def = this.deps.agents.get(run.agent);
    if (def) await this.finished(final, this.deps.context.get<AgentBehavior>(def.beanId));
    return final;
  }

  private async finished(run: RunRecord, behavior: AgentBehavior): Promise<void> {
    try {
      await behavior.onRunFinished?.(run);
    } catch (err) {
      this.deps.logger.error('onRunFinished failed', { runId: run.id, err });
    }
  }
}

/** Thrown inside the loop when the run is cancelled or the process shuts down. */
/** Why a run's signal fired; anything other than the runner's own reasons counts as a cancel. */
export function stopReasonOf(signal: AbortSignal): StopReason {
  const r = signal.reason;
  return r === 'shutdown' || r === 'lost' || r === 'cancel' ? r : 'cancel';
}

export class StopSignal extends Error {
  constructor(readonly reason: StopReason) {
    super(reason);
  }
}

/** An expected failure with a message for the person. */
export class RunFailure extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

function describeApproval(tool: string): string {
  return `The agent wants to run "${tool.replace(/_/g, ' ')}".`;
}

function raceAbort<T>(work: Promise<T> | T, signal: AbortSignal): Promise<T> {
  if (!(work instanceof Promise)) return Promise.resolve(work);
  if (signal.aborted) return Promise.reject(new StopSignal(stopReasonOf(signal)));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new StopSignal(stopReasonOf(signal)));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/**
 * The run store as seen by the worker executing a run: every update also requires that the run is
 * still held by that worker, so a worker that stalled past its lease can't overwrite the run after
 * another worker took it over.
 */
function ownedBy(store: RunStore, workerId: string | undefined): RunStore {
  if (!workerId) return store;
  return {
    create: (run) => store.create(run),
    get: (id) => store.get(id),
    update: (id, patch, condition) => store.update(id, patch, { ...condition, workerId }),
    listByThread: (threadId) => store.listByThread(threadId),
    appendEvents: (runId, events) => store.appendEvents(runId, events),
    events: (runId, afterSeq) => store.events(runId, afterSeq),
    claim: (id, staleBefore) => store.claim(id, staleBefore),
  };
}
