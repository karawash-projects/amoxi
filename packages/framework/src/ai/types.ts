// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

/**
 * Contracts of the Amoxi AI module (`amoxi/ai`).
 *
 * Every moving part is an interface with a default implementation chosen by configuration
 * (Strategy + Factory): chat models, embedders, vector stores, conversation and run stores.
 * An app replaces any of them by declaring its own bean that implements the interface; the
 * compiler then wires the app's implementation instead of the built-in one.
 */

/* ------------------------------------------------------------------ */
/* JSON values and schemas                                             */
/* ------------------------------------------------------------------ */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
/** A JSON Schema object (draft 2020-12 subset), generated at build time from TypeScript types. */
export type JsonSchema = Record<string, unknown>;

/** Validation error details, same shape as request-body validation errors. */
export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

/** A generated validator: returns the cleaned value (unknown properties removed) or throws. */
export type GeneratedValidator = (value: unknown) => unknown;

/* ------------------------------------------------------------------ */
/* Messages (provider-neutral)                                         */
/* ------------------------------------------------------------------ */

export interface TextPart {
  readonly type: 'text';
  readonly text: string;
}

/** The model asked to call a tool. `input` is the parsed JSON arguments. */
export interface ToolCallPart {
  readonly type: 'tool_call';
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

/** The result of a tool call, sent back to the model. */
export interface ToolResultPart {
  readonly type: 'tool_result';
  readonly callId: string;
  readonly name: string;
  /** JSON-serialisable output (or an error description when isError). */
  readonly output: unknown;
  readonly isError?: boolean;
}

/**
 * Generative UI: a component the agent showed the user. Kept in the transcript so pages can
 * re-render it; model adapters never send it to the model (the matching tool result is sent).
 */
export interface UiPart {
  readonly type: 'ui';
  readonly id: string;
  readonly component: string;
  readonly props: Record<string, unknown>;
}

export type MessagePart = TextPart | ToolCallPart | ToolResultPart | UiPart;

export interface ChatMessage {
  /** 'user': text from the person; 'assistant': text and tool calls; 'tool': tool results. */
  readonly role: 'user' | 'assistant' | 'tool';
  readonly content: readonly MessagePart[];
  /** Set by conversation stores. */
  readonly id?: string;
  readonly createdAt?: string;
  readonly runId?: string;
}

/* ------------------------------------------------------------------ */
/* Chat models (Strategy)                                              */
/* ------------------------------------------------------------------ */

/** A tool as the model sees it. */
export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
}

export interface ChatRequest {
  readonly system?: string;
  readonly messages: readonly ChatMessage[];
  readonly tools?: readonly ToolSpec[];
  /** 'auto' (default): the model decides; 'none': text only; 'required': must call a tool. */
  readonly toolChoice?: 'auto' | 'none' | 'required';
  /** Overrides the configured model id for this request. */
  readonly model?: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly signal?: AbortSignal;
}

export type FinishReason = 'stop' | 'tool_calls' | 'max_tokens' | 'refusal' | 'other';

/** Streamed output of a model turn. Tool calls are emitted once complete (arguments parsed). */
export type ModelEvent =
  | { readonly type: 'text'; readonly delta: string }
  | { readonly type: 'tool_call'; readonly id: string; readonly name: string; readonly input: unknown }
  | { readonly type: 'usage'; readonly inputTokens: number; readonly outputTokens: number }
  | { readonly type: 'finish'; readonly reason: FinishReason };

/** A large language model. Implementations: Anthropic, OpenAI-compatible, offline, scripted (tests). */
export interface ChatModel {
  /** e.g. 'anthropic', 'openai', 'offline'. */
  readonly provider: string;
  /** Default model id. */
  readonly model: string;
  stream(request: ChatRequest): AsyncIterable<ModelEvent>;
}

/** Raised by model adapters for HTTP/API failures (after retries). */
export class ModelError extends Error {
  override name = 'ModelError';
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
  }
}

/* ------------------------------------------------------------------ */
/* Embeddings and vector search                                        */
/* ------------------------------------------------------------------ */

export interface Embedder {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]>;
}

export type Metadata = Readonly<Record<string, string | number | boolean>>;

