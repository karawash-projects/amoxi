// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0
'use strict';
// End-to-end tests of the agent runtime: runs, streaming, approvals, cancellation, durable
// resume after shutdown and crash, ownership, and the HTTP/SSE endpoints. The application
// module is written by hand here (what `amoxi build` would generate).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./dist.cjs');

const { Config, AmoxiApplication, $validate, $v } = load('runtime/index');
const ai = load('ai/index');
const { aiExtension, $aiService, ScriptedChatModel, AiServices, MemoryRunStore, MemoryConversationStore } = ai;

const SERVICES = ['ChatModel', 'Embedder', 'VectorStore', 'ConversationStore', 'RunStore', 'AgentPlatform', 'KnowledgeBases', 'MemoryService'];

/** A minimal bank: one read-only tool, one tool needing approval, one generative component. */
function bankModule(log) {
  class Bank {
    constructor() {
      this.balance = 1000;
    }
    balanceOf() {
      log.push('balance');
      return { balance: this.balance };
    }
    async transfer(input, ctx) {
      log.push(`transfer:${input.amount}`);
      const ref = await ctx.step('charge', () => `REF-${input.amount}`);
      this.balance -= input.amount;
      ctx.ui('Receipt', { reference: ref, amount: input.amount });
      ctx.progress('Transfer sent');
      return { reference: ref, balance: this.balance };
    }
    async slow(_input, ctx) {
      log.push('slow:start');
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, 5000);
        ctx.signal.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new Error('aborted'));
        });
      });
      log.push('slow:end');
      return { ok: true };
    }
  }
  class Assistant {
    instructions(ctx) {
      return `You help with banking. Principal: ${JSON.stringify(ctx.principal ?? null)}`;
    }
    principal(req) {
      return req.headers['x-customer'] ?? null;
    }
    onRunFinished(run) {
      log.push(`finished:${run.status}`);
    }
    beforeToolCall({ tool, input }) {
      if (tool === 'transfer' && input.amount > 5000) return 'Transfers over 5000 need a branch visit.';
      return undefined;
    }
  }
  const amount = [['amount', (x, e, p) => $v.num(x, e, p, { integer: true, minimum: 1 }), false]];
  const beans = [
    { id: 0, name: 'Bank', scope: 'singleton', eager: false, primary: false, types: ['Bank'], create: () => new Bank() },
    { id: 1, name: 'Assistant', scope: 'singleton', eager: false, primary: false, types: ['Assistant'], create: () => new Assistant() },
    ...SERVICES.map((name, i) => ({ id: 2 + i, name, scope: 'singleton', eager: false, primary: false, types: [name], create: (r) => $aiService(r, name) })),
  ];
  const typeIndex = Object.fromEntries(beans.map((b) => [b.types[0], [b.id]]));
  const obj = { type: 'object', properties: { amount: { type: 'integer', minimum: 1 } }, required: ['amount'] };
  return {
    beans,
    typeIndex,
    routes: [],
    middleware: [],
    websockets: [],
    buildInfo: { generatedAt: 'test', compilerVersion: 'test' },
    extensions: [aiExtension],
    ai: {
      tools: [
        { name: 'get_balance', description: 'Balance', beanId: 0, inputSchema: { type: 'object', properties: {} }, validate: () => ({}), invoke: (b) => b.balanceOf(), approval: false, readOnly: true, expose: true, source: 'Bank.balanceOf' },
        {
          name: 'transfer',
          description: 'Send money',
          beanId: 0,
          inputSchema: obj,
          validate: (x) => $validate(x ?? {}, (y, e, p) => $v.obj(y, e, p, amount)),
          invoke: (b, i, t) => b.transfer(i, t),
          approval: true,
          readOnly: false,
          expose: true,
          source: 'Bank.transfer',
        },
        { name: 'slow', description: 'Slow', beanId: 0, inputSchema: { type: 'object', properties: {} }, validate: () => ({}), invoke: (b, i, t) => b.slow(i, t), approval: false, readOnly: false, expose: false, source: 'Bank.slow' },
      ],
      components: [
        {
          name: 'Receipt',
          description: 'A receipt',
          propsSchema: { type: 'object' },
          validate: (x) => $validate(x ?? {}, (y, e, p) => $v.obj(y, e, p, [['reference', $v.str, false], ['amount', $v.num, false]])),
          component: () => '',
        },
      ],
      agents: [
        {
          name: 'assistant',
          description: 'Banking helper',
          beanId: 1,
          tools: ['get_balance', 'transfer', 'slow'],
          ui: ['Receipt'],
          knowledge: [],
          recall: 0,
          rememberTool: false,
          examples: [],
          hooks: { principal: true, owner: false, beforeToolCall: true, onRunFinished: true },
        },
      ],
    },
  };
}

