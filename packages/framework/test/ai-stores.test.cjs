// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0
'use strict';
// Run stores, conversation stores, PostgreSQL stores and the store factory (amoxi/ai).
//
// PostgreSQL tests run against PGlite (Postgres in WASM) with pgvector when
// `@electric-sql/pglite` and `@electric-sql/pglite-pgvector` can be resolved, from the normal
// module path or from the folder in AMOXI_PGLITE_DIR; otherwise they are skipped.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { load } = require('./dist.cjs');

const { MemoryRunStore } = load('ai/stores/memory-run-store');
const { RunConflictError } = load('ai/types');
const { FileRunStore } = load('ai/stores/file-run-store');
const { MemoryConversationStore } = load('ai/stores/memory-conversation-store');
const { FileConversationStore } = load('ai/stores/file-conversation-store');
const { createAiStores, createEmbedder } = load('ai/stores/factory');
const { loadPg, checkTablePrefix } = load('ai/pg/pg-loader');
const { PgRunStore } = load('ai/pg/pg-run-store');
const { PgConversationStore } = load('ai/pg/pg-conversation-store');
const { PgVectorStore } = load('ai/pg/pg-vector-store');
const { Config } = load('runtime/config');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'amoxi-ai-stores-'));
}

/* ------------------------------------------------------------------ */
/* PGlite adapter (PgQueryable)                                        */
/* ------------------------------------------------------------------ */

function resolvePglite() {
  const paths = [process.env.AMOXI_PGLITE_DIR, process.cwd(), __dirname].filter(Boolean);
  try {
    const { PGlite } = require(require.resolve('@electric-sql/pglite', { paths }));
    const { vector } = require(require.resolve('@electric-sql/pglite-pgvector', { paths }));
    return { PGlite, vector };
  } catch {
    return undefined;
  }
}
const pglite = resolvePglite();

/** Adapts PGlite to the PgQueryable interface the stores accept. */
async function pgliteDb() {
  const db = await pglite.PGlite.create({ extensions: { vector: pglite.vector } });
  return {
    raw: db,
    async query(text, params) {
      const r = await db.query(text, params ?? []);
      return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
    },
    close: () => db.close(),
  };
}

/* ------------------------------------------------------------------ */
/* Shared RunStore contract tests                                       */
/* ------------------------------------------------------------------ */

let counter = 0;
function run(overrides = {}) {
  counter++;
  const createdAt = overrides.createdAt ?? new Date(Date.UTC(2026, 0, 1, 0, 0, counter)).toISOString();
  return {
    id: `run-${counter}-${Math.random().toString(36).slice(2, 8)}`,
    agent: 'support',
    threadId: 'thread-1',
    owner: 'owner-1',
    status: 'queued',
    input: 'hello',
    createdAt,
    updatedAt: createdAt,
    turns: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    ...overrides,
  };
}

function ev(runId, seq, type = 'progress') {
  return { seq, runId, type, data: { n: seq }, at: new Date().toISOString() };
}

