// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0
'use strict';
// Benchmark of durable agent runs: a support agent handling refund requests.
//
// Each run is a realistic support conversation: 4 model turns and 3 tool calls (look up the order,
// check the refund policy, issue the refund inside ctx.step), with streamed text. The model is
// simulated, so the numbers measure Amoxi (checkpointing, the worker, the store), not a provider.
//
//   npm run bench:agents -- [--store file|postgres|memory] [--runs 500] [--concurrency 8]
//                           [--model instant|realistic] [--json]
//
// --model instant answers at once: the most runs per second the framework can checkpoint.
// --model realistic waits like a hosted model (time to first token, then output at a steady rate),
// so a run takes seconds and throughput depends on how many runs execute at once (concurrency).
// PostgreSQL uses DATABASE_URL and needs `pg`: `npm install --no-save pg`, or set BENCH_PG_MODULES to
// a node_modules folder that has it. Build first: npm run build -w amoxi

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { load } = require('../packages/framework/test/dist.cjs');

const { Config, AmoxiApplication, $validate, $v } = load('runtime/index');
const { aiExtension, $aiService, AiServices, FileRunStore, FileConversationStore, MemoryRunStore, MemoryConversationStore, PgRunStore, PgConversationStore } =
  load('ai/index');

/* ------------------------------------------------------------------ */
/* Options                                                             */
/* ------------------------------------------------------------------ */

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const options = {
  store: arg('store', 'file'),
  runs: Number(arg('runs', '500')),
  concurrency: Number(arg('concurrency', '8')),
  model: arg('model', 'instant'),
  json: args.includes('--json'),
};
// A hosted model: about 600 ms to the first token, then 60 tokens a second (a token is about 4 characters).
const REALISTIC = { firstTokenMs: 600, tokensPerSecond: 60 };

/* ------------------------------------------------------------------ */
/* The support agent (fictional shop and customers)                    */
/* ------------------------------------------------------------------ */

const INSTRUCTIONS = `You are the support assistant for Northwind Outfitters, an online outdoor-gear shop.
Help customers with orders, deliveries, returns and refunds. Be brief, warm and precise.
Always look up the order before answering a question about it. Never guess an order's contents or status.
Refunds: check the refund policy for the order first. Issue a refund only when the policy allows it, and
only for the amount the policy states. Tell the customer the refund reference and when the money arrives.
If the customer is upset, acknowledge it once, then focus on fixing the problem.
Do not share other customers' details. Do not promise anything the policy doesn't allow.`.repeat(2);

const FIRST = ['Maya', 'Omar', 'Lena', 'Kenji', 'Sofia', 'Tariq', 'Ines', 'Luca'];
const LAST = ['Fischer', 'Haddad', 'Moreau', 'Tanaka', 'Rossi', 'Novak', 'Silva', 'Berg'];

function orderFor(id) {
  const n = Number(id.slice(2));
  return {
    orderId: id,
    customer: { name: `${FIRST[n % 8]} ${LAST[(n >> 3) % 8]}`, email: `customer${n}@example.com`, tier: n % 5 === 0 ? 'member' : 'standard' },
    placedAt: '2026-10-21T14:12:00Z',
    status: 'delivered',
    deliveredAt: '2026-10-24T10:40:00Z',
    items: [
      { sku: 'TENT-2P-ULTRA', name: 'Ridgeline 2-person tent', quantity: 1, price: 289.0 },
      { sku: 'MAT-INSUL-R4', name: 'Insulated sleeping mat, R-value 4', quantity: 2, price: 74.5 },
      { sku: 'STOVE-CAN-MINI', name: 'Compact canister stove', quantity: 1, price: 39.95 },
    ],
    shipping: { method: 'standard', carrier: 'Parcelway', tracking: `PW${100000 + n}CA`, address: { city: 'Halifax', region: 'NS', country: 'CA' } },
    totals: { subtotal: 477.95, shipping: 0, tax: 71.69, total: 549.64, currency: 'CAD' },
    notes: [],
  };
}

const POLICY = {
  window: 'Within 30 days of delivery',
  damagedItems: 'Full refund of the item price, no return needed when a photo is provided',
  method: 'Refunded to the original payment method in 3-5 business days',
  exclusions: ['Items used beyond inspection', 'Gift cards', 'Final-sale items'],
};

let refundsIssued = 0;

