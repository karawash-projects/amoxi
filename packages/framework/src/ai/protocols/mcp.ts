// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

/**
 * Model Context Protocol server (Streamable HTTP transport), implemented from the specification.
 *
 * Dual-era on one endpoint:
 * - Modern (2026-07-28): stateless. Every request carries `params._meta["io.modelcontextprotocol/
 *   protocolVersion"]` plus the `MCP-Protocol-Version`, `Mcp-Method` and (for tools/call and
 *   resources/read) `Mcp-Name` headers, which must match the body. `server/discover` replaces
 *   `initialize`; results carry `resultType: "complete"`; list/read results carry caching hints.
 * - Legacy (2025-11-25, 2025-06-18, 2025-03-26): `initialize` / `notifications/initialized` /
 *   `ping`. No `Mcp-Session-Id` is minted (sessions are optional), so the server stays stateless
 *   and works behind any load balancer; GET and DELETE answer 405.
 *
 * Offered tools: every app tool with `expose: true` and `approval: false`, and one `ask_<agent>`
 * tool per agent. Tools that need a person's approval are never offered: MCP has no channel to
 * put a person in the loop on the server's side, and the calling model must not approve itself.
 */

import { randomUUID } from 'node:crypto';
import type { AgentInfo, AgentPlatform, JsonSchema, JsonValue, RunRecord, ToolDefinition } from '../types';
import { TERMINAL_STATUSES } from '../types';
import type { ExtensionRoute, RequestContext } from '../../runtime/types';
import { HttpResponse } from '../../runtime/http';
import { eventStream } from '../../runtime/sse';
import {
  accepts,
  anySignal,
  authenticate,
  checkTokens,
  Channel,
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
  success,
  toText,
  type JsonRpcId,
} from './jsonrpc';

export interface McpOptions {
  /** Endpoint path. Default '/mcp'. */
  readonly path?: string;
  /** Server name reported to clients. */
  readonly name: string;
  readonly version: string;
  /** Guidance for the client's model on how to use this server. */
  readonly instructions?: string;
  /** When set, every request must send `Authorization: Bearer <token>` (compared in constant time). */
  readonly token?: string;
  /**
   * One token per caller (name -> token). A request with one of them is accepted and owned by
   * 'mcp:<name>', so each caller keeps its own conversations and remembered facts.
   */
  readonly callers?: Readonly<Record<string, string>>;
  /** Browser origins allowed besides the server's own host (DNS-rebinding protection). */
  readonly allowedOrigins?: readonly string[];
  /** Identity passed to tools and runs (ToolContext.principal). */
  readonly principal?: (ctx: RequestContext) => JsonValue | undefined;
  /**
   * Owner of threads and runs started over MCP. Default: 'mcp:<name>' for a named caller (see
   * `callers`), otherwise a new owner per conversation, since such callers can't be told apart.
   */
  readonly owner?: (ctx: RequestContext) => string;
  /** Optional resources (documents, data) offered to clients. */
  readonly resources?: McpResourceProvider;
  /** Offer one `ask_<agent>` tool per agent. Default true. */
  readonly exposeAgents?: boolean;
  /**
   * What happens when an agent run started over MCP wants an action that needs a person's approval
   * (@Tool({ approval: true })). 'decline' (the default without an `owner` hook): the action is
   * declined, the agent is told why and finishes its answer. 'wait' (the default with `owner`): the run
   * pauses until the person it belongs to approves it in the app.
   */
  readonly approvals?: 'decline' | 'wait';
}

/** Declines approvals an MCP client can't give, at most this many times per call. */
const MAX_AUTO_DECLINES = 10;

/** Supplies MCP resources. `read` returns undefined for an unknown URI. */
export interface McpResourceProvider {
  list(): Promise<Array<{ uri: string; name: string; title?: string; description?: string; mimeType?: string }>>;
  read(uri: string): Promise<{ text: string; mimeType: string } | undefined>;
}

export const MCP_MODERN_VERSION = '2026-07-28';
export const MCP_LEGACY_VERSIONS: readonly string[] = ['2025-11-25', '2025-06-18', '2025-03-26'];
export const MCP_SUPPORTED_VERSIONS: readonly string[] = [MCP_MODERN_VERSION, ...MCP_LEGACY_VERSIONS];

