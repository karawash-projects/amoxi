// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

/**
 * Agent2Agent (A2A) server, JSON-RPC binding, implemented from the specification.
 *
 * Serves two protocol versions on one endpoint, selected by the `A2A-Version` request header
 * (or `?A2A-Version=`): missing/empty means 0.3 (as the spec requires), `1.0` selects v1. The
 * wire differences (method names, enum spellings, `kind` discriminators, stream envelopes) live
 * in two small Dialect strategies; everything else is shared.
 *
 * Mapping to the agent runtime: a Task is a run (Task.id = run id), a context is a thread
 * (contextId = thread id), the final answer is the artifact "answer". A run paused for a person's
 * approval is a task in the input-required state: the client answers it with a message carrying
 * the taskId and "approve"/"deny" (or a data part `{ "approved": true|false }`).
 */

import { randomUUID } from 'node:crypto';
import type { AgentPlatform, JsonValue, RunRecord } from '../types';
import { TERMINAL_STATUSES } from '../types';
import type { ExtensionRoute, RequestContext } from '../../runtime/types';
import { HttpResponse } from '../../runtime/http';
import { eventStream } from '../../runtime/sse';
import {
  anySignal,
  authenticate,
  checkTokens,
  decodeCursor,
  encodeCursor,
  failure,
  header,
  humanize,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  parseMessage,
  requestSignal,
  RpcError,
  sleep,
  success,
  toText,
  type JsonRpcId,
} from './jsonrpc';

export interface A2aOptions {
  /** JSON-RPC endpoint path. Default '/a2a'. */
  readonly path?: string;
  /** Agent card name and description (the whole app as one A2A agent; each Amoxi agent is a skill). */
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly provider?: { readonly organization: string; readonly url: string };
  /** When set, JSON-RPC calls must send `Authorization: Bearer <token>`; the card advertises it. */
  readonly token?: string;
  /**
   * One token per caller (name -> token). A request with one of them is accepted and owned by
   * 'a2a:<name>', so each partner keeps its own tasks and remembered facts.
   */
  readonly callers?: Readonly<Record<string, string>>;
  /** Identity captured for runs (ToolContext.principal). */
  readonly principal?: (ctx: RequestContext) => JsonValue | undefined;
  /**
   * Owner of the threads and runs created over A2A. Default: 'a2a:<name>' for a named caller (see
   * `callers`), otherwise a new owner per conversation, since such callers can't be told apart.
   */
  readonly owner?: (ctx: RequestContext) => string;
  /** Skill (agent name) used when a message names none. Default: the first agent. */
  readonly defaultAgent?: string;
  /** Longest a blocking SendMessage waits for the run to finish or pause. Default 120000 ms. */
  readonly maxWaitMs?: number;
  /**
   * Who may decide actions that need approval (@Tool({ approval: true })) in runs started over A2A.
   * 'decline' (the default without an `owner` hook): nobody over A2A; the action is declined, the agent
   * is told why and finishes. 'wait' (the default with `owner`): the run pauses until the person it
   * belongs to approves it in the app; the A2A caller can't decide. 'caller': the calling agent may
   * approve by replying, so use it only for partners you trust to act for the person.
   */
  readonly approvals?: 'decline' | 'wait' | 'caller';
}

/** Declines approvals an A2A caller can't give, at most this many times per wait. */
const MAX_AUTO_DECLINES = 10;
const DECLINE_NOTE = "This action needs a person's approval, which can't be given over A2A. Tell the user to do it in the app.";

/** A2A error codes (JSON-RPC binding). */
export const A2A_ERRORS = {
  TaskNotFound: -32001,
  TaskNotCancelable: -32002,
  PushNotificationNotSupported: -32003,
  UnsupportedOperation: -32004,
  ContentTypeNotSupported: -32005,
  InvalidAgentResponse: -32006,
  ExtendedAgentCardNotConfigured: -32007,
  ExtensionSupportRequired: -32008,
  VersionNotSupported: -32009,
} as const;

export const A2A_SUPPORTED_VERSIONS: readonly string[] = ['0.3', '1.0'];

const ERROR_REASONS: Readonly<Record<number, string>> = {
  [-32001]: 'TASK_NOT_FOUND',
  [-32002]: 'TASK_NOT_CANCELABLE',
  [-32003]: 'PUSH_NOTIFICATION_NOT_SUPPORTED',
  [-32004]: 'UNSUPPORTED_OPERATION',
  [-32005]: 'CONTENT_TYPE_NOT_SUPPORTED',
  [-32009]: 'VERSION_NOT_SUPPORTED',
};

const ARTIFACT_ID = 'answer';
const MAX_TEXT = 100_000;
const MAX_PARTS = 100;
const MAX_ID = 200;
const MAX_HISTORY = 100;
const LIST_THREAD_LIMIT = 50;
const LIST_RUN_LIMIT = 500;
const INPUT_MODES = ['text/plain', 'application/json'];
const OUTPUT_MODES = ['text/plain'];

/* ------------------------------------------------------------------ */
/* Neutral model (version independent)                                 */
/* ------------------------------------------------------------------ */

type TaskState = 'submitted' | 'working' | 'input-required' | 'completed' | 'failed' | 'canceled';

interface NPart {
  readonly text?: string;
  readonly data?: JsonValue;
}
interface NMessage {
  readonly messageId: string;
  readonly role: 'user' | 'agent';
  readonly parts: readonly NPart[];
  readonly taskId?: string;
  readonly contextId?: string;
}
interface NStatus {
  readonly state: TaskState;
  readonly message?: NMessage;
  readonly timestamp: string;
}
interface NArtifact {
  readonly artifactId: string;
  readonly name?: string;
  readonly parts: readonly NPart[];
}
interface NTask {
  readonly id: string;
  readonly contextId: string;
  readonly status: NStatus;
  readonly artifacts?: readonly NArtifact[];
  readonly history?: readonly NMessage[];
  readonly metadata?: Record<string, JsonValue>;
}

