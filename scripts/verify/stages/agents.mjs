// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import { APPS, signIn } from '../lib/apps.mjs';
import { Client } from '../lib/http.mjs';
import { startProduction } from './production.mjs';

const TERMINAL = new Set(['run.completed', 'run.failed']);

/** The agent runtime end to end, in production mode, against every agent example. */
export const agents = {
  id: 'agents',
  title: 'AI agents end to end',
  description: 'runs over SSE, resume with Last-Event-ID, conversations, MCP and A2A, against every agent example',
  quick: true,
  needs: ['build'],
  async run(ctx) {
    for (const app of APPS.filter((a) => a.agent)) {
      const started = await ctx.check(`${app.id}: starts in production`, () => startProduction(ctx, app));
      if (!started) continue;
      const c = new Client(started.base);
      await signIn(c, app);

      await ctx.check(`${app.id}: the agent is listed`, async () => {
        const { res, data } = await c.json('/agents');
        ctx.assert.equal(res.status, 200);
        ctx.assert.ok(data.agents.some((a) => a.name === app.agent), JSON.stringify(data));
      });

      const first = await ctx.check(`${app.id}: a streamed run completes ("${app.prompt}")`, async () => {
        const { res, events, text } = await c.sse(`/agents/${app.agent}/runs`, { method: 'POST', json: { input: app.prompt } });
        ctx.assert.equal(res.status, 200, text);
        ctx.assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
        const last = events.at(-1);
        ctx.assert.equal(last?.event, 'run.completed', `ended with ${JSON.stringify(last)}`);
        const ids = events.map((e) => Number(e.id));
        ctx.assert.deepEqual([...ids].sort((a, b) => a - b), ids, 'event ids are not increasing');
        ctx.assert.ok(events.some((e) => e.event === 'message.delta'), 'no token streaming');
        return { runId: events[0].data.runId, threadId: events[0].data.threadId, events };
      });
      if (!first) continue;

      await ctx.check(`${app.id}: reconnecting with Last-Event-ID replays only what was missed`, async () => {
        const all = await c.sse(`/agents/${app.agent}/runs/${first.runId}/events`);
        const durable = all.events.filter((e) => Number.isInteger(Number(e.id)));
        ctx.assert.equal(all.events.at(-1)?.event, 'run.completed');
        const cut = durable[Math.floor(durable.length / 2)].id;
        const rest = await c.sse(`/agents/${app.agent}/runs/${first.runId}/events`, { headers: { 'last-event-id': cut } });
        ctx.assert.deepEqual(
          rest.events.map((e) => e.id),
          all.events.filter((e) => Number(e.id) > Number(cut)).map((e) => e.id),
        );
      });

      await ctx.check(`${app.id}: the conversation continues in the same thread and is stored`, async () => {
        const { events } = await c.sse(`/agents/${app.agent}/runs`, { method: 'POST', json: { input: app.prompt, threadId: first.threadId } });
        ctx.assert.ok(TERMINAL.has(events.at(-1)?.event ?? ''), `ended with ${events.at(-1)?.event}`);
        ctx.assert.equal(events[0].data.threadId, first.threadId);
        const { res, data } = await c.json(`/agents/${app.agent}/threads/${first.threadId}`);
        ctx.assert.equal(res.status, 200);
        ctx.assert.ok(data.items.filter((i) => i.kind === 'user').length >= 2, 'both messages are in the thread');
        const list = await c.json(`/agents/${app.agent}/threads`);
        ctx.assert.ok(list.data.threads.some((t) => t.id === first.threadId));
      });

      await ctx.check(`${app.id}: bad input is rejected cleanly (400/404/413, never 500)`, async () => {
        const cases = [
          [{ input: 42 }, 400],
          [{ input: '   ' }, 400],
          [{ input: 'x'.repeat(25_000) }, 413],
          [{ input: 'hi', threadId: 'does-not-exist' }, 404],
        ];
        for (const [json, status] of cases) {
          const res = await c.request(`/agents/${app.agent}/runs`, { method: 'POST', json });
          await res.arrayBuffer();
          ctx.assert.equal(res.status, status, `${JSON.stringify(json).slice(0, 60)} -> ${res.status}`);
        }
        const unknown = await c.request('/agents/no-such-agent/runs', { method: 'POST', json: { input: 'hi' } });
        await unknown.arrayBuffer();
        ctx.assert.equal(unknown.status, 404);
      });

      await ctx.check(`${app.id}: a client that disconnects mid-stream doesn't break the run`, async () => {
        const controller = new AbortController();
        const res = await fetch(`${started.base}/agents/${app.agent}/runs`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'text/event-stream', 'sec-fetch-site': 'same-origin', cookie: c.cookieHeader() },
          body: JSON.stringify({ input: app.prompt }),
          signal: controller.signal,
        });
        const runId = res.headers.get('x-amoxi-run-id');
        controller.abort();
        ctx.assert.ok(runId, 'no run id header');
        const deadline = Date.now() + 30_000;
        for (;;) {
          const { data } = await c.json(`/agents/${app.agent}/runs/${runId}`);
          if (['completed', 'failed', 'awaiting_approval', 'cancelled'].includes(data?.status)) {
            ctx.assert.notEqual(data.status, 'failed', JSON.stringify(data.error));
            break;
          }
          if (Date.now() > deadline) throw new Error(`run still ${data?.status} after 30 s`);
          await new Promise((r) => setTimeout(r, 200));
        }
      });

      if (app.mcpToken) {
        await ctx.check(`${app.id}: MCP lists tools and answers calls with protocol errors, not crashes`, async () => {
          const rpc = async (body, version = '2026-07-28') => {
            const res = await fetch(`${started.base}/mcp`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${app.mcpToken}`, 'mcp-protocol-version': version, 'mcp-method': body.method, ...(body.params?.name ? { 'mcp-name': body.params.name } : {}) },
              body: JSON.stringify(body),
            });
            return { status: res.status, data: await res.json().catch(() => undefined) };
          };
          const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' };
          const list = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: meta } });
          ctx.assert.equal(list.status, 200);
          const tools = list.data.result.tools;
          ctx.assert.ok(tools.length >= 1);
          for (const t of tools) ctx.assert.equal(t.inputSchema?.type, 'object', `${t.name} has no object input schema`);
          const bad = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tools[0].name, arguments: { unexpected: { deeply: ['nested'] } }, _meta: meta } });
          ctx.assert.ok(bad.status < 500, `tools/call with bad arguments -> HTTP ${bad.status}`);
          ctx.assert.ok(bad.data?.error || bad.data?.result?.isError !== undefined, JSON.stringify(bad.data));
          const legacy = await rpc({ jsonrpc: '2.0', id: 3, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'verify', version: '1' } } }, '2025-11-25');
          ctx.assert.equal(legacy.data?.result?.protocolVersion, '2025-11-25');
        });
      }
      if (app.a2aToken) {
        await ctx.check(`${app.id}: A2A answers message/send (v0.3) and SendMessage (v1.0) without server errors`, async () => {
          const call = async (method, params, version) => {
            const res = await fetch(`${started.base}/a2a`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', authorization: `Bearer ${app.a2aToken}`, ...(version ? { 'a2a-version': version } : {}) },
              body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
            });
            return { status: res.status, data: await res.json().catch(() => undefined) };
          };
          const v03 = await call('message/send', { message: { kind: 'message', role: 'user', messageId: 'verify-1', parts: [{ kind: 'text', text: app.prompt }] } });
          ctx.assert.equal(v03.status, 200);
          ctx.assert.ok(v03.data?.result || v03.data?.error, JSON.stringify(v03.data));
          const v1 = await call('SendMessage', { message: { role: 'ROLE_USER', messageId: 'verify-2', parts: [{ text: app.prompt }] } }, '1.0');
          ctx.assert.equal(v1.status, 200);
          ctx.assert.ok(v1.data?.result || v1.data?.error, JSON.stringify(v1.data));
          const card = await (await fetch(`${started.base}/.well-known/agent-card.json`)).json();
          ctx.assert.ok(card.supportedInterfaces?.[0]?.url?.startsWith('http'), 'card has no interface URL');
        });
      }
    }
  },
};