export interface VectorRecord {
  readonly id: string;
  readonly vector: readonly number[];
  readonly text: string;
  readonly metadata?: Metadata;
}

export interface VectorMatch {
  readonly id: string;
  readonly text: string;
  readonly metadata?: Metadata;
  /** Cosine similarity, 1 = identical. */
  readonly score: number;
}

export interface VectorQuery {
  readonly limit?: number;
  readonly minScore?: number;
  /** Exact-match filter on metadata fields. */
  readonly filter?: Metadata;
}

/** Stores vectors in namespaces (one per knowledge base or memory owner). */
export interface VectorStore {
  upsert(namespace: string, records: readonly VectorRecord[]): Promise<void>;
  query(namespace: string, vector: readonly number[], query?: VectorQuery): Promise<VectorMatch[]>;
  delete(namespace: string, ids: readonly string[]): Promise<void>;
  /** Removes a whole namespace. */
  clear(namespace: string): Promise<void>;
}

/** A remembered fact. */
export interface MemoryItem {
  readonly id: string;
  readonly text: string;
  readonly metadata?: Metadata;
  readonly createdAt: string;
  /** Relevance to the query (recall only). */
  readonly score?: number;
}

/** Long-term memory of one subject (usually one user), backed by a vector store. */
export interface AgentMemory {
  remember(text: string, metadata?: Metadata): Promise<MemoryItem>;
  recall(query: string, options?: VectorQuery): Promise<MemoryItem[]>;
  forget(id: string): Promise<void>;
}

export interface KnowledgeDocument {
  readonly id: string;
  readonly text: string;
  readonly title?: string;
  readonly url?: string;
  readonly metadata?: Metadata;
}

export interface KnowledgeHit {
  readonly documentId: string;
  readonly title?: string;
  readonly url?: string;
  readonly text: string;
  readonly score: number;
}

/* ------------------------------------------------------------------ */
/* Conversations and runs (Repository)                                  */
/* ------------------------------------------------------------------ */

export interface Thread {
  readonly id: string;
  /** Who may read and continue it (see AgentBehavior.owner). */
  readonly owner: string;
  readonly agent: string;
  readonly title?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly metadata?: Metadata;
}

/** Chat history per thread. */
export interface ConversationStore {
  createThread(input: { owner: string; agent: string; title?: string; metadata?: Metadata }): Promise<Thread>;
  getThread(id: string): Promise<Thread | undefined>;
  listThreads(owner: string, options?: { agent?: string; limit?: number }): Promise<Thread[]>;
  updateThread(id: string, patch: { title?: string; metadata?: Metadata }): Promise<void>;
  deleteThread(id: string): Promise<void>;
  /** Appends in order; assigns id and createdAt when missing. */
  appendMessages(threadId: string, messages: readonly ChatMessage[]): Promise<ChatMessage[]>;
  /** Oldest first. `limit` keeps the most recent messages. */
  getMessages(threadId: string, options?: { limit?: number }): Promise<ChatMessage[]>;
}

export type RunStatus = 'queued' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled';

export const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set(['completed', 'failed', 'cancelled']);

/** A tool call that needs a person's decision before it runs (human in the loop). */
export interface PendingApproval {
  readonly callId: string;
  readonly tool: string;
  readonly input: unknown;
  /** Why approval is needed, shown to the person. */
  readonly reason?: string;
  readonly requestedAt: string;
  /** Set once decided. */
  readonly decision?: { readonly approved: boolean; readonly note?: string; readonly decidedAt: string };
}

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** One agent run: a durable, resumable unit of work that can outlive the HTTP request. */
export interface RunRecord {
  readonly id: string;
  readonly agent: string;
  readonly threadId: string;
  readonly owner: string;
  readonly status: RunStatus;
  /** The person's message that started the run. */
  readonly input: string;
  /** Identity captured at start (AgentBehavior.principal); tools receive it. JSON only. */
  readonly principal?: JsonValue;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  /** Final answer text. */
  readonly output?: string;
  readonly error?: { readonly message: string; readonly code?: string };
  readonly pending?: readonly PendingApproval[];
  /**
   * Messages produced so far in this run (not yet in the thread). Saved after every model turn
   * and tool result, so a run interrupted by a crash or deploy resumes from the last step.
   */
  readonly checkpoint?: readonly ChatMessage[];
  /** Results of durable steps (ToolContext.step), by step key. */
  readonly steps?: Readonly<Record<string, JsonValue>>;
  readonly turns: number;
  readonly usage: Usage;
  readonly metadata?: Metadata;
  /** Worker that holds the run, and its last heartbeat (lease for crash recovery). */
  readonly workerId?: string;
  readonly heartbeatAt?: string;
  /** Set when someone cancels a run another worker is executing; that worker stops at its next heartbeat. */
  readonly cancelRequested?: boolean;
  /** Incremented by the store on every update; used for compare-and-set (RunUpdateCondition). */
  readonly revision?: number;
}

