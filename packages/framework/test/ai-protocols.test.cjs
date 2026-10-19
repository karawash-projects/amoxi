// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0
'use strict';
// MCP and A2A servers, driven through their route handlers with a fake AgentPlatform.
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./dist.cjs');

const { mcpRoutes, askToolName } = load('ai/protocols/mcp');
const { a2aRoutes, parseDecision } = load('ai/protocols/a2a');
const { HttpResponse } = load('runtime/http');
const { EventStreamResponse } = load('runtime/sse');

const TOKEN = 'secret-token-0123456789abcdef';
const MODERN = '2026-07-28';
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

/* ------------------------------------------------------------------ */
/* Fake platform: in-memory runs driven by scripts keyed on the input  */
/* ------------------------------------------------------------------ */

function fakePlatform() {
  const runs = new Map();
  const events = new Map();
  const threads = new Map();
  let waiters = [];
  let n = 0;
  const now = () => new Date(Date.now() + n).toISOString();
  const wake = () => {
    const w = waiters;
    waiters = [];
    for (const f of w) f();
  };
  const tick = () => new Promise((r) => setImmediate(r));

  const update = (id, patch) => {
    const r = { ...runs.get(id), ...patch, updatedAt: now() };
    runs.set(id, r);
    return r;
  };
  const emit = (id, type, data) => {
    const list = events.get(id);
    list.push({ seq: list.length + 1, runId: id, type, data, at: now() });
    wake();
  };
  const setStatus = (id, status, extra = {}) => {
    update(id, { status, ...extra });
    emit(id, 'run.status', { status });
  };
  const finish = (id, output) => {
    const r = runs.get(id);
    const t = threads.get(r.threadId);
    t.messages.push({ id: `${id}-u`, role: 'user', content: [{ type: 'text', text: r.input }], runId: id });
    t.messages.push({ id: `${id}-a`, role: 'assistant', content: [{ type: 'text', text: output }], runId: id });
    update(id, { output, finishedAt: now() });
    emit(id, 'run.completed', { output, usage: { inputTokens: 1, outputTokens: 1 } });
    setStatus(id, 'completed');
  };

  async function script(id) {
    const input = runs.get(id).input;
    await tick();
    if (runs.get(id).status === 'cancelled') return;
    setStatus(id, 'running', { startedAt: now() });
    await tick();
    if (input.includes('fail')) {
      update(id, { error: { message: 'model exploded' } });
      emit(id, 'run.failed', { error: { message: 'model exploded' } });
      setStatus(id, 'failed');
      return;
    }
    if (input.includes('slow')) return; // waits for cancel()
    if (input.includes('transfer')) {
      emit(id, 'message.delta', { text: 'Checking. ' });
      emit(id, 'tool.started', { callId: 'c0', tool: 'get_balance', input: {} });
      emit(id, 'tool.completed', { callId: 'c0', tool: 'get_balance', output: { balance: 100 }, isError: false });
      const pending = [{ callId: 'c1', tool: 'transfer', input: { amount: 5 }, reason: 'Moves money', requestedAt: now() }];
      update(id, { pending });
      emit(id, 'approval.required', { callId: 'c1', tool: 'transfer', input: { amount: 5 }, reason: 'Moves money' });
      setStatus(id, 'awaiting_approval');
      return; // resumed by decide()
    }
    emit(id, 'progress', { message: 'Looking things up' });
    emit(id, 'message.delta', { text: 'Hello ' });
    await tick();
    emit(id, 'message.delta', { text: 'world' });
    emit(id, 'message.completed', { text: 'Hello world' });
    finish(id, 'Hello world');
  }

  async function resume(id) {
    await tick();
    const approved = runs.get(id).pending.every((p) => p.decision.approved);
    setStatus(id, 'running');
    await tick();
    const out = approved ? 'Transferred 5 EUR' : 'Transfer denied';
    emit(id, 'message.delta', { text: out });
    finish(id, out);
  }

  const tools = [
    { name: 'get_balance', description: 'Account balance', inputSchema: { type: 'object', properties: { account: { type: 'string' } }, required: ['account'] }, outputSchema: { type: 'object', properties: { balance: { type: 'number' } } }, approval: false, readOnly: true, expose: true },
    { name: 'transfer', description: 'Move money', inputSchema: { type: 'object' }, approval: true, readOnly: false, expose: true },
    { name: 'internal_audit', description: 'Hidden', inputSchema: { type: 'object' }, approval: false, readOnly: true, expose: false },
    { name: 'send_email', description: 'Sends mail', inputSchema: { properties: { to: { type: 'string' } } }, approval: false, readOnly: false, expose: true },
  ];
  const calls = [];

  const platform = {
    calls,
    runs,
    agents: () => [
      { name: 'banking-assistant', description: 'Helps with accounts', tools: ['get_balance', 'transfer'], examples: ['What is my balance?'] },
      { name: 'faq', description: 'Answers questions', tools: [], examples: [] },
    ],
    tools: () => tools,
    tool: (name) => tools.find((t) => t.name === name),
    async callTool(name, input, options) {
      calls.push({ name, input, options });
      if (name === 'get_balance') {
        if (typeof input.account !== 'string') throw Object.assign(new Error('Invalid tool input'), { issues: [{ path: 'account', message: 'is required' }] });
        return { output: { balance: 100, account: input.account }, isError: false, ui: [{ type: 'ui', id: 'u1', component: 'Balance', props: { balance: 100 } }] };
      }
      if (name === 'send_email') return { output: 'SMTP down', isError: true, ui: [] };
      throw new Error(`no tool ${name}`);
    },
    async startRun(req) {
      n++;
      const id = `run-${n}`;
      let threadId = req.threadId;
      if (!threadId) {
        threadId = `thread-${n}`;
        threads.set(threadId, { thread: { id: threadId, owner: req.owner, agent: req.agent, createdAt: now(), updatedAt: now() }, messages: [] });
      }
      const rec = { id, agent: req.agent, threadId, owner: req.owner, status: 'queued', input: req.input, principal: req.principal, createdAt: now(), updatedAt: now(), turns: 0, usage: { inputTokens: 0, outputTokens: 0 } };
      runs.set(id, rec);
      events.set(id, [{ seq: 1, runId: id, type: 'run.status', data: { status: 'queued' }, at: now() }]);
      void script(id);
      return rec;
    },
    async getRun(id) {
      return runs.get(id);
    },
    async *subscribe(runId, afterSeq, signal) {
      let seq = afterSeq;
      for (;;) {
        const list = events.get(runId) || [];
        for (const e of list.filter((x) => x.seq > seq)) {
          seq = e.seq;
          yield e;
        }
        const r = runs.get(runId);
        if (!r || TERMINAL.has(r.status)) return;
        if (r.status === 'awaiting_approval' && r.pending.some((p) => !p.decision)) return;
        if (signal && signal.aborted) return;
        await new Promise((res) => {
          waiters.push(res);
          if (signal) signal.addEventListener('abort', res, { once: true });
        });
      }
    },
    async decide(runId, callId, decision) {
      const r = runs.get(runId);
      const pending = r.pending.map((p) => (p.callId === callId ? { ...p, decision: { ...decision, decidedAt: now() } } : p));
      const rec = update(runId, { pending });
      if (pending.every((p) => p.decision)) void resume(runId);
      return rec;
    },
    async cancel(runId) {
      const rec = update(runId, { status: 'cancelled', finishedAt: now() });
      emit(runId, 'run.status', { status: 'cancelled' });
      return rec;
    },
    async thread(id) {
      return threads.get(id);
    },
    async threads(owner) {
      return [...threads.values()].filter((t) => t.thread.owner === owner).map((t) => t.thread).reverse();
    },
  };
  return platform;
}