async function start(script, { log = [], stores, extra = {} } = {}) {
  const model = new ScriptedChatModel(script);
  const module = bankModule(log);
  const overrides = [['ChatModel', model]];
  if (stores) overrides.push(['RunStore', stores.runs], ['ConversationStore', stores.conversations]);
  const app = await AmoxiApplication.run(module, {
    config: Config.of({ server: { port: 0, host: '127.0.0.1' }, ai: { runs: { 'poll-ms': 50, 'lease-ms': 5000 } }, ...extra }, 'test'),
    silent: true,
    shutdownHook: false,
    overrides,
  });
  const base = `http://127.0.0.1:${app.port}`;
  const jar = { cookie: '' };
  const request = async (path, init = {}) => {
    const res = await fetch(base + path, {
      ...init,
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...(jar.cookie ? { cookie: jar.cookie } : {}), ...(init.headers ?? {}) },
    });
    const set = res.headers.get('set-cookie');
    if (set) jar.cookie = set.split(';')[0];
    return res;
  };
  return { app, model, log, base, request, jar, platform: AiServices.of(app.context).platform() };
}

/** Parses an SSE response into [{ id, event, data }]. */
async function sse(res) {
  const text = await res.text();
  return text
    .split('\n\n')
    .filter((b) => b.includes('data:'))
    .map((block) => {
      const out = {};
      for (const line of block.split('\n')) {
        const i = line.indexOf(':');
        const k = line.slice(0, i);
        const v = line.slice(i + 2);
        if (k === 'data') out.data = JSON.parse(v);
        else if (k) out[k] = v;
      }
      return out;
    });
}