/** A simulated model playing a refund conversation. The turn is read from the transcript, as a real model would. */
class SupportModel {
  constructor(mode) {
    this.provider = 'bench';
    this.model = 'support-sim';
    this.mode = mode;
    this.modelMs = 0;
  }
  async *stream(request) {
    const lastUser = request.messages.map((m) => m.role).lastIndexOf('user');
    const toolsSoFar = request.messages.slice(lastUser).filter((m) => m.role === 'tool').length;
    const orderId = /A-\d+/.exec(JSON.stringify(request.messages[lastUser]))[0];
    const turns = [
      { text: `I'm sorry to hear that. Let me look up order ${orderId}.`, call: { name: 'lookup_order', input: { orderId } } },
      { text: '', call: { name: 'check_refund_policy', input: { orderId, reason: 'damaged' } } },
      { text: 'The tent arrived damaged and the order is within the refund window, so I can refund it now.', call: { name: 'issue_refund', input: { orderId, sku: 'TENT-2P-ULTRA', amount: 289 } } },
      {
        text:
          `Done. I've refunded CAD 289.00 for the Ridgeline 2-person tent on order ${orderId}. ` +
          'The money goes back to your original payment method in 3-5 business days, and you don\'t need to send the tent back. ' +
          'The rest of your order is unaffected. Is there anything else I can help with?',
      },
    ];
    const turn = turns[Math.min(toolsSoFar, 3)];
    const tokens = turn.text.match(/.{1,4}/gs) ?? [];
    if (this.mode === 'realistic') {
      const wait = REALISTIC.firstTokenMs + ((tokens.length + (turn.call ? 20 : 0)) / REALISTIC.tokensPerSecond) * 1000;
      this.modelMs += wait;
      await sleep(REALISTIC.firstTokenMs, request.signal);
      const perToken = 1000 / REALISTIC.tokensPerSecond;
      // Stream in groups of 5 tokens, as providers send small batches.
      for (let i = 0; i < tokens.length; i += 5) {
        await sleep(perToken * 5, request.signal);
        yield { type: 'text', delta: tokens.slice(i, i + 5).join('') };
      }
      if (turn.call) await sleep(perToken * 20, request.signal);
    } else {
      for (const t of tokens) yield { type: 'text', delta: t };
    }
    if (turn.call) yield { type: 'tool_call', id: `call_${toolsSoFar + 1}`, name: turn.call.name, input: turn.call.input };
    yield { type: 'usage', inputTokens: 1400 + 350 * toolsSoFar, outputTokens: tokens.length + (turn.call ? 20 : 0) };
    yield { type: 'finish', reason: turn.call ? 'tool_calls' : 'stop' };
  }
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });

class Shop {
  lookupOrder({ orderId }) {
    return orderFor(orderId);
  }
  checkRefundPolicy({ orderId }) {
    return { orderId, eligible: true, refundableAmount: 289.0, currency: 'CAD', policy: POLICY };
  }
  async issueRefund({ orderId, amount }, ctx) {
    // The side effect runs once per call, even if the run is resumed after a crash.
    const refund = await ctx.step('refund', async () => {
      refundsIssued++;
      return { refundId: `RF-${orderId.slice(2)}-${ctx.callId.slice(-6)}`, amount, currency: 'CAD', status: 'pending', expectedBy: '2026-11-11' };
    });
    return refund;
  }
}

const done = new Map();
const early = new Map();
class Support {
  instructions() {
    return INSTRUCTIONS;
  }
  onRunFinished(run) {
    const cb = done.get(run.id);
    if (cb) cb(run);
    else early.set(run.id, run); // finished before startRun returned
  }
}

function supportModule() {
  const str = (name) => [name, $v.str, false];
  const schema = (props) => ({ type: 'object', properties: Object.fromEntries(props.map((p) => [p, { type: p === 'amount' ? 'number' : 'string' }])), required: props });
  const tool = (name, props, invoke, extra = {}) => ({
    name,
    description: name.replace(/_/g, ' '),
    beanId: 0,
    inputSchema: schema(props),
    validate: (x) => $validate(x ?? {}, (y, e, p) => $v.obj(y, e, p, props.map((k) => (k === 'amount' ? [k, $v.num, false] : str(k))))),
    invoke,
    approval: false,
    readOnly: false,
    expose: true,
    source: `Shop.${name}`,
    ...extra,
  });
  const SERVICES = ['ChatModel', 'Embedder', 'VectorStore', 'ConversationStore', 'RunStore', 'AgentPlatform', 'KnowledgeBases', 'MemoryService'];
  const beans = [
    { id: 0, name: 'Shop', scope: 'singleton', eager: false, primary: false, types: ['Shop'], create: () => new Shop() },
    { id: 1, name: 'Support', scope: 'singleton', eager: false, primary: false, types: ['Support'], create: () => new Support() },
    ...SERVICES.map((name, i) => ({ id: 2 + i, name, scope: 'singleton', eager: false, primary: false, types: [name], create: (r) => $aiService(r, name) })),
  ];
  return {
    beans,
    typeIndex: Object.fromEntries(beans.map((b) => [b.types[0], [b.id]])),
    routes: [],
    middleware: [],
    websockets: [],
    buildInfo: { generatedAt: 'bench', compilerVersion: 'bench' },
    extensions: [aiExtension],
    ai: {
      tools: [
        tool('lookup_order', ['orderId'], (b, i) => b.lookupOrder(i), { readOnly: true }),
        tool('check_refund_policy', ['orderId', 'reason'], (b, i) => b.checkRefundPolicy(i), { readOnly: true }),
        tool('issue_refund', ['orderId', 'sku', 'amount'], (b, i, t) => b.issueRefund(i, t), { idempotent: true }),
      ],
      components: [],
      agents: [
        {
          name: 'support',
          description: 'Customer support',
          beanId: 1,
          tools: ['lookup_order', 'check_refund_policy', 'issue_refund'],
          ui: [],
          knowledge: [],
          recall: 0,
          rememberTool: false,
          examples: [],
          hooks: { principal: false, owner: false, beforeToolCall: false, onRunFinished: true },
        },
      ],
    },
  };
}