type Operation = 'send' | 'stream' | 'get' | 'list' | 'cancel' | 'subscribe' | 'push' | 'extendedCard';

/* ------------------------------------------------------------------ */
/* Dialects (Strategy): wire encoding per protocol version             */
/* ------------------------------------------------------------------ */

interface Dialect {
  readonly version: '0.3' | '1.0';
  readonly methods: Readonly<Record<string, Operation>>;
  task(t: NTask): Record<string, unknown>;
  sendResult(t: NTask): unknown;
  streamTask(t: NTask): unknown;
  statusUpdate(t: { id: string; contextId: string }, status: NStatus, final: boolean): unknown;
  artifactUpdate(t: { id: string; contextId: string }, artifact: NArtifact, append: boolean, lastChunk: boolean): unknown;
  errorData(code: number, metadata?: Record<string, string>): unknown;
  /** Reads SendMessageConfiguration: wait for the result? */
  blocking(configuration: Record<string, unknown>): boolean;
  pushConfig(configuration: Record<string, unknown>): unknown;
}

/** A2A 0.3: slash method names, kebab-case states, `kind` discriminators, `final` on status events. */
class DialectV03 implements Dialect {
  readonly version = '0.3' as const;
  readonly methods: Readonly<Record<string, Operation>> = {
    'message/send': 'send',
    'message/stream': 'stream',
    'tasks/get': 'get',
    'tasks/cancel': 'cancel',
    'tasks/resubscribe': 'subscribe',
    'tasks/pushNotificationConfig/set': 'push',
    'tasks/pushNotificationConfig/get': 'push',
    'tasks/pushNotificationConfig/list': 'push',
    'tasks/pushNotificationConfig/delete': 'push',
    'agent/getAuthenticatedExtendedCard': 'extendedCard',
  };
  private part(p: NPart): unknown {
    return p.text !== undefined ? { kind: 'text', text: p.text } : { kind: 'data', data: p.data ?? null };
  }
  private message(m: NMessage): Record<string, unknown> {
    return compact({ kind: 'message', messageId: m.messageId, role: m.role, parts: m.parts.map((p) => this.part(p)), taskId: m.taskId, contextId: m.contextId });
  }
  private status(s: NStatus): Record<string, unknown> {
    return compact({ state: s.state, message: s.message ? this.message(s.message) : undefined, timestamp: s.timestamp });
  }
  private artifact(a: NArtifact): Record<string, unknown> {
    return compact({ artifactId: a.artifactId, name: a.name, parts: a.parts.map((p) => this.part(p)) });
  }
  task(t: NTask): Record<string, unknown> {
    return compact({
      kind: 'task',
      id: t.id,
      contextId: t.contextId,
      status: this.status(t.status),
      artifacts: t.artifacts?.map((a) => this.artifact(a)),
      history: t.history?.map((m) => this.message(m)),
      metadata: t.metadata,
    });
  }
  sendResult(t: NTask): unknown {
    return this.task(t);
  }
  streamTask(t: NTask): unknown {
    return this.task(t);
  }
  statusUpdate(t: { id: string; contextId: string }, status: NStatus, final: boolean): unknown {
    return { kind: 'status-update', taskId: t.id, contextId: t.contextId, status: this.status(status), final };
  }
  artifactUpdate(t: { id: string; contextId: string }, artifact: NArtifact, append: boolean, lastChunk: boolean): unknown {
    return { kind: 'artifact-update', taskId: t.id, contextId: t.contextId, artifact: this.artifact(artifact), append, lastChunk };
  }
  errorData(): unknown {
    return undefined;
  }
  blocking(configuration: Record<string, unknown>): boolean {
    return configuration.blocking !== false;
  }
  pushConfig(configuration: Record<string, unknown>): unknown {
    return configuration.pushNotificationConfig;
  }
}

/** A2A 1.0: PascalCase methods, ProtoJSON enums, parts without `kind`, wrapped stream payloads. */
class DialectV1 implements Dialect {
  readonly version = '1.0' as const;
  readonly methods: Readonly<Record<string, Operation>> = {
    SendMessage: 'send',
    SendStreamingMessage: 'stream',
    GetTask: 'get',
    ListTasks: 'list',
    CancelTask: 'cancel',
    SubscribeToTask: 'subscribe',
    CreateTaskPushNotificationConfig: 'push',
    GetTaskPushNotificationConfig: 'push',
    ListTaskPushNotificationConfigs: 'push',
    DeleteTaskPushNotificationConfig: 'push',
    GetExtendedAgentCard: 'extendedCard',
  };
  private part(p: NPart): unknown {
    return p.text !== undefined ? { text: p.text } : { data: p.data ?? null, mediaType: 'application/json' };
  }
  private message(m: NMessage): Record<string, unknown> {
    return compact({
      messageId: m.messageId,
      role: m.role === 'user' ? 'ROLE_USER' : 'ROLE_AGENT',
      parts: m.parts.map((p) => this.part(p)),
      taskId: m.taskId,
      contextId: m.contextId,
    });
  }
  private status(s: NStatus): Record<string, unknown> {
    return compact({ state: `TASK_STATE_${s.state.replace('-', '_').toUpperCase()}`, message: s.message ? this.message(s.message) : undefined, timestamp: s.timestamp });
  }
  private artifact(a: NArtifact): Record<string, unknown> {
    return compact({ artifactId: a.artifactId, name: a.name, parts: a.parts.map((p) => this.part(p)) });
  }
  task(t: NTask): Record<string, unknown> {
    return compact({
      id: t.id,
      contextId: t.contextId,
      status: this.status(t.status),
      artifacts: t.artifacts?.map((a) => this.artifact(a)),
      history: t.history?.map((m) => this.message(m)),
      metadata: t.metadata,
    });
  }
  sendResult(t: NTask): unknown {
    return { task: this.task(t) };
  }
  streamTask(t: NTask): unknown {
    return { task: this.task(t) };
  }
  statusUpdate(t: { id: string; contextId: string }, status: NStatus): unknown {
    return { statusUpdate: { taskId: t.id, contextId: t.contextId, status: this.status(status) } };
  }
  artifactUpdate(t: { id: string; contextId: string }, artifact: NArtifact, append: boolean, lastChunk: boolean): unknown {
    return { artifactUpdate: { taskId: t.id, contextId: t.contextId, artifact: this.artifact(artifact), append, lastChunk } };
  }
  errorData(code: number, metadata?: Record<string, string>): unknown {
    const reason = ERROR_REASONS[code];
    if (!reason) return undefined;
    return [compact({ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, domain: 'a2a-protocol.org', metadata })];
  }
  blocking(configuration: Record<string, unknown>): boolean {
    return configuration.returnImmediately !== true;
  }
  pushConfig(configuration: Record<string, unknown>): unknown {
    return configuration.taskPushNotificationConfig ?? configuration.pushNotificationConfig;
  }
}