const waitFor = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('agent runs over HTTP', () => {
  test('streams tokens and tool events, then completes and stores the transcript', async () => {
    const t = await start([{ text: 'Checking.', toolCalls: [{ name: 'get_balance', input: {} }] }, { text: 'You have $1000.' }]);
    try {
      const res = await t.request('/agents/assistant/runs', { method: 'POST', headers: { accept: 'text/event-stream', 'x-customer': 'C-7' }, body: JSON.stringify({ input: 'balance?' }) });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /text\/event-stream/);
      const events = await sse(res);
      const types = events.map((e) => e.event);
      assert.deepEqual(types.filter((x) => x !== 'message.delta'), ['run.status', 'run.status', 'message.completed', 'tool.started', 'tool.completed', 'message.completed', 'run.completed']);
      assert.ok(types.includes('message.delta'));
      assert.equal(events.at(-1).data.output, 'You have $1000.');
      // ids increase and deltas sit between durable events
      const ids = events.map((e) => Number(e.id));
      assert.deepEqual([...ids].sort((a, b) => a - b), ids);
      // the model saw the principal in its instructions and the tool result
      assert.match(t.model.requests[0].system, /C-7/);
      assert.equal(t.model.requests[1].messages.at(-1).role, 'tool');
      const threadId = events[0].data.threadId;
      const thread = await (await t.request(`/agents/assistant/threads/${threadId}`)).json();
      assert.deepEqual(thread.items.map((i) => i.kind), ['user', 'assistant', 'tool', 'assistant']);
      assert.ok(t.log.includes('finished:completed'));
    } finally {
      await t.app.close();
    }
  });

  test('202 + polling without streaming; validation errors; unknown agent', async () => {
    const t = await start([{ text: 'Hi.' }]);
    try {
      const res = await t.request('/agents/assistant/runs', { method: 'POST', body: JSON.stringify({ input: 'hello' }) });
      assert.equal(res.status, 202);
      const run = await res.json();
      assert.ok(res.headers.get('location').endsWith(run.id));
      const done = await waitFor(async () => {
        const r = await (await t.request(`/agents/assistant/runs/${run.id}`)).json();
        return r.status === 'completed' && r;
      });
      assert.equal(done.output, 'Hi.');
      assert.equal(done.checkpoint, undefined, 'internal fields are not exposed');
      assert.equal((await t.request('/agents/assistant/runs', { method: 'POST', body: JSON.stringify({ input: 42 }) })).status, 400);
      assert.equal((await t.request('/agents/assistant/runs', { method: 'POST', body: JSON.stringify({ input: '   ' }) })).status, 400);
      assert.equal((await t.request('/agents/nobody/runs', { method: 'POST', body: JSON.stringify({ input: 'x' }) })).status, 404);
      const list = await (await t.request('/agents')).json();
      assert.deepEqual(list.agents.map((a) => a.name), ['assistant']);
    } finally {
      await t.app.close();
    }
  });

  test('another owner cannot read, stream, continue or cancel a run', async () => {
    const t = await start([{ text: 'Mine.' }]);
    try {
      const run = await (await t.request('/agents/assistant/runs', { method: 'POST', body: JSON.stringify({ input: 'hi' }) })).json();
      await waitFor(async () => (await t.platform.getRun(run.id)).status === 'completed');
      const stranger = (path, init) => fetch(t.base + path, { ...init, headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' } });
      assert.equal((await stranger(`/agents/assistant/runs/${run.id}`)).status, 404);
      assert.equal((await stranger(`/agents/assistant/runs/${run.id}/events`)).status, 404);
      assert.equal((await stranger(`/agents/assistant/runs/${run.id}/cancel`, { method: 'POST' })).status, 404);
      assert.equal((await stranger(`/agents/assistant/threads/${run.threadId}`)).status, 404);
      assert.equal((await stranger('/agents/assistant/runs', { method: 'POST', body: JSON.stringify({ input: 'x', threadId: run.threadId }) })).status, 404);
      const threads = await (await stranger('/agents/assistant/threads')).json();
      assert.deepEqual(threads.threads, []);
    } finally {
      await t.app.close();
    }
  });

  test('cross-site requests with cookies are blocked (CSRF)', async () => {
    const t = await start([{ text: 'x' }]);
    try {
      await t.request('/agents/assistant/runs', { method: 'POST', body: JSON.stringify({ input: 'hi' }) });
      const res = await fetch(`${t.base}/agents/assistant/runs`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: t.jar.cookie, origin: 'https://evil.example' }, body: JSON.stringify({ input: 'steal' }) });
      assert.equal(res.status, 403);
    } finally {
      await t.app.close();
    }
  });
});