/* ------------------------------------------------------------------ */
/* Stores, with a count of every write                                 */
/* ------------------------------------------------------------------ */

const writes = { run: 0, events: 0, conversation: 0 };
function counted(store, kind, methods) {
  return new Proxy(store, {
    get(target, prop) {
      const v = target[prop];
      if (typeof v !== 'function') return v;
      if (methods.includes(prop)) return (...a) => (writes[kind === 'run' && prop === 'appendEvents' ? 'events' : kind]++, v.apply(target, a));
      return v.bind(target);
    },
  });
}

async function openStores(kind) {
  if (kind === 'memory') return { runs: new MemoryRunStore(), conversations: new MemoryConversationStore(), size: async () => undefined, close: async () => undefined };
  if (kind === 'file') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amoxi-bench-'));
    const du = (d) => fs.readdirSync(d, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).reduce((s, e) => s + fs.statSync(path.join(e.parentPath ?? e.path, e.name)).size, 0);
    return {
      runs: new FileRunStore(path.join(dir, 'runs')),
      conversations: new FileConversationStore(path.join(dir, 'threads')),
      size: async () => ({ runs: du(path.join(dir, 'runs')), conversations: du(path.join(dir, 'threads')) }),
      close: async () => fs.rmSync(dir, { recursive: true, force: true }),
    };
  }
  if (kind === 'postgres') {
    const pg = require(path.join(process.env.BENCH_PG_MODULES ?? path.join(__dirname, '..', 'node_modules'), 'pg'));
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
    const prefix = `bench_${process.pid}_`;
    const tables = async () => (await pool.query(`SELECT tablename FROM pg_tables WHERE tablename LIKE $1`, [`${prefix}%`])).rows.map((r) => r.tablename);
    return {
      runs: new PgRunStore({ db: pool, tablePrefix: prefix }),
      conversations: new PgConversationStore({ db: pool, tablePrefix: prefix }),
      async size() {
        const out = {};
        for (const t of await tables()) {
          const r = await pool.query(`SELECT pg_total_relation_size($1) AS total, pg_relation_size($1) AS data`, [t]);
          out[t.slice(prefix.length)] = { total: Number(r.rows[0].total), data: Number(r.rows[0].data) };
        }
        const payload = await pool.query(
          `SELECT (SELECT COALESCE(SUM(pg_column_size(t.*)), 0) FROM ${prefix}runs t) AS runs,
                  (SELECT COALESCE(SUM(pg_column_size(t.*)), 0) FROM ${prefix}run_events t) AS events,
                  (SELECT COALESCE(SUM(pg_column_size(t.*)), 0) FROM ${prefix}messages t) AS messages`,
        );
        out.rowBytes = { runs: Number(payload.rows[0].runs), events: Number(payload.rows[0].events), messages: Number(payload.rows[0].messages) };
        return out;
      },
      async close() {
        for (const t of await tables()) await pool.query(`DROP TABLE IF EXISTS ${t} CASCADE`);
        await pool.end();
      },
    };
  }
  throw new Error(`Unknown store '${kind}'`);
}

/* ------------------------------------------------------------------ */
/* Run                                                                 */
/* ------------------------------------------------------------------ */

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