const V03 = new DialectV03();
const V1 = new DialectV1();

/** An A2A error with optional ErrorInfo metadata (v1 puts it in `error.data`). */
class A2aError extends RpcError {
  constructor(code: number, message: string, readonly metadata?: Record<string, string>) {
    super(code, message);
  }
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

/**
 * Creates the A2A routes: the agent card at `/.well-known/agent-card.json` (and the older
 * `/.well-known/agent.json`) and the JSON-RPC endpoint (POST `path`).
 *
 *   extensions: [{ routes: a2aRoutes(platform, { name: 'Bank', description: 'Banking help', version: '1.0.0' }) }]
 */
export function a2aRoutes(platform: AgentPlatform, options: A2aOptions): ExtensionRoute[] {
  if (!options.name || !options.description) throw new Error('a2aRoutes: options.name and options.description are required (they appear on the agent card)');
  checkTokens('a2aRoutes', options.token, options.callers);
  const server = new A2aServer(platform, options);
  const card = (ctx: RequestContext): HttpResponse => server.card(ctx);
  return [
    { method: 'GET', path: '/.well-known/agent-card.json', handler: card },
    { method: 'GET', path: '/.well-known/agent.json', handler: card },
    { method: 'POST', path: server.path, needsBody: true, handler: (ctx) => server.handle(ctx) },
  ];
}

interface SendInput {
  readonly text: string;
  readonly decision?: boolean;
  readonly taskId?: string;
  readonly contextId?: string;
  readonly skill?: string;
  readonly blocking: boolean;
  readonly historyLength?: number;
}

class A2aServer {
  readonly path: string;
  private readonly maxWaitMs: number;
  private readonly approvals: 'decline' | 'wait' | 'caller';

  constructor(
    private readonly platform: AgentPlatform,
    private readonly options: A2aOptions,
  ) {
    this.path = options.path ?? '/a2a';
    this.maxWaitMs = options.maxWaitMs ?? 120_000;
    this.approvals = options.approvals ?? (options.owner ? 'wait' : 'decline');
  }

  /* ---------------------------------------------------------------- */
  /* Agent card                                                        */
  /* ---------------------------------------------------------------- */