/** An event of a run, numbered per run (the SSE id), so clients can resume after a disconnect. */
export interface RunEvent {
  readonly seq: number;
  readonly runId: string;
  readonly type: RunEventType;
  readonly data: Record<string, unknown>;
  readonly at: string;
}

/**
 * The Amoxi agent stream protocol. Every event is also an SSE event of the same name.
 *   run.status        { status }
 *   message.delta     { text }                       token streaming
 *   message.completed { text }
 *   tool.started      { callId, tool, input }
 *   tool.completed    { callId, tool, output, isError }
 *   ui                { id, component, props }       generative UI
 *   approval.required { callId, tool, input, reason }
 *   progress          { message }
 *   run.completed     { output, usage }
 *   run.failed        { error }
 */
export type RunEventType =
  | 'run.status'
  | 'message.delta'
  | 'message.completed'
  | 'tool.started'
  | 'tool.completed'
  | 'ui'
  | 'approval.required'
  | 'progress'
  | 'run.completed'
  | 'run.failed';

/** Condition for a compare-and-set `RunStore.update`: the record must still match it. */
export interface RunUpdateCondition {
  /** The run's status must be one of these. */
  readonly status?: readonly RunStatus[];
  /** The run's `revision` must equal this (the record was not changed since it was read). */
  readonly revision?: number;
  /** The run must still be held by this worker (it wasn't taken over after a missed heartbeat). */
  readonly workerId?: string;
}

/**
 * Throw from a tool when the message is meant for the model and the person, for example
 * `throw new ToolError('Only 2 left in size M')`. In production, the messages of other errors
 * (a database error, a bug) are replaced by "internal error" plus a reference that is logged with
 * the details, so internals never reach the browser. HttpError messages are shown as well.
 */
export class ToolError extends Error {
  override name = 'ToolError';
}

/** Thrown by `RunStore.update` when a `RunUpdateCondition` no longer holds. */
export class RunConflictError extends Error {
  override name = 'RunConflictError';
  constructor(readonly runId: string) {
    super(`Run '${runId}' was changed concurrently`);
  }
}

/** True when `run` satisfies `condition` (helper for RunStore implementations). */
export function matchesCondition(run: RunRecord, condition: RunUpdateCondition | undefined): boolean {
  if (!condition) return true;
  if (condition.status && !condition.status.includes(run.status)) return false;
  if (condition.revision !== undefined && (run.revision ?? 0) !== condition.revision) return false;
  if (condition.workerId !== undefined && run.workerId !== condition.workerId) return false;
  return true;
}

/** Durable run state and event log. `claim` gives multi-worker, crash-safe execution. */
export interface RunStore {
  create(run: RunRecord): Promise<void>;
  /**
   * Creates the run only if its thread has no unfinished run, atomically (across processes too), and
   * returns undefined; otherwise creates nothing and returns the unfinished run. Stores without it
   * get a check-then-create that is only safe within one process.
   */
  createIfIdle?(run: RunRecord): Promise<RunRecord | undefined>;
  get(id: string): Promise<RunRecord | undefined>;
  /**
   * Shallow merge; returns the updated record. Throws when the run doesn't exist. With `condition`
   * the update is a compare-and-set: it must be applied atomically (across processes too) and
   * throw `RunConflictError` when the stored record no longer matches.
   */
  update(id: string, patch: Partial<Omit<RunRecord, 'id'>>, condition?: RunUpdateCondition): Promise<RunRecord>;
  listByThread(threadId: string): Promise<RunRecord[]>;
  appendEvents(runId: string, events: readonly RunEvent[]): Promise<void>;
  /** Events with seq > afterSeq, in order. */
  events(runId: string, afterSeq: number): Promise<RunEvent[]>;
  /**
   * Atomically takes the oldest run that is 'queued', or 'running' with a heartbeat older than
   * `staleBefore` (its worker died), marks it 'running' with this worker and heartbeat now.
   */
  claim(workerId: string, staleBefore: string): Promise<RunRecord | undefined>;
}