async function main() {
  const stores = await openStores(options.store);
  const model = new SupportModel(options.model);
  const app = await AmoxiApplication.run(supportModule(), {
    config: Config.of({ server: { port: 0, host: '127.0.0.1' }, ai: { runs: { concurrency: options.concurrency } } }, 'bench'),
    silent: true,
    shutdownHook: false,
    overrides: [
      ['ChatModel', model],
      ['RunStore', counted(stores.runs, 'run', ['create', 'createIfIdle', 'update', 'claim', 'appendEvents'])],
      ['ConversationStore', counted(stores.conversations, 'conversation', ['createThread', 'appendMessages', 'updateThread'])],
    ],
  });
  const platform = AiServices.of(app.context).platform();

  // Warm up: a few runs so that tables exist and code is compiled by V8.
  await batch(platform, Math.min(20, options.runs), 'warm');
  for (const k of Object.keys(writes)) writes[k] = 0;
  model.modelMs = 0;
  refundsIssued = 0;
  const sizeBefore = await stores.size();

  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  const results = await batch(platform, options.runs, 'run');
  const wall = performance.now() - t0;
  const cpu = process.cpuUsage(cpu0);
  const sizeAfter = await stores.size();

  const failed = results.filter((r) => r.status !== 'completed');
  const latencies = results.map((r) => r.ms).sort((a, b) => a - b);
  const exec = results.map((r) => r.execMs).sort((a, b) => a - b);
  const sample = await platform.getRun(results[0].id);
  const events = await stores.runs.events(results[0].id, 0);
  const report = {
    store: options.store,
    model: options.model,
    concurrency: options.concurrency,
    runs: options.runs,
    failed: failed.length,
    refundsIssued,
    machine: `${os.cpus().length} vCPU, ${Math.round(os.totalmem() / 2 ** 30)} GB, Node.js ${process.versions.node}`,
    runsPerSecond: +(options.runs / (wall / 1000)).toFixed(1),
    latencyMs: { p50: Math.round(pct(latencies, 50)), p95: Math.round(pct(latencies, 95)), p99: Math.round(pct(latencies, 99)) },
    // From the worker picking the run up to its end (latency also includes time queued).
    runDurationMs: { p50: Math.round(pct(exec, 50)), p95: Math.round(pct(exec, 95)) },
    cpuMsPerRun: +((cpu.user + cpu.system) / 1000 / options.runs).toFixed(2),
    modelMsPerRun: options.model === 'realistic' ? Math.round(model.modelMs / options.runs) : 0,
    perRun: {
      modelTurns: sample.turns,
      durableEvents: events.length,
      runRecordBytes: Buffer.byteLength(JSON.stringify(sample)),
      eventBytes: events.reduce((s, e) => s + Buffer.byteLength(JSON.stringify(e)), 0),
      storeWrites: +((writes.run + writes.events + writes.conversation) / options.runs).toFixed(1),
      writesByKind: Object.fromEntries(Object.entries(writes).map(([k, v]) => [k, +(v / options.runs).toFixed(1)])),
    },
    storageBytesPerRun: perRunSize(sizeBefore, sizeAfter, options.runs),
  };
  await app.close();
  await stores.close();
  if (options.json) console.log(JSON.stringify(report));
  else console.log(JSON.stringify(report, null, 2));
  if (failed.length) process.exitCode = 1;
}

let seq = 0;
/** Starts n runs, up to 32 requests at a time (like concurrent HTTP requests), and waits for all to finish. */
async function batch(platform, n, label) {
  const finished = [];
  let next = 0;
  const submit = async () => {
    while (next < n) {
      const i = next++;
      const orderId = `A-${1000 + (seq++ % 9000)}`;
      const started = performance.now();
      let resolveRun;
      const finishedRun = new Promise((r) => (resolveRun = r));
      const run = await platform.startRun({ agent: 'support', owner: `customer-${label}-${i}`, input: `Hi, my order ${orderId} arrived and the tent is torn. Can I get a refund?` });
      const onDone = (r) => (done.delete(run.id), resolveRun({ id: r.id, status: r.status, ms: performance.now() - started, execMs: Date.parse(r.finishedAt) - Date.parse(r.startedAt) }));
      if (early.has(run.id)) onDone(early.get(run.id)), early.delete(run.id);
      else done.set(run.id, onDone);
      finished.push(finishedRun);
    }
  };
  await Promise.all(Array.from({ length: Math.min(32, n) }, submit));
  return Promise.all(finished);
}

function perRunSize(before, after, n) {
  if (!before || !after) return undefined;
  const out = {};
  if (after.rowBytes) {
    const rows = {};
    for (const k of Object.keys(after.rowBytes)) rows[k] = Math.round((after.rowBytes[k] - before.rowBytes[k]) / n);
    out.liveRowBytes = rows;
  }
  for (const k of Object.keys(after)) {
    if (k === 'rowBytes') continue;
    const a = after[k];
    const b = before[k] ?? (typeof a === 'number' ? 0 : { total: 0, data: 0 });
    out[k] = typeof a === 'number' ? Math.round((a - b) / n) : Math.round((a.total - b.total) / n);
  }
  return out;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
