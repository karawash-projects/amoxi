// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0
'use strict';
// Embeddings, vector search, agent memory and knowledge bases (amoxi/ai).
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { load } = require('./dist.cjs');

const { cosineSimilarity, l2Normalize } = load('ai/vector/math');
const { HashingEmbedder } = load('ai/vector/hashing-embedder');
const { OpenAiEmbedder } = load('ai/vector/openai-embedder');
const { LocalVectorStore } = load('ai/vector/local-vector-store');
const { VectorAgentMemory } = load('ai/vector/agent-memory');
const { KnowledgeBase, chunkText } = load('ai/vector/knowledge-base');
const { ModelError } = load('ai/types');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'amoxi-ai-memory-'));
}

/** Local stub of an OpenAI-compatible /embeddings endpoint. */
async function stubServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const r = { method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : undefined };
      requests.push(r);
      handler(r, res, requests.length);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}/v1`, requests, close: () => new Promise((r) => server.close(r)) };
}

/** Deterministic fake embeddings: [len, index-in-request, 1]. Returned in reverse order. */
function fakeEmbeddings(input) {
  const data = input.map((text, index) => ({ object: 'embedding', index, embedding: [text.length, index, 1] }));
  return { object: 'list', data: data.reverse(), model: 'm' };
}

describe('vector math', () => {
  test('cosine similarity and normalisation', () => {
    assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
    assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
    assert.equal(cosineSimilarity([1, 0], [-1, 0]), -1);
    assert.equal(cosineSimilarity([0, 0], [1, 1]), 0, 'zero vector gives 0, not NaN');
    const n = l2Normalize([3, 4]);
    assert.deepEqual(n, [0.6, 0.8]);
    assert.deepEqual(l2Normalize([0, 0]), [0, 0]);
  });
});

describe('HashingEmbedder', () => {
  test('is deterministic, normalised and sized', async () => {
    const e = new HashingEmbedder();
    assert.equal(e.model, 'amoxi-hashing-v1');
    assert.equal(e.dimensions, 512);
    const [a, b] = await e.embed(['Hello world', 'Hello world']);
    assert.equal(a.length, 512);
    assert.deepEqual(a, b);
    assert.ok(Math.abs(Math.hypot(...a) - 1) < 1e-9);
    assert.equal((await new HashingEmbedder({ dims: 64 }).embed(['x']))[0].length, 64);
    const [blank] = await e.embed(['']);
    assert.ok(blank.every((x) => x === 0));
    assert.throws(() => new HashingEmbedder({ dims: 3 }), RangeError);
  });

  test('related texts are clearly more similar than unrelated ones', async () => {
    const e = new HashingEmbedder();
    const [q, related, unrelated, other] = await e.embed([
      'reset my password',
      'password reset help',
      'the weather in Paris is sunny today',
      'shipping costs for international orders',
    ]);
    const sRel = cosineSimilarity(q, related);
    const sUn = cosineSimilarity(q, unrelated);
    const sOther = cosineSimilarity(q, other);
    assert.ok(sRel > 0.3, `related similarity ${sRel}`);
    assert.ok(sRel > sUn + 0.25, `related ${sRel} vs unrelated ${sUn}`);
    assert.ok(sRel > sOther + 0.25, `related ${sRel} vs other ${sOther}`);
    // Inflections share character trigrams.
    const [x, y, z] = await e.embed(['resetting passwords', 'password reset', 'banana smoothie']);
    assert.ok(cosineSimilarity(x, y) > cosineSimilarity(x, z) + 0.1);
  });

  test('honours an aborted signal', async () => {
    await assert.rejects(new HashingEmbedder().embed(['x'], AbortSignal.abort()));
  });
});

describe('OpenAiEmbedder', () => {
  test('batches requests, sorts by index, sends model, dimensions and bearer key', async () => {
    const stub = await stubServer((r, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(fakeEmbeddings(r.body.input)));
    });
    try {
      const e = new OpenAiEmbedder({ apiKey: 'sk-test', baseUrl: stub.baseUrl + '/', model: 'text-embedding-3-small', batchSize: 2 });
      assert.equal(e.dimensions, 0, 'unknown until the first response');
      const out = await e.embed(['a', 'bb', 'ccc', 'dddd', 'eeeee']);
      assert.deepEqual(out.map((v) => v[0]), [1, 2, 3, 4, 5], 'order follows input');
      assert.equal(e.dimensions, 3, 'learned from the response');
      assert.equal(stub.requests.length, 3);
      assert.deepEqual(stub.requests.map((r) => r.body.input.length), [2, 2, 1]);
      const first = stub.requests[0];
      assert.equal(first.url, '/v1/embeddings');
      assert.equal(first.method, 'POST');
      assert.equal(first.headers.authorization, 'Bearer sk-test');
      assert.equal(first.body.model, 'text-embedding-3-small');
      assert.equal('dimensions' in first.body, false);

      const e2 = new OpenAiEmbedder({ baseUrl: stub.baseUrl, model: 'm', dimensions: 3 });
      assert.equal(e2.dimensions, 3);
      await e2.embed(['q']);
      const last = stub.requests.at(-1);
      assert.equal(last.body.dimensions, 3);
      assert.equal(last.headers.authorization, undefined, 'no key, no header');
    } finally {
      await stub.close();
    }
  });

  test('retries 429 honouring retry-after, and 5xx', async () => {
    const stub = await stubServer((r, res, n) => {
      if (n === 1) {
        res.writeHead(429, { 'retry-after': '0', 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'slow down' } }));
      }
      if (n === 2) {
        res.writeHead(503, { 'retry-after': '0' });
        return res.end('busy');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(fakeEmbeddings(r.body.input)));
    });
    try {
      const e = new OpenAiEmbedder({ apiKey: 'k', baseUrl: stub.baseUrl, model: 'm' });
      const started = Date.now();
      const [v] = await e.embed(['hello']);
      assert.deepEqual(v, [5, 0, 1]);
      assert.equal(stub.requests.length, 3);
      assert.ok(Date.now() - started < 1500, 'retry-after: 0 is honoured instead of the default backoff');
    } finally {
      await stub.close();
    }
  });

  test('gives up after maxRetries with a ModelError', async () => {
    const stub = await stubServer((r, res) => {
      res.writeHead(429, { 'retry-after': '0' });
      res.end('{}');
    });
    try {
      const e = new OpenAiEmbedder({ apiKey: 'k', baseUrl: stub.baseUrl, model: 'm', maxRetries: 2 });
      await assert.rejects(e.embed(['x']), (err) => err instanceof ModelError && err.status === 429 && err.retryable === true);
      assert.equal(stub.requests.length, 3);
    } finally {
      await stub.close();
    }
  });

  test('401 fails fast with an actionable message that never contains the key', async () => {
    const stub = await stubServer((r, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Incorrect API key provided' } }));
    });
    try {
      const e = new OpenAiEmbedder({ apiKey: 'sk-secret-123', baseUrl: stub.baseUrl, model: 'm' });
      await assert.rejects(e.embed(['x']), (err) => {
        assert.ok(err instanceof ModelError);
        assert.equal(err.status, 401);
        assert.match(err.message, /Incorrect API key provided/);
        assert.match(err.message, /OPENAI_API_KEY|ai\.embeddings\.api-key/);
        assert.doesNotMatch(err.message, /sk-secret-123/);
        return true;
      });
      assert.equal(stub.requests.length, 1, 'no retry on 401');
    } finally {
      await stub.close();
    }
  });

  test('times out and reports unreachable servers', async () => {
    const stub = await stubServer(() => {
      /* never answers */
    });
    try {
      const e = new OpenAiEmbedder({ baseUrl: stub.baseUrl, model: 'm', timeoutMs: 100, maxRetries: 0 });
      await assert.rejects(e.embed(['x']), /timed out after 100 ms/);
    } finally {
      stub.close();
    }
  });
});

describe('LocalVectorStore', () => {
  const recs = [
    { id: 'a', text: 'alpha', vector: [1, 0, 0], metadata: { kind: 'x', n: 1 } },
    { id: 'b', text: 'beta', vector: [0.9, 0.1, 0], metadata: { kind: 'y', n: 2 } },
    { id: 'c', text: 'gamma', vector: [0, 0, 1], metadata: { kind: 'x', n: 3 } },
  ];

  test('query ranks by cosine, applies limit, minScore and exact metadata filter', async () => {
    const s = new LocalVectorStore();
    await s.upsert('ns', recs);
    const all = await s.query('ns', [1, 0, 0]);
    assert.deepEqual(all.map((m) => m.id), ['a', 'b', 'c']);
    assert.ok(Math.abs(all[0].score - 1) < 1e-6);
    assert.deepEqual((await s.query('ns', [1, 0, 0], { limit: 1 })).map((m) => m.id), ['a']);
    assert.deepEqual((await s.query('ns', [1, 0, 0], { minScore: 0.5 })).map((m) => m.id), ['a', 'b']);
    assert.deepEqual((await s.query('ns', [1, 0, 0], { filter: { kind: 'x' } })).map((m) => m.id), ['a', 'c']);
    assert.deepEqual((await s.query('ns', [1, 0, 0], { filter: { kind: 'x', n: 3 } })).map((m) => m.id), ['c']);
    assert.deepEqual(await s.query('ns', [1, 0, 0], { filter: { missing: true } }), []);
    assert.deepEqual(await s.query('other', [1, 0, 0]), [], 'namespaces are isolated');
    assert.deepEqual(all[0].metadata, { kind: 'x', n: 1 });
  });

  test('upsert replaces, delete and clear remove; mixed sizes are rejected', async () => {
    const s = new LocalVectorStore();
    await s.upsert('ns', recs);
    await s.upsert('ns', [{ id: 'a', text: 'alpha2', vector: [0, 0, 1] }]);
    const top = await s.query('ns', [0, 0, 1], { limit: 2 });
    assert.deepEqual(top.map((m) => m.text).sort(), ['alpha2', 'gamma']);
    await s.delete('ns', ['a', 'nope']);
    assert.deepEqual((await s.query('ns', [0, 0, 1])).map((m) => m.id), ['c', 'b']);
    await s.clear('ns');
    assert.deepEqual(await s.query('ns', [0, 0, 1]), []);
    await s.upsert('ns', recs);
    await assert.rejects(s.upsert('ns', [{ id: 'z', text: 'z', vector: [1, 0] }]), /dimensions/);
  });

  test('bounds records per namespace', async () => {
    const s = new LocalVectorStore({ maxRecordsPerNamespace: 2 });
    await s.upsert('ns', recs.slice(0, 2));
    await s.upsert('ns', recs.slice(0, 2)); // replacing is fine
    await assert.rejects(s.upsert('ns', recs.slice(2)), /exceed 2 records/);
  });

  test('persists atomically and round-trips through the file', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'sub', 'vectors.json');
    const s = new LocalVectorStore({ file, writeDelayMs: 20 });
    await Promise.all([s.upsert('ns', recs), s.upsert('ns2', [recs[0]]), s.delete('ns2', ['zzz'])]);
    await s.flush();
    assert.ok(fs.existsSync(file));
    assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp')), []);
    const again = new LocalVectorStore({ file });
    const hits = await again.query('ns', [1, 0, 0], { filter: { kind: 'x' } });
    assert.deepEqual(hits.map((m) => [m.id, m.text]), [['a', 'alpha'], ['c', 'gamma']]);
    assert.equal((await again.query('ns2', [1, 0, 0])).length, 1);
    // Debounced write without explicit flush.
    await again.delete('ns', ['a']);
    await new Promise((r) => setTimeout(r, 400));
    const third = new LocalVectorStore({ file });
    assert.deepEqual((await third.query('ns', [1, 0, 0])).map((m) => m.id), ['b', 'c']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('reports a corrupt file clearly', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'v.json');
    fs.writeFileSync(file, '{oops');
    await assert.rejects(new LocalVectorStore({ file }).query('ns', [1]), /not valid JSON/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('VectorAgentMemory', () => {
  test('remember, recall by relevance, forget', async () => {
    const embedder = new HashingEmbedder();
    const store = new LocalVectorStore();
    const ns = VectorAgentMemory.namespace('user-1', embedder);
    assert.equal(ns, 'memory:user-1@amoxi-hashing-v1');
    const memory = new VectorAgentMemory(store, embedder, ns);
    const seat = await memory.remember('The customer prefers a window seat on flights', { source: 'chat' });
    await memory.remember('The customer is allergic to peanuts');
    await memory.remember('Home airport is Beirut (BEY)');
    assert.ok(seat.id && seat.createdAt);
    assert.deepEqual(seat.metadata, { source: 'chat' });

    const hits = await memory.recall('which seat does the customer like on a flight?', { limit: 2 });
    assert.equal(hits.length, 2);
    assert.equal(hits[0].id, seat.id);
    assert.equal(hits[0].createdAt, seat.createdAt);
    assert.deepEqual(hits[0].metadata, { source: 'chat' }, 'internal metadata is hidden');
    assert.ok(hits[0].score > hits[1].score);

    const other = new VectorAgentMemory(store, embedder, VectorAgentMemory.namespace('user-2', embedder));
    assert.deepEqual(await other.recall('window seat'), [], 'subjects are isolated');

    await memory.forget(seat.id);
    const after = await memory.recall('window seat flights');
    assert.ok(after.every((m) => m.id !== seat.id));
    await assert.rejects(memory.remember('   '), TypeError);
    assert.deepEqual(await memory.recall(''), []);
  });

  test('namespaces differ per embedder model', () => {
    assert.notEqual(VectorAgentMemory.namespace('u', { model: 'a' }), VectorAgentMemory.namespace('u', { model: 'b' }));
  });
});

describe('chunkText', () => {
  test('keeps short text whole and drops blank input', () => {
    assert.deepEqual(chunkText('Hello world.'), ['Hello world.']);
    assert.deepEqual(chunkText('  \n\n  '), []);
  });

  test('splits on paragraph boundaries first', () => {
    const p1 = 'A'.repeat(60) + '.';
    const p2 = 'B'.repeat(60) + '.';
    const p3 = 'C'.repeat(60) + '.';
    const chunks = chunkText(`${p1}\n\n${p2}\n\n${p3}`, { size: 130, overlap: 0 });
    assert.deepEqual(chunks, [`${p1}\n\n${p2}`, p3]);
  });

  test('splits long paragraphs at sentence ends, every chunk within size, with overlap', () => {
    const sentences = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} talks about topic ${i}.`);
    const text = sentences.join(' ');
    const chunks = chunkText(text, { size: 200, overlap: 40 });
    assert.ok(chunks.length > 5);
    for (const c of chunks) assert.ok(c.length <= 200, `chunk of ${c.length}`);
    // Each chunk ends at a sentence end.
    for (const c of chunks) assert.match(c, /\.$/);
    // Overlap: chunk n+1 starts with text from the end of chunk n.
    const firstWords = chunks[1].split(' ').slice(0, 2).join(' ');
    assert.ok(chunks[0].includes(firstWords), `"${firstWords}" overlaps`);
    // Nothing lost.
    for (const s of sentences) assert.ok(chunks.some((c) => c.includes(s)), s);
  });

  test('hard-splits text without boundaries', () => {
    const chunks = chunkText('x'.repeat(500), { size: 100, overlap: 0 });
    assert.equal(chunks.length, 5);
    assert.ok(chunks.every((c) => c.length === 100));
  });
});

