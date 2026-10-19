// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto';
import type { ApplicationContext } from '../../runtime/container';
import { HttpError, HttpResponse } from '../../runtime/http';
import { eventStream, lastEventId, type EventStreamResponse } from '../../runtime/sse';
import type { ExtensionRoute, RequestContext } from '../../runtime/types';
import { TERMINAL_STATUSES, type AgentBehavior, type AgentDefinition, type JsonValue, type RunRecord } from '../types';
import { toChatItems, type ChatItem } from './messages';
import type { DefaultAgentPlatform } from './platform';
import type { AiSettings } from './settings';

const SESSION_KEY = 'amoxi.ai.owner';

/**
 * The owner key Amoxi stores on threads and runs for a user id returned by an agent's
 * owner(req) hook. Use it to look up a user's conversations from your own code, e.g.
 * `platform.threads(userOwner(customerId), 'banking-assistant')`.
 */
export function userOwner(id: string): string {
  return `user:${id}`;
}

/** What clients see of a run (no checkpoint, principal or worker details). */
export function publicRun(run: RunRecord, base: string): Record<string, unknown> {
  const self = `${base}/${run.agent}/runs/${run.id}`;
  return {
    id: run.id,
    agent: run.agent,
    threadId: run.threadId,
    status: run.status,
    input: run.input,
    output: run.output ?? null,
    error: run.error ?? null,
    pending: (run.pending ?? []).filter((p) => !p.decision).map((p) => ({ callId: p.callId, tool: p.tool, input: p.input, reason: p.reason ?? null, requestedAt: p.requestedAt })),
    turns: run.turns,
    usage: run.usage,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    finishedAt: run.finishedAt ?? null,
    links: { self, events: `${self}/events`, cancel: `${self}/cancel`, thread: `${base}/${run.agent}/threads/${run.threadId}` },
  };
}

/**
 * REST + SSE endpoints of the agents, under `ai.path` (default /agents):
 *
 *   GET  /agents                                  list agents
 *   POST /agents/:agent/runs                      { input, threadId? } -> 202 run (or SSE with Accept: text/event-stream)
 *   GET  /agents/:agent/runs/:id                  run status, output, pending approvals
 *   GET  /agents/:agent/runs/:id/events           SSE; resumes after Last-Event-ID
 *   POST /agents/:agent/runs/:id/approvals/:call  { approved, note? } (SSE with Accept: text/event-stream)
 *   POST /agents/:agent/runs/:id/cancel
 *   GET  /agents/:agent/threads                   the caller's conversations
 *   GET  /agents/:agent/threads/:id               a conversation, as messages and chat items
 *
 * Conversations belong to an owner: by default an anonymous id kept in the encrypted session
 * cookie, or the agent's owner(request) hook (e.g. the signed-in user). Other owners get 404.
 * The app's middleware runs first, so authentication middleware protects these routes too.
 */