/** MCP-specific JSON-RPC error codes. */
export const HEADER_MISMATCH = -32020;
export const MISSING_REQUIRED_CLIENT_CAPABILITY = -32021;
export const UNSUPPORTED_PROTOCOL_VERSION = -32022;
/** Legacy (≤ 2025-11-25) "resource not found". */
export const RESOURCE_NOT_FOUND_LEGACY = -32002;

const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';
/** Result `_meta` key carrying generative UI components a tool showed. */
const META_UI = 'js.amoxi/ui';
const PAGE_SIZE = 100;
const MAX_TOOL_NAME = 64;
const MAX_MESSAGE_CHARS = 100_000;
const LIST_TTL_MS = 60_000;

type Era = 'modern' | 'legacy';

interface CallContext {
  readonly era: Era;
  readonly version: string;
  readonly ctx: RequestContext;
  readonly params: Record<string, unknown>;
}

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: unknown;
  isError: boolean;
  _meta?: Record<string, unknown>;
}

/** Reports progress of a long tool call (only when the client asked for it). */
type ProgressSink = (message: string) => void;

/** One entry of the offered tool list. */
interface OfferedTool {
  readonly descriptor: Record<string, unknown>;
  call(args: Record<string, unknown>, cc: CallContext, signal: AbortSignal, progress: ProgressSink | undefined): Promise<ToolResult>;
}

/**
 * Creates the MCP endpoint routes (POST for JSON-RPC, GET/DELETE answering 405).
 *
 *   extensions: [{ routes: mcpRoutes(platform, { name: 'bank', version: '1.0.0', token: config.string('mcp.token', '') || undefined }) }]
 */
export function mcpRoutes(platform: AgentPlatform, options: McpOptions): ExtensionRoute[] {
  if (!options.name) throw new Error('mcpRoutes: options.name is required (the server name shown to MCP clients)');
  checkTokens('mcpRoutes', options.token, options.callers);
  const server = new McpServer(platform, options);
  const path = options.path ?? '/mcp';
  const notAllowed = (): HttpResponse => new HttpResponse(405, { error: 'Method Not Allowed: this MCP endpoint accepts POST only' }, { allow: 'POST' });
  return [
    { method: 'POST', path, needsBody: true, handler: (ctx) => server.handle(ctx) },
    { method: 'GET', path, handler: notAllowed },
    { method: 'DELETE', path, handler: notAllowed },
  ];
}

/** Handles one MCP POST. Stateless: every request is served on its own. */
class McpServer {
  private readonly exposeAgents: boolean;

  constructor(
    private readonly platform: AgentPlatform,
    private readonly options: McpOptions,
  ) {
    this.exposeAgents = options.exposeAgents ?? true;
  }