function runStoreSuite(name, make) {
  describe(`${name} (RunStore)`, () => {
    test('create, get, update, listByThread', async () => {
      const { store, done } = await make();
      try {
        const r = run({ threadId: 't-a', principal: { customer: 7 } });
        await store.create(r);
        await assert.rejects(store.create(r), /already exists/);
        assert.deepEqual(await store.get(r.id), r);
        assert.equal(await store.get('missing'), undefined);
        const up = await store.update(r.id, { status: 'completed', output: 'done', turns: 2, usage: { inputTokens: 5, outputTokens: 3 } });
        assert.equal(up.status, 'completed');
        assert.equal(up.output, 'done');
        assert.equal(up.input, 'hello', 'shallow merge keeps other fields');
        assert.deepEqual(up.principal, { customer: 7 });
        assert.deepEqual(await store.get(r.id), up);
        await assert.rejects(store.update('missing', { turns: 1 }), /not found/);
        const r2 = run({ threadId: 't-a' });
        await store.create(r2);
        await store.create(run({ threadId: 't-b' }));
        assert.deepEqual((await store.listByThread('t-a')).map((x) => x.id), [r.id, r2.id]);
        assert.deepEqual(await store.listByThread('nope'), []);
      } finally {
        await done();
      }
    });

    test('conditional update is a compare-and-set on status and revision', async () => {
      const { store, done } = await make();
      try {
        const r = run({ status: 'awaiting_approval' });
        await store.create(r);
        const seen = await store.get(r.id);
        const rev = seen.revision ?? 0;
        // Two writers read the same revision; only the first wins.
        const first = await store.update(r.id, { status: 'queued' }, { status: ['awaiting_approval'], revision: rev });
        assert.equal(first.status, 'queued');
        assert.ok((first.revision ?? 0) > rev, 'revision increases');
        await assert.rejects(store.update(r.id, { status: 'cancelled' }, { status: ['awaiting_approval', 'queued'], revision: rev }), (e) => e instanceof RunConflictError);
        await assert.rejects(store.update(r.id, { status: 'cancelled' }, { status: ['awaiting_approval'] }), (e) => e instanceof RunConflictError);
        assert.equal((await store.get(r.id)).status, 'queued', 'a failed compare-and-set changes nothing');
        const ok = await store.update(r.id, { status: 'cancelled' }, { status: ['queued'], revision: first.revision });
        assert.equal(ok.status, 'cancelled');
        await assert.rejects(store.update('missing', { turns: 1 }, { status: ['queued'] }), /not found/);
        // A worker that stalled can't write after another worker took the run over.
        const r3 = run({ status: 'queued' });
        await store.create(r3);
        const a = await store.claim('worker-a', new Date(Date.now() - 60_000).toISOString());
        assert.equal(a.workerId, 'worker-a');
        const b = await store.claim('worker-b', new Date(Date.now() + 60_000).toISOString()); // a's lease looks expired
        assert.equal(b.workerId, 'worker-b');
        assert.equal(b.id, a.id, 'worker-b took over the run worker-a held');
        await assert.rejects(store.update(a.id, { turns: 9 }, { workerId: 'worker-a' }), (e) => e instanceof RunConflictError);
        assert.equal((await store.update(a.id, { turns: 2 }, { workerId: 'worker-b' })).turns, 2);
        // Concurrent compare-and-sets from one starting point: exactly one succeeds.
        const r2 = run({ status: 'queued' });
        await store.create(r2);
        const base = (await store.get(r2.id)).revision ?? 0;
        const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => store.update(r2.id, { turns: i + 1 }, { revision: base })));
        assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
      } finally {
        await done();
      }
    });

    test('events after seq, in order', async () => {
      const { store, done } = await make();
      try {
        const r = run();
        await store.create(r);
        await store.appendEvents(r.id, [ev(r.id, 1), ev(r.id, 2)]);
        await store.appendEvents(r.id, []);
        await store.appendEvents(r.id, [ev(r.id, 3, 'run.completed')]);
        assert.deepEqual((await store.events(r.id, 0)).map((e) => e.seq), [1, 2, 3]);
        assert.deepEqual((await store.events(r.id, 2)).map((e) => e.seq), [3]);
        await store.appendEvents(r.id, [ev(r.id, 4)]);
        assert.deepEqual((await store.events(r.id, 2)).map((e) => e.seq), [3, 4], 'sees appended events');
        const all = await store.events(r.id, 0);
        assert.deepEqual(all[2], ev(r.id, 3, 'run.completed') && { ...all[2] });
        assert.equal(all[2].type, 'run.completed');
        assert.deepEqual(all[0].data, { n: 1 });
        assert.deepEqual(await store.events('none', 0), []);
      } finally {
        await done();
      }
    });

    test('claim takes the oldest claimable run and reclaims stale ones', async () => {
      const { store, done } = await make();
      try {
        const now = Date.now();
        const old = new Date(now - 60_000).toISOString();
        const fresh = new Date(now).toISOString();
        const staleBefore = new Date(now - 30_000).toISOString();
        const busy = run({ status: 'running', workerId: 'w0', heartbeatAt: fresh, createdAt: '2026-01-01T00:00:00.000Z' });
        const waiting = run({ status: 'awaiting_approval', createdAt: '2026-01-01T00:00:01.000Z' });
        const finished = run({ status: 'completed', createdAt: '2026-01-01T00:00:02.000Z' });
        const q2 = run({ createdAt: '2026-01-01T00:00:05.000Z' });
        const q1 = run({ createdAt: '2026-01-01T00:00:04.000Z' });
        const stale = run({ status: 'running', workerId: 'dead', heartbeatAt: old, createdAt: '2026-01-01T00:00:06.000Z', startedAt: old });
        for (const r of [busy, waiting, finished, q2, q1, stale]) await store.create(r);

        const a = await store.claim('w1', staleBefore);
        assert.equal(a.id, q1.id, 'oldest first');
        assert.equal(a.status, 'running');
        assert.equal(a.workerId, 'w1');
        assert.ok(a.heartbeatAt && a.startedAt);
        assert.deepEqual(await store.get(q1.id), a);
        assert.equal((await store.claim('w1', staleBefore)).id, q2.id);
        const c = await store.claim('w2', staleBefore);
        assert.equal(c.id, stale.id, 'stale run is reclaimed');
        assert.equal(c.workerId, 'w2');
        assert.equal(c.startedAt, old, 'startedAt is kept');
        assert.equal(await store.claim('w3', staleBefore), undefined, 'fresh, waiting and finished runs are not claimed');
        await assert.rejects(store.claim('w3', 'not a date'), /ISO date/);
      } finally {
        await done();
      }
    });
  });
}