/* ------------------------------------------------------------------ */
/* Request helpers                                                     */
/* ------------------------------------------------------------------ */

function makeCtx(method, path, headers = {}, body) {
  return { id: 'req-1', method, path, search: '', params: {}, query: new URLSearchParams(), headers: { host: 'localhost:3000', ...headers }, body, protocol: 'http', state: {}, res: undefined };
}

function route(routes, method, path) {
  const r = routes.find((x) => x.method === method && x.path === path);
  assert.ok(r, `route ${method} ${path}`);
  return r;
}

async function drain(resp) {
  assert.ok(resp instanceof EventStreamResponse, 'expected an event stream');
  const out = [];
  for await (const e of resp.source(new AbortController().signal)) out.push(typeof e.data === 'string' ? JSON.parse(e.data) : e.data);
  return out;
}

const modernHeaders = (method, name) => ({ 'mcp-protocol-version': MODERN, 'mcp-method': method, ...(name !== undefined ? { 'mcp-name': name } : {}) });
const modernBody = (id, method, params = {}) => ({ jsonrpc: '2.0', id, method, params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN, 'io.modelcontextprotocol/clientCapabilities': {}, ...(params._meta || {}) } } });

function mcp(options = {}) {
  const platform = fakePlatform();
  const routes = mcpRoutes(platform, { name: 'bank', version: '1.2.3', instructions: 'Use ask_ tools', ...options });
  const post = route(routes, 'POST', options.path || '/mcp');
  const call = (headers, body) => post.handler(makeCtx('POST', '/mcp', headers, body));
  const modern = (id, method, params, extraHeaders = {}) => {
    const name = method === 'tools/call' ? params.name : method === 'resources/read' ? params.uri : undefined;
    return call({ ...modernHeaders(method, name), ...extraHeaders }, modernBody(id, method, params));
  };
  const legacy = (id, method, params, extraHeaders = {}) => call({ 'mcp-protocol-version': '2025-11-25', ...extraHeaders }, { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
  return { platform, routes, call, modern, legacy };
}

/* ------------------------------------------------------------------ */
/* MCP                                                                 */
/* ------------------------------------------------------------------ */

test('MCP modern: server/discover is stateless and advertises both eras', async () => {
  const { modern } = mcp();
  const res = await modern(1, 'server/discover', {});
  assert.ok(res instanceof HttpResponse);
  assert.equal(res.status, 200);
  const r = res.body.result;
  assert.equal(r.resultType, 'complete');
  assert.deepEqual(r.supportedVersions, ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26']);
  assert.deepEqual(r._meta['io.modelcontextprotocol/serverInfo'], { name: 'bank', version: '1.2.3' });
  assert.equal(r.instructions, 'Use ask_ tools');
  assert.equal(typeof r.ttlMs, 'number');
  assert.equal(r.cacheScope, 'public');
  assert.deepEqual(r.capabilities.tools, { listChanged: false });
  assert.equal(r.capabilities.resources, undefined);
});

test('MCP legacy: initialize, initialized notification and ping', async () => {
  const { call, legacy } = mcp();
  const init = await call({}, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } } });
  assert.equal(init.status, 200);
  assert.equal(init.body.result.protocolVersion, '2025-06-18');
  assert.deepEqual(init.body.result.serverInfo, { name: 'bank', version: '1.2.3' });
  assert.equal(init.body.result.resultType, undefined, 'legacy results have no resultType');
  assert.equal(init.headers['mcp-session-id'], undefined, 'no session minted');
  const unknownVersion = await call({}, { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2099-01-01' } });
  assert.equal(unknownVersion.body.result.protocolVersion, '2025-11-25');
  const note = await call({ 'mcp-protocol-version': '2025-06-18' }, { jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(note.status, 202);
  assert.equal(note.body, undefined);
  const ping = await legacy(3, 'ping');
  assert.deepEqual(ping.body, { jsonrpc: '2.0', id: 3, result: {} });
  const noHeader = await call({}, { jsonrpc: '2.0', id: 4, method: 'ping' });
  assert.deepEqual(noHeader.body.result, {}, 'missing header = 2025-03-26');
});

test('MCP: ping is removed in 2026-07-28; unknown methods are 404/-32601', async () => {
  const { modern, legacy } = mcp();
  const ping = await modern(1, 'ping', {});
  assert.equal(ping.status, 404);
  assert.equal(ping.body.error.code, -32601);
  const unknownLegacy = await legacy(2, 'prompts/list');
  assert.equal(unknownLegacy.status, 200);
  assert.equal(unknownLegacy.body.error.code, -32601);
});

test('MCP tools/list: exposed non-approval tools, ask_ tools and annotations', async () => {
  const { modern, legacy } = mcp();
  const res = await modern(1, 'tools/list', {});
  const tools = res.body.result.tools;
  const names = tools.map((t) => t.name);
  assert.deepEqual(names, ['get_balance', 'send_email', 'ask_banking_assistant', 'ask_faq']);
  assert.equal(res.body.result.nextCursor, undefined);
  assert.equal(res.body.result.cacheScope, 'public');
  const bal = tools[0];
  assert.deepEqual(bal.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  assert.equal(bal.outputSchema.type, 'object');
  assert.equal(bal.title, 'Get balance');
  assert.equal(tools[1].inputSchema.type, 'object', 'schema without type gets type object');
  assert.equal(tools[1].annotations.destructiveHint, true);
  const ask = tools[2];
  assert.deepEqual(ask.inputSchema.required, ['message']);
  assert.ok(ask.inputSchema.properties.threadId);
  assert.match(ask.description, /Helps with accounts/);
  assert.equal(ask.annotations.readOnlyHint, false, 'agent with a non-read-only tool');
  assert.equal(tools[3].annotations.readOnlyHint, true, 'agent without tools is read-only');
  const old = await legacy(2, 'tools/list');
  assert.equal(old.body.result.tools.length, 4);
  assert.equal(old.body.result.ttlMs, undefined);
  assert.equal(askToolName('a'.repeat(100)).length, 64);
});

test('MCP tools/list paginates beyond 100 tools', async () => {
  const platform = fakePlatform();
  const many = Array.from({ length: 150 }, (_, i) => ({ name: `t${i}`, description: 'x', inputSchema: { type: 'object' }, approval: false, readOnly: true, expose: true }));
  platform.tools = () => many;
  const post = route(mcpRoutes(platform, { name: 's', version: '1', exposeAgents: false }), 'POST', '/mcp');
  const first = await post.handler(makeCtx('POST', '/mcp', modernHeaders('tools/list'), modernBody(1, 'tools/list')));
  assert.equal(first.body.result.tools.length, 100);
  assert.ok(first.body.result.nextCursor);
  const second = await post.handler(makeCtx('POST', '/mcp', modernHeaders('tools/list'), modernBody(2, 'tools/list', { cursor: first.body.result.nextCursor })));
  assert.equal(second.body.result.tools.length, 50);
  assert.equal(second.body.result.nextCursor, undefined);
  const bad = await post.handler(makeCtx('POST', '/mcp', modernHeaders('tools/list'), modernBody(3, 'tools/list', { cursor: '!!' })));
  assert.equal(bad.body.error.code, -32602);
});

test('MCP tools/call: success with structuredContent, ui meta, owner and principal', async () => {
  const { modern, platform } = mcpWith({ owner: () => 'acme', principal: () => ({ customer: 7 }) });
  const res = await modern(1, 'tools/call', { name: 'get_balance', arguments: { account: 'A1' } });
  const r = res.body.result;
  assert.equal(r.resultType, 'complete');
  assert.equal(r.isError, false);
  assert.deepEqual(r.structuredContent, { balance: 100, account: 'A1' });
  assert.deepEqual(JSON.parse(r.content[0].text), { balance: 100, account: 'A1' });
  assert.equal(r._meta['js.amoxi/ui'][0].component, 'Balance');
  assert.equal(platform.calls[0].options.owner, 'acme');
  assert.deepEqual(platform.calls[0].options.principal, { customer: 7 });
});

function mcpWith(options) {
  return mcp(options);
}

test('MCP tools/call: tool errors, invalid input, unknown and hidden tools', async () => {
  const { modern, legacy } = mcp();
  const failed = await modern(1, 'tools/call', { name: 'send_email', arguments: { to: 'x' } });
  assert.equal(failed.body.result.isError, true);
  assert.equal(failed.body.result.content[0].text, 'SMTP down');
  assert.equal(failed.body.result.structuredContent, undefined);
  const invalid = await modern(2, 'tools/call', { name: 'get_balance', arguments: {} });
  assert.equal(invalid.body.result.isError, true);
  assert.match(invalid.body.result.content[0].text, /Invalid tool input.*account/);
  const unknown = await modern(3, 'tools/call', { name: 'nope', arguments: {} });
  assert.equal(unknown.body.error.code, -32602);
  const approvalTool = await legacy(4, 'tools/call', { name: 'transfer', arguments: {} });
  assert.equal(approvalTool.body.error.code, -32602, 'approval tools are not offered');
  const hidden = await legacy(5, 'tools/call', { name: 'internal_audit', arguments: {} });
  assert.equal(hidden.body.error.code, -32602);
  const badArgs = await legacy(6, 'tools/call', { name: 'get_balance', arguments: [1] });
  assert.equal(badArgs.body.error.code, -32602);
});

test('MCP ask_ tool with approvals: "wait" (apps that map MCP callers to people) reports the pause', async () => {
  const { legacy } = mcp({ approvals: 'wait' });
  const paused = await legacy(1, 'tools/call', { name: 'ask_banking_assistant', arguments: { message: 'transfer 5' } });
  assert.equal(paused.body.result.isError, false);
  assert.equal(paused.body.result.structuredContent.status, 'awaiting_approval');
  assert.match(paused.body.result.content[0].text, /\/agents\/banking-assistant\/runs\/run-\d+/);
});

test('MCP ask_ tool: runs the agent, continues a thread, declines approvals it cannot get, reports failures', async () => {
  const { modern, legacy } = mcp();
  const res = await modern(1, 'tools/call', { name: 'ask_faq', arguments: { message: 'hi' } });
  const r = res.body.result;
  assert.equal(r.content[0].text, 'Hello world');
  assert.equal(r.structuredContent.status, 'completed');
  assert.match(r.structuredContent.runId, /^run-/);
  const again = await legacy(2, 'tools/call', { name: 'ask_faq', arguments: { message: 'more', threadId: r.structuredContent.threadId } });
  assert.equal(again.body.result.structuredContent.threadId, r.structuredContent.threadId);
  const wrongThread = await legacy(3, 'tools/call', { name: 'ask_banking_assistant', arguments: { message: 'x', threadId: r.structuredContent.threadId } });
  assert.equal(wrongThread.body.result.isError, true, 'thread of another agent');
  // Nobody can approve over MCP, so by default the action is declined and the agent finishes.
  const declined = await legacy(4, 'tools/call', { name: 'ask_banking_assistant', arguments: { message: 'transfer 5' } });
  assert.equal(declined.body.result.isError, false);
  assert.equal(declined.body.result.structuredContent.status, 'completed');
  assert.equal(declined.body.result.content[0].text, 'Transfer denied');
  const failed = await legacy(5, 'tools/call', { name: 'ask_faq', arguments: { message: 'please fail' } });
  assert.equal(failed.body.result.isError, true);
  assert.match(failed.body.result.content[0].text, /model exploded/);
  const empty = await legacy(6, 'tools/call', { name: 'ask_faq', arguments: { message: '  ' } });
  assert.equal(empty.body.result.isError, true);
});

test('MCP tools/call streams notifications/progress over SSE when asked', async () => {
  const { modern } = mcp();
  const resp = await modern(9, 'tools/call', { name: 'ask_faq', arguments: { message: 'hi' }, _meta: { progressToken: 'p1' } }, { accept: 'application/json, text/event-stream' });
  const msgs = await drain(resp);
  const progress = msgs.filter((m) => m.method === 'notifications/progress');
  assert.ok(progress.length >= 1);
  assert.equal(progress[0].params.progressToken, 'p1');
  assert.equal(progress[0].params.message, 'Looking things up');
  const last = msgs[msgs.length - 1];
  assert.equal(last.id, 9);
  assert.equal(last.result.content[0].text, 'Hello world');
  // Without Accept: text/event-stream the same call is plain JSON.
  const plain = await modern(10, 'tools/call', { name: 'ask_faq', arguments: { message: 'hi' }, _meta: { progressToken: 'p2' } });
  assert.ok(plain instanceof HttpResponse);
});

test('MCP resources: list, read, not found per era', async () => {
  const resources = {
    list: async () => [{ uri: 'docs://rates', name: 'rates', mimeType: 'text/plain' }],
    read: async (uri) => (uri === 'docs://rates' ? { text: '3%', mimeType: 'text/plain' } : undefined),
  };
  const { modern, legacy } = mcp({ resources });
  const disc = await modern(1, 'server/discover', {});
  assert.ok(disc.body.result.capabilities.resources);
  const list = await modern(2, 'resources/list', {});
  assert.equal(list.body.result.resources[0].uri, 'docs://rates');
  assert.equal(list.body.result.cacheScope, 'private');
  const read = await modern(3, 'resources/read', { uri: 'docs://rates' });
  assert.deepEqual(read.body.result.contents, [{ uri: 'docs://rates', mimeType: 'text/plain', text: '3%' }]);
  const missing = await modern(4, 'resources/read', { uri: 'docs://nope' });
  assert.equal(missing.body.error.code, -32602);
  const missingLegacy = await legacy(5, 'resources/read', { uri: 'docs://nope' });
  assert.equal(missingLegacy.body.error.code, -32002);
  const { modern: noRes } = mcp();
  assert.equal((await noRes(6, 'resources/list', {})).body.error.code, -32601);
});

test('MCP transport: auth token, Origin, GET/DELETE, bad envelopes, notifications', async () => {
  const { call, routes } = mcp({ token: TOKEN, allowedOrigins: ['https://app.example'] });
  const body = { jsonrpc: '2.0', id: 1, method: 'ping' };
  const noAuth = await call({}, body);
  assert.equal(noAuth.status, 401);
  assert.equal(noAuth.headers['www-authenticate'], 'Bearer');
  assert.equal((await call({ authorization: 'Bearer wrong' }, body)).status, 401);
  const ok = await call({ authorization: `Bearer ${TOKEN}` }, body);
  assert.equal(ok.status, 200);
  const auth = { authorization: `Bearer ${TOKEN}` };
  assert.equal((await call({ ...auth, origin: 'https://evil.example' }, body)).status, 403);
  assert.equal((await call({ ...auth, origin: 'http://localhost:3000' }, body)).status, 200, 'same host');
  assert.equal((await call({ ...auth, origin: 'https://app.example' }, body)).status, 200, 'allowed origin');
  assert.equal(route(routes, 'GET', '/mcp').handler(makeCtx('GET', '/mcp')).status, 405);
  assert.equal(route(routes, 'DELETE', '/mcp').handler(makeCtx('DELETE', '/mcp')).status, 405);
  const batch = await call(auth, [body]);
  assert.equal(batch.status, 400);
  assert.equal(batch.body.error.code, -32600);
  assert.equal((await call(auth, undefined)).body.error.code, -32600);
  assert.equal((await call(auth, { jsonrpc: '1.0', id: 1, method: 'ping' })).body.error.code, -32600);
  const modernNote = await call({ ...auth, ...modernHeaders('notifications/cancelled') }, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN } } });
  assert.equal(modernNote.status, 202);
  assert.equal((await call(auth, { jsonrpc: '2.0', id: 5, result: {} })).status, 202, 'responses are accepted');
  assert.throws(() => mcpRoutes(fakePlatform(), { name: 'x', version: '1', token: 'short' }), /at least 16/);
});

test('MCP version and header validation', async () => {
  const { call, modern } = mcp();
  const wrongVersion = await call({ ...modernHeaders('tools/list'), 'mcp-protocol-version': '1900-01-01' }, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '1900-01-01' } } });
  assert.equal(wrongVersion.status, 400);
  assert.equal(wrongVersion.body.error.code, -32022);
  assert.equal(wrongVersion.body.error.data.requested, '1900-01-01');
  assert.ok(wrongVersion.body.error.data.supported.includes(MODERN));
  const legacyBad = await call({ 'mcp-protocol-version': '2024-01-01' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(legacyBad.status, 400);
  assert.equal(legacyBad.body.error.code, -32022);
  const methodMismatch = await modern(3, 'tools/list', {}, { 'mcp-method': 'tools/call' });
  assert.equal(methodMismatch.status, 400);
  assert.equal(methodMismatch.body.error.code, -32020);
  const missingVersionHeader = await call({ 'mcp-method': 'tools/list' }, modernBody(4, 'tools/list'));
  assert.equal(missingVersionHeader.body.error.code, -32020);
  const nameMismatch = await modern(5, 'tools/call', { name: 'get_balance', arguments: { account: 'A' } }, { 'mcp-name': 'send_email' });
  assert.equal(nameMismatch.body.error.code, -32020);
  const b64 = Buffer.from('get_balance').toString('base64');
  const encoded = await modern(6, 'tools/call', { name: 'get_balance', arguments: { account: 'A' } }, { 'mcp-name': `=?base64?${b64}?=` });
  assert.equal(encoded.body.result.isError, false, 'base64 sentinel decoded');
  const headerOnly = await call({ 'mcp-protocol-version': MODERN }, { jsonrpc: '2.0', id: 7, method: 'tools/list' });
  assert.equal(headerOnly.body.error.code, -32020, 'modern header without body _meta');
});

/* ------------------------------------------------------------------ */
/* A2A                                                                 */
/* ------------------------------------------------------------------ */

function a2a(options = {}) {
  const platform = fakePlatform();
  const routes = a2aRoutes(platform, { name: 'Bank', description: 'Banking agents', version: '2.0.0', provider: { organization: 'Acme', url: 'https://acme.example' }, ...options });
  const post = route(routes, 'POST', options.path || '/a2a');
  const v1 = (id, method, params, headers = {}) => post.handler(makeCtx('POST', '/a2a', { 'a2a-version': '1.0', ...headers }, { jsonrpc: '2.0', id, method, params }));
  const v03 = (id, method, params, headers = {}) => post.handler(makeCtx('POST', '/a2a', headers, { jsonrpc: '2.0', id, method, params }));
  return { platform, routes, v1, v03, post };
}

const textMsg = (text, extra = {}) => ({ messageId: `m-${Math.random()}`, role: 'ROLE_USER', parts: [{ text }], ...extra });
const textMsg03 = (text, extra = {}) => ({ kind: 'message', messageId: `m-${Math.random()}`, role: 'user', parts: [{ kind: 'text', text }], ...extra });

test('A2A agent card satisfies v1 and v0.3', async () => {
  const { routes } = a2a({ token: TOKEN });
  const res = route(routes, 'GET', '/.well-known/agent-card.json').handler(makeCtx('GET', '/.well-known/agent-card.json'));
  assert.equal(res.headers['cache-control'], 'public, max-age=300');
  const card = res.body;
  assert.deepEqual(card.supportedInterfaces[0], { url: 'http://localhost:3000/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' });
  assert.equal(card.protocolVersion, '0.3.0');
  assert.equal(card.url, 'http://localhost:3000/a2a');
  assert.equal(card.preferredTransport, 'JSONRPC');
  assert.equal(card.capabilities.streaming, true);
  assert.equal(card.capabilities.pushNotifications, false);
  assert.deepEqual(card.provider, { organization: 'Acme', url: 'https://acme.example' });
  assert.equal(card.skills.length, 2);
  assert.deepEqual(card.skills[0], { id: 'banking-assistant', name: 'Banking assistant', description: 'Helps with accounts', tags: ['banking', 'assistant'], examples: ['What is my balance?'], inputModes: ['text/plain', 'application/json'], outputModes: ['text/plain'] });
  assert.ok(card.securitySchemes.bearer.httpAuthSecurityScheme);
  assert.equal(card.securitySchemes.bearer.type, 'http');
  const evil = route(routes, 'GET', '/.well-known/agent.json').handler(makeCtx('GET', '/x', { host: 'evil"/><script>' }));
  assert.equal(evil.body.url, 'http://localhost/a2a', 'hostile Host header is not reflected');
});

test('A2A v1 SendMessage (blocking) completes with an answer artifact, GetTask returns history', async () => {
  const { v1 } = a2a();
  const res = await v1(1, 'SendMessage', { message: textMsg('hello'), metadata: { skill: 'faq' } });
  const task = res.body.result.task;
  assert.equal(task.status.state, 'TASK_STATE_COMPLETED');
  assert.deepEqual(task.artifacts, [{ artifactId: 'answer', name: 'answer', parts: [{ text: 'Hello world' }] }]);
  assert.equal(task.kind, undefined, 'no kind in v1');
  assert.equal(task.metadata.skill, 'faq');
  const got = await v1(2, 'GetTask', { id: task.id, historyLength: 10 });
  const h = got.body.result.history;
  assert.equal(h[0].role, 'ROLE_USER');
  assert.equal(h[1].role, 'ROLE_AGENT');
  assert.deepEqual(h[1].parts, [{ text: 'Hello world' }]);
  const none = await v1(3, 'GetTask', { id: task.id, historyLength: 0 });
  assert.equal(none.body.result.history, undefined);
  const next = await v1(4, 'SendMessage', { message: textMsg('again', { contextId: task.contextId }) });
  assert.equal(next.body.result.task.contextId, task.contextId, 'thread continued');
  assert.equal(next.body.result.task.metadata.skill, 'faq', 'skill taken from the thread');
  const nonBlocking = await v1(5, 'SendMessage', { message: textMsg('hey'), configuration: { returnImmediately: true } });
  assert.equal(nonBlocking.body.result.task.status.state, 'TASK_STATE_SUBMITTED');
});

test('A2A v0.3 message/send uses kind fields and kebab-case states', async () => {
  const { v03 } = a2a({ defaultAgent: 'faq' });
  const res = await v03('a', 'message/send', { message: textMsg03('hi') });
  const t = res.body.result;
  assert.equal(t.kind, 'task');
  assert.equal(t.status.state, 'completed');
  assert.deepEqual(t.artifacts[0].parts, [{ kind: 'text', text: 'Hello world' }]);
  const got = await v03('b', 'tasks/get', { id: t.id });
  assert.equal(got.body.result.history[0].role, 'user');
  assert.equal(got.body.result.history[0].kind, 'message');
});

test('A2A input-required approval flow when the app trusts callers (approvals: "caller")', async () => {
  const { v1, v03, platform } = a2a({ approvals: 'caller' });
  const res = await v1(1, 'SendMessage', { message: textMsg('transfer 5') });
  const task = res.body.result.task;
  assert.equal(task.status.state, 'TASK_STATE_INPUT_REQUIRED');
  assert.match(task.status.message.parts[0].text, /transfer/);
  assert.equal(task.status.message.parts[1].data.pendingApprovals[0].callId, 'c1');
  assert.equal(task.status.message.role, 'ROLE_AGENT');
  const unclear = await v1(2, 'SendMessage', { message: textMsg('hmm, maybe', { taskId: task.id }) });
  assert.equal(unclear.body.result.task.status.state, 'TASK_STATE_INPUT_REQUIRED');
  assert.match(unclear.body.result.task.status.message.parts[0].text, /explicit decision/);
  const approved = await v1(3, 'SendMessage', { message: textMsg('Yes, approve', { taskId: task.id }) });
  assert.equal(approved.body.result.task.status.state, 'TASK_STATE_COMPLETED');
  assert.equal(approved.body.result.task.artifacts[0].parts[0].text, 'Transferred 5 EUR');
  assert.equal(platform.runs.get(task.id).pending[0].decision.approved, true);
  const after = await v1(4, 'SendMessage', { message: textMsg('yes', { taskId: task.id }) });
  assert.equal(after.body.error.code, -32004, 'terminal tasks take no more messages');

  const r03 = await v03(5, 'message/send', { message: textMsg03('transfer 5') });
  assert.equal(r03.body.result.status.state, 'input-required');
  const denied = await v03(6, 'message/send', { message: { kind: 'message', messageId: 'x', role: 'user', taskId: r03.body.result.id, parts: [{ kind: 'data', data: { approved: false } }] } });
  assert.equal(denied.body.result.status.state, 'completed');
  assert.equal(denied.body.result.artifacts[0].parts[0].text, 'Transfer denied');
  assert.equal(parseDecision('No thanks'), false);
  assert.equal(parseDecision('confirm'), true);
  assert.equal(parseDecision('what?'), undefined);
});

test('A2A v1 SendStreamingMessage: task, artifact chunks, status updates', async () => {
  const { v1 } = a2a();
  const items = await drain(await v1(7, 'SendStreamingMessage', { message: textMsg('hello'), metadata: { skill: 'faq' } }));
  assert.ok(items.every((i) => i.jsonrpc === '2.0' && i.id === 7));
  const results = items.map((i) => i.result);
  assert.ok(results[0].task, 'first item is the task');
  const chunks = results.filter((r) => r.artifactUpdate);
  assert.equal(chunks[0].artifactUpdate.append, false);
  assert.equal(chunks[1].artifactUpdate.append, true);
  assert.equal(chunks.map((c) => c.artifactUpdate.artifact.parts[0].text).join(''), 'Hello world');
  assert.equal(chunks[chunks.length - 1].artifactUpdate.lastChunk, true);
  const statuses = results.filter((r) => r.statusUpdate).map((r) => r.statusUpdate.status.state);
  assert.ok(statuses.includes('TASK_STATE_WORKING'));
  assert.equal(statuses[statuses.length - 1], 'TASK_STATE_COMPLETED');
  assert.equal(results[results.length - 1].statusUpdate.final, undefined, 'no final flag in v1');
});

test('A2A v0.3 message/stream ends with final:true; input-required closes the stream', async () => {
  const { v03 } = a2a({ defaultAgent: 'faq', approvals: 'caller' });
  const items = (await drain(await v03(1, 'message/stream', { message: textMsg03('hello') }))).map((i) => i.result);
  assert.equal(items[0].kind, 'task');
  assert.ok(items.some((i) => i.kind === 'artifact-update'));
  const last = items[items.length - 1];
  assert.equal(last.kind, 'status-update');
  assert.equal(last.final, true);
  assert.equal(last.status.state, 'completed');
  assert.ok(items.slice(1, -1).filter((i) => i.kind === 'status-update').every((i) => i.final === false));
  const paused = (await drain(await v03(2, 'message/stream', { message: textMsg03('transfer 5'), metadata: { skill: 'banking-assistant' } }))).map((i) => i.result);
  const end = paused[paused.length - 1];
  assert.equal(end.status.state, 'input-required');
  assert.equal(end.final, true);
});

test('A2A by default: a caller cannot approve; the action is declined and the agent finishes', async () => {
  const { v1, v03 } = a2a();
  const res = await v1(1, 'SendMessage', { message: textMsg('transfer 5') });
  const task = res.body.result.task;
  assert.equal(task.status.state, 'TASK_STATE_COMPLETED');
  assert.match(JSON.stringify(task.artifacts), /Transfer denied/);
  // Streaming ends the same way.
  const items = (await drain(await v03(2, 'message/stream', { message: textMsg03('transfer 5'), metadata: { skill: 'banking-assistant' } }))).map((i) => i.result);
  assert.equal(items[items.length - 1].status.state, 'completed');
});

test('A2A approvals: "wait" pauses for a person in the app and refuses a caller\'s "approve"', async () => {
  const { v1, platform } = a2a({ approvals: 'wait' });
  const res = await v1(1, 'SendMessage', { message: textMsg('transfer 5') });
  const task = res.body.result.task;
  assert.equal(task.status.state, 'TASK_STATE_INPUT_REQUIRED');
  assert.match(task.status.message.parts[0].text, /person must approve it in the app/);
  const reply = await v1(2, 'SendMessage', { message: { ...textMsg('approve'), taskId: task.id } });
  assert.ok(reply.body.error, 'the caller must not be able to approve');
  assert.match(reply.body.error.message, /person in the app/);
  const run = await platform.getRun(task.id);
  assert.ok(run.pending.every((p) => !p.decision), 'nothing was decided');
});

test('A2A cancel, resubscribe/SubscribeToTask and errors', async () => {
  const { v1, v03 } = a2a();
  const started = await v1(1, 'SendMessage', { message: textMsg('slow job'), configuration: { returnImmediately: true } });
  const id = started.body.result.task.id;
  await new Promise((r) => setTimeout(r, 5));
  const subscription = await v1(2, 'SubscribeToTask', { id });
  const collecting = drain(subscription);
  await new Promise((r) => setTimeout(r, 5));
  const cancelled = await v1(3, 'CancelTask', { id });
  assert.equal(cancelled.body.result.status.state, 'TASK_STATE_CANCELED');
  const items = (await collecting).map((i) => i.result);
  assert.ok(items[0].task);
  assert.equal(items[items.length - 1].statusUpdate.status.state, 'TASK_STATE_CANCELED');
  const again = await v1(4, 'CancelTask', { id });
  assert.equal(again.body.error.code, -32002);
  assert.equal(again.body.error.data[0].reason, 'TASK_NOT_CANCELABLE');
  const subTerminal = await drain(await v1(5, 'SubscribeToTask', { id }));
  assert.equal(subTerminal[0].error.code, -32004);
  const resub = (await drain(await v03(6, 'tasks/resubscribe', { id }))).map((i) => i.result);
  assert.equal(resub[resub.length - 1].final, true);
  assert.equal((await v1(7, 'GetTask', { id: 'nope' })).body.error.code, -32001);
  assert.equal((await v03(8, 'tasks/get', { id: 'nope' })).body.error.data, undefined, 'v0.3 errors carry no ErrorInfo');
});

test('A2A tasks are scoped to their owner', async () => {
  let who = 'alice';
  const { v1 } = a2a({ owner: () => who });
  const res = await v1(1, 'SendMessage', { message: textMsg('hello'), metadata: { skill: 'faq' } });
  const { id, contextId } = res.body.result.task;
  who = 'bob';
  assert.equal((await v1(2, 'GetTask', { id })).body.error.code, -32001);
  assert.equal((await v1(3, 'SendMessage', { message: textMsg('hi', { contextId }) })).body.error.code, -32602);
});

test('A2A ListTasks (v1) filters, sorts and paginates', async () => {
  const { v1, v03 } = a2a({ owner: () => 'acme' });
  for (let i = 0; i < 3; i++) await v1(i, 'SendMessage', { message: textMsg('hello'), metadata: { skill: 'faq' } });
  const list = await v1(10, 'ListTasks', { pageSize: 2 });
  const r = list.body.result;
  assert.equal(r.totalSize, 3);
  assert.equal(r.tasks.length, 2);
  assert.ok(r.nextPageToken);
  assert.equal(r.tasks[0].artifacts, undefined, 'artifacts omitted by default');
  const page2 = await v1(11, 'ListTasks', { pageSize: 2, pageToken: r.nextPageToken, includeArtifacts: true });
  assert.equal(page2.body.result.tasks.length, 1);
  assert.equal(page2.body.result.nextPageToken, '');
  assert.equal(page2.body.result.tasks[0].artifacts[0].artifactId, 'answer');
  const filtered = await v1(12, 'ListTasks', { status: 'TASK_STATE_WORKING' });
  assert.equal(filtered.body.result.totalSize, 0);
  assert.equal((await v03(13, 'tasks/list', {})).body.error.code, -32601);
});

test('A2A callers the app does not identify can only reach their own conversation', async () => {
  const { v1 } = a2a();
  const first = (await v1(1, 'SendMessage', { message: textMsg('hello'), metadata: { skill: 'faq' } })).body.result.task;
  await v1(2, 'SendMessage', { message: textMsg('hello again'), metadata: { skill: 'faq' } });
  // No owner hook: a list without a contextId shows nothing, since callers can't be told apart.
  assert.equal((await v1(3, 'ListTasks', {})).body.result.totalSize, 0);
  // The ids a caller was given still work: its task, and its conversation.
  assert.equal((await v1(4, 'GetTask', { id: first.id })).body.result.id, first.id);
  const own = (await v1(5, 'ListTasks', { contextId: first.contextId })).body.result;
  assert.deepEqual(own.tasks.map((t) => t.id), [first.id]);
  const next = (await v1(6, 'SendMessage', { message: textMsg('more', { contextId: first.contextId }) })).body.result.task;
  assert.equal(next.contextId, first.contextId);
});

test('MCP callers the app does not identify get an owner per call, never a shared one', async () => {
  const { modern, platform } = mcpWith({});
  await modern(1, 'tools/call', { name: 'get_balance', arguments: { account: 'A1' } });
  await modern(2, 'tools/call', { name: 'get_balance', arguments: { account: 'A1' } });
  const owners = platform.calls.map((c) => c.options.owner);
  assert.equal(owners.length, 2);
  for (const o of owners) assert.match(o, /^mcp:anonymous:/);
  assert.notEqual(owners[0], owners[1], 'two callers shared an owner');
});

test('A2A named callers each keep their own tasks; the card asks for a token', async () => {
  const callers = { alpha: 'alpha-token-0123456789abcdef', beta: 'beta-token-0123456789abcdef' };
  const { v1, routes } = a2a({ callers });
  const as = (name) => ({ authorization: `Bearer ${callers[name]}` });
  assert.equal((await v1(1, 'ListTasks', {}, { authorization: 'Bearer wrong-token-0123456789' })).status, 401);
  const task = (await v1(2, 'SendMessage', { message: textMsg('hello'), metadata: { skill: 'faq' } }, as('alpha'))).body.result.task;
  await v1(3, 'SendMessage', { message: textMsg('again'), metadata: { skill: 'faq' } }, as('alpha'));
  assert.equal((await v1(4, 'ListTasks', {}, as('alpha'))).body.result.totalSize, 2);
  assert.equal((await v1(5, 'ListTasks', {}, as('beta'))).body.result.totalSize, 0);
  assert.equal((await v1(6, 'GetTask', { id: task.id }, as('beta'))).body.error.code, -32001, "beta can't read alpha's task");
  const card = route(routes, 'GET', '/.well-known/agent-card.json').handler(makeCtx('GET', '/.well-known/agent-card.json')).body;
  assert.ok(card.securitySchemes.bearer);
});

test('MCP named callers own their calls as mcp:<name>; short tokens are refused', async () => {
  const callers = { alpha: 'alpha-token-0123456789abcdef' };
  const { modern, platform } = mcpWith({ callers });
  const ok = await modern(1, 'tools/call', { name: 'get_balance', arguments: { account: 'A1' } }, { authorization: `Bearer ${callers.alpha}` });
  assert.equal(ok.body.result.isError, false);
  assert.equal(platform.calls[0].options.owner, 'mcp:alpha');
  const denied = await modern(2, 'tools/call', { name: 'get_balance', arguments: { account: 'A1' } });
  assert.equal(denied.status, 401);
  assert.throws(() => mcpWith({ callers: { short: 'too-short' } }), /at least 16 characters/);
});

test('A2A protocol errors: version, methods, parts, push, auth', async () => {
  const { v1, v03, post } = a2a({ token: TOKEN });
  const auth = { authorization: `Bearer ${TOKEN}` };
  const unauth = await v1(1, 'GetTask', { id: 'x' });
  assert.equal(unauth.status, 401);
  const version = await v1(2, 'GetTask', { id: 'x' }, { ...auth, 'a2a-version': '0.5' });
  assert.equal(version.body.error.code, -32009);
  const patch = await v1(3, 'GetTask', { id: 'x' }, { ...auth, 'a2a-version': '1.0.2' });
  assert.equal(patch.body.error.code, -32001, '1.0.2 is treated as 1.0');
  const wrongFamily = await v03(4, 'SendMessage', { message: textMsg('x') }, auth);
  assert.equal(wrongFamily.body.error.code, -32601);
  assert.match(wrongFamily.body.error.message, /A2A-Version: 1.0/);
  const file = await v1(5, 'SendMessage', { message: { messageId: 'f', role: 'ROLE_USER', parts: [{ url: 'https://x/y.pdf', mediaType: 'application/pdf' }] } }, auth);
  assert.equal(file.body.error.code, -32005);
  const push = await v1(6, 'CreateTaskPushNotificationConfig', { taskId: 'x', url: 'https://hook' }, auth);
  assert.equal(push.body.error.code, -32003);
  const pushCfg = await v03(7, 'message/send', { message: textMsg03('hi'), configuration: { pushNotificationConfig: { url: 'https://hook' } } }, auth);
  assert.equal(pushCfg.body.error.code, -32003);
  const noParts = await v1(8, 'SendMessage', { message: { messageId: 'e', role: 'ROLE_USER', parts: [] } }, auth);
  assert.equal(noParts.body.error.code, -32602);
  const skill = await v1(9, 'SendMessage', { message: textMsg('x'), metadata: { skill: 'nope' } }, auth);
  assert.equal(skill.body.error.code, -32602);
  const card = await v1(10, 'GetExtendedAgentCard', {}, auth);
  assert.equal(card.body.error.code, -32004);
  const streamErr = await drain(await v1(11, 'SendStreamingMessage', { message: textMsg('x', { taskId: 'missing' }) }, auth));
  assert.equal(streamErr[0].error.code, -32001, 'stream errors arrive as an SSE event');
  const bad = await post.handler(makeCtx('POST', '/a2a', auth, { jsonrpc: '2.0', id: 1 }));
  assert.equal(bad.body.error.code, -32600);
});