/* ------------------------------------------------------------------ */
/* Tools, agents and generative UI (generated by `amoxi build`)       */
/* ------------------------------------------------------------------ */

/** What a tool method receives as its optional second parameter. */
export interface ToolContext {
  readonly runId: string;
  /**
   * Id of this tool call, the same when an interrupted call is run again on resume. Use it as an
   * idempotency key for side effects: two identical requests in one run are still two calls.
   */
  readonly callId: string;
  readonly threadId: string;
  readonly agent: string;
  /** Identity captured when the run started (AgentBehavior.principal), e.g. a customer id. */
  readonly principal: JsonValue | undefined;
  /** Aborted when the run is cancelled. */
  readonly signal: AbortSignal;
  /** Long-term memory of this run's subject. */
  readonly memory: AgentMemory;
  /** Show a generative UI component (one of the app's @generative islands) to the person. */
  ui(component: string, props: Record<string, unknown>): void;
  /** Report progress ("Searching flights...") to the person. */
  progress(message: string): void;
  /**
   * Runs `fn` once per tool call and key: when a run is resumed after a crash, an
   * @Tool({ idempotent: true }) tool is run again and completed steps return their recorded
   * results instead of repeating. Use it for side effects such as charging a card.
   */
  step<T extends JsonValue>(key: string, fn: () => Promise<T> | T): Promise<T>;
}

export interface ToolDefinition {
  /** Unique tool name (snake_case), as the model sees it. */
  readonly name: string;
  readonly description: string;
  readonly beanId: number;
  readonly inputSchema: JsonSchema;
  readonly outputSchema?: JsonSchema;
  /** Validates and cleans the model's arguments (generated from the parameter type). */
  readonly validate: GeneratedValidator;
  readonly invoke: (bean: any, input: any, ctx: ToolContext) => unknown;
  /** A person must approve each call (human in the loop). */
  readonly approval: boolean;
  /** Has no side effects (MCP readOnlyHint; safe to retry after a crash). */
  readonly readOnly: boolean;
  /** Safe to re-run with the same input (side effects guarded by ctx.step or an idempotency key). */
  readonly idempotent?: boolean;
  /** Offered to external agents over MCP. */
  readonly expose: boolean;
  /** Class.method, for errors and logs. */
  readonly source: string;
}

export interface AgentDefinition {
  /** URL-safe name, e.g. 'banking-assistant'. */
  readonly name: string;
  readonly description: string;
  readonly beanId: number;
  /** Names of the tools it may call. */
  readonly tools: readonly string[];
  /** Generative UI components it may show (each becomes a `show_<name>` tool). */
  readonly ui: readonly string[];
  /** Knowledge bases it can search (adds a `search_knowledge` tool). */
  readonly knowledge: readonly string[];
  /** Recall this many memories into the instructions at the start of each run (0 = off). */
  readonly recall: number;
  /** Adds a `remember` tool so the model can save facts. */
  readonly rememberTool: boolean;
  /** Example prompts (shown in UIs, MCP and A2A agent cards). */
  readonly examples: readonly string[];
  readonly maxTurns?: number;
  readonly model?: string;
  /** Hooks implemented by the class (generated from its methods). */
  readonly hooks: { readonly principal: boolean; readonly owner: boolean; readonly beforeToolCall: boolean; readonly onRunFinished: boolean };
}