/** Two claimers draining one queue never take the same run. */
async function assertExclusiveClaims(claimerA, claimerB, create, total) {
  for (let i = 0; i < total; i++) await create(run());
  const staleBefore = new Date(Date.now() - 60_000).toISOString();
  const taken = { A: [], B: [] };
  const drain = async (label, store) => {
    for (;;) {
      const r = await store.claim(label, staleBefore);
      if (!r) {
        // A claim may skip a run locked by the other claimer: retry briefly before giving up.
        await new Promise((res) => setTimeout(res, 5));
        const again = await store.claim(label, staleBefore);
        if (!again) return;
        taken[label].push(again.id);
        continue;
      }
      taken[label].push(r.id);
    }
  };
  await Promise.all([drain('A', claimerA), drain('A', claimerA), drain('B', claimerB), drain('B', claimerB)]);
  const all = [...taken.A, ...taken.B];
  assert.equal(new Set(all).size, all.length, 'no run claimed twice');
  assert.equal(all.length, total, 'every run claimed');
  return taken;
}

runStoreSuite('MemoryRunStore', async () => ({ store: new MemoryRunStore(), done: async () => undefined }));

runStoreSuite('FileRunStore', async () => {
  const dir = tmpDir();
  return { store: new FileRunStore(dir), done: async () => fs.rmSync(dir, { recursive: true, force: true }) };
});