describe('human approval', () => {
  test('pauses before a sensitive tool, resumes when approved, and shows generative UI', async () => {
    const t = await start([{ toolCalls: [{ name: 'transfer', input: { amount: 250 } }] }, { text: 'Sent.' }]);
    try {
      const events = await sse(await t.request('/agents/assistant/runs', { method: 'POST', headers: { accept: 'text/event-stream' }, body: JSON.stringify({ input: 'send 250' }) }));
      const approval = events.find((e) => e.event === 'approval.required');
      assert.ok(approval, 'approval requested');
      assert.deepEqual(approval.data.input, { amount: 250 });
      assert.equal(events.at(-1).data.status, 'awaiting_approval');
      assert.deepEqual(t.log, [], 'nothing ran before approval');
      const runId = events[0].data.runId;
      const run = await (await t.request(`/agents/assistant/runs/${runId}`)).json();
      assert.equal(run.pending.length, 1);
      // a reload shows the pending approval card
      const paused = await (await t.request(`/agents/assistant/threads/${run.threadId}`)).json();
      assert.equal(paused.activeRun.status, 'awaiting_approval');
      assert.ok(paused.items.some((i) => i.kind === 'approval' && i.callId === approval.data.callId && i.status === 'pending'));
      // a second message while waiting is refused
      const busy = await t.request('/agents/assistant/runs', { method: 'POST', body: JSON.stringify({ input: 'again', threadId: run.threadId }) });
      assert.equal(busy.status, 409);

      const last = events.at(-1).id;
      const after = await sse(await t.request(`/agents/assistant/runs/${runId}/approvals/${approval.data.callId}?after=${last}`, { method: 'POST', headers: { accept: 'text/event-stream' }, body: JSON.stringify({ approved: true }) }));
      const types = after.map((e) => e.event).filter((x) => x !== 'message.delta');
      assert.ok(types.includes('ui'));
      assert.ok(types.includes('tool.completed'));
      assert.equal(types.at(-1), 'run.completed');
      assert.equal(after.find((e) => e.event === 'ui').data.component, 'Receipt');
      assert.ok(after.every((e) => Number(e.id) > Number(last)), 'no repeated events');
      assert.deepEqual(t.log.filter((l) => l.startsWith('transfer')), ['transfer:250']);
      const thread = await (await t.request(`/agents/assistant/threads/${run.threadId}`)).json();
      assert.ok(thread.items.some((i) => i.kind === 'ui' && i.props.reference === 'REF-250'));
    } finally {
      await t.app.close();
    }
  });

  test('a declined action is reported to the model and never runs', async () => {
    const t = await start([{ toolCalls: [{ name: 'transfer', input: { amount: 99 } }] }, { text: 'Okay, not sent.' }]);
    try {
      const run = await t.platform.startRun({ agent: 'assistant', input: 'send', owner: 'o1' });
      const paused = await waitFor(async () => {
        const r = await t.platform.getRun(run.id);
        return r.status === 'awaiting_approval' && r;
      });
      await t.platform.decide(run.id, paused.pending[0].callId, { approved: false, note: 'wrong amount' });
      const done = await waitFor(async () => {
        const r = await t.platform.getRun(run.id);
        return r.status === 'completed' && r;
      });
      assert.equal(done.output, 'Okay, not sent.');
      const result = t.model.requests[1].messages.at(-1).content[0];
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result.output), /declined/);
      assert.ok(!t.log.some((l) => l.startsWith('transfer')));
      await assert.rejects(t.platform.decide(run.id, paused.pending[0].callId, { approved: true }), /not waiting/);
    } finally {
      await t.app.close();
    }
  });

  test('approve and cancel at the same time: never "cancelled" while the action runs, never stuck', async () => {
    for (const order of ['approve-first', 'cancel-first']) {
      for (let trial = 0; trial < 6; trial++) {
        const t = await start([{ toolCalls: [{ name: 'transfer', input: { amount: 5 } }] }, { text: 'Sent.' }]);
        try {
          const run = await t.platform.startRun({ agent: 'assistant', input: 'send 5', owner: 'o' });
          const paused = await waitFor(async () => {
            const r = await t.platform.getRun(run.id);
            return r.status === 'awaiting_approval' && r;
          });
          const approve = () => t.platform.decide(run.id, paused.pending[0].callId, { approved: true });
          const cancel = () => t.platform.cancel(run.id);
          const [a, c] = order === 'approve-first' ? await Promise.allSettled([approve(), cancel()]) : (await Promise.allSettled([cancel(), approve()])).reverse();
          const final = await waitFor(async () => {
            const r = await t.platform.getRun(run.id);
            return ['completed', 'cancelled', 'failed'].includes(r.status) && r;
          });
          const executed = t.log.some((l) => l.startsWith('transfer'));
          if (c.status === 'fulfilled' && c.value.status === 'cancelled') {
            assert.equal(executed, false, `${order} #${trial}: cancel said "cancelled" but the transfer ran`);
            assert.equal(final.status, 'cancelled');
          }
          if (executed) assert.equal(a.status, 'fulfilled', 'the transfer only runs after a successful approval');
          // The conversation is usable afterwards (not wedged by a half-finished run).
          const next = await t.platform.startRun({ agent: 'assistant', input: 'hello', owner: 'o', threadId: run.threadId });
          assert.ok(next.id);
        } finally {
          await t.app.close();
        }
      }
    }
  });

  test('a guardrail refuses before anyone is asked to approve', async () => {
    const t = await start([{ toolCalls: [{ name: 'transfer', input: { amount: 9999 } }] }, { text: 'Please visit a branch.' }]);
    try {
      const run = await t.platform.startRun({ agent: 'assistant', input: 'send 9999', owner: 'o' });
      const done = await waitFor(async () => {
        const r = await t.platform.getRun(run.id);
        return (r.status === 'completed' || r.status === 'awaiting_approval') && r;
      });
      assert.equal(done.status, 'completed', 'never paused for approval');
      assert.match(JSON.stringify(t.model.requests[1].messages.at(-1).content[0].output), /branch visit/);
      assert.ok(!t.log.some((l) => l.startsWith('transfer')));
    } finally {
      await t.app.close();
    }
  });

  test('invalid tool arguments go back to the model so it can correct them', async () => {
    const t = await start([{ toolCalls: [{ name: 'transfer', input: { amount: -5 } }] }, { text: 'Fixed.' }]);
    try {
      const run = await t.platform.startRun({ agent: 'assistant', input: 'x', owner: 'o' });
      await waitFor(async () => (await t.platform.getRun(run.id)).status === 'completed');
      const result = t.model.requests[1].messages.at(-1).content[0];
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result.output), /amount/);
    } finally {
      await t.app.close();
    }
  });
});

