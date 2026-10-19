// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0
'use strict';
// Regression tests for defects found by a security and reliability audit: each test sends the
// request that used to crash, hang or leak and checks the server now answers safely.
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { fork } = require('node:child_process');
const { load, DIST } = require('./dist.cjs');

const rt = load('runtime/index');
const { jsx, raw } = load('runtime/jsx');
const { htmlToDocument } = load('runtime/html-markdown');
const { Session } = load('runtime/session');

/** A hand-written module: routes `{ method, path, handler(ctx), page?, cache?, multipart? }`. */
function makeModule({ routes = [], websockets = [], middleware, i18n, beans: extraBeans = [] } = {}) {
  const compile = (p) => {
    const names = [];
    const src = p
      .split('/')
      .filter(Boolean)
      .map((s) => (s.startsWith(':') ? (names.push(s.slice(1)), '\\/([^/]+)') : `\\/${s}`))
      .join('');
    return { pattern: names.length ? new RegExp(`^${src}$`) : null, paramNames: names };
  };
  return {
    beans: [
      { id: 0, name: 'Bean', scope: 'singleton', eager: false, primary: false, types: ['Bean'], create: () => ({}) },
      { id: 1, name: 'Mw', scope: 'singleton', eager: false, primary: false, types: ['Mw'], create: () => ({ handle: middleware ?? ((_c, next) => next()) }) },
      ...extraBeans.map((b, i) => ({ id: 2 + i, name: `Extra${i}`, eager: false, primary: false, types: [`Extra${i}`], scope: 'singleton', ...b })),
    ],
    typeIndex: { Bean: [0], Mw: [1] },
    middleware: middleware ? [1] : [],
    routes: routes.map((r) => ({
      method: r.method ?? 'GET',
      path: r.path,
      ...compile(r.path),
      beanId: 0,
      needsBody: !!r.needsBody,
      multipart: !!r.multipart,
      page: !!r.page,
      cache: r.cache,
      handler: (_b, ctx) => (r.page ? rt.$page(r.handler(ctx), ctx) : r.handler(ctx)),
    })),
    websockets: websockets.map((w) => ({ path: w.path, ...compile(w.path), beanId: 0, message: (_b, s, d) => w.message(s, d) })),
    sessionKey: 'k'.repeat(64),
    buildInfo: { generatedAt: 'test', compilerVersion: 'test' },
    ...(i18n ? { i18n } : {}),
  };
}

async function serve(spec, configValues = {}) {
  const module = makeModule(spec);
  const config = rt.Config.of({ server: { 'request-log': false }, ...configValues }, 'test');
  const ctx = new rt.ApplicationContext(module, config);
  rt.configurePages({ csp: rt.DEFAULT_CSP });
  const server = rt.createHttpServer(ctx, { config, logger: rt.Logger.silent() });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    port,
    context: ctx,
    // node:http rather than fetch, which won't send a custom Host header.
    get: (p, headers = {}) =>
      new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: p, headers }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            resolve({ status: res.statusCode, headers: { get: (n) => res.headers[n.toLowerCase()] ?? null }, text: async () => body });
          });
        });
        req.on('error', reject);
        req.end();
      }),
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** Raw request over TCP; resolves with everything the server sent before closing (or timeout). */
function rawRequest(port, text, timeout = 5000) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    let out = '';
    s.on('data', (d) => (out += d.toString('latin1')));
    s.on('close', () => resolve(out));
    s.on('error', () => resolve(out));
    s.setTimeout(timeout, () => s.destroy());
    s.write(text);
  });
}

// Child process for the upload I/O error test: serve and report the port, no tests.
if (process.env.AMOXI_HARDENING_CHILD === 'upload') {
  serve({ routes: [{ path: '/ping', handler: () => 'pong' }, { method: 'POST', path: '/upload', multipart: true, handler: (ctx) => ({ n: ctx.body.files.length }) }] }).then(({ port }) => process.send({ port }));
  return;
}
if (process.env.AMOXI_HARDENING_CHILD === 'websocket') {
  const gc = globalThis.gc ?? (() => {});
  const sockets = new Set();
  const module = makeModule({ websockets: [{ path: '/ws', message: (s) => s.close(1000, 'bye') }] });
  const config = rt.Config.of({ server: { 'request-log': false } }, 'test');
  const server = rt.createHttpServer(new rt.ApplicationContext(module, config), { config, logger: rt.Logger.silent() });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
  process.on('message', () => {
    gc();
    process.send({ memory: process.memoryUsage().arrayBuffers, openSockets: sockets.size });
  });
  return;
}

test('a WebSocket upgrade with malformed %-encoding is refused, not a process crash', async () => {
  const app = await serve({ routes: [{ path: '/ping', handler: () => 'pong' }], websockets: [{ path: '/ws/rooms/:room', message: () => {} }] });
  try {
    const res = await rawRequest(app.port, 'GET /ws/rooms/%E0%A4%A HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n');
    assert.match(res, /^HTTP\/1\.1 400/);
    assert.equal(await (await app.get('/ping')).text(), 'pong', 'still serving');
  } finally {
    await app.close();
  }
});