  async handle(ctx: RequestContext): Promise<unknown> {
    if (!this.originAllowed(ctx)) return json(403, failure(null, INVALID_REQUEST, 'Forbidden: Origin not allowed'));
    if (!authenticate(ctx, this.options.token, this.options.callers).ok) {
      return new HttpResponse(401, failure(null, INVALID_REQUEST, 'Unauthorized: send Authorization: Bearer <token>'), { 'www-authenticate': 'Bearer' });
    }
    const msg = parseMessage(ctx.body);
    if (msg.kind === 'invalid') return json(400, failure(msg.id, msg.error.code, msg.error.message));
    if (msg.kind === 'response') return new HttpResponse(202);

    const id: JsonRpcId = msg.kind === 'request' ? msg.id : null;
    const meta = isObject(msg.params._meta) ? msg.params._meta : undefined;
    const modernVersion = meta?.[META_VERSION];
    const headerVersion = header(ctx, 'mcp-protocol-version');

    let era: Era;
    let version: string;
    if (msg.method === 'initialize') {
      era = 'legacy';
      version = '';
    } else if (modernVersion !== undefined) {
      era = 'modern';
      version = String(modernVersion);
      if (version !== MCP_MODERN_VERSION) {
        return json(400, failure(id, UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', { supported: MCP_SUPPORTED_VERSIONS, requested: version }));
      }
      // Header rules are defined for requests only (the spec leaves notification POSTs open).
      const mismatch = msg.kind === 'request' ? this.headerMismatch(ctx, msg.method, msg.params, version) : undefined;
      if (mismatch) return json(400, failure(id, HEADER_MISMATCH, `Header mismatch: ${mismatch}`));
    } else {
      era = 'legacy';
      if (headerVersion === MCP_MODERN_VERSION) {
        return json(400, failure(id, HEADER_MISMATCH, `Header mismatch: MCP-Protocol-Version is ${MCP_MODERN_VERSION} but params._meta["${META_VERSION}"] is missing`));
      }
      if (headerVersion !== undefined && !MCP_LEGACY_VERSIONS.includes(headerVersion)) {
        return json(400, failure(id, UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', { supported: MCP_SUPPORTED_VERSIONS, requested: headerVersion }));
      }
      // Clients older than 2025-06-18 don't send the header (transport spec: assume 2025-03-26).
      version = headerVersion ?? '2025-03-26';
    }

    if (msg.kind === 'notification') return new HttpResponse(202);

    const cc: CallContext = { era, version, ctx, params: msg.params };
    try {
      if (msg.method === 'tools/call') return await this.toolsCall(id, cc);
      const result = await this.dispatch(msg.method, cc);
      return json(200, success(id, era === 'modern' ? { resultType: 'complete', ...result } : result));
    } catch (err) {
      return errorResponse(id, err);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Transport checks                                                  */
  /* ---------------------------------------------------------------- */

  /** DNS-rebinding protection: a browser Origin must be this host or explicitly allowed. */
  private originAllowed(ctx: RequestContext): boolean {
    const origin = header(ctx, 'origin');
    if (origin === undefined) return true;
    if (this.options.allowedOrigins?.includes(origin)) return true;
    try {
      const host = header(ctx, 'host');
      return host !== undefined && new URL(origin).host.toLowerCase() === host.toLowerCase();
    } catch {
      return false;
    }
  }

  /** Modern requests mirror body fields into headers; any disagreement is rejected. */
  private headerMismatch(ctx: RequestContext, method: string, params: Record<string, unknown>, version: string): string | undefined {
    const hv = header(ctx, 'mcp-protocol-version');
    if (hv !== version) return hv === undefined ? 'MCP-Protocol-Version header is required' : `MCP-Protocol-Version header '${hv}' does not match body value '${version}'`;
    const hm = header(ctx, 'mcp-method');
    if (hm !== method) return hm === undefined ? 'Mcp-Method header is required' : `Mcp-Method header '${hm}' does not match body value '${method}'`;
    if (method === 'tools/call' || method === 'resources/read' || method === 'prompts/get') {
      const bodyName = method === 'resources/read' ? params.uri : params.name;
      const raw = header(ctx, 'mcp-name');
      if (raw === undefined) return 'Mcp-Name header is required';
      const decoded = decodeHeaderValue(raw);
      if (decoded === undefined) return 'Mcp-Name header has an invalid encoding';
      if (decoded !== bodyName) return `Mcp-Name header value '${raw}' does not match body value '${String(bodyName)}'`;
    }
    return undefined;
  }

  /* ---------------------------------------------------------------- */
  /* Methods                                                           */
  /* ---------------------------------------------------------------- */

  private async dispatch(method: string, cc: CallContext): Promise<Record<string, unknown>> {
    const modern = cc.era === 'modern';
    switch (method) {
      case 'initialize':
        return this.initialize(cc.params);
      case 'ping':
        if (!modern) return {};
        break;
      case 'server/discover':
        if (modern) return this.discover();
        break;
      case 'tools/list':
        return this.toolsList(cc);
      case 'resources/list':
        if (this.options.resources) return this.resourcesList(cc);
        break;
      case 'resources/read':
        if (this.options.resources) return this.resourcesRead(cc);
        break;
      case 'resources/templates/list':
        if (this.options.resources) return modern ? { resourceTemplates: [], ttlMs: LIST_TTL_MS, cacheScope: 'public' } : { resourceTemplates: [] };
        break;
    }
    // 2026-07-28: an unimplemented method is HTTP 404 with -32601; legacy keeps HTTP 200.
    throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}`, undefined, modern ? 404 : 200);
  }

  private capabilities(): Record<string, unknown> {
    const caps: Record<string, unknown> = { tools: { listChanged: false } };
    if (this.options.resources) caps.resources = { subscribe: false, listChanged: false };
    return caps;
  }

  private initialize(params: Record<string, unknown>): Record<string, unknown> {
    const requested = params.protocolVersion;
    const protocolVersion = typeof requested === 'string' && MCP_LEGACY_VERSIONS.includes(requested) ? requested : MCP_LEGACY_VERSIONS[0];
    const result: Record<string, unknown> = {
      protocolVersion,
      capabilities: this.capabilities(),
      serverInfo: { name: this.options.name, version: this.options.version },
    };
    if (this.options.instructions) result.instructions = this.options.instructions;
    return result;
  }

  private discover(): Record<string, unknown> {
    const result: Record<string, unknown> = {
      supportedVersions: MCP_SUPPORTED_VERSIONS,
      capabilities: this.capabilities(),
      _meta: { [META_SERVER_INFO]: { name: this.options.name, version: this.options.version } },
      ttlMs: LIST_TTL_MS,
      cacheScope: 'public',
    };
    if (this.options.instructions) result.instructions = this.options.instructions;
    return result;
  }

  private toolsList(cc: CallContext): Record<string, unknown> {
    const tools = [...this.offeredTools().values()].map((t) => t.descriptor);
    const page = paginate(tools, cc.params.cursor);
    const result: Record<string, unknown> = { tools: page.items };
    if (page.nextCursor !== undefined) result.nextCursor = page.nextCursor;
    if (cc.era === 'modern') Object.assign(result, { ttlMs: LIST_TTL_MS, cacheScope: 'public' });
    return result;
  }

  private async resourcesList(cc: CallContext): Promise<Record<string, unknown>> {
    const all = await this.options.resources!.list();
    const page = paginate(all, cc.params.cursor);
    const result: Record<string, unknown> = { resources: page.items };
    if (page.nextCursor !== undefined) result.nextCursor = page.nextCursor;
    // Resources are app-defined and may depend on the caller: never shared between callers.
    if (cc.era === 'modern') Object.assign(result, { ttlMs: 0, cacheScope: 'private' });
    return result;
  }

  private async resourcesRead(cc: CallContext): Promise<Record<string, unknown>> {
    const uri = cc.params.uri;
    if (typeof uri !== 'string' || uri.length === 0 || uri.length > 2048) throw new RpcError(INVALID_PARAMS, 'params.uri must be a non-empty string');
    const found = await this.options.resources!.read(uri);
    if (!found) {
      throw new RpcError(cc.era === 'modern' ? INVALID_PARAMS : RESOURCE_NOT_FOUND_LEGACY, 'Resource not found', { uri });
    }
    const result: Record<string, unknown> = { contents: [{ uri, mimeType: found.mimeType, text: found.text }] };
    if (cc.era === 'modern') Object.assign(result, { ttlMs: 0, cacheScope: 'private' });
    return result;
  }

  /**
   * tools/call. Answers with a single JSON response, or with an SSE stream carrying
   * notifications/progress before the result when the client sent `_meta.progressToken` and
   * accepts text/event-stream. Closing that stream cancels the call (and the agent run).
   */
  private async toolsCall(id: JsonRpcId, cc: CallContext): Promise<unknown> {
    const { params, ctx } = cc;
    if (typeof params.name !== 'string' || params.name.length === 0) throw new RpcError(INVALID_PARAMS, 'params.name must be the tool name');
    const args = params.arguments ?? {};
    if (!isObject(args)) throw new RpcError(INVALID_PARAMS, 'params.arguments must be an object');
    const tool = this.offeredTools().get(params.name);
    if (!tool) throw new RpcError(INVALID_PARAMS, `Unknown tool: ${params.name}`);

    const meta = isObject(params._meta) ? params._meta : {};
    const token = meta.progressToken;
    const wantsProgress = (typeof token === 'string' || typeof token === 'number') && accepts(ctx, 'text/event-stream');
    const wrap = (r: ToolResult): Record<string, unknown> => (cc.era === 'modern' ? { resultType: 'complete', ...r } : { ...r });

    if (!wantsProgress) {
      const req = requestSignal(ctx);
      try {
        const result = await tool.call(args, cc, req.signal, undefined);
        return json(200, success(id, wrap(result)));
      } finally {
        req.dispose();
      }
    }

    return eventStream(async function* (signal) {
      const channel = new Channel<unknown>();
      let progress = 0;
      const sink: ProgressSink = (message) =>
        channel.push({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: ++progress, message } });
      tool
        .call(args, cc, signal, sink)
        .then(
          (result) => channel.push(success(id, wrap(result))),
          (err: unknown) => channel.push(errorBody(id, err)),
        )
        .finally(() => channel.close());
      for await (const message of channel) {
        if (signal.aborted) return;
        yield { data: message };
      }
    });
  }

  /* ---------------------------------------------------------------- */
  /* Tool catalogue                                                    */
  /* ---------------------------------------------------------------- */

  /** Name -> tool, in a stable order (app tools first, then agents). Built per request: cheap and always current. */
  private offeredTools(): Map<string, OfferedTool> {
    const map = new Map<string, OfferedTool>();
    for (const def of this.platform.tools()) {
      if (!def.expose || def.approval) continue;
      map.set(def.name, this.appTool(def));
    }
    if (this.exposeAgents) {
      for (const agent of this.platform.agents()) {
        const name = askToolName(agent.name);
        if (!map.has(name)) map.set(name, this.agentTool(agent, name));
      }
    }
    return map;
  }

  private appTool(def: ToolDefinition): OfferedTool {
    const outputSchema = def.outputSchema && def.outputSchema.type === 'object' ? def.outputSchema : undefined;
    const descriptor: Record<string, unknown> = {
      name: def.name,
      title: humanize(def.name),
      description: def.description,
      inputSchema: objectSchema(def.inputSchema),
      annotations: { readOnlyHint: def.readOnly, destructiveHint: !def.readOnly, idempotentHint: def.readOnly || !!def.idempotent, openWorldHint: false },
    };
    if (outputSchema) descriptor.outputSchema = outputSchema;
    return {
      descriptor,
      call: async (args, cc, signal) => {
        let outcome;
        try {
          outcome = await this.platform.callTool(def.name, args, { principal: this.principal(cc.ctx), owner: this.owner(cc.ctx) ?? `${ANONYMOUS_OWNER}${randomUUID()}`, signal });
        } catch (err) {
          // Validation and execution failures go back to the model so it can correct itself.
          return { content: [{ type: 'text', text: errorText(err) }], isError: true };
        }
        const result: ToolResult = { content: [{ type: 'text', text: toText(outcome.output) }], isError: outcome.isError };
        // With an outputSchema (always type object) the object output is the structured content.
        if (!outcome.isError && isObject(outcome.output)) result.structuredContent = outcome.output;
        if (outcome.ui.length > 0) result._meta = { [META_UI]: outcome.ui };
        return result;
      },
    };
  }

  private agentTool(agent: AgentInfo, name: string): OfferedTool {
    const readOnly = agent.tools.every((t) => this.platform.tool(t)?.readOnly ?? false);
    const descriptor: Record<string, unknown> = {
      name,
      title: `Ask ${humanize(agent.name).toLowerCase()}`,
      description:
        `${agent.description}\n\nSends a message to the "${agent.name}" agent and returns its answer. ` +
        'Pass the threadId from a previous answer to continue that conversation.' +
        (agent.examples.length > 0 ? `\nExamples: ${agent.examples.slice(0, 5).map((e) => JSON.stringify(e)).join(', ')}` : ''),
      inputSchema: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'What to ask the agent.', minLength: 1, maxLength: MAX_MESSAGE_CHARS },
          threadId: { type: 'string', description: 'Continue this conversation (threadId from an earlier answer).' },
        },
        required: ['message'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          runId: { type: 'string' },
          threadId: { type: 'string' },
          status: { type: 'string', enum: ['completed', 'failed', 'cancelled', 'awaiting_approval', 'running', 'queued'] },
          output: { type: 'string' },
        },
        required: ['runId', 'threadId', 'status'],
      },
      annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: false, openWorldHint: false },
    };
    return { descriptor, call: (args, cc, signal, progress) => this.askAgent(agent, args, cc, signal, progress) };
  }

  /** Runs an agent to its end (or until it pauses for a person's approval) and returns its answer. */
  private async askAgent(agent: AgentInfo, args: Record<string, unknown>, cc: CallContext, signal: AbortSignal, progress: ProgressSink | undefined): Promise<ToolResult> {
    const message = args.message;
    if (typeof message !== 'string' || message.trim().length === 0) return toolError('"message" is required: a non-empty string');
    if (message.length > MAX_MESSAGE_CHARS) return toolError(`"message" is too long (max ${MAX_MESSAGE_CHARS} characters)`);
    const caller = this.owner(cc.ctx);
    // Without an owner hook every conversation is its own caller (see owner()).
    let owner = caller ?? `${ANONYMOUS_OWNER}${randomUUID()}`;
    let threadId: string | undefined;
    if (args.threadId !== undefined) {
      if (typeof args.threadId !== 'string' || args.threadId.length > 200) return toolError('"threadId" must be a string');
      const found = await this.platform.thread(args.threadId);
      const allowed = found && (caller === undefined ? found.thread.owner.startsWith(ANONYMOUS_OWNER) : found.thread.owner === caller);
      if (!found || !allowed || found.thread.agent !== agent.name) {
        return toolError(`Unknown threadId "${args.threadId}": omit it to start a new conversation`);
      }
      threadId = args.threadId;
      owner = found.thread.owner;
    }

    const run = await this.platform.startRun({ agent: agent.name, input: message, owner, threadId, principal: this.principal(cc.ctx) });
    const onAbort = (): void => {
      // The client went away (closed the stream or the connection): stop the run.
      void this.platform
        .getRun(run.id)
        .then((r) => (r && !TERMINAL_STATUSES.has(r.status) ? this.platform.cancel(run.id) : undefined))
        .catch(() => undefined);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    const decline = (this.options.approvals ?? (this.options.owner ? 'wait' : 'decline')) === 'decline';
    try {
      let after = 0;
      for (let declines = 0; ; ) {
        for await (const event of this.platform.subscribe(run.id, after, signal)) {
          after = Math.max(after, Number.isInteger(event.seq) ? event.seq : after);
          if (!progress) continue;
          if (event.type === 'progress' && typeof event.data.message === 'string') progress(event.data.message);
          else if (event.type === 'tool.started' && typeof event.data.tool === 'string') progress(`Calling ${event.data.tool}`);
        }
        if (!decline || signal.aborted) break;
        const paused = await this.platform.getRun(run.id);
        if (!paused || paused.status !== 'awaiting_approval') break;
        // Nobody can approve over MCP: decline, so the agent explains instead of waiting forever.
        if (++declines > MAX_AUTO_DECLINES) {
          await this.platform.cancel(run.id);
          break;
        }
        for (const p of paused.pending ?? []) {
          if (p.decision) continue;
          await this.platform
            .decide(run.id, p.callId, { approved: false, note: 'This action needs a person\'s approval, which can\'t be given over MCP. Tell the user to do it in the app.' })
            .catch(() => undefined);
        }
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
    if (signal.aborted) {
      onAbort();
      throw new RpcError(INTERNAL_ERROR, 'Request cancelled by the client');
    }
    const final = (await this.platform.getRun(run.id)) ?? run;
    return agentResult(final);
  }

  /**
   * The caller's identity: the `owner` hook, else the named caller whose token was sent. Without
   * either, callers can't be told apart: each
   * conversation (and each direct tool call) then gets an owner of its own, and the unguessable
   * threadId is what lets a caller continue a conversation. So facts an agent remembers never reach
   * another caller's prompts.
   */
  private owner(ctx: RequestContext): string | undefined {
    const caller = authenticate(ctx, this.options.token, this.options.callers).caller;
    return this.options.owner?.(ctx) || (caller ? `mcp:${caller}` : undefined);
  }

  private principal(ctx: RequestContext): JsonValue | undefined {
    return this.options.principal?.(ctx);
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** `ask_<agent>` with '-' -> '_', limited to 64 characters. */
export function askToolName(agent: string): string {
  return `ask_${agent.replace(/-/g, '_').replace(/[^A-Za-z0-9_.]/g, '_')}`.slice(0, MAX_TOOL_NAME);
}

function agentResult(run: RunRecord): ToolResult {
  const structured: Record<string, unknown> = { runId: run.id, threadId: run.threadId, status: run.status };
  switch (run.status) {
    case 'completed': {
      const output = run.output ?? '';
      structured.output = output;
      return { content: [{ type: 'text', text: output }], structuredContent: structured, isError: false };
    }
    case 'awaiting_approval': {
      const pending = (run.pending ?? []).filter((p) => !p.decision).map((p) => p.tool);
      const what = pending.length > 0 ? ` to run ${pending.join(', ')}` : '';
      const text =
        `The ${run.agent} agent is waiting for a person's approval${what}. ` +
        `A person must approve it at /agents/${run.agent}/runs/${run.id}; the run then continues on its own. ` +
        `To follow up later, call this tool again with threadId "${run.threadId}".`;
      return { content: [{ type: 'text', text }], structuredContent: structured, isError: false };
    }
    case 'failed':
      return { content: [{ type: 'text', text: `The agent run failed: ${run.error?.message ?? 'unknown error'}` }], structuredContent: structured, isError: true };
    case 'cancelled':
      return { content: [{ type: 'text', text: 'The agent run was cancelled.' }], structuredContent: structured, isError: true };
    default:
      return { content: [{ type: 'text', text: `The agent run is still ${run.status}.` }], structuredContent: structured, isError: false };
  }
}

function toolError(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const issues = (err as { issues?: unknown }).issues;
    return Array.isArray(issues) && issues.length > 0 ? `${err.message}: ${toText(issues, 4000)}` : err.message;
  }
  return String(err);
}

function objectSchema(schema: JsonSchema): JsonSchema {
  if (!schema || typeof schema !== 'object') return { type: 'object' };
  return schema.type === 'object' ? schema : { type: 'object', ...schema };
}

function paginate<T>(items: readonly T[], cursor: unknown): { items: T[]; nextCursor?: string } {
  if (items.length <= PAGE_SIZE && (cursor === undefined || cursor === null)) return { items: [...items] };
  const start = decodeCursor(cursor, items.length);
  if (start === undefined) throw new RpcError(INVALID_PARAMS, 'Invalid cursor');
  const end = start + PAGE_SIZE;
  return end < items.length ? { items: items.slice(start, end), nextCursor: encodeCursor(end) } : { items: items.slice(start) };
}

/** Decodes the `=?base64?…?=` sentinel form of Mcp-Name / Mcp-Param-* values. */
function decodeHeaderValue(raw: string): string | undefined {
  const m = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/.exec(raw);
  if (!m) return raw.startsWith('=?base64?') ? undefined : raw;
  return Buffer.from(m[1], 'base64').toString('utf8');
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function json(status: number, body: unknown): HttpResponse {
  return new HttpResponse(status, body, { 'content-type': 'application/json' });
}

function errorBody(id: JsonRpcId, err: unknown): unknown {
  if (err instanceof RpcError) return failure(id, err.code, err.message, err.data);
  return failure(id, INTERNAL_ERROR, 'Internal error');
}

function errorResponse(id: JsonRpcId, err: unknown): HttpResponse {
  // Unexpected failures stay HTTP 200 with a JSON-RPC internal error (details are not leaked).
  return json(err instanceof RpcError ? err.httpStatus : 200, errorBody(id, err));
}

/** Owner prefix of conversations started by callers the app doesn't identify. */
const ANONYMOUS_OWNER = 'mcp:anonymous:';