export interface UiComponentDefinition {
  /** Island name, e.g. 'FlightOptions'. */
  readonly name: string;
  readonly description: string;
  readonly propsSchema: JsonSchema;
  readonly validate: GeneratedValidator;
  /** The island component, so the server can render it (transcripts, page reloads). */
  readonly component: (props: any) => unknown;
}

/** The `ai` section of the generated ApplicationModule. */
export interface AiModule {
  readonly tools: readonly ToolDefinition[];
  readonly agents: readonly AgentDefinition[];
  readonly components: readonly UiComponentDefinition[];
}

/**
 * Optional methods of an @Agent class (Template Method). Only `instructions` is required.
 */
export interface AgentBehavior {
  /** System prompt. Called at the start of every run. */
  instructions(ctx: AgentRunContext): string | Promise<string>;
  /**
   * Identity to capture for the run (it runs in the background, outside the HTTP request), e.g.
   * the signed-in customer's id from the session. Tools receive it as ToolContext.principal.
   */
  principal?(request: import('../runtime/types').RequestContext): JsonValue | undefined | Promise<JsonValue | undefined>;
  /**
   * Owner key for threads and runs: only requests with the same owner can read or continue them.
   * Default: an anonymous id kept in the encrypted session cookie.
   */
  owner?(request: import('../runtime/types').RequestContext): string | undefined | Promise<string | undefined>;
  /** Guardrail: return a string to refuse the call (sent to the model as the tool's error). */
  beforeToolCall?(call: { tool: string; input: unknown; ctx: ToolContext }): string | undefined | Promise<string | undefined>;
  /** Called when a run reaches a terminal state (audit, notifications, metrics). */
  onRunFinished?(run: RunRecord): void | Promise<void>;
}

export interface AgentRunContext {
  readonly run: RunRecord;
  readonly principal: JsonValue | undefined;
  /** Memories recalled for this run's input (when the agent has `recall`). */
  readonly memories: readonly MemoryItem[];
  readonly now: Date;
}

/* ------------------------------------------------------------------ */
/* Agent platform facade (used by HTTP endpoints, MCP and A2A)         */
/* ------------------------------------------------------------------ */

export interface StartRunRequest {
  readonly agent: string;
  readonly input: string;
  readonly owner: string;
  /** Continue a thread; a new one is created when omitted. */
  readonly threadId?: string;
  readonly principal?: JsonValue;
  readonly metadata?: Metadata;
}

export interface AgentInfo {
  readonly name: string;
  readonly description: string;
  readonly tools: readonly string[];
  readonly examples: readonly string[];
}

export interface ToolCallOutcome {
  readonly output: unknown;
  readonly isError: boolean;
  /** Components the tool showed (MCP clients get them as structured content). */
  readonly ui: readonly UiPart[];
}

/** Facade over the agent runtime (Facade pattern): the one entry point for every protocol. */
export interface AgentPlatform {
  agents(): readonly AgentInfo[];
  tool(name: string): ToolDefinition | undefined;
  tools(): readonly ToolDefinition[];
  /** Calls a tool directly (no model), validating its input; used by MCP. */
  callTool(name: string, input: unknown, options: { principal?: JsonValue; owner: string; signal?: AbortSignal }): Promise<ToolCallOutcome>;
  startRun(request: StartRunRequest): Promise<RunRecord>;
  getRun(id: string): Promise<RunRecord | undefined>;
  /** Replays events after `afterSeq`, then follows the run live; ends after its terminal event. */
  subscribe(runId: string, afterSeq: number, signal?: AbortSignal): AsyncIterable<RunEvent>;
  /** Decides a pending approval; the run continues once every pending call is decided. */
  decide(runId: string, callId: string, decision: { approved: boolean; note?: string }): Promise<RunRecord>;
  cancel(runId: string): Promise<RunRecord>;
  thread(id: string): Promise<{ thread: Thread; messages: ChatMessage[] } | undefined>;
  threads(owner: string, agent?: string): Promise<Thread[]>;
  /** Runs of a thread, oldest first. */
  runs(threadId: string): Promise<RunRecord[]>;
  /** Sequence number of a run's last durable event, to continue its stream (agentChat resume). */
  lastSeq(runId: string): Promise<number>;
}