describe('long-running and durable runs', () => {
  test('cancel stops a running tool and records the cancellation', async () => {
    const t = await start([{ toolCalls: [{ name: 'slow', input: {} }] }, { text: 'never' }]);
    try {
      const run = await t.platform.startRun({ agent: 'assistant', input: 'slow', owner: 'o' });
      await waitFor(() => t.log.includes('slow:start'));
      await t.platform.cancel(run.id);
      const r = await waitFor(async () => {
        const x = await t.platform.getRun(run.id);
        return x.status === 'cancelled' && x;
      });
      assert.equal(r.status, 'cancelled');
      assert.ok(!t.log.includes('slow:end'));
      const { messages } = await t.platform.thread(r.threadId);
      // the open tool call was sealed with a result, so the conversation can continue
      assert.equal(messages.at(-1).role, 'tool');
      assert.ok(t.log.includes('finished:cancelled'));
    } finally {
      await t.app.close();
    }
  });

  test('a run interrupted by shutdown resumes on the next start from its checkpoint', async () => {
    const stores = { runs: new MemoryRunStore(), conversations: new MemoryConversationStore() };
    const first = await start([{ text: 'Step one.', toolCalls: [{ name: 'slow', input: {} }] }], { stores });
    const run = await first.platform.startRun({ agent: 'assistant', input: 'long job', owner: 'o' });
    await waitFor(() => first.log.includes('slow:start'));
    await first.app.close(); // deploy: the run goes back to the queue with its checkpoint
    const queued = await stores.runs.get(run.id);
    assert.equal(queued.status, 'queued');
    assert.equal(queued.checkpoint.length, 1, 'the model turn was checkpointed');

    // The new process doesn't repeat the model turn; the interrupted side effect isn't repeated blindly.
    const second = await start([{ text: 'Resumed and done.' }], { stores });
    try {
      const done = await waitFor(async () => {
        const r = await stores.runs.get(run.id);
        return r.status === 'completed' && r;
      });
      assert.equal(done.output, 'Resumed and done.');
      assert.equal(second.model.requests.length, 1);
      const toolResult = second.model.requests[0].messages.at(-1).content[0];
      assert.match(JSON.stringify(toolResult.output), /interrupted/);
      // all durable events of both processes, numbered without gaps or repeats
      const events = await stores.runs.events(run.id, 0);
      assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i + 1));
    } finally {
      await second.app.close();
    }
  });

  test('an idempotent tool interrupted by shutdown re-runs on resume, replaying its completed steps', async () => {
    const stores = { runs: new MemoryRunStore(), conversations: new MemoryConversationStore() };
    const charges = [];
    const first = await start([{ toolCalls: [{ name: 'slow', input: {} }] }], { stores });
    // Make 'slow' idempotent with a step that records a charge, then hangs until shutdown.
    const tool = first.app.context.module.ai.tools.find((t) => t.name === 'slow');
    tool.idempotent = true;
    tool.invoke = async (_b, _i, ctx) => {
      await ctx.step('charge', () => {
        charges.push('charged');
        return 'CH-1';
      });
      await new Promise((resolve) => (ctx.signal.aborted ? resolve() : ctx.signal.addEventListener('abort', resolve)));
      return { ok: true };
    };
    const run = await first.platform.startRun({ agent: 'assistant', input: 'charge me', owner: 'o' });
    await waitFor(() => charges.length === 1);
    await first.app.close();

    const second = await start([{ text: 'Charged once.' }], { stores });
    const t2 = second.app.context.module.ai.tools.find((t) => t.name === 'slow');
    t2.idempotent = true;
    t2.invoke = async (_b, _i, ctx) => ({ charge: await ctx.step('charge', () => {
      charges.push('charged again');
      return 'CH-2';
    }) });
    try {
      const done = await waitFor(async () => {
        const r = await stores.runs.get(run.id);
        return r.status === 'completed' && r;
      });
      assert.equal(done.output, 'Charged once.');
      assert.deepEqual(charges, ['charged'], 'the side effect ran once');
      const result = second.model.requests[0].messages.at(-1).content[0];
      assert.deepEqual(result.output, { charge: 'CH-1' }, 'the recorded step result was replayed');
    } finally {
      await second.app.close();
    }
  });

  test('a run whose worker crashed is taken over after its lease expires', async () => {
    const stores = { runs: new MemoryRunStore(), conversations: new MemoryConversationStore() };
    const thread = await stores.conversations.createThread({ owner: 'o', agent: 'assistant' });
    await stores.conversations.appendMessages(thread.id, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
    const old = new Date(Date.now() - 60_000).toISOString();
    await stores.runs.create({ id: 'crashed', agent: 'assistant', threadId: thread.id, owner: 'o', status: 'running', input: 'hi', createdAt: old, updatedAt: old, turns: 0, usage: { inputTokens: 0, outputTokens: 0 }, workerId: 'dead-worker', heartbeatAt: old });
    const t = await start([{ text: 'Recovered.' }], { stores });
    try {
      const done = await waitFor(async () => {
        const r = await stores.runs.get('crashed');
        return r.status === 'completed' && r;
      });
      assert.equal(done.output, 'Recovered.');
    } finally {
      await t.app.close();
    }
  });

  test('a client that reconnects with Last-Event-ID gets only what it missed', async () => {
    const t = await start([{ text: 'One.', toolCalls: [{ name: 'get_balance', input: {} }] }, { text: 'Two.' }]);
    try {
      const run = await (await t.request('/agents/assistant/runs', { method: 'POST', body: JSON.stringify({ input: 'go' }) })).json();
      await waitFor(async () => (await t.platform.getRun(run.id)).status === 'completed');
      const all = await sse(await t.request(`/agents/assistant/runs/${run.id}/events`));
      assert.equal(all[0].data.status, 'queued');
      assert.equal(all.at(-1).event, 'run.completed');
      const cut = all[3].id;
      const rest = await sse(await t.request(`/agents/assistant/runs/${run.id}/events`, { headers: { 'last-event-id': cut } }));
      assert.deepEqual(rest.map((e) => e.id), all.filter((e) => Number(e.id) > Number(cut)).map((e) => e.id));
    } finally {
      await t.app.close();
    }
  });

  test('a model failure fails the run with a readable error and a valid transcript', async () => {
    const t = await start([{ error: 'provider exploded' }]);
    try {
      const run = await t.platform.startRun({ agent: 'assistant', input: 'x', owner: 'o' });
      const r = await waitFor(async () => {
        const x = await t.platform.getRun(run.id);
        return x.status === 'failed' && x;
      });
      assert.match(r.error.message, /provider exploded/);
      // the thread can continue afterwards
      const next = await t.platform.startRun({ agent: 'assistant', input: 'again', owner: 'o', threadId: r.threadId }).catch((e) => e);
      assert.ok(next.id, 'a new run starts in the same thread');
    } finally {
      await t.app.close();
    }
  });
});