test('multipart: endless "transport padding" after a boundary is rejected early', async () => {
  const app = await serve({ routes: [{ method: 'POST', path: '/upload', multipart: true, handler: (ctx) => ({ n: ctx.body.files.length }) }] });
  try {
    const head = `POST /upload HTTP/1.1\r\nHost: x\r\nContent-Type: multipart/form-data; boundary=B\r\nTransfer-Encoding: chunked\r\n\r\n`;
    const chunk = `--B${'x'.repeat(4096)}`;
    const res = await rawRequest(app.port, `${head}${chunk.length.toString(16)}\r\n${chunk}\r\n`, 3000);
    assert.match(res, /^HTTP\/1\.1 400/);
  } finally {
    await app.close();
  }
});

test('an error before the body is read closes the connection; request logging survives the detached socket', async () => {
  const app = await serve({ routes: [{ path: '/ping', handler: () => 'pong' }, { method: 'POST', path: '/upload', multipart: true, handler: () => 'ok' }] }, { server: { 'request-log': true } });
  try {
    const started = performance.now();
    const chunk = `--B${'x'.repeat(64 * 1024)}`;
    const res = await rawRequest(app.port, `POST /upload HTTP/1.1\r\nHost: x\r\nContent-Type: multipart/form-data; boundary=B\r\nTransfer-Encoding: chunked\r\n\r\n${chunk.length.toString(16)}\r\n${chunk}\r\n`, 5000);
    assert.match(res, /^HTTP\/1\.1 400/);
    assert.match(res, /connection: close/i);
    assert.ok(performance.now() - started < 3000, 'the connection was kept open');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(await (await app.get('/ping')).text(), 'pong', 'still serving');
  } finally {
    await app.close();
  }
});

