// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPS } from '../lib/apps.mjs';
import { Client } from '../lib/http.mjs';
import { freePort, ServerProcess, sleep } from '../lib/proc.mjs';
import { startProduction } from './production.mjs';

const HARNESS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'harness.cjs');
const app = (id) => APPS.find((a) => a.id === id);

/** Starts an app in the harness (one process, production profile) to read memory over IPC. */
async function harness(ctx, id, extra = []) {
  const a = app(id);
  const port = await freePort();
  const server = await ctx.server(`${id} (harness)`, ['--expose-gc', HARNESS, path.join(ctx.root, a.dir), String(port), `--ai.store.dir=${ctx.tmp('amoxi-h-')}`, ...extra], {
    cwd: path.join(ctx.root, a.dir),
    env: { NODE_ENV: 'production', ...(a.env ?? {}) },
    readyUrl: `http://127.0.0.1:${port}/amoxi/health/ready`,
  });
  const stats = () =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('stats timed out')), 10_000);
      const on = (m) => {
        if (m?.type !== 'stats') return;
        clearTimeout(t);
        server.child.off('message', on);
        resolve(m);
      };
      server.child.on('message', on);
      server.child.send({ type: 'stats' });
    });
  return { server, port, base: `http://127.0.0.1:${port}`, stats };
}

const mb = (n) => Math.round((n / 1024 / 1024) * 10) / 10;
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;

/** Closed-loop load: `concurrency` virtual users repeat `pick()` requests for `ms`. */
async function load(base, { concurrency, ms, pick }) {
  const latencies = [];
  const errors = new Map();
  const end = Date.now() + ms;
  const worker = async () => {
    while (Date.now() < end) {
      const { path: p, init, expect } = pick();
      const t0 = performance.now();
      try {
        const res = await fetch(base + p, { ...init, signal: AbortSignal.timeout(15_000) });
        await res.arrayBuffer();
        latencies.push(performance.now() - t0);
        if (!expect.includes(res.status)) errors.set(`${p} -> ${res.status}`, (errors.get(`${p} -> ${res.status}`) ?? 0) + 1);
      } catch (err) {
        errors.set(`${p} -> ${err.name}`, (errors.get(`${p} -> ${err.name}`) ?? 0) + 1);
      }
    }
  };
  const t0 = Date.now();
  await Promise.all(Array.from({ length: concurrency }, worker));
  const sorted = latencies.sort((a, b) => a - b);
  return { requests: sorted.length, rps: Math.round(sorted.length / ((Date.now() - t0) / 1000)), p50: pct(sorted, 50), p95: pct(sorted, 95), p99: pct(sorted, 99), max: sorted.at(-1) ?? 0, errors };
}