describe('tools for other agents', () => {
  test('callTool validates input and returns UI parts', async () => {
    const t = await start([]);
    try {
      const ok = await t.platform.callTool('get_balance', {}, { owner: 'mcp' });
      assert.deepEqual(ok.output, { balance: 1000 });
      await assert.rejects(t.platform.callTool('transfer', { amount: 'lots' }, { owner: 'mcp' }), /Invalid tool arguments/);
      await assert.rejects(t.platform.callTool('nope', {}, { owner: 'mcp' }), /No tool/);
    } finally {
      await t.app.close();
    }
  });
});

describe('keyed lists', () => {
  test('components receive key from the automatic JSX runtime (For)', () => {
    const { jsx } = load('runtime/jsx-runtime');
    const { For, renderToString } = load('runtime/index');
    const html = renderToString(jsx(For, { each: () => [{ id: 'a', t: 'one' }, { id: 'b', t: 'two' }], children: (i) => jsx('li', { children: i.t }) }, (i) => i.id));
    assert.equal(html, '<li>one</li><li>two</li>');
  });
});

describe('run event hub memory', () => {
  const { RunEventHub } = load('ai/runtime/event-hub');
  const ev = (runId, seq, type, data = {}) => ({ runId, seq, type, data, at: new Date().toISOString() });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  test('a finished or paused run frees its buffered events after the grace period', async () => {
    const hub = new RunEventHub(30);
    hub.publish(ev('r1', 1, 'run.status', { status: 'running' }));
    hub.publish(ev('r1', 2, 'run.completed', { output: 'done' }));
    hub.publish(ev('r2', 1, 'run.status', { status: 'awaiting_approval' }));
    hub.publish(ev('r3', 1, 'run.status', { status: 'running' }));
    assert.equal(hub.recentEvents('r1', 0).length, 2, 'late subscribers still get them during the grace period');
    await sleep(80);
    assert.equal(hub.recentEvents('r1', 0).length, 0);
    assert.equal(hub.recentEvents('r2', 0).length, 0);
    assert.equal(hub.recentEvents('r3', 0).length, 1, 'a running run keeps its events');
  });

  test('a run with a subscriber is freed once the subscriber leaves', async () => {
    const hub = new RunEventHub(20);
    const off = hub.subscribe('r1', () => {});
    hub.publish(ev('r1', 1, 'run.completed', {}));
    await sleep(60);
    assert.equal(hub.bufferedRuns, 1);
    off();
    await sleep(60);
    assert.equal(hub.bufferedRuns, 0);
  });

  test('the number of buffered runs is bounded', () => {
    const hub = new RunEventHub(60_000);
    for (let i = 0; i < 2500; i++) hub.publish(ev(`run-${i}`, 1, 'run.status', { status: 'running' }));
    assert.ok(hub.bufferedRuns <= 2000);
    assert.equal(hub.recentEvents('run-2499', 0).length, 1, 'the newest runs are kept');
  });
});