export function agentRoutes(platform: DefaultAgentPlatform, context: ApplicationContext, settings: AiSettings): ExtensionRoute[] {
  const base = settings.path;

  const agentOf = (ctx: RequestContext): { def: AgentDefinition; behavior: AgentBehavior } => {
    const def = platform.agent(ctx.params.agent);
    if (!def) throw new HttpError(404, `No agent named '${ctx.params.agent}'`);
    return { def, behavior: context.get<AgentBehavior>(def.beanId) };
  };

  const ownerOf = async (ctx: RequestContext, def: AgentDefinition, behavior: AgentBehavior, create: boolean): Promise<string | undefined> => {
    if (def.hooks.owner && behavior.owner) {
      const own = await behavior.owner(ctx);
      if (own) return userOwner(own);
    }
    let id = ctx.session.get<string>(SESSION_KEY);
    if (typeof id !== 'string') {
      if (!create) return undefined;
      id = randomUUID();
      ctx.session.set(SESSION_KEY, id);
    }
    return `session:${id}`;
  };

  /** The run, if it exists and belongs to the caller; 404 otherwise (never reveal other people's runs). */
  const ownedRun = async (ctx: RequestContext): Promise<{ run: RunRecord; def: AgentDefinition }> => {
    const { def, behavior } = agentOf(ctx);
    const owner = await ownerOf(ctx, def, behavior, false);
    const run = await platform.getRun(ctx.params.run);
    if (!run || !owner || run.owner !== owner || run.agent !== def.name) throw new HttpError(404, 'Run not found');
    return { run, def };
  };

  const wantsStream = (ctx: RequestContext): boolean => String(ctx.headers.accept ?? '').includes('text/event-stream');

  const stream = (runId: string, after: number, headers: Record<string, string> = {}): EventStreamResponse =>
    eventStream(
      async function* (signal) {
        for await (const e of platform.subscribe(runId, after, signal)) {
          yield { id: e.seq, event: e.type, data: { ...e.data, seq: e.seq, at: e.at } };
        }
      },
      { headers: { 'cache-control': 'no-store', ...headers } },
    );

  const body = (ctx: RequestContext): Record<string, unknown> => {
    const b = ctx.body;
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'Request body must be a JSON object');
    return b as Record<string, unknown>;
  };

  return [
    {
      method: 'GET',
      path: base,
      handler: () => ({
        agents: platform.agents().map((a) => ({ ...a, url: `${base}/${a.name}` })),
      }),
    },
    {
      method: 'GET',
      path: `${base}/:agent`,
      handler: (ctx) => {
        const { def } = agentOf(ctx);
        return { name: def.name, description: def.description, examples: def.examples, tools: def.tools, ui: def.ui, links: { runs: `${base}/${def.name}/runs`, threads: `${base}/${def.name}/threads` } };
      },
    },
    {
      method: 'POST',
      path: `${base}/:agent/runs`,
      needsBody: true,
      handler: async (ctx) => {
        const { def, behavior } = agentOf(ctx);
        const b = body(ctx);
        if (typeof b.input !== 'string') throw new HttpError(400, 'Invalid request body', { error: 'Invalid request body', details: [{ path: 'input', message: 'must be a string' }] });
        if (b.threadId !== undefined && typeof b.threadId !== 'string') throw new HttpError(400, 'Invalid request body', { error: 'Invalid request body', details: [{ path: 'threadId', message: 'must be a string' }] });
        const owner = (await ownerOf(ctx, def, behavior, true))!;
        const principal = def.hooks.principal && behavior.principal ? ((await behavior.principal(ctx)) as JsonValue | undefined) : undefined;
        const run = await platform.startRun({ agent: def.name, input: b.input, owner, threadId: b.threadId as string | undefined, principal });
        if (wantsStream(ctx)) return stream(run.id, 0, { 'x-amoxi-run-id': run.id, 'x-amoxi-thread-id': run.threadId });
        return new HttpResponse(202, publicRun(run, base), { location: `${base}/${def.name}/runs/${run.id}` });
      },
    },
    {
      method: 'GET',
      path: `${base}/:agent/runs/:run`,
      handler: async (ctx) => publicRun((await ownedRun(ctx)).run, base),
    },
    {
      method: 'GET',
      path: `${base}/:agent/runs/:run/events`,
      handler: async (ctx) => {
        const { run } = await ownedRun(ctx);
        const raw = lastEventId(ctx.headers, ctx.query) ?? ctx.query.get('after') ?? '0';
        const after = Number(raw);
        return stream(run.id, Number.isFinite(after) && after >= 0 ? after : 0);
      },
    },
    {
      method: 'POST',
      path: `${base}/:agent/runs/:run/approvals/:call`,
      needsBody: true,
      handler: async (ctx) => {
        const { run } = await ownedRun(ctx);
        const b = body(ctx);
        if (typeof b.approved !== 'boolean') throw new HttpError(400, 'Invalid request body', { error: 'Invalid request body', details: [{ path: 'approved', message: 'must be true or false' }] });
        const note = typeof b.note === 'string' ? b.note : undefined;
        const next = await platform.decide(run.id, ctx.params.call, { approved: b.approved, note });
        if (wantsStream(ctx)) {
          // ?after=<last event id the client saw> continues the stream without repeating events.
          const after = Number(ctx.query.get('after') ?? '0');
          return stream(next.id, Number.isFinite(after) && after >= 0 ? after : 0);
        }
        return publicRun(next, base);
      },
    },
    {
      method: 'POST',
      path: `${base}/:agent/runs/:run/cancel`,
      handler: async (ctx) => publicRun(await platform.cancel((await ownedRun(ctx)).run.id), base),
    },
    {
      method: 'GET',
      path: `${base}/:agent/threads`,
      handler: async (ctx) => {
        const { def, behavior } = agentOf(ctx);
        const owner = await ownerOf(ctx, def, behavior, false);
        if (!owner) return { threads: [] };
        const threads = await platform.threads(owner, def.name);
        return { threads: threads.map((t) => ({ id: t.id, title: t.title ?? null, createdAt: t.createdAt, updatedAt: t.updatedAt, url: `${base}/${def.name}/threads/${t.id}` })) };
      },
    },
    {
      method: 'GET',
      path: `${base}/:agent/threads/:thread`,
      handler: async (ctx) => {
        const { def, behavior } = agentOf(ctx);
        const owner = await ownerOf(ctx, def, behavior, false);
        const found = await platform.thread(ctx.params.thread);
        if (!found || !owner || found.thread.owner !== owner || found.thread.agent !== def.name) throw new HttpError(404, 'Conversation not found');
        // A run still in progress contributes its finished steps and any approval it waits for,
        // so a reloaded page shows the same conversation (approval cards included).
        const active = (await platform.runs(found.thread.id)).find((r) => !TERMINAL_STATUSES.has(r.status));
        const items: ChatItem[] = toChatItems([...found.messages, ...(active?.checkpoint ?? [])]);
        for (const p of active?.pending ?? []) {
          if (!p.decision) items.push({ kind: 'approval', id: `ap-${p.callId}`, callId: p.callId, tool: p.tool, input: p.input, reason: p.reason, status: 'pending' });
        }
        return {
          thread: { id: found.thread.id, title: found.thread.title ?? null, createdAt: found.thread.createdAt, updatedAt: found.thread.updatedAt },
          items,
          // lastSeq lets a chat client continue the run's event stream (agentChat({ resume })).
          activeRun: active ? { ...publicRun(active, base), lastSeq: await platform.lastSeq(active.id) } : null,
        };
      },
    },
  ];
}