export const loadStage = {
  id: 'load',
  title: 'Load and memory',
  description: 'sustained concurrent traffic, latency percentiles, memory and handle leaks, concurrent agent runs',
  quick: false,
  needs: ['build'],
  async run(ctx) {
    // ---- HTTP: pages, cached pages, JSON API ---------------------------------------------
    const h = await harness(ctx, 'user-service', ['--server.compression=true']);
    const mix = () => {
      const r = Math.random();
      if (r < 0.4) return { path: `/users/${1 + Math.floor(Math.random() * 3)}`, init: {}, expect: [200, 404] };
      if (r < 0.65) return { path: '/wiring', init: { headers: { accept: 'text/html' } }, expect: [200] };
      if (r < 0.9) return { path: '/people', init: { headers: { accept: 'text/html', 'accept-encoding': 'gzip' } }, expect: [200] };
      return { path: '/users', init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Load Test', email: `load${Math.floor(Math.random() * 1e6)}@example.org` }) }, expect: [201, 409] }; // 409: the demo's 500-user limit
    };
    await load(h.base, { concurrency: 16, ms: 3000, pick: mix }); // warm-up (JIT, caches)
    const base = await h.stats();
    const rounds = [];
    for (let i = 0; i < 3; i++) {
      const r = await load(h.base, { concurrency: 64, ms: 8000, pick: mix });
      rounds.push({ ...r, stats: await h.stats() });
    }
    const all = rounds.reduce((a, r) => ({ requests: a.requests + r.requests, errors: new Map([...a.errors, ...r.errors]) }), { requests: 0, errors: new Map() });
    const last = rounds.at(-1);
    ctx.metric('requests served (3 × 8 s, 64 concurrent clients)', all.requests);
    ctx.metric('throughput (last round)', last.rps, 'req/s');
    ctx.metric('latency p50 / p95 / p99 / max', `${last.p50.toFixed(1)} / ${last.p95.toFixed(1)} / ${last.p99.toFixed(1)} / ${last.max.toFixed(0)}`, 'ms', 'p99 < 1500 ms');
    ctx.metric('heap after warm-up → after each round', `${mb(base.memory.heapUsed)} → ${rounds.map((r) => mb(r.stats.memory.heapUsed)).join(' → ')}`, 'MB');
    await ctx.check('no failed requests under load', () => ctx.assert.deepEqual(Object.fromEntries(all.errors), {}));
    await ctx.check('p99 latency under 1.5 s at 64 concurrent clients', () => ctx.assert.ok(last.p99 < 1500, `p99 ${last.p99.toFixed(0)} ms`));
    await ctx.check('no memory leak: heap stable across rounds (< 25 MB growth after round 1)', () => {
      const growth = rounds.at(-1).stats.memory.heapUsed - rounds[0].stats.memory.heapUsed;
      ctx.assert.ok(growth < 25 * 1024 * 1024, `heap grew ${mb(growth)} MB between round 1 and round 3`);
    });
    await ctx.check('no handle leak: open handles return to baseline once clients disconnect', async () => {
      await sleep(6500); // keep-alive timeout is 5 s
      const after = await h.stats();
      ctx.assert.ok(after.handles <= base.handles + 8, `handles ${base.handles} → ${after.handles}`);
    });
    await h.server.stop();

    // ---- Agents: concurrent streamed runs ------------------------------------------------
    const b = await harness(ctx, 'banking-assistant', ['--ai.offline.delay-ms=2']);
    const users = await Promise.all(
      Array.from({ length: 20 }, async (_, i) => {
        const c = new Client(b.base);
        await c.request('/api/session', { method: 'POST', json: { customerId: ['C-1001', 'C-1002', 'C-1003'][i % 3] } }).then((r) => r.arrayBuffer());
        return c;
      }),
    );
    const warm = await b.stats();
    const durations = [];
    const failures = [];
    await Promise.all(
      users.map(async (c) => {
        for (let i = 0; i < 3; i++) {
          const t0 = performance.now();
          const { events } = await c.sse('/agents/banking-assistant/runs', { method: 'POST', json: { input: 'Show my accounts and balances' }, timeoutMs: 60_000 });
          durations.push(performance.now() - t0);
          if (events.at(-1)?.event !== 'run.completed') failures.push(events.at(-1)?.event ?? 'no events');
        }
      }),
    );
    // Clients that walk away mid-stream must not leave listeners behind.
    await Promise.all(
      users.slice(0, 10).map(async (c) => {
        const ctl = new AbortController();
        const res = await fetch(`${b.base}/agents/banking-assistant/runs`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream', 'sec-fetch-site': 'same-origin', cookie: c.cookieHeader() }, body: JSON.stringify({ input: 'Show my accounts and balances' }), signal: ctl.signal }).catch(() => undefined);
        await sleep(20);
        ctl.abort();
        void res;
      }),
    );
    await sleep(3000);
    const after = await b.stats();
    const sorted = durations.sort((x, y) => x - y);
    ctx.metric('agent runs (20 users × 3, concurrent)', durations.length);
    ctx.metric('run duration p50 / p95', `${pct(sorted, 50).toFixed(0)} / ${pct(sorted, 95).toFixed(0)}`, 'ms');
    ctx.metric('heap before → after agent load', `${mb(warm.memory.heapUsed)} → ${mb(after.memory.heapUsed)}`, 'MB');
    await ctx.check('every concurrent agent run completes', () => ctx.assert.deepEqual(failures, []));
    await ctx.check('disconnected streams release their listeners', () => ctx.assert.equal(after.hub?.listeners, 0, `hub listeners: ${after.hub?.listeners}`));
    await ctx.check('agent load leaves bounded memory (< 60 MB for 70 runs incl. stored transcripts)', () => {
      ctx.assert.ok(after.memory.heapUsed - warm.memory.heapUsed < 60 * 1024 * 1024, `heap grew ${mb(after.memory.heapUsed - warm.memory.heapUsed)} MB`);
    });
  },
};

export const recovery = {
  id: 'recovery',
  title: 'Crash and restart recovery',
  description: 'worker crash under amoxi start; agent runs resuming after a hard crash and after a graceful restart',
  quick: false,
  needs: ['build'],
  async run(ctx) {
    // ---- A crashed cluster worker is replaced while the others keep serving -----------------
    await ctx.check('amoxi start replaces a crashed worker without downtime', async () => {
      const { base } = await startProduction(ctx, app('user-service'), { workers: 2, env: { AMOXI_MANAGEMENT_ENABLED: 'true' } });
      const c = new Client(base);
      const info = await c.json('/amoxi/info');
      const pid = info.data?.runtime?.pid;
      ctx.assert.ok(pid, `no worker pid: ${info.text}`);
      process.kill(pid, 'SIGKILL');
      let failures = 0;
      for (let i = 0; i < 40; i++) {
        const res = await fetch(`${base}/amoxi/health/ready`).catch(() => undefined);
        if (!res?.ok) failures++;
        await res?.arrayBuffer();
        await sleep(50);
      }
      ctx.assert.ok(failures <= 2, `${failures} of 40 health checks failed while a worker restarted`);
      const pids = new Set();
      for (let i = 0; i < 20; i++) pids.add((await c.json('/amoxi/info')).data?.runtime?.pid);
      ctx.assert.ok(!pids.has(pid), 'the crashed worker is still listed');
    });

    // ---- Durable agent runs: dispatch planner (slow, multi-step tool) ----------------------
    const a = app('dispatch-agent');
    const dataDir = ctx.tmp('amoxi-recovery-');
    const env = { NODE_ENV: 'production', AI_STORE_TYPE: 'file', AI_STORE_DIR: dataDir, AI_RUNS_LEASEMS: '5000', AI_RUNS_POLLMS: '250', DISPATCH_PLANNER_STEPMS: '400' };
    const startOne = async (port) =>
      ServerProcess.start('dispatch-agent', ['dist/src/main.js'], { cwd: path.join(ctx.root, a.dir), env: { ...env, ...(a.env ?? {}), SERVER_PORT: String(port) }, readyUrl: `http://127.0.0.1:${port}/amoxi/health/ready` });
    const waitFor = async (fn, ms, what) => {
      const end = Date.now() + ms;
      for (;;) {
        const v = await fn().catch(() => undefined);
        if (v) return v;
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await sleep(250);
      }
    };
    const startPlan = async (c) => {
      const { res, data, text } = await c.json('/agents/dispatch-planner/runs', { method: 'POST', json: { input: 'Plan routes for Toronto depot tomorrow' } });
      ctx.assert.equal(res.status, 202, text);
      return data.id;
    };
    const inProgress = (c, id) =>
      waitFor(async () => {
        const { events } = await c.sse(`/agents/dispatch-planner/runs/${id}/events`, { timeoutMs: 2000 }).catch(() => ({ events: [] }));
        return events.some((e) => e.event === 'progress' || e.event === 'tool.started');
      }, 30_000, 'the planner to start working');
    const finished = (c, id) =>
      waitFor(async () => {
        const { data } = await c.json(`/agents/dispatch-planner/runs/${id}`);
        return ['completed', 'failed', 'cancelled'].includes(data?.status) ? data : undefined;
      }, 120_000, 'the run to finish');
    const contiguous = async (c, id) => {
      const { events } = await c.sse(`/agents/dispatch-planner/runs/${id}/events`);
      const seqs = events.map((e) => Number(e.id)).filter(Number.isInteger);
      ctx.assert.deepEqual(seqs, seqs.map((_, i) => i + 1), 'durable events are not numbered 1..n without gaps');
      ctx.assert.equal(events.filter((e) => e.event === 'run.completed').length, 1, 'run.completed must appear exactly once');
    };

    await ctx.check('a run interrupted by a hard crash (kill -9) resumes and completes after restart', async () => {
      const port = await freePort();
      let server = await startOne(port);
      const c = new Client(`http://127.0.0.1:${port}`);
      const id = await startPlan(c);
      await inProgress(c, id);
      await server.kill();
      server = await startOne(port);
      try {
        const run = await finished(c, id);
        ctx.assert.equal(run.status, 'completed', JSON.stringify(run.error));
        await contiguous(c, id);
      } finally {
        await server.stop();
      }
    });

    await ctx.check('a run interrupted by a graceful restart (deploy) resumes and completes', async () => {
      const port = await freePort();
      let server = await startOne(port);
      const c = new Client(`http://127.0.0.1:${port}`);
      const id = await startPlan(c);
      await inProgress(c, id);
      const exit = await server.stop();
      ctx.assert.equal(exit.code, 0, 'graceful stop must exit 0');
      server = await startOne(port);
      try {
        const run = await finished(c, id);
        ctx.assert.equal(run.status, 'completed', JSON.stringify(run.error));
        await contiguous(c, id);
      } finally {
        await server.stop();
      }
    });
  },
};