describe('KnowledgeBase', () => {
  const docs = [
    { id: 'returns', title: 'Return policy', url: 'https://example.com/returns', text: 'You can return any item within 30 days of delivery for a full refund. Items must be unused.' },
    { id: 'shipping', title: 'Shipping', text: 'We ship worldwide. Standard shipping takes 5 to 7 business days; express shipping takes 2 days.' },
    { id: 'password', title: 'Account help', text: 'To reset your password, click "Forgot password" on the sign-in page and follow the email link.' },
  ];

  test('ingest and search', async () => {
    const embedder = new HashingEmbedder();
    const store = new LocalVectorStore();
    const kb = new KnowledgeBase('help', store, embedder);
    assert.equal(kb.namespace, 'kb:help@amoxi-hashing-v1');
    const res = await kb.ingest(docs);
    assert.deepEqual(res, { documents: 3, chunks: 3 });

    const hits = await kb.search('how do I reset my password?');
    assert.equal(hits[0].documentId, 'password');
    assert.equal(hits[0].title, 'Account help');
    assert.match(hits[0].text, /Forgot password/);
    const ret = await kb.search('return an item for a refund', { limit: 1 });
    assert.deepEqual(ret.map((h) => [h.documentId, h.url]), [['returns', 'https://example.com/returns']]);
    assert.equal((await kb.search('refund', { minScore: 0.99 })).length, 0);
  });

  test('re-ingesting replaces old chunks; remove deletes them', async () => {
    const embedder = new HashingEmbedder();
    const store = new LocalVectorStore();
    const kb = new KnowledgeBase('docs', store, embedder, { size: 120, overlap: 0 });
    const long = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} explains the zebra feature in detail.`).join('\n\n');
    const first = await kb.ingest([{ id: 'guide', text: long }]);
    assert.ok(first.chunks > 3);
    const before = await kb.search('zebra feature', { limit: 50 });
    assert.equal(before.length, first.chunks);

    await kb.ingest([{ id: 'guide', text: 'Short replacement about the giraffe feature.' }]);
    const after = await kb.search('zebra giraffe feature', { limit: 50 });
    assert.equal(after.length, 1, 'old chunks are gone');
    assert.match(after[0].text, /giraffe/);

    await kb.ingest([{ id: 'other', text: 'Another document about giraffes.' }]);
    await kb.remove('guide');
    const left = await kb.search('giraffe', { limit: 50 });
    assert.deepEqual(left.map((h) => h.documentId), ['other']);
    await assert.rejects(kb.ingest([{ id: '', text: 'x' }]), TypeError);
  });
});

describe('LocalVectorStore shared by several processes (cluster workers)', () => {
  const { execFile } = require('node:child_process');
  const { DIST } = require('./dist.cjs');
  const worker = (file, name, count) =>
    new Promise((resolve, reject) => {
      const code = `
        const { LocalVectorStore } = require(${JSON.stringify(path.join(DIST, 'ai/vector/local-vector-store.js'))});
        const s = new LocalVectorStore({ file: process.argv[1], writeDelayMs: 1 });
        (async () => {
          for (let i = 0; i < ${count}; i++) {
            await s.upsert('memories', [{ id: '${name}-' + i, text: '${name} note ' + i, vector: [1, i + 1, 0.5] }]);
            if (i % 3 === 0) await s.flush();
          }
          await s.flush();
        })().catch((e) => { console.error(e); process.exit(1); });`;
      execFile(process.execPath, ['-e', code, file], (err, _out, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve()));
    });

  test('no process overwrites what another one saved', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amoxi-vec-'));
    const file = path.join(dir, 'vectors.json');
    try {
      await Promise.all(['a', 'b', 'c', 'd'].map((n) => worker(file, n, 25)));
      const reader = new LocalVectorStore({ file });
      const all = await reader.query('memories', [1, 1, 0.5], { limit: 1000 });
      assert.equal(all.length, 100, `${100 - all.length} of 100 memories were lost`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a process sees what another one saved, and its own unsaved changes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amoxi-vec-'));
    const file = path.join(dir, 'vectors.json');
    try {
      const mine = new LocalVectorStore({ file, writeDelayMs: 1 });
      await mine.upsert('m', [{ id: 'mine', text: 'mine', vector: [1, 0] }]);
      await mine.flush();
      await worker(file, 'other', 1);
      await new Promise((r) => setTimeout(r, 300)); // refresh interval
      await mine.upsert('m', [{ id: 'unsaved', text: 'unsaved', vector: [0, 1] }]);
      const ids = (await mine.query('m', [1, 1], { limit: 10 })).map((h) => h.id).sort();
      // 'other' wrote to namespace 'memories', so check both namespaces.
      assert.deepEqual(ids, ['mine', 'unsaved']);
      assert.equal((await mine.query('memories', [1, 1, 0.5])).length, 1, "the other process's memory is visible");
      await mine.flush();
      const fresh = new LocalVectorStore({ file });
      assert.equal((await fresh.query('m', [1, 1], { limit: 10 })).length, 2);
      assert.equal((await fresh.query('memories', [1, 1, 0.5])).length, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