  /** One card that satisfies v1 (supportedInterfaces) and v0.3 (protocolVersion, url, preferredTransport). */
  card(ctx: RequestContext): HttpResponse {
    const url = `${baseUrl(ctx)}${this.path}`;
    const skills = this.platform.agents().map((a) => ({
      id: a.name,
      name: humanize(a.name),
      description: a.description || humanize(a.name),
      tags: a.name.split(/[-_\s]+/).filter(Boolean).map((w) => w.toLowerCase()),
      examples: a.examples.slice(0, 10),
      inputModes: INPUT_MODES,
      outputModes: OUTPUT_MODES,
    }));
    const card: Record<string, unknown> = {
      name: this.options.name,
      description: this.options.description,
      version: this.options.version,
      supportedInterfaces: [
        { url, protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
        { url, protocolBinding: 'JSONRPC', protocolVersion: '0.3' },
      ],
      protocolVersion: '0.3.0',
      url,
      preferredTransport: 'JSONRPC',
      additionalInterfaces: [{ url, transport: 'JSONRPC' }],
      capabilities: { streaming: true, pushNotifications: false, extendedAgentCard: false },
      defaultInputModes: INPUT_MODES,
      defaultOutputModes: OUTPUT_MODES,
      skills,
    };
    if (this.options.provider) card.provider = { organization: this.options.provider.organization, url: this.options.provider.url };
    if (this.options.token !== undefined || Object.keys(this.options.callers ?? {}).length > 0) {
      // Both shapes in one object: v0.3 reads `type`/`scheme`, v1 reads `httpAuthSecurityScheme`.
      card.securitySchemes = { bearer: { type: 'http', scheme: 'bearer', httpAuthSecurityScheme: { scheme: 'Bearer' } } };
      card.security = [{ bearer: [] }];
      card.securityRequirements = [{ schemes: { bearer: { list: [] } } }];
    }
    return new HttpResponse(200, card, { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' });
  }

  /* ---------------------------------------------------------------- */
  /* JSON-RPC                                                          */
  /* ---------------------------------------------------------------- */

  async handle(ctx: RequestContext): Promise<unknown> {
    if (!authenticate(ctx, this.options.token, this.options.callers).ok) {
      return new HttpResponse(401, failure(null, INVALID_REQUEST, 'Unauthorized: send Authorization: Bearer <token>'), { 'www-authenticate': 'Bearer' });
    }
    const msg = parseMessage(ctx.body);
    if (msg.kind === 'invalid') return json(failure(msg.id, msg.error.code, msg.error.message));
    if (msg.kind !== 'request') return new HttpResponse(202);
    const { id, method, params } = msg;

    const requested = (header(ctx, 'a2a-version') ?? ctx.query?.get('A2A-Version') ?? '').trim();
    const dialect = selectDialect(requested);
    if (!dialect) {
      return json(
        failure(id, A2A_ERRORS.VersionNotSupported, `A2A version "${requested}" is not supported; use one of: ${A2A_SUPPORTED_VERSIONS.join(', ')}`, V1.errorData(A2A_ERRORS.VersionNotSupported, { requested, supported: A2A_SUPPORTED_VERSIONS.join(',') })),
      );
    }

    const op = dialect.methods[method];
    const streaming = op === 'stream' || op === 'subscribe';
    try {
      switch (op) {
        case 'send':
          return json(success(id, await this.send(ctx, dialect, params)));
        case 'stream':
          return await this.stream(ctx, dialect, id, params);
        case 'get':
          return json(success(id, await this.getTask(ctx, dialect, params)));
        case 'list':
          return json(success(id, await this.listTasks(ctx, dialect, params)));
        case 'cancel':
          return json(success(id, await this.cancel(ctx, dialect, params)));
        case 'subscribe':
          return await this.subscribe(ctx, dialect, id, params);
        case 'push':
          throw new A2aError(A2A_ERRORS.PushNotificationNotSupported, 'Push notifications are not supported by this agent; use streaming or GetTask polling');
        case 'extendedCard':
          throw new A2aError(A2A_ERRORS.UnsupportedOperation, 'This agent has no extended agent card');
        default: {
          const other = dialect === V1 ? V03 : V1;
          const hint = other.methods[method] ? ` (it is an A2A ${other.version} method: send header A2A-Version: ${other.version === '0.3' ? '0.3 or none' : other.version})` : '';
          throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}${hint}`);
        }
      }
    } catch (err) {
      const body = this.errorBody(dialect, id, err);
      // Clients of streaming methods expect text/event-stream: send the error as one event.
      return streaming ? eventStream(async function* () { yield { data: body }; }) : json(body);
    }
  }

  private errorBody(dialect: Dialect, id: JsonRpcId, err: unknown): unknown {
    if (err instanceof RpcError) {
      return failure(id, err.code, err.message, dialect.errorData(err.code, err instanceof A2aError ? err.metadata : undefined));
    }
    return failure(id, INTERNAL_ERROR, 'Internal error');
  }

  /* ---------------------------------------------------------------- */
  /* SendMessage / message/send                                        */
  /* ---------------------------------------------------------------- */

  private async send(ctx: RequestContext, dialect: Dialect, params: Record<string, unknown>): Promise<unknown> {
    const input = parseSend(dialect, params);
    const begun = await this.begin(ctx, input);
    if ('reply' in begun) return dialect.sendResult(begun.reply);
    let run = begun.run;
    if (input.blocking) {
      const req = requestSignal(ctx);
      try {
        run = await this.waitForRest(run.id, req.signal);
      } finally {
        req.dispose();
      }
    }
    return dialect.sendResult(await this.toTask(run, { history: input.historyLength }));
  }

  /**
   * Starts a run for a new message, or answers a paused run's approvals. Returns `reply` when the
   * message doesn't contain a clear decision (the task stays input-required).
   */
  private async begin(ctx: RequestContext, input: SendInput): Promise<{ run: RunRecord } | { reply: NTask }> {
    const owner = this.owner(ctx);
    if (input.taskId !== undefined) {
      let run = await this.ownedRun(input.taskId, owner);
      if (TERMINAL_STATUSES.has(run.status)) {
        throw new A2aError(
          A2A_ERRORS.UnsupportedOperation,
          `Task ${run.id} is ${mapState(run)} and cannot accept more messages; send a new message with contextId "${run.threadId}" to continue the conversation`,
          { taskId: run.id },
        );
      }
      const pending = (run.pending ?? []).filter((p) => !p.decision);
      if (run.status !== 'awaiting_approval' || pending.length === 0) {
        throw new A2aError(A2A_ERRORS.UnsupportedOperation, `Task ${run.id} is still working; wait for it (GetTask or SubscribeToTask) or cancel it`, { taskId: run.id });
      }
      if (this.approvals !== 'caller') {
        throw new A2aError(
          A2A_ERRORS.UnsupportedOperation,
          `Task ${run.id} is waiting for approval by a person in the app; an A2A caller can't approve or deny it`,
          { taskId: run.id },
        );
      }
      const approved = input.decision ?? parseDecision(input.text);
      if (approved === undefined) {
        const task = await this.toTask(run, {});
        const ask: NMessage = {
          messageId: randomUUID(),
          role: 'agent',
          taskId: run.id,
          contextId: run.threadId,
          parts: [{ text: 'I need an explicit decision: reply "approve" to allow the pending action or "deny" to refuse it (or send a data part {"approved": true|false}).' }],
        };
        return { reply: { ...task, status: { ...task.status, message: ask } } };
      }
      for (const p of pending) {
        run = await this.platform.decide(run.id, p.callId, { approved, note: input.text ? input.text.slice(0, 1000) : undefined });
      }
      return { run };
    }

    if (input.text.trim().length === 0) throw new RpcError(INVALID_PARAMS, 'The message has no text: send at least one text part');
    const agents = this.platform.agents();
    let thread: { agent: string } | undefined;
    // Without an owner hook every conversation is its own caller (see owner()).
    let runOwner = owner ?? `${ANONYMOUS_OWNER}${randomUUID()}`;
    if (input.contextId !== undefined) {
      const found = await this.platform.thread(input.contextId);
      if (!found || !mayAccess(found.thread.owner, owner)) {
        throw new RpcError(INVALID_PARAMS, `Unknown contextId "${input.contextId}": omit contextId to start a new conversation (the agent assigns one)`);
      }
      thread = found.thread;
      runOwner = found.thread.owner;
    }
    const agent = input.skill ?? thread?.agent ?? this.options.defaultAgent ?? agents[0]?.name;
    if (!agent || !agents.some((a) => a.name === agent)) {
      throw new RpcError(INVALID_PARAMS, agent ? `Unknown skill "${agent}"; the agent card lists the available skills` : 'This server has no agents');
    }
    if (thread && thread.agent !== agent) {
      throw new RpcError(INVALID_PARAMS, `contextId "${input.contextId}" belongs to skill "${thread.agent}", not "${agent}"`);
    }
    const run = await this.platform.startRun({ agent, input: input.text, owner: runOwner, threadId: input.contextId, principal: this.options.principal?.(ctx) });
    return { run };
  }

  /** Follows a run until it ends or pauses for approval (or the wait limit / client disconnect). */
  private async waitForRest(runId: string, signal: AbortSignal): Promise<RunRecord> {
    const stop = anySignal(signal, AbortSignal.timeout(this.maxWaitMs));
    let seq = 0;
    let declines = 0;
    for (;;) {
      let seen = 0;
      try {
        for await (const e of this.platform.subscribe(runId, seq, stop)) {
          seq = Math.max(seq, e.seq);
          seen++;
        }
      } catch (err) {
        if (!stop.aborted) throw err;
      }
      const run = await this.platform.getRun(runId);
      if (!run) throw new A2aError(A2A_ERRORS.TaskNotFound, `Task ${runId} not found`, { taskId: runId });
      if (isPaused(run) && !stop.aborted && (await this.declinePaused(run, ++declines))) continue;
      if (TERMINAL_STATUSES.has(run.status) || isPaused(run) || stop.aborted) return run;
      await sleep(seen === 0 ? 100 : 0, stop);
    }
  }

  /**
   * In 'decline' mode, declines every pending action of a paused run (the agent is told why and
   * continues). Returns true when it did, so the caller keeps following the run.
   */
  private async declinePaused(run: RunRecord, attempt: number): Promise<boolean> {
    if (this.approvals !== 'decline') return false;
    if (attempt > MAX_AUTO_DECLINES) {
      await this.platform.cancel(run.id).catch(() => undefined);
      return true;
    }
    for (const p of run.pending ?? []) {
      if (!p.decision) await this.platform.decide(run.id, p.callId, { approved: false, note: DECLINE_NOTE }).catch(() => undefined);
    }
    return true;
  }

  /* ---------------------------------------------------------------- */
  /* Streaming                                                         */
  /* ---------------------------------------------------------------- */

  private async stream(ctx: RequestContext, dialect: Dialect, id: JsonRpcId, params: Record<string, unknown>): Promise<unknown> {
    const input = parseSend(dialect, params);
    const begun = await this.begin(ctx, input);
    if ('reply' in begun) {
      const reply = begun.reply;
      return eventStream(async function* () {
        yield { data: success(id, dialect.streamTask(reply)) };
        if (dialect.version === '0.3') yield { data: success(id, dialect.statusUpdate(reply, reply.status, true)) };
      });
    }
    return this.follow(dialect, id, begun.run);
  }

  private async subscribe(ctx: RequestContext, dialect: Dialect, id: JsonRpcId, params: Record<string, unknown>): Promise<unknown> {
    const run = await this.ownedRun(taskIdParam(params), this.owner(ctx));
    if (TERMINAL_STATUSES.has(run.status)) {
      if (dialect.version === '1.0') {
        throw new A2aError(A2A_ERRORS.UnsupportedOperation, `Task ${run.id} is ${mapState(run)}; use GetTask to read its result`, { taskId: run.id });
      }
      const task = await this.toTask(run, {});
      return eventStream(async function* () {
        yield { data: success(id, dialect.streamTask(task)) };
        yield { data: success(id, dialect.statusUpdate(task, task.status, true)) };
      });
    }
    return this.follow(dialect, id, run);
  }

  /**
   * SSE stream of a run: the Task first, then artifact chunks from token deltas, status updates
   * on state changes and progress, and a final status when the run ends or pauses for approval.
   * The final artifact event always reconciles the streamed text with the run's real output.
   */
  private follow(dialect: Dialect, id: JsonRpcId, run: RunRecord): unknown {
    const platform = this.platform;
    const toTask = (r: RunRecord): Promise<NTask> => this.toTask(r, {});
    const declinePaused = (r: RunRecord, attempt: number): Promise<boolean> => this.declinePaused(r, attempt);
    let declines = 0;
    return eventStream(async function* (signal) {
      const ev = (result: unknown): { data: unknown } => ({ data: success(id, result) });
      const first = await toTask(run);
      const ref = { id: first.id, contextId: first.contextId };
      yield ev(dialect.streamTask(first));
      let last: TaskState = first.status.state;
      let streamed = '';
      let chunks = 0;
      let seq = 0;
      const now = (): string => new Date().toISOString();
      const note = (text: string): NStatus => ({
        state: 'working',
        timestamp: now(),
        message: { messageId: randomUUID(), role: 'agent', taskId: ref.id, contextId: ref.contextId, parts: [{ text }] },
      });

      for (;;) {
        let seen = 0;
        let ended = false;
        try {
          for await (const e of platform.subscribe(run.id, seq, signal)) {
            seq = Math.max(seq, e.seq);
            seen++;
            if (e.type === 'message.delta' && typeof e.data.text === 'string' && e.data.text.length > 0) {
              if (streamed.length < MAX_TEXT * 10) streamed += e.data.text;
              yield ev(dialect.artifactUpdate(ref, { artifactId: ARTIFACT_ID, name: ARTIFACT_ID, parts: [{ text: e.data.text }] }, chunks++ > 0, false));
            } else if (e.type === 'progress' && typeof e.data.message === 'string') {
              last = 'working';
              yield ev(dialect.statusUpdate(ref, note(e.data.message), false));
            } else if (e.type === 'tool.started' && typeof e.data.tool === 'string') {
              last = 'working';
              yield ev(dialect.statusUpdate(ref, note(`Using ${e.data.tool}…`), false));
            } else if (e.type === 'run.status' && typeof e.data.status === 'string') {
              const state = mapStatus(e.data.status);
              if ((state === 'submitted' || state === 'working') && state !== last) {
                last = state;
                yield ev(dialect.statusUpdate(ref, { state, timestamp: e.at }, false));
              }
              if (TERMINAL_STATUSES.has(e.data.status as RunRecord['status'])) ended = true;
            } else if (e.type === 'run.completed' || e.type === 'run.failed') ended = true;
            if (ended) break;
          }
        } catch (err) {
          if (!signal.aborted) throw err;
        }
        if (signal.aborted) return;
        const cur = await platform.getRun(run.id);
        if (!cur) return;
        if (TERMINAL_STATUSES.has(cur.status)) {
          const task = await toTask(cur);
          if (cur.status === 'completed' && cur.output !== undefined) {
            const reconciled = chunks > 0 && streamed === cur.output;
            const parts = [{ text: reconciled ? '' : cur.output }];
            yield ev(dialect.artifactUpdate(ref, { artifactId: ARTIFACT_ID, name: ARTIFACT_ID, parts }, reconciled, true));
          }
          yield ev(dialect.statusUpdate(ref, task.status, true));
          return;
        }
        if (isPaused(cur) && (await declinePaused(cur, ++declines))) continue;
        if (isPaused(cur)) {
          const task = await toTask(cur);
          yield ev(dialect.statusUpdate(ref, task.status, true));
          return;
        }
        await sleep(seen === 0 || ended ? 100 : 0, signal);
      }
    });
  }

  /* ---------------------------------------------------------------- */
  /* Tasks                                                             */
  /* ---------------------------------------------------------------- */

  private async getTask(ctx: RequestContext, dialect: Dialect, params: Record<string, unknown>): Promise<unknown> {
    const run = await this.ownedRun(taskIdParam(params), this.owner(ctx));
    const history = historyParam(params.historyLength);
    return dialect.task(await this.toTask(run, { history: history ?? MAX_HISTORY }));
  }

  private async cancel(ctx: RequestContext, dialect: Dialect, params: Record<string, unknown>): Promise<unknown> {
    const run = await this.ownedRun(taskIdParam(params), this.owner(ctx));
    if (TERMINAL_STATUSES.has(run.status)) {
      throw new A2aError(A2A_ERRORS.TaskNotCancelable, `Task ${run.id} is already ${mapState(run)} and cannot be canceled`, { taskId: run.id });
    }
    const updated = await this.platform.cancel(run.id);
    return dialect.task(await this.toTask(updated, {}));
  }

  /**
   * ListTasks (v1). Tasks are found through the owner's threads (most recent first, at most 50)
   * and the run ids recorded on their messages, so a run is listed once it has written to its
   * thread. Sorted by last update, newest first.
   */
  private async listTasks(ctx: RequestContext, dialect: Dialect, params: Record<string, unknown>): Promise<unknown> {
    const owner = this.owner(ctx);
    const pageSize = params.pageSize === undefined ? 50 : Number(params.pageSize);
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new RpcError(INVALID_PARAMS, 'pageSize must be an integer between 1 and 100');
    const history = historyParam(params.historyLength);
    let wantedState: TaskState | undefined;
    if (params.status !== undefined && params.status !== 'TASK_STATE_UNSPECIFIED') {
      const s = typeof params.status === 'string' ? params.status.replace(/^TASK_STATE_/, '').toLowerCase().replace('_', '-') : '';
      if (!['submitted', 'working', 'input-required', 'completed', 'failed', 'canceled'].includes(s)) throw new RpcError(INVALID_PARAMS, `Unknown status ${String(params.status)}`);
      wantedState = s as TaskState;
    }
    let after: number | undefined;
    if (params.statusTimestampAfter !== undefined) {
      after = typeof params.statusTimestampAfter === 'string' ? Date.parse(params.statusTimestampAfter) : NaN;
      if (Number.isNaN(after)) throw new RpcError(INVALID_PARAMS, 'statusTimestampAfter must be an ISO 8601 timestamp');
    }

    let threadIds: string[];
    if (params.contextId !== undefined) {
      if (typeof params.contextId !== 'string') throw new RpcError(INVALID_PARAMS, 'contextId must be a string');
      threadIds = [params.contextId];
    } else if (owner !== undefined) {
      threadIds = (await this.platform.threads(owner)).slice(0, LIST_THREAD_LIMIT).map((t) => t.id);
    } else {
      // Anonymous callers can't be told apart, so they only see the conversation they name.
      threadIds = [];
    }
    const runIds = new Set<string>();
    const owners = new Set<string>();
    for (const threadId of threadIds) {
      const data = await this.platform.thread(threadId);
      if (!data || !mayAccess(data.thread.owner, owner)) continue;
      owners.add(data.thread.owner);
      for (const m of data.messages) if (m.runId && runIds.size < LIST_RUN_LIMIT) runIds.add(m.runId);
    }
    const runs = (await Promise.all([...runIds].map((rid) => this.platform.getRun(rid))))
      .filter((r): r is RunRecord => r !== undefined && owners.has(r.owner))
      .filter((r) => !wantedState || mapState(r) === wantedState)
      .filter((r) => after === undefined || Date.parse(r.updatedAt) > after)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));

    const start = params.pageToken === undefined || params.pageToken === '' ? 0 : decodeCursor(params.pageToken, runs.length);
    if (start === undefined) throw new RpcError(INVALID_PARAMS, 'Invalid pageToken');
    const page = runs.slice(start, start + pageSize);
    const includeArtifacts = params.includeArtifacts === true;
    const tasks = await Promise.all(page.map((r) => this.toTask(r, { history, artifacts: includeArtifacts })));
    return {
      tasks: tasks.map((t) => dialect.task(t)),
      nextPageToken: start + pageSize < runs.length ? encodeCursor(start + pageSize) : '',
      pageSize,
      totalSize: runs.length,
    };
  }