describe('tool errors in production', () => {
  const { toolFailure } = load('ai/runtime/tools');
  const { ToolError } = load('ai/types');
  const { HttpError } = load('runtime/http');
  const logged = [];
  const logger = { warn: (msg, ctx) => logged.push(['warn', msg, ctx]), error: (msg, ctx) => logged.push(['error', msg, ctx]) };

  test('internal errors are hidden behind a logged reference; ToolError and HttpError messages are shown', () => {
    const internal = toolFailure(new Error('relation "accounts" does not exist at 10.0.0.5:5432'), 'get_balance', true, logger);
    assert.match(internal.error, /^The get balance tool failed with an internal error \(reference [0-9a-f]{8}\)\.$/);
    assert.ok(!JSON.stringify(internal).includes('10.0.0.5'));
    const ref = /reference ([0-9a-f]{8})/.exec(internal.error)[1];
    assert.ok(logged.some(([level, , ctx]) => level === 'error' && ctx.reference === ref && /accounts/.test(ctx.err.message)), 'details are logged under the reference');
    assert.deepEqual(toolFailure(new ToolError('Only 2 left in size M'), 'add_to_cart', true, logger), { error: 'Only 2 left in size M' });
    assert.deepEqual(toolFailure(new HttpError(409, 'Insufficient funds'), 'transfer', true, logger), { error: 'Insufficient funds', status: 409 });
    // In development the real message helps while building.
    assert.deepEqual(toolFailure(new Error('boom'), 'x', false, logger), { error: 'boom' });
  });
});