test('a too-large body of known size is read and discarded, so the client always gets its 413', async () => {
  const app = await serve({ routes: [{ method: 'POST', path: '/echo', needsBody: true, handler: (ctx) => ctx.body }, { path: '/ping', handler: () => 'pong' }] }, { server: { 'max-body-size': 65536 } });
  try {
    const body = JSON.stringify({ x: 'y'.repeat(2_000_000) });
    const res = await fetch(`http://127.0.0.1:${app.port}/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal(res.status, 413);
    assert.notEqual(res.headers.get('connection'), 'close', 'the connection stays usable');
    // A body of unknown length that is too large still gets an answer, then the connection closes.
    const chunk = 'z'.repeat(70_000);
    const raw = await rawRequest(app.port, `POST /echo HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n${chunk.length.toString(16)}\r\n${chunk}\r\n`, 3000);
    assert.match(raw, /^HTTP\/1\.1 413/);
    assert.match(raw, /connection: close/i);
    assert.equal(await (await app.get('/ping')).text(), 'pong');
  } finally {
    await app.close();
  }
});

test('multipart: a failing temp-file write answers 500 instead of crashing', { skip: process.platform !== 'linux' && 'needs /proc to simulate an I/O error' }, async () => {
  // <TMPDIR>/amoxi-uploads points somewhere files can't be created: the same path as ENOSPC/EIO.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'amoxi-upload-err-'));
  fs.symlinkSync('/proc/1', path.join(tmp, 'amoxi-uploads'));
  const child = fork(__filename, [], { env: { ...process.env, TMPDIR: tmp, AMOXI_HARDENING_CHILD: 'upload' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  try {
    const port = await new Promise((resolve, reject) => {
      child.once('message', (m) => resolve(m.port));
      child.once('exit', (code) => reject(new Error(`child exited ${code}`)));
    });
    const body = '--B\r\nContent-Disposition: form-data; name="f"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\nhello\r\n--B--\r\n';
    const res = await fetch(`http://127.0.0.1:${port}/upload`, { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=B' }, body });
    assert.equal(res.status, 500);
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/ping`)).text(), 'pong', 'still serving');
    assert.equal(child.exitCode, null);
  } finally {
    child.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a forged Host header cannot poison cached markdown/JSON page views', async () => {
  const app = await serve({ routes: [{ path: '/docs', page: true, cache: { ttl: 60, swr: 0 }, handler: () => jsx('main', { children: [jsx('h1', { children: 'Docs' }), jsx('a', { href: '/guide', children: 'Guide' })] }) }] });
  try {
    const evil = await (await app.get('/docs.md', { host: 'attacker.example' })).text();
    assert.match(evil, /attacker\.example/, 'the forger sees their own host');
    const victim = await (await app.get('/docs.md')).text();
    assert.doesNotMatch(victim, /attacker\.example/);
    const json = await (await app.get('/docs', { accept: 'application/json', host: 'evil.example' })).text();
    assert.ok(json.length > 0);
    assert.doesNotMatch(await (await app.get('/docs', { accept: 'application/json' })).text(), /evil\.example/);
    // A Host that isn't a host name is never used in links.
    assert.doesNotMatch(await (await app.get('/docs.md', { host: 'a"b<c' })).text(), /a"b<c/);
  } finally {
    await app.close();
  }
});

test('a configured app.url is used for absolute links regardless of Host', async () => {
  const app = await serve({ routes: [{ path: '/docs', page: true, handler: () => jsx('main', { children: jsx('h1', { children: 'Docs' }) }) }] }, { app: { url: 'https://docs.acme.test/' } });
  try {
    const md = await (await app.get('/docs.md', { host: 'attacker.example' })).text();
    assert.match(md, /https:\/\/docs\.acme\.test\/docs/);
    assert.doesNotMatch(md, /attacker/);
  } finally {
    await app.close();
  }
});

test('html to markdown runs in linear time on long whitespace runs (no ReDoS)', () => {
  const started = performance.now();
  htmlToDocument(`<main><pre>${' '.repeat(200_000)}x</pre><pre>${'\n'.repeat(200_000)}y</pre></main>`, { baseUrl: 'http://x/' });
  assert.ok(performance.now() - started < 2000, 'took too long');
});

test('CSP nonce: only scripts written in JSX or by the framework get it, never injected HTML', async () => {
  const stored = '<p>Nice post!</p><script>alert(document.cookie)</script>';
  const app = await serve({
    routes: [{ path: '/post', page: true, handler: () => jsx('html', { children: jsx('body', { children: [jsx('script', { children: raw('window.ok=1') }), raw(stored)] }) }) }],
  });
  try {
    const res = await app.get('/post');
    const html = await res.text();
    const nonce = /'nonce-([^']+)'/.exec(res.headers.get('content-security-policy'))[1];
    assert.ok(html.includes(`<script nonce="${nonce}">window.ok=1</script>`), 'JSX script carries the nonce');
    assert.ok(html.includes('<script>alert(document.cookie)</script>'), 'injected script has no nonce');
    assert.doesNotMatch(html, /amoxi-nonce-/, 'the internal marker never leaves the server');
  } finally {
    await app.close();
  }
  // Rendering outside a request removes the marker too.
  assert.equal(rt.renderToString(jsx('script', { children: raw('1') })), '<script>1</script>');
});

test('middleware sees the page path for /x.md and /x/index.md, so guards cover every view', async () => {
  const seen = [];
  const app = await serve({
    routes: [{ path: '/account', page: true, handler: () => jsx('main', { children: 'Balance: 42' }) }],
    middleware: (ctx, next) => {
      seen.push(`${ctx.path} ${ctx.representation}`);
      if (ctx.path === '/account') throw new rt.HttpError(401, 'Sign in');
      return next();
    },
  });
  try {
    for (const p of ['/account', '/account.md', '/account/index.md']) assert.equal((await app.get(p)).status, 401, p);
    assert.equal((await app.get('/account', { accept: 'application/json' })).status, 401);
    assert.deepEqual(seen, ['/account html', '/account markdown', '/account markdown', '/account json']);
  } finally {
    await app.close();
  }
});

test('sessions have a stable id; regenerate() and destroy() replace it', () => {
  const s = new Session({ user: 'u1' }, { id: 'abc', issuedAt: 5 });
  assert.equal(s.id, 'abc');
  assert.equal(s.issuedAt, 5);
  s.regenerate();
  assert.notEqual(s.id, 'abc');
  assert.equal(s.get('user'), 'u1', 'regenerate keeps the data');
  const before = s.id;
  s.destroy();
  assert.notEqual(s.id, before);
  assert.equal(s.get('user'), undefined);
  const fresh = new Session(undefined);
  assert.equal(fresh.id, fresh.id, 'stable within a request');
  assert.equal(fresh.pendingWrite, undefined, 'reading the id does not write a cookie');
});

test('the cluster supervisor keeps replacing crashed workers instead of stopping the service', { timeout: 60_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amoxi-supervisor-'));
  // Each worker listens, then crashes 100 ms later; workers that never listen are a startup failure.
  const worker = path.join(dir, 'worker.cjs');
  fs.writeFileSync(worker, `const http=require('node:http');const s=http.createServer((q,r)=>r.end('ok'));s.listen(0,()=>setTimeout(()=>{throw new Error('boom')},100));`);
  const sup = path.join(dir, 'sup.cjs');
  fs.writeFileSync(sup, `require(${JSON.stringify(path.join(DIST, 'compiler/start.js'))}).runCluster(${JSON.stringify(worker)}, '1', 1000);`);
  const child = fork(sup, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  try {
    await new Promise((r) => setTimeout(r, 6000));
    assert.equal(child.exitCode, null, `supervisor stopped:\n${out}`);
    assert.ok((out.match(/starting a replacement/g) ?? []).length > 10, out);
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the cluster supervisor stops when workers cannot start at all', { timeout: 30_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amoxi-supervisor-'));
  const worker = path.join(dir, 'worker.cjs');
  fs.writeFileSync(worker, `throw new Error('bad config');`);
  const sup = path.join(dir, 'sup.cjs');
  fs.writeFileSync(sup, `require(${JSON.stringify(path.join(DIST, 'compiler/start.js'))}).runCluster(${JSON.stringify(worker)}, '2', 1000);`);
  const child = fork(sup, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  try {
    const code = await new Promise((r) => child.once('exit', (c) => r(c)));
    assert.equal(code, 1);
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


/** Forces a garbage collection so memory measurements only count what is still referenced. */
function collectGarbage() {
  require('node:v8').setFlagsFromString('--expose-gc');
  require('node:vm').runInNewContext('gc')();
}

test('email validation runs in linear time; patterns and formats are skipped once maxLength failed', () => {
  const { $v } = load('runtime/validate');
  const check = (value, constraints) => {
    const errors = [];
    const started = performance.now();
    $v.str(value, errors, 'email', constraints);
    return { errors, ms: performance.now() - started };
  };
  assert.equal(check('first.last+tag@sub.example.com', { format: 'email' }).errors.length, 0);
  for (const bad of ['no-at', 'a@b', 'a@.b', 'a@b.', 'a b@c.d', 'a@b@c.d', '@b.c']) assert.equal(check(bad, { format: 'email' }).errors.length, 1, bad);
  const attack = check(`a@${'.'.repeat(1_000_000)}@`, { format: 'email' });
  assert.equal(attack.errors.length, 1);
  assert.ok(attack.ms < 200, `email check took ${attack.ms.toFixed(0)} ms`);
  // A slow pattern is never run over a value that is already too long.
  const slow = check(`${'a'.repeat(40)}!`, { maxLength: 10, pattern: /^(a+)+$/ });
  assert.equal(slow.errors.length, 1);
  assert.match(slow.errors[0].message, /at most 10/);
  assert.ok(slow.ms < 200, `pattern ran over an over-long value (${slow.ms.toFixed(0)} ms)`);
});

test('a closed WebSocket keeps nothing the client sends afterwards and is dropped soon', { timeout: 30_000 }, async () => {
  // The server runs in a child process, so its memory isn't mixed with this client's buffers.
  const child = fork(__filename, [], { env: { ...process.env, AMOXI_HARDENING_CHILD: 'websocket' }, execArgv: ['--expose-gc'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  // A server that is stuck (for example, busy copying a growing buffer) doesn't answer: report that
  // as a failure after a few seconds instead of waiting forever.
  const ask = (what) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the server stopped answering (busy with buffered data?)')), 3000);
      child.once('message', (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      child.send(what);
    });
  try {
    const { port } = await new Promise((resolve) => child.once('message', resolve));
    // allowHalfOpen: like a hostile client, keep sending after the server has closed its side.
    const sock = net.connect({ port, host: '127.0.0.1', allowHalfOpen: true });
    sock.on('error', () => {});
    await new Promise((r) => sock.once('connect', r));
    sock.write('GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n');
    await new Promise((r) => sock.once('data', r)); // 101
    sock.on('data', () => {});
    // One masked text frame: the server answers by closing.
    sock.write(Buffer.from([0x81, 0x82, 1, 2, 3, 4, 'h'.charCodeAt(0) ^ 1, 'i'.charCodeAt(0) ^ 2]));
    await new Promise((r) => setTimeout(r, 100));
    const before = (await ask('stats')).memory;
    const junk = Buffer.alloc(1024 * 1024, 0x41);
    for (let i = 0; i < 40; i++) {
      if (sock.write(junk)) continue;
      // A server that buffers what it receives slows down and stops reading: fail instead of waiting.
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('the server stopped reading what the client sends')), 5000);
        sock.once('drain', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    // Memory must come back down once the server has read everything. Sample until it does (a slow
    // machine, Windows in particular, can still hold data it has read but not yet processed), up to
    // 4 s; data kept by the connection would never be released.
    let grown = Infinity;
    for (let i = 0; i < 20 && grown >= 16; i++) {
      await new Promise((r) => setTimeout(r, 200));
      grown = ((await ask('stats')).memory - before) / 1024 / 1024;
    }
    assert.ok(grown < 16, `server kept ${grown.toFixed(1)} MB of 40 MB sent after the connection closed`);
    // The server drops the connection once the close timeout (5 s) has passed.
    await new Promise((r) => setTimeout(r, 5500));
    assert.equal((await ask('stats')).openSockets, 0, 'the server still holds the closed connection');
    sock.destroy();
  } finally {
    child.kill('SIGKILL');
  }
});

test('HttpResponse.file() waits for slow readers instead of loading the file into memory', { timeout: 30_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amoxi-file-'));
  const file = path.join(dir, 'big.bin');
  fs.writeFileSync(file, Buffer.alloc(64 * 1024 * 1024, 7));
  const app = await serve({ routes: [{ path: '/big', handler: () => rt.HttpResponse.file(file) }] }, { server: { compression: false } });
  try {
    collectGarbage();
    const before = process.memoryUsage().arrayBuffers;
    const sock = net.connect(app.port, '127.0.0.1');
    sock.on('error', () => {});
    await new Promise((r) => sock.once('connect', r));
    sock.write('GET /big HTTP/1.1\r\nHost: x\r\n\r\n');
    await new Promise((r) => sock.once('data', r));
    sock.pause(); // a client that stops reading
    await new Promise((r) => setTimeout(r, 1500));
    collectGarbage();
    const grown = (process.memoryUsage().arrayBuffers - before) / 1024 / 1024;
    sock.destroy();
    assert.ok(grown < 24, `server buffered ${grown.toFixed(1)} MB of a 64 MB file for a client that stopped reading`);
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('JSX drops invalid attribute names and string event handlers from spread props', () => {
  const untrusted = { title: 'ok', 'onload=alert(1) x': 'y', '"><script>alert(1)</script>': '1', onclick: 'alert(1)', ONMOUSEOVER: 'x', 'data-id': '7', 'aria-label': 'Save' };
  assert.equal(rt.renderToString(jsx('div', { ...untrusted, children: 'hi' })), '<div title="ok" data-id="7" aria-label="Save">hi</div>');
  assert.throws(() => jsx('img src=x onerror=alert(1)', {}), /Invalid element name/);
});

test('a cached page is cached per language, and shared caches are told it varies', async () => {
  const i18n = { defaultLocale: 'en', locales: ['en', 'fr'], messages: { en: { hi: 'Hello' }, fr: { hi: 'Bonjour' } } };
  const app = await serve({ i18n, routes: [{ path: '/welcome', page: true, cache: { ttl: 60, swr: 0 }, handler: (ctx) => jsx('main', { children: jsx('h1', { children: ctx.t('hi') }) }) }] });
  try {
    const fr = await app.get('/welcome', { 'accept-language': 'fr-CA,fr;q=0.9' });
    assert.match(await fr.text(), /Bonjour/);
    const en = await app.get('/welcome', { 'accept-language': 'en-US' });
    assert.match(await en.text(), /Hello/, 'an English visitor got the French page from the cache');
    const frAgain = await app.get('/welcome', { 'accept-language': 'fr' });
    assert.equal(frAgain.headers.get('x-amoxi-cache'), 'HIT');
    assert.match(await frAgain.text(), /Bonjour/);
    assert.match(String(frAgain.headers.get('vary')), /Accept-Language/i);
  } finally {
    await app.close();
  }
});

test('behind a proxy, the client address is the one the proxy added, not one the client forged', async () => {
  const route = { path: '/ip', handler: (ctx) => ({ ip: ctx.ip, protocol: ctx.protocol }) };
  const ask = async (app, headers) => JSON.parse(await (await app.get('/ip', headers)).text());
  const one = await serve({ routes: [route] }, { server: { 'request-log': false, 'trust-proxy': true } });
  const two = await serve({ routes: [route] }, { server: { 'request-log': false, 'trust-proxy': 2 } });
  const none = await serve({ routes: [route] });
  try {
    // The client sent "X-Forwarded-For: 6.6.6.6"; our proxy appended the address it saw.
    const forged = { 'x-forwarded-for': '6.6.6.6, 203.0.113.9', 'x-forwarded-proto': 'http, https' };
    assert.deepEqual(await ask(one, forged), { ip: '203.0.113.9', protocol: 'https' });
    // Two proxies (CDN, then load balancer): the CDN's entry is the client.
    assert.equal((await ask(two, { 'x-forwarded-for': '6.6.6.6, 198.51.100.7, 10.0.0.2' })).ip, '198.51.100.7');
    // Without trust-proxy the headers are ignored.
    assert.equal((await ask(none, forged)).ip, '127.0.0.1');
  } finally {
    await Promise.all([one.close(), two.close(), none.close()]);
  }
});

/* ------------------------------------------------------------------ */
/* Second audit: file handles and WebSocket limits                     */
/* ------------------------------------------------------------------ */

test('HEAD requests to a file route never open the file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amoxi-head-'));
  const file = path.join(dir, 'report.bin');
  fs.writeFileSync(file, Buffer.alloc(4096, 1));
  // Count the files the server opens and closes (works the same on every platform).
  const open = new Set();
  let opened = 0;
  const realOpen = fs.open;
  const realClose = fs.close;
  fs.open = function (p, ...rest) {
    const cb = rest[rest.length - 1];
    if (String(p) !== file) return realOpen.call(this, p, ...rest);
    opened++;
    return realOpen.call(this, p, ...rest.slice(0, -1), (err, fd) => {
      if (!err) open.add(fd);
      cb(err, fd);
    });
  };
  fs.close = function (fd, ...rest) {
    open.delete(fd);
    return realClose.call(this, fd, ...rest);
  };
  const app = await serve({ routes: [{ method: 'HEAD', path: '/report', handler: () => rt.HttpResponse.file(file) }, { path: '/report', handler: () => rt.HttpResponse.file(file) }] });
  try {
    for (let i = 0; i < 30; i++) {
      const res = await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: app.port, path: '/report', method: 'HEAD' }, resolve);
        req.on('error', reject);
        req.end();
      });
      assert.equal(res.headers['content-length'], '4096');
      res.resume();
    }
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(opened, 0, `HEAD requests opened the file ${opened} times`);
    // A GET still sends the file and closes it afterwards.
    const got = await app.get('/report');
    assert.equal((await got.text()).length, 4096);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(open.size, 0, 'the file stayed open after a GET');
  } finally {
    fs.open = realOpen;
    fs.close = realClose;
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A WebSocket connection over an in-memory socket, so a test decides exactly how bytes arrive. */
function memorySocket({ open, message, close, options = {}, head = Buffer.alloc(0), stalled = false } = {}) {
  const { EventEmitter } = require('node:events');
  const { Duplex } = require('node:stream');
  const { attachWebSockets } = load('runtime/websocket');
  const sent = [];
  const held = [];
  const socket = new Duplex({
    read() {},
    write(chunk, _enc, cb) {
      sent.push(chunk);
      // A stalled client never reads: the write never completes, so data piles up in writableLength.
      if (stalled) held.push(cb);
      else cb();
    },
  });
  const server = new EventEmitter();
  const bean = {};
  const ctx = { isEnabled: () => true, get: () => bean };
  const endpoint = { path: '/ws', pattern: null, paramNames: [], beanId: 0, message: (_b, c, d) => message?.(c, d), ...(open ? { open: (_b, c) => open(c) } : {}), ...(close ? { close: (_b, c, code, reason) => close(c, code, reason) } : {}) };
  const ws = attachWebSockets(server, ctx, [endpoint], { trustProxy: 0, secureCookies: false }, { maxMessageSize: 1024 * 1024, pingIntervalMs: 60_000, allowedOrigins: [], ...options }, rt.Logger.silent());
  const req = { url: '/ws', headers: { host: 'x', upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } };
  server.emit('upgrade', req, socket, head);
  /** Server frames after the 101 response, as { opcode, payload }. */
  const frames = () => {
    const all = Buffer.concat(sent.filter((c) => !c.toString('latin1').startsWith('HTTP/1.1')));
    const out = [];
    for (let i = 0; i + 2 <= all.length; ) {
      let len = all[i + 1] & 0x7f;
      let off = 2;
      if (len === 126) (len = all.readUInt16BE(i + 2)), (off = 4);
      else if (len === 127) (len = Number(all.readBigUInt64BE(i + 2))), (off = 10);
      out.push({ opcode: all[i] & 0x0f, payload: all.subarray(i + off, i + off + len) });
      i += off + len;
    }
    return out;
  };
  const closeCode = () => {
    const f = frames().find((x) => x.opcode === 0x8);
    return f && f.payload.length >= 2 ? f.payload.readUInt16BE(0) : undefined;
  };
  return { socket, ws, sent, frames, closeCode, send: (buf) => socket.emit('data', buf) };
}

/** A masked client frame. */
function clientFrame(opcode, payload = Buffer.alloc(0), fin = true) {
  const mask = Buffer.from([1, 2, 3, 4]);
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0, 0x80 | len]) : len < 65536 ? Buffer.from([0, 0x80 | 126, 0, 0]) : Buffer.from([0, 0x80 | 127, 0, 0, 0, 0, 0, 0, 0, 0]);
  if (len >= 126 && len < 65536) head.writeUInt16BE(len, 2);
  else if (len >= 65536) head.writeBigUInt64BE(BigInt(len), 2);
  head[0] = (fin ? 0x80 : 0) | opcode;
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
  return Buffer.concat([head, mask, body]);
}

test('WebSocket: a client that floods pings but never reads stops being read from, then is dropped', () => {
  let conn;
  let closed;
  const ws = memorySocket({ stalled: true, options: { maxBufferedSize: 1024 * 1024 }, open: (c) => (conn = c), close: (_c, code) => (closed = code) });
  const ping = clientFrame(0x9, Buffer.alloc(125, 7));
  let paused = false;
  for (let i = 0; i < 100_000; i++) {
    ws.send(ping);
    if (ws.socket.isPaused()) {
      paused = true;
      break;
    }
  }
  assert.ok(paused, 'the server kept reading pings while its answers piled up');
  assert.ok(ws.socket.writableLength <= 1024 * 1024, `${ws.socket.writableLength} bytes waiting for a client that never reads`);
  assert.equal(conn.bufferedAmount, ws.socket.writableLength);
  // What the application sends past the limit drops the connection instead of growing without bound.
  for (let i = 0; i < 16 && !ws.socket.destroyed; i++) conn.send(Buffer.alloc(256 * 1024));
  assert.ok(ws.socket.destroyed, 'the connection was kept although its send queue passed the limit');
  assert.equal(closed, 1006);
  assert.equal(conn.open, false);
});

test('WebSocket: a message can be split into at most max-fragments frames, empty ones included', () => {
  const ws = memorySocket({ options: { maxFragments: 100 } });
  ws.send(clientFrame(0x1, Buffer.from('a'), false));
  const empty = clientFrame(0x0, Buffer.alloc(0), false);
  for (let i = 0; i < 1000 && !ws.closeCode(); i++) ws.send(empty);
  assert.equal(ws.closeCode(), 1009, 'endless empty continuation frames were accepted');
});

test('WebSocket: a large frame sent in tiny pieces is assembled in linear time', () => {
  const received = [];
  const ws = memorySocket({ message: (_c, d) => received.push(d) });
  const data = Buffer.alloc(1024 * 1024 - 64, 0x61);
  const wire = clientFrame(0x2, data);
  // Count the bytes joined while the frame arrives: re-joining everything on every 16-byte piece
  // copies about 32 GB here; collecting the pieces copies each byte about once.
  const realConcat = Buffer.concat;
  let copied = 0;
  Buffer.concat = function (list, total) {
    const out = realConcat.call(this, list, total);
    copied += out.length;
    return out;
  };
  try {
    for (let i = 0; i < wire.length; i += 16) ws.send(wire.subarray(i, i + 16));
  } finally {
    Buffer.concat = realConcat;
  }
  assert.equal(received.length, 1);
  assert.equal(received[0].length, data.length);
  assert.ok(copied < 4 * wire.length, `assembling a ${wire.length}-byte frame copied ${copied} bytes`);
});

test('WebSocket: messages sent with the upgrade request arrive after open has run', async () => {
  const order = [];
  const head = clientFrame(0x1, Buffer.from('early'));
  memorySocket({
    head,
    open: async () => {
      order.push('open:start');
      await new Promise((r) => setTimeout(r, 20));
      order.push('open:end');
    },
    message: (_c, d) => order.push(`message:${d}`),
  });
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(order, ['open:start', 'open:end', 'message:early']);
});

test('WebSocket: reserved close codes are refused and close reasons are cut to 123 bytes', () => {
  // A client may not send 1005, 1006 or 1015; the server answers with a protocol error, not an echo.
  for (const code of [1005, 1006, 1015, 999, 2000, 5000]) {
    const ws = memorySocket();
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code, 0);
    ws.send(clientFrame(0x8, payload));
    assert.equal(ws.closeCode(), 1002, `close code ${code} was echoed`);
  }
  const ok = memorySocket();
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(4001, 0);
  ok.send(clientFrame(0x8, payload));
  assert.equal(ok.closeCode(), 4001);
  // The application can't send reserved codes or reasons that don't fit in a close frame.
  let conn;
  const app = memorySocket({ open: (c) => (conn = c) });
  assert.throws(() => conn.close(1006), RangeError);
  conn.close(1000, 'x'.repeat(300));
  const frame = app.frames().find((f) => f.opcode === 0x8);
  assert.equal(frame.payload.length, 125);
});

/* ------------------------------------------------------------------ */
/* Second audit: cached pages, script URLs                             */
/* ------------------------------------------------------------------ */

test('a cached page that reads the session is neither stored nor publicly cacheable', async () => {
  const app = await serve({
    routes: [
      { path: '/login', handler: (ctx) => (ctx.session.set('name', String(ctx.query.get('as'))), 'ok') },
      { path: '/greeting', page: true, cache: { ttl: 60, swr: 0 }, handler: (ctx) => jsx('p', { children: `Hello ${ctx.session.get('name') ?? 'guest'}` }) },
    ],
  });
  try {
    const login = await app.get('/login?as=Ada');
    const cookie = login.headers.get('set-cookie')[0].split(';')[0];
    const ada = await app.get('/greeting', { cookie });
    assert.match(await ada.text(), /Hello Ada/);
    assert.equal(ada.headers.get('cache-control'), 'private, no-store');
    // The next visitor gets their own page, not Ada's.
    const guest = await app.get('/greeting');
    assert.match(await guest.text(), /Hello guest/);
    assert.notEqual(guest.headers.get('x-amoxi-cache'), 'HIT');
  } finally {
    await app.close();
  }
});

test('a response that sets a cookie is never publicly cacheable', async () => {
  const app = await serve({
    routes: [{ path: '/welcome-cookie', page: true, cache: { ttl: 60, swr: 0 }, handler: (ctx) => (ctx.cookies.set('seen', '1'), jsx('p', { children: 'Welcome' })) }],
  });
  try {
    const res = await app.get('/welcome-cookie');
    assert.ok(res.headers.get('set-cookie'));
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    // A later request must not get the first visitor's Set-Cookie from the cache.
    const again = await app.get('/welcome-cookie');
    assert.notEqual(again.headers.get('x-amoxi-cache'), 'HIT');
  } finally {
    await app.close();
  }
});

test('background revalidation finishes before the request scope is cleaned up', async () => {
  let renders = 0;
  const problems = [];
  const app = await serve({
    beans: [{ scope: 'request', create: () => ({ open: true }), preDestroy: (b) => (b.open = false) }],
    routes: [
      {
        path: '/swr-page',
        page: true,
        cache: { ttl: 1, swr: 60 },
        handler: async () => {
          const tx = app.context.get(2); // a request-scoped resource, like a database transaction
          renders++;
          await new Promise((r) => setTimeout(r, 50));
          if (!tx.open) problems.push('used after cleanup');
          return jsx('p', { children: `render ${renders}` });
        },
      },
    ],
  });
  try {
    await app.get('/swr-page'); // MISS: rendered and stored
    await new Promise((r) => setTimeout(r, 1100)); // now stale
    const stale = await app.get('/swr-page');
    assert.equal(stale.headers.get('x-amoxi-cache'), 'STALE');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(renders, 2, 'the stale page was refreshed in the background');
    assert.deepEqual(problems, []);
    const fresh = await app.get('/swr-page');
    assert.match(await fresh.text(), /render 2/);
  } finally {
    await app.close();
  }
});

test('JSX drops script URLs from href and src, on the server and in the browser', () => {
  const html = (el) => String(el);
  for (const bad of ['javascript:alert(1)', ' JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', 'vbscript:x', 'data:text/html,<script>alert(1)</script>']) {
    assert.doesNotMatch(html(jsx('a', { href: bad, children: 'x' })), /href=/, `server kept href=${bad}`);
    assert.doesNotMatch(html(jsx('form', { action: bad })), /action=/);
  }
  assert.match(html(jsx('a', { href: 'https://example.com/a', children: 'x' })), /href="https:\/\/example.com\/a"/);
  assert.match(html(jsx('a', { href: '/relative?x=1', children: 'x' })), /href="\/relative\?x=1"/);
  assert.match(html(jsx('img', { src: 'data:image/png;base64,AAAA', alt: '' })), /src="data:image\/png/);
  assert.doesNotMatch(html(jsx('iframe', { src: 'javascript:alert(1)' })), /src=/);

  // The browser runtime, against a minimal DOM.
  const elements = [];
  const fakeElement = () => {
    const el = {
      attributes: {},
      setAttribute(n, v) {
        this.attributes[n] = v;
      },
      removeAttribute(n) {
        delete this.attributes[n];
      },
      addEventListener() {},
    };
    elements.push(el);
    return el;
  };
  const previous = globalThis.document;
  globalThis.document = { createElement: fakeElement, createElementNS: fakeElement };
  try {
    const dom = load('client/dom');
    assert.equal(dom.jsx('a', { href: 'javascript:alert(1)' }).attributes.href, undefined);
    assert.equal(dom.jsx('img', { src: ' javascript:alert(1)' }).attributes.src, undefined);
    assert.equal(dom.jsx('a', { href: 'https://example.com/' }).attributes.href, 'https://example.com/');
  } finally {
    globalThis.document = previous;
  }
});

test('the browser client backs off when an event stream keeps closing without an end event', async () => {
  const previous = { fetch: globalThis.fetch, document: globalThis.document };
  let calls = 0;
  globalThis.document = { querySelector: () => null };
  // Every stream sends the same event and closes, as a proxy that cuts streams short would.
  globalThis.fetch = async () => {
    calls++;
    await new Promise((r) => setImmediate(r)); // a real fetch yields to timers; a tight loop would starve them
    return new Response('id: 1\nevent: message.delta\ndata: {"text":"hi"}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const controller = new AbortController();
  try {
    const { followRun } = load('client/agent');
    const following = followRun('/agents/a/runs/r/events', { signal: controller.signal, onEvent: () => {} });
    await new Promise((r) => setTimeout(r, 1500));
    controller.abort();
    assert.equal(await following, 1);
    // With no back-off this loop reconnects thousands of times a second.
    assert.ok(calls <= 5, `reconnected ${calls} times in 1.5 s`);
  } finally {
    controller.abort();
    globalThis.fetch = previous.fetch;
    globalThis.document = previous.document;
  }
});