  private async ownedRun(taskId: string, owner: string | undefined): Promise<RunRecord> {
    const run = await this.platform.getRun(taskId);
    // Someone else's task is reported exactly like a missing one (no existence leak).
    if (!run || !mayAccess(run.owner, owner)) throw new A2aError(A2A_ERRORS.TaskNotFound, `Task ${taskId} not found`, { taskId });
    return run;
  }

  /** RunRecord -> neutral Task. `history`: number of recent messages (0/undefined: none). */
  private async toTask(run: RunRecord, opts: { history?: number; artifacts?: boolean }): Promise<NTask> {
    const state = mapState(run);
    let message: NMessage | undefined;
    if (state === 'input-required') message = approvalPrompt(run, this.approvals === 'caller');
    else if (state === 'failed') {
      message = { messageId: `${run.id}-error`, role: 'agent', taskId: run.id, contextId: run.threadId, parts: [{ text: `The agent failed: ${run.error?.message ?? 'unknown error'}` }] };
    }
    const task: { -readonly [K in keyof NTask]: NTask[K] } = {
      id: run.id,
      contextId: run.threadId,
      status: message ? { state, message, timestamp: run.updatedAt } : { state, timestamp: run.updatedAt },
      metadata: { skill: run.agent },
    };
    if (opts.artifacts !== false) {
      task.artifacts = run.status === 'completed' && run.output !== undefined ? [{ artifactId: ARTIFACT_ID, name: ARTIFACT_ID, parts: [{ text: run.output }] }] : [];
    }
    if (opts.history && opts.history > 0) task.history = await this.history(run, Math.min(opts.history, MAX_HISTORY));
    return task;
  }