describe('stopping a run while the model is answering', () => {
  test('cancel during a model reply records "cancelled", not a failure', async () => {
    // The scripted model, like real model clients, throws its own error when the signal fires.
    const t = await start([{ text: 'A long answer', delayMs: 5000 }]);
    try {
      const run = await t.platform.startRun({ agent: 'assistant', input: 'hello', owner: 'o' });
      await waitFor(async () => (await t.platform.getRun(run.id)).status === 'running');
      await new Promise((r) => setTimeout(r, 100));
      await t.platform.cancel(run.id);
      const r = await waitFor(async () => {
        const x = await t.platform.getRun(run.id);
        return ['cancelled', 'failed'].includes(x.status) && x;
      });
      assert.equal(r.status, 'cancelled', `run ended as ${r.status}: ${JSON.stringify(r.error ?? null)}`);
      assert.ok(t.log.includes('finished:cancelled'));
    } finally {
      await t.app.close();
    }
  });

  test('a deploy during a model reply puts the run back in the queue', async () => {
    const stores = { runs: new MemoryRunStore(), conversations: new MemoryConversationStore() };
    const first = await start([{ text: 'A long answer', delayMs: 5000 }], { stores });
    const run = await first.platform.startRun({ agent: 'assistant', input: 'hello', owner: 'o' });
    await waitFor(async () => (await stores.runs.get(run.id)).status === 'running');
    await new Promise((r) => setTimeout(r, 100));
    await first.app.close();
    assert.equal((await stores.runs.get(run.id)).status, 'queued');
    const second = await start([{ text: 'Done after the deploy.' }], { stores });
    try {
      const done = await waitFor(async () => {
        const r = await stores.runs.get(run.id);
        return r.status === 'completed' && r;
      });
      assert.equal(done.output, 'Done after the deploy.');
    } finally {
      await second.app.close();
    }
  });
});

describe('run events with several workers', () => {
  const { RunJournal } = load('ai/runtime/journal');
  const { RunEventHub } = load('ai/runtime/event-hub');
  const { Logger } = load('runtime/index');

  test('a worker continues after the newest stored event, even when its own hub saw older ones', async () => {
    const store = new MemoryRunStore();
    const runId = 'run-1';
    const hubA = new RunEventHub();
    const hubB = new RunEventHub();
    // Worker A writes events 1-2 and sees them in its hub.
    const a = await RunJournal.open(runId, store, hubA, Logger.silent());
    a.emit('run.status', { status: 'running' });
    a.emit('message.completed', { text: 'one' });
    await a.flush();
    // Worker B takes the run (after an approval) and writes events 3-4; A's hub never sees them.
    const b = await RunJournal.open(runId, store, hubB, Logger.silent());
    b.emit('run.status', { status: 'running' });
    b.emit('message.completed', { text: 'two' });
    await b.flush();
    // The run comes back to worker A.
    const again = await RunJournal.open(runId, store, hubA, Logger.silent());
    again.emit('message.completed', { text: 'three' });
    await again.flush();
    const seqs = (await store.events(runId, 0)).map((e) => e.seq);
    assert.deepEqual(seqs, [1, 2, 3, 4, 5], 'event numbers are never reused');
  });
});

describe('one run per conversation at a time', () => {
  for (const kind of ['memory', 'file']) {
    test(`two requests for one conversation at once start one run (${kind} store)`, async () => {
      const fs = require('node:fs');
      const os = require('node:os');
      const path = require('node:path');
      const dir = kind === 'file' ? fs.mkdtempSync(path.join(os.tmpdir(), 'amoxi-busy-')) : undefined;
      const stores =
        kind === 'file'
          ? { runs: new ai.FileRunStore(path.join(dir, 'runs')), conversations: new ai.FileConversationStore(path.join(dir, 'conversations')) }
          : { runs: new MemoryRunStore(), conversations: new MemoryConversationStore() };
      const t = await start([{ text: 'First answer.' }, { text: 'Second answer.', delayMs: 300 }, { text: 'never' }], { stores });
      try {
        const first = await t.platform.startRun({ agent: 'assistant', input: 'hello', owner: 'o' });
        await waitFor(async () => (await t.platform.getRun(first.id)).status === 'completed');
        const results = await Promise.allSettled([
          t.platform.startRun({ agent: 'assistant', input: 'again', owner: 'o', threadId: first.threadId }),
          t.platform.startRun({ agent: 'assistant', input: 'again', owner: 'o', threadId: first.threadId }),
        ]);
        const started = results.filter((r) => r.status === 'fulfilled');
        const refused = results.filter((r) => r.status === 'rejected');
        assert.equal(started.length, 1, 'both requests started a run');
        assert.equal(refused[0].reason.status, 409);
        await waitFor(async () => (await t.platform.getRun(started[0].value.id)).status === 'completed');
        // The refused request left nothing in the conversation.
        const { messages } = await t.platform.thread(first.threadId);
        assert.equal(messages.filter((m) => m.role === 'user').length, 2);
      } finally {
        await t.app.close();
        if (dir) fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