describe('FileRunStore across instances', () => {
  test('two store instances on one directory never claim the same run', async () => {
    const dir = tmpDir();
    try {
      const a = new FileRunStore(dir);
      const b = new FileRunStore(dir);
      const taken = await assertExclusiveClaims(a, b, (r) => a.create(r), 40);
      assert.ok(taken.A.length > 0 && taken.B.length > 0, `both worked: ${taken.A.length}/${taken.B.length}`);
      // Records and lock files are consistent.
      assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.lock') || f.endsWith('.tmp')), []);
      const claimedBy = await Promise.all([...taken.A, ...taken.B].map((id) => b.get(id)));
      for (const r of claimedBy) assert.equal(r.status, 'running');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('four processes draining one directory never claim the same run', async () => {
    const { execFile } = require('node:child_process');
    const dir = tmpDir();
    try {
      const seed = new FileRunStore(dir);
      for (let i = 0; i < 40; i++) await seed.create(run());
      const script = `
        const { FileRunStore } = require(process.argv[1]);
        const s = new FileRunStore(process.argv[2]);
        (async () => {
          const ids = [];
          for (let misses = 0; misses < 3; ) {
            const r = await s.claim('p' + process.pid, new Date(Date.now() - 60000).toISOString());
            if (r) ids.push(r.id); else { misses++; await new Promise((res) => setTimeout(res, 10)); }
          }
          process.stdout.write(JSON.stringify(ids));
        })();`;
      const modulePath = path.join(require('./dist.cjs').DIST, 'ai', 'stores', 'file-run-store.js');
      const outputs = await Promise.all(
        [1, 2, 3, 4].map(
          () => new Promise((resolve, reject) => execFile(process.execPath, ['-e', script, modulePath, dir], (err, out) => (err ? reject(err) : resolve(JSON.parse(out))))),
        ),
      );
      const all = outputs.flat();
      assert.equal(new Set(all).size, all.length, 'no run claimed twice');
      assert.equal(all.length, 40);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('ids that are not file-name safe are stored under a hash', async () => {
    const dir = tmpDir();
    try {
      const s = new FileRunStore(dir);
      const r = run({ id: '../../etc/passwd', threadId: 'thread/../x' });
      await s.create(r);
      assert.deepEqual(await s.get(r.id), r);
      assert.deepEqual((await s.listByThread('thread/../x')).map((x) => x.id), [r.id]);
      for (const f of fs.readdirSync(dir)) assert.doesNotMatch(f, /passwd/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('finished runs leave the active index; an abandoned lock is broken', async () => {
    const dir = tmpDir();
    try {
      const s = new FileRunStore(dir, { lockTimeoutMs: 50 });
      const r = run();
      await s.create(r);
      fs.writeFileSync(path.join(dir, `${r.id}.lock`), 'crashed-worker');
      const past = new Date(Date.now() - 10_000);
      fs.utimesSync(path.join(dir, `${r.id}.lock`), past, past);
      const staleBefore = new Date().toISOString();
      assert.equal(await s.claim('w', staleBefore), undefined, 'locked: skipped, lock broken');
      assert.equal((await s.claim('w', staleBefore)).id, r.id, 'claimed on the next poll');
      await s.update(r.id, { status: 'completed' });
      assert.deepEqual(fs.readdirSync(path.join(dir, 'active')), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ */
/* Shared ConversationStore contract tests                              */
/* ------------------------------------------------------------------ */

function msg(role, text) {
  return { role, content: [{ type: 'text', text }] };
}

function conversationSuite(name, make) {
  describe(`${name} (ConversationStore)`, () => {
    test('threads: create, get, list by owner and agent, update, delete', async () => {
      const { store, done } = await make();
      try {
        const t1 = await store.createThread({ owner: 'alice', agent: 'support', title: 'First', metadata: { plan: 'pro' } });
        assert.match(t1.id, /^[0-9a-f-]{36}$/);
        assert.equal(t1.owner, 'alice');
        assert.deepEqual(t1.metadata, { plan: 'pro' });
        assert.ok(t1.createdAt && t1.updatedAt);
        assert.deepEqual(await store.getThread(t1.id), t1);
        await new Promise((r) => setTimeout(r, 5));
        const t2 = await store.createThread({ owner: 'alice', agent: 'sales' });
        await store.createThread({ owner: 'bob', agent: 'support' });
        assert.equal((await store.getThread(t2.id)).title, undefined);

        assert.deepEqual((await store.listThreads('alice')).map((t) => t.id), [t2.id, t1.id], 'most recently updated first');
        assert.deepEqual((await store.listThreads('alice', { agent: 'support' })).map((t) => t.id), [t1.id]);
        assert.equal((await store.listThreads('alice', { limit: 1 })).length, 1);
        assert.deepEqual(await store.listThreads('nobody'), []);

        await new Promise((r) => setTimeout(r, 5));
        await store.updateThread(t1.id, { title: 'Renamed' });
        const u = await store.getThread(t1.id);
        assert.equal(u.title, 'Renamed');
        assert.deepEqual(u.metadata, { plan: 'pro' }, 'metadata untouched');
        assert.ok(u.updatedAt > t1.updatedAt);
        assert.equal((await store.listThreads('alice'))[0].id, t1.id);
        await assert.rejects(store.updateThread('00000000-0000-0000-0000-000000000000', { title: 'x' }), /not found/);

        await store.appendMessages(t1.id, [msg('user', 'hi')]);
        await store.deleteThread(t1.id);
        assert.equal(await store.getThread(t1.id), undefined);
        assert.deepEqual(await store.getMessages(t1.id), []);
        assert.deepEqual((await store.listThreads('alice')).map((t) => t.id), [t2.id]);
      } finally {
        await done();
      }
    });

    test('messages: append assigns ids, getMessages returns the most recent N oldest first', async () => {
      const { store, done } = await make();
      try {
        const t = await store.createThread({ owner: 'o', agent: 'a' });
        const saved = await store.appendMessages(t.id, [msg('user', 'm1'), { ...msg('assistant', 'm2'), id: 'given-id', runId: 'r1' }]);
        assert.equal(saved.length, 2);
        assert.match(saved[0].id, /^[0-9a-f-]{36}$/);
        assert.ok(saved[0].createdAt);
        assert.equal(saved[1].id, 'given-id');
        await store.appendMessages(t.id, [msg('user', 'm3')]);
        await store.appendMessages(t.id, [
          msg('assistant', 'm4'),
          { role: 'tool', content: [{ type: 'tool_result', callId: 'c1', name: 'x', output: { ok: true } }] },
        ]);
        const texts = (list) => list.map((m) => (m.content[0].type === 'text' ? m.content[0].text : m.content[0].type));
        assert.deepEqual(texts(await store.getMessages(t.id)), ['m1', 'm2', 'm3', 'm4', 'tool_result']);
        assert.deepEqual(texts(await store.getMessages(t.id, { limit: 2 })), ['m4', 'tool_result']);
        assert.deepEqual(await store.getMessages(t.id, { limit: 0 }), []);
        const all = await store.getMessages(t.id);
        assert.deepEqual(all[1], saved[1]);
        assert.deepEqual(all[4].content[0].output, { ok: true });
        await assert.rejects(store.appendMessages('00000000-0000-0000-0000-000000000000', [msg('user', 'x')]), /not found/);
      } finally {
        await done();
      }
    });
  });
}

conversationSuite('MemoryConversationStore', async () => ({ store: new MemoryConversationStore(), done: async () => undefined }));
conversationSuite('FileConversationStore', async () => {
  const dir = tmpDir();
  return { store: new FileConversationStore(dir), done: async () => fs.rmSync(dir, { recursive: true, force: true }) };
});

describe('FileConversationStore across instances', () => {
  test('a second instance sees threads and messages', async () => {
    const dir = tmpDir();
    try {
      const a = new FileConversationStore(dir);
      const t = await a.createThread({ owner: 'user:42@example', agent: 'a' });
      await Promise.all([a.appendMessages(t.id, [msg('user', 'one')]), a.appendMessages(t.id, [msg('user', 'two')])]);
      const b = new FileConversationStore(dir);
      assert.equal((await b.getMessages(t.id)).length, 2);
      assert.deepEqual((await b.listThreads('user:42@example')).map((x) => x.id), [t.id]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ */
/* PostgreSQL (PGlite)                                                  */
/* ------------------------------------------------------------------ */

describe('pg loader', () => {
  test('missing pg package gives install instructions', () => {
    const dir = tmpDir();
    try {
      assert.throws(() => loadPg(dir), (err) => /npm install pg/.test(err.message) && /pgvector/.test(err.message) && /CREATE EXTENSION/.test(err.message));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('table prefixes are validated', () => {
    assert.equal(checkTablePrefix('app_'), 'app_');
    for (const bad of ['App', '1x', 'x;drop', 'a-b', '']) assert.throws(() => checkTablePrefix(bad), /Invalid table prefix/);
    assert.throws(() => new PgRunStore({ db: { query: async () => ({ rows: [], rowCount: 0 }) }, tablePrefix: 'x"; --' }), /Invalid table prefix/);
  });
});

const pgSkip = pglite ? false : 'PGlite (@electric-sql/pglite + @electric-sql/pglite-pgvector) not resolvable; set AMOXI_PGLITE_DIR';

describe('PostgreSQL stores on PGlite', { skip: pgSkip }, () => {
  if (!pglite) return;
  let db;
  let n = 0;
  const prefix = () => `t${++n}_`;

  test('setup', async () => {
    db = await pgliteDb();
  });

  runStoreSuite('PgRunStore', async () => ({ store: new PgRunStore({ db, tablePrefix: prefix() }), done: async () => undefined }));
  conversationSuite('PgConversationStore', async () => ({ store: new PgConversationStore({ db, tablePrefix: prefix() }), done: async () => undefined }));

  test('PgRunStore: concurrent claimers never get the same run', async () => {
    const p = prefix();
    const a = new PgRunStore({ db, tablePrefix: p });
    const b = new PgRunStore({ db, tablePrefix: p });
    await assertExclusiveClaims(a, b, (r) => a.create(r), 20);
  });

  test('PgVectorStore: upsert, query with filter/limit/minScore, delete, clear', async () => {
    const p = prefix();
    const s = new PgVectorStore({ db, tablePrefix: p, dimensions: 3 });
    await s.upsert('ns', [
      { id: 'a', text: 'alpha', vector: [1, 0, 0], metadata: { kind: 'x', n: 1 } },
      { id: 'b', text: 'beta', vector: [0.9, 0.1, 0], metadata: { kind: 'y' } },
      { id: 'c', text: 'gamma', vector: [0, 0, 1], metadata: { kind: 'x' } },
    ]);
    await s.upsert('other', [{ id: 'a', text: 'other', vector: [1, 0, 0] }]);
    const all = await s.query('ns', [1, 0, 0]);
    assert.deepEqual(all.map((m) => m.id), ['a', 'b', 'c']);
    assert.ok(Math.abs(all[0].score - 1) < 1e-6);
    assert.deepEqual(all[0].metadata, { kind: 'x', n: 1 });
    assert.deepEqual((await s.query('ns', [1, 0, 0], { limit: 1 })).map((m) => m.id), ['a']);
    assert.deepEqual((await s.query('ns', [1, 0, 0], { minScore: 0.5 })).map((m) => m.id), ['a', 'b']);
    assert.deepEqual((await s.query('ns', [1, 0, 0], { filter: { kind: 'x' } })).map((m) => m.id), ['a', 'c']);
    await s.upsert('ns', [{ id: 'a', text: 'alpha2', vector: [0, 0, 1] }]);
    const replaced = (await s.query('ns', [0, 0, 1])).find((m) => m.id === 'a');
    assert.equal(replaced.text, 'alpha2');
    assert.equal(replaced.metadata, undefined, 'upsert replaces metadata too');
    await s.delete('ns', ['a', 'b']);
    assert.deepEqual((await s.query('ns', [1, 0, 0])).map((m) => m.id), ['c']);
    await s.clear('ns');
    assert.deepEqual(await s.query('ns', [1, 0, 0]), []);
    assert.equal((await s.query('other', [1, 0, 0])).length, 1, 'other namespace untouched');
    await assert.rejects(s.upsert('ns', [{ id: 'z', text: 'z', vector: [1, 0] }]), /configured for 3/);
    const idx = await db.query(`SELECT indexdef FROM pg_indexes WHERE tablename = $1`, [`${p}vectors_3`]);
    assert.ok(idx.rows.some((r) => /hnsw/.test(r.indexdef) && /vector_cosine_ops/.test(r.indexdef)), 'HNSW cosine index');
  });

  test('PgVectorStore backs a KnowledgeBase and agent memory', async () => {
    const { HashingEmbedder } = load('ai/vector/hashing-embedder');
    const { KnowledgeBase } = load('ai/vector/knowledge-base');
    const { VectorAgentMemory } = load('ai/vector/agent-memory');
    const embedder = new HashingEmbedder({ dims: 256 });
    const s = new PgVectorStore({ db, tablePrefix: prefix() });
    const kb = new KnowledgeBase('help', s, embedder, { size: 100, overlap: 0 });
    await kb.ingest([
      { id: 'pw', title: 'Account', text: 'To reset your password use the Forgot password link.' },
      { id: 'ship', text: 'Shipping takes five days.\n\n'.repeat(8) },
    ]);
    const hits = await kb.search('reset password');
    assert.equal(hits[0].documentId, 'pw');
    assert.equal(hits[0].title, 'Account');
    await kb.ingest([{ id: 'ship', text: 'Express shipping only.' }]);
    assert.equal((await kb.search('shipping', { limit: 50 })).filter((h) => h.documentId === 'ship').length, 1);
    await kb.remove('pw');
    assert.ok((await kb.search('password', { limit: 50 })).every((h) => h.documentId !== 'pw'));

    const mem = new VectorAgentMemory(s, embedder, VectorAgentMemory.namespace('u1', embedder));
    const item = await mem.remember('Prefers aisle seats', { source: 'chat' });
    const got = await mem.recall('aisle seat');
    assert.equal(got[0].id, item.id);
    assert.deepEqual(got[0].metadata, { source: 'chat' });
    assert.equal(got[0].createdAt, item.createdAt);
    await mem.forget(item.id);
    assert.deepEqual(await mem.recall('aisle seat'), []);
  });

  test('teardown', async () => {
    await db.close();
  });
});

describe('PgVectorStore without pgvector', () => {
  test('explains how to enable the extension', async () => {
    const fake = {
      async query(text) {
        if (/pg_extension/.test(text)) return { rows: [], rowCount: 0 };
        if (/CREATE EXTENSION/.test(text)) throw new Error('extension "vector" is not available');
        return { rows: [], rowCount: 0 };
      },
    };
    const s = new PgVectorStore({ db: fake });
    await assert.rejects(s.upsert('ns', [{ id: 'a', text: 'a', vector: [1] }]), /needs the pgvector extension.*not available.*CREATE EXTENSION IF NOT EXISTS vector/s);
  });
});

/* ------------------------------------------------------------------ */
/* Factory                                                              */
/* ------------------------------------------------------------------ */

describe('createAiStores', () => {
  test('test profile defaults to memory stores and the offline embedder', async () => {
    const stores = createAiStores(Config.of({}, 'test'));
    assert.equal(stores.runs.constructor.name, 'MemoryRunStore');
    assert.equal(stores.conversations.constructor.name, 'MemoryConversationStore');
    assert.equal(stores.vectors.constructor.name, 'LocalVectorStore');
    assert.equal(stores.embedder.model, 'amoxi-hashing-v1');
    await stores.close();
  });

  test('file stores under ai.store.dir (default data/ai), persisted on close', async () => {
    const cwd = tmpDir();
    try {
      const stores = createAiStores(Config.of({}, 'development'), { cwd });
      assert.equal(stores.runs.constructor.name, 'FileRunStore');
      assert.equal(stores.conversations.constructor.name, 'FileConversationStore');
      const t = await stores.conversations.createThread({ owner: 'o', agent: 'a' });
      await stores.runs.create(run());
      await stores.vectors.upsert('ns', [{ id: 'x', text: 'x', vector: [1, 2] }]);
      await stores.close();
      assert.ok(fs.existsSync(path.join(cwd, 'data', 'ai', 'threads', `${t.id}.json`)));
      assert.ok(fs.readdirSync(path.join(cwd, 'data', 'ai', 'runs')).some((f) => f.endsWith('.json')));
      assert.ok(fs.existsSync(path.join(cwd, 'data', 'ai', 'vectors.json')));

      const custom = createAiStores(Config.of({ 'ai.store': 'file', 'ai.store.dir': 'state' }, 'test'), { cwd });
      await custom.conversations.createThread({ owner: 'o', agent: 'a' });
      assert.ok(fs.existsSync(path.join(cwd, 'state', 'threads')));
      const viaType = createAiStores(Config.of({ ai: { store: { type: 'memory' } } }, 'development'), { cwd });
      assert.equal(viaType.runs.constructor.name, 'MemoryRunStore');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('embedder selection', () => {
    assert.equal(createEmbedder(Config.of({})).constructor.name, 'HashingEmbedder');
    const auto = createEmbedder(Config.of({ openai: { api: { key: 'sk-x' } } }));
    assert.equal(auto.constructor.name, 'OpenAiEmbedder');
    assert.equal(auto.model, 'text-embedding-3-small');
    assert.doesNotMatch(JSON.stringify(auto), /sk-x/, 'the key is not exposed by JSON.stringify');
    assert.doesNotMatch(require('node:util').inspect(auto, { showHidden: true }), /sk-x/, 'nor by console.log');
    const custom = createEmbedder(
      Config.of({ ai: { embeddings: { provider: 'openai', 'api-key': 'k', 'base-url': 'http://localhost:11434/v1', model: 'nomic-embed-text', dimensions: 768 } } }),
    );
    assert.equal(custom.model, 'nomic-embed-text');
    assert.equal(custom.dimensions, 768);
    assert.equal(createEmbedder(Config.of({ ai: { embeddings: { provider: 'offline' } }, openai: { api: { key: 'k' } } })).constructor.name, 'HashingEmbedder');
    assert.throws(() => createEmbedder(Config.of({ ai: { embeddings: { provider: 'magic' } } })), /Unknown ai.embeddings.provider/);
    assert.throws(() => createAiStores(Config.of({ ai: { store: 'redis' } })), /Unknown ai.store/);
  });

  test('postgres needs a URL and the pg package', () => {
    const cwd = tmpDir();
    try {
      assert.throws(() => createAiStores(Config.of({ ai: { store: 'postgres' } }), { cwd }), /ai.postgres.url or DATABASE_URL/);
      assert.throws(
        () => createAiStores(Config.of({ ai: { store: 'postgres' }, database: { url: 'postgres://u:secret@localhost/db' } }), { cwd }),
        (err) => /npm install pg/.test(err.message) && !/secret/.test(err.message),
      );
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('postgres with a pg package builds Pg stores and ends the pool on close', async () => {
    const cwd = tmpDir();
    try {
      // A stand-in `pg` package in the app's node_modules.
      const pgDir = path.join(cwd, 'node_modules', 'pg');
      fs.mkdirSync(pgDir, { recursive: true });
      fs.writeFileSync(path.join(cwd, 'package.json'), '{"name":"app"}');
      fs.writeFileSync(
        path.join(pgDir, 'index.js'),
        `class Pool { constructor(c) { Pool.last = this; this.config = c; this.ended = false; }
           async query() { return { rows: [], rowCount: 0 }; } async end() { this.ended = true; } }
         module.exports = { Pool };`,
      );
      const stores = createAiStores(Config.of({ ai: { store: 'postgres', postgres: { url: 'postgres://x/y', 'pool-size': 4 } } }), { cwd });
      assert.equal(stores.runs.constructor.name, 'PgRunStore');
      assert.equal(stores.conversations.constructor.name, 'PgConversationStore');
      assert.equal(stores.vectors.constructor.name, 'PgVectorStore');
      const { Pool } = require(path.join(pgDir, 'index.js'));
      assert.deepEqual(Pool.last.config, { connectionString: 'postgres://x/y', max: 4 });
      await stores.close();
      assert.equal(Pool.last.ended, true);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('Windows file locking', () => {
  const { retryOnWindows } = load('ai/stores/fs-retry');
  const asPlatform = async (platform, fn) => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: platform });
    try {
      return await fn();
    } finally {
      Object.defineProperty(process, 'platform', original);
    }
  };
  const flaky = (failures, code) => {
    let n = 0;
    return async () => {
      if (n++ < failures) throw Object.assign(new Error(code), { code });
      return 'ok';
    };
  };

  test('on Windows, EPERM/EACCES/EBUSY from a file another process has open are retried', async () => {
    await asPlatform('win32', async () => {
      for (const code of ['EPERM', 'EACCES', 'EBUSY']) assert.equal(await retryOnWindows(flaky(3, code)), 'ok');
      await assert.rejects(retryOnWindows(flaky(1, 'ENOENT')), /ENOENT/, 'other errors are not retried');
      await assert.rejects(retryOnWindows(flaky(1000, 'EPERM')), /EPERM/, 'gives up eventually');
    });
  });

  test('elsewhere, permission errors are real and thrown at once', async () => {
    await asPlatform('linux', async () => {
      await assert.rejects(retryOnWindows(flaky(1, 'EPERM')), /EPERM/);
    });
  });
});