  private async history(run: RunRecord, limit: number): Promise<NMessage[]> {
    const data = await this.platform.thread(run.threadId);
    const mine = (data?.messages ?? []).filter((m) => m.runId === run.id);
    const out: NMessage[] = [];
    if (!mine.some((m) => m.role === 'user')) {
      out.push({ messageId: `${run.id}-input`, role: 'user', taskId: run.id, contextId: run.threadId, parts: [{ text: run.input }] });
    }
    mine.forEach((m, i) => {
      if (m.role === 'tool') return;
      const text = m.content.map((p) => (p.type === 'text' ? p.text : '')).join('');
      if (!text) return;
      out.push({ messageId: m.id ?? `${run.id}-${i}`, role: m.role === 'user' ? 'user' : 'agent', taskId: run.id, contextId: run.threadId, parts: [{ text }] });
    });
    return out.slice(-limit);
  }

  /**
   * The caller's identity: the `owner` hook, else the named caller whose token was sent. Without
   * either, callers can't be told apart: each
   * conversation then gets an owner of its own, and its unguessable task and context ids are what
   * let a caller come back to it. So no caller can list or read another's tasks, and facts an agent
   * remembers stay inside the conversation they came from.
   */
  private owner(ctx: RequestContext): string | undefined {
    const caller = authenticate(ctx, this.options.token, this.options.callers).caller;
    return this.options.owner?.(ctx) || (caller ? `a2a:${caller}` : undefined);
  }
}

/** Owner prefix of conversations started by callers the app doesn't identify. */
const ANONYMOUS_OWNER = 'a2a:anonymous:';

/** Whether a caller (`owner`, undefined when anonymous) may use a task or conversation owned by `recordOwner`. */
function mayAccess(recordOwner: string, owner: string | undefined): boolean {
  return owner === undefined ? recordOwner.startsWith(ANONYMOUS_OWNER) : recordOwner === owner;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function selectDialect(requested: string): Dialect | undefined {
  if (requested === '') return V03;
  const m = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(requested);
  if (!m) return undefined;
  const mm = `${Number(m[1])}.${Number(m[2])}`;
  return mm === '0.3' ? V03 : mm === '1.0' ? V1 : undefined;
}

function mapStatus(status: string): TaskState {
  switch (status) {
    case 'queued':
      return 'submitted';
    case 'running':
      return 'working';
    case 'awaiting_approval':
      return 'input-required';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'canceled';
    default:
      return 'working';
  }
}

/** A run whose approvals are all decided is about to resume: report it as working. */
function mapState(run: RunRecord): TaskState {
  if (run.status === 'awaiting_approval' && !isPaused(run)) return 'working';
  return mapStatus(run.status);
}

function isPaused(run: RunRecord): boolean {
  return run.status === 'awaiting_approval' && (run.pending === undefined || run.pending.length === 0 || run.pending.some((p) => !p.decision));
}

function approvalPrompt(run: RunRecord, callerDecides: boolean): NMessage {
  const pending = (run.pending ?? []).filter((p) => !p.decision);
  const lines = pending.map((p) => `- ${p.tool} ${toText(p.input, 500)}${p.reason ? ` (${p.reason})` : ''}`);
  const text =
    `Approval needed before I can continue:\n${lines.join('\n') || '- a pending action'}\n` +
    (callerDecides
      ? 'Reply "approve" to allow it or "deny" to refuse it (or send a data part {"approved": true|false}) with this taskId.'
      : 'A person must approve it in the app; the task then continues on its own. Follow it with GetTask or SubscribeToTask.');
  const data = { pendingApprovals: pending.map((p) => ({ callId: p.callId, tool: p.tool, input: toJson(p.input), reason: p.reason ?? null })) } as JsonValue;
  return { messageId: `${run.id}-approval-${pending.map((p) => p.callId).join('-').slice(0, 100)}`, role: 'agent', taskId: run.id, contextId: run.threadId, parts: [{ text }, { data }] };
}

const APPROVE = /^(approve|approved|yes|y|confirm|confirmed|ok|okay|allow|accept)\b/;
const DENY = /^(deny|denied|no|n|reject|rejected|cancel|decline|refuse)\b/;

/** "approve"/"yes"/"confirm" -> true; "deny"/"no"/"cancel" -> false; anything else -> undefined. */
export function parseDecision(text: string): boolean | undefined {
  const t = text.trim().toLowerCase().replace(/^["'(]+/, '');
  if (APPROVE.test(t)) return true;
  if (DENY.test(t)) return false;
  return undefined;
}

function parseSend(dialect: Dialect, params: Record<string, unknown>): SendInput {
  const message = params.message;
  if (!isObject(message)) throw new RpcError(INVALID_PARAMS, 'params.message is required');
  const parts = message.parts;
  if (!Array.isArray(parts) || parts.length === 0) throw new RpcError(INVALID_PARAMS, 'message.parts must contain at least one part');
  if (parts.length > MAX_PARTS) throw new RpcError(INVALID_PARAMS, `message.parts has more than ${MAX_PARTS} parts`);
  const texts: string[] = [];
  let decision: boolean | undefined;
  for (const part of parts) {
    if (!isObject(part)) throw new RpcError(INVALID_PARAMS, 'Each part must be an object');
    if (typeof part.text === 'string') texts.push(part.text);
    else if ('data' in part) {
      if (isObject(part.data) && typeof part.data.approved === 'boolean') decision = part.data.approved;
      else texts.push(toText(part.data));
    } else if ('file' in part || 'raw' in part || 'url' in part || part.kind === 'file') {
      throw new A2aError(A2A_ERRORS.ContentTypeNotSupported, 'Only text and data parts are supported; send files as links in text');
    } else throw new RpcError(INVALID_PARAMS, 'Unrecognised part: expected text or data');
  }
  const text = texts.join('\n');
  if (text.length > MAX_TEXT) throw new RpcError(INVALID_PARAMS, `The message is too long (max ${MAX_TEXT} characters)`);
  const taskId = optionalId(message.taskId, 'message.taskId');
  const contextId = optionalId(message.contextId, 'message.contextId');

  const configuration = isObject(params.configuration) ? params.configuration : {};
  if (dialect.pushConfig(configuration) !== undefined) {
    throw new A2aError(A2A_ERRORS.PushNotificationNotSupported, 'Push notifications are not supported by this agent; use streaming or GetTask polling');
  }
  const modes = configuration.acceptedOutputModes;
  if (Array.isArray(modes) && modes.length > 0 && !modes.some((m) => m === 'text/plain' || m === 'text/*' || m === '*/*')) {
    throw new A2aError(A2A_ERRORS.ContentTypeNotSupported, 'This agent answers in text/plain; include it in acceptedOutputModes');
  }
  const skillOf = (meta: unknown): string | undefined => (isObject(meta) && typeof meta.skill === 'string' ? meta.skill : undefined);
  return {
    text,
    decision,
    taskId,
    contextId,
    skill: skillOf(params.metadata) ?? skillOf(message.metadata),
    blocking: dialect.blocking(configuration),
    historyLength: historyParam(configuration.historyLength),
  };
}

function taskIdParam(params: Record<string, unknown>): string {
  const id = params.id;
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID) throw new RpcError(INVALID_PARAMS, 'params.id must be the task id');
  return id;
}

function historyParam(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new RpcError(INVALID_PARAMS, 'historyLength must be a non-negative integer');
  return value;
}

function optionalId(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > MAX_ID) throw new RpcError(INVALID_PARAMS, `${name} must be a string`);
  return value;
}

function baseUrl(ctx: RequestContext): string {
  const host = header(ctx, 'host');
  const safe = host && /^[A-Za-z0-9.\-:[\]]{1,255}$/.test(host) ? host : 'localhost';
  return `${ctx.protocol === 'https' ? 'https' : 'http'}://${safe}`;
}

function toJson(value: unknown): JsonValue {
  try {
    return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
  } catch {
    return null;
  }
}

function compact<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function json(body: unknown): HttpResponse {
  return new HttpResponse(200, body, { 'content-type': 'application/json' });
}
