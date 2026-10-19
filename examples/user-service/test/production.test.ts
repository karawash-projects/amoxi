import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { brotliDecompressSync } from 'node:zlib';
import { Config, AmoxiApplication, responseCache, type RunningApplication } from 'amoxi';
import { applicationModule } from '../src/generated/amoxi.generated';
import { UserService } from '../src/service/user-service';

const SECRET = 'test-secret-that-is-at-least-32-characters-long';

async function start(config: Record<string, unknown> = {}, overrides: Array<[unknown, unknown]> = [], profile = 'test'): Promise<{ app: RunningApplication; base: string }> {
  responseCache.clear();
  const app = await AmoxiApplication.run(applicationModule, {
    config: Config.of({ server: { port: 0, host: '127.0.0.1', 'static-dir': 'public' }, amoxi: { session: { secret: SECRET } }, ...config }, profile),
    overrides: overrides as never,
    silent: true,
    shutdownHook: false,
  });
  return { app, base: `http://127.0.0.1:${app.port}` };
}

const json = { 'content-type': 'application/json' };
const html = { accept: 'text/html' };

describe('production features', () => {
  let app: RunningApplication;
  let base: string;
  before(async () => ({ app, base } = await start()));
  after(() => app.close());

  test('request bodies are validated from TypeScript types and sanitized', async () => {
    const bad = await fetch(`${base}/users`, { method: 'POST', headers: json, body: JSON.stringify({ name: '   ', email: 'nope' }) });
    assert.equal(bad.status, 400);
    const body = (await bad.json()) as { details: Array<{ path: string; message: string }> };
    assert.deepEqual(body.details, [
      { path: 'name', message: 'must not be blank' },
      { path: 'email', message: 'must be a valid email' },
    ]);

    const wrongType = await fetch(`${base}/users`, { method: 'POST', headers: json, body: JSON.stringify({ name: 42 }) });
    const wt = (await wrongType.json()) as { details: Array<{ path: string; message: string }> };
    assert.deepEqual(wt.details.map((d) => d.path), ['name', 'email']);
    assert.match(wt.details[0].message, /must be a string/);

    // Unknown properties never reach the service (no mass assignment of `id`).
    const ok = await fetch(`${base}/users`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'Eve', email: 'eve@example.com', id: 999, admin: true }) });
    const user = (await ok.json()) as Record<string, unknown>;
    assert.equal(ok.status, 201);
    assert.notEqual(user.id, 999);
    assert.equal(user.admin, undefined);

    assert.equal((await fetch(`${base}/users`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'hi' })).status, 415);
  });

  test('security headers and a per-request CSP nonce on pages', async () => {
    const res = await fetch(`${base}/people`, { headers: html });
    const page = await res.text();
    for (const h of ['x-content-type-options', 'x-frame-options', 'referrer-policy', 'cross-origin-opener-policy', 'x-request-id']) {
      assert.ok(res.headers.get(h), `missing ${h}`);
    }
    const nonce = /'nonce-([^']+)'/.exec(res.headers.get('content-security-policy') ?? '')?.[1];
    assert.ok(nonce, 'CSP header with nonce');
    const scripts = [...page.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/g)].map((m) => m[0]);
    assert.ok(scripts.length > 0);
    for (const s of scripts) assert.ok(s.includes(`nonce="${nonce}"`), `inline script without nonce: ${s}`);
    const second = await fetch(`${base}/people`, { headers: html });
    assert.notEqual(/'nonce-([^']+)'/.exec(second.headers.get('content-security-policy')!)![1], nonce, 'nonce is per request');
    assert.equal(res.headers.get('x-request-id')?.length, 36);
    const traced = await fetch(`${base}/users`, { headers: { 'x-request-id': 'trace-123' } });
    assert.equal(traced.headers.get('x-request-id'), 'trace-123');
  });

  test('encrypted cookie sessions persist across requests', async () => {
    const first = await fetch(`${base}/people/1`, { headers: html });
    const cookie = first.headers.get('set-cookie') ?? '';
    assert.match(cookie, /^amoxi_session=[\w-]+; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Lax/);
    assert.ok(!cookie.includes('Ada'), 'session contents are encrypted');
    const jar = cookie.split(';')[0];
    const page = await (await fetch(`${base}/people/2`, { headers: { ...html, cookie: jar } })).text();
    assert.match(page, /Recently viewed.*Ada Larkwhistle/s);
    const tampered = jar.slice(0, -4) + 'AAAA';
    const fresh = await (await fetch(`${base}/people/2`, { headers: { ...html, cookie: tampered } })).text();
    assert.ok(!fresh.includes('Recently viewed'), 'tampered cookies are ignored');
  });

  test('CSRF protection blocks cross-site cookie requests', async () => {
    const body = JSON.stringify({ name: 'Mallory', email: 'm@example.com' });
    const evil = await fetch(`${base}/users`, { method: 'POST', headers: { ...json, cookie: 'amoxi_session=x', origin: 'https://evil.example' }, body });
    assert.equal(evil.status, 403);
    const same = await fetch(`${base}/users`, { method: 'POST', headers: { ...json, cookie: 'amoxi_session=x', origin: base }, body });
    assert.equal(same.status, 201);
    const fetchMeta = await fetch(`${base}/users`, { method: 'POST', headers: { ...json, cookie: 'a=b', 'sec-fetch-site': 'cross-site' }, body });
    assert.equal(fetchMeta.status, 403);
  });

  test('compression: gzip for dynamic responses, precompressed brotli for static bundles', async () => {
    const res = await fetch(`${base}/people`, { headers: { ...html, 'accept-encoding': 'gzip, br' } });
    assert.equal(res.headers.get('content-encoding'), 'gzip', 'dynamic responses prefer fast gzip');
    const brOnly = await fetch(`${base}/people`, { headers: { ...html, 'accept-encoding': 'br' } });
    assert.equal(brOnly.headers.get('content-encoding'), 'br');
    const page = await (await fetch(`${base}/people`, { headers: html })).text();
    const css = /href="(\/_amoxi\/app-[A-Z0-9]+\.css)"/.exec(page)![1];
    const asset = await fetch(`${base}${css}`, { headers: { 'accept-encoding': 'br' } });
    assert.equal(asset.headers.get('content-encoding'), 'br');
    assert.match(asset.headers.get('cache-control')!, /immutable/);
  });

  test('405 with Allow, HEAD support, 413 body limit', async () => {
    const put = await fetch(`${base}/users`, { method: 'PUT' });
    assert.equal(put.status, 405);
    assert.match(put.headers.get('allow')!, /GET.*POST.*HEAD/);
    const head = await fetch(`${base}/users/1`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    const big = await fetch(`${base}/users`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'x'.repeat(2_000_000), email: 'a@example.com' }) });
    assert.equal(big.status, 413);
  });

  test('@Cached responses with revalidatePath on writes', async () => {
    responseCache.clear();
    const a = await fetch(`${base}/users`);
    assert.equal(a.headers.get('x-amoxi-cache'), 'MISS');
    const before = (await a.json()) as unknown[];
    const b = await fetch(`${base}/users`);
    assert.equal(b.headers.get('x-amoxi-cache'), 'HIT');
    assert.match(b.headers.get('cache-control')!, /s-maxage=30, stale-while-revalidate=60/);
    await fetch(`${base}/users`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'Cache Buster', email: 'cb@example.com' }) });
    const c = await fetch(`${base}/users`);
    assert.equal(c.headers.get('x-amoxi-cache'), 'MISS', 'revalidated after POST');
    assert.equal(((await c.json()) as unknown[]).length, before.length + 1);
  });

  test('cached pages get a fresh CSP nonce on every hit', async () => {
    const one = await fetch(`${base}/wiring`, { headers: html });
    const two = await fetch(`${base}/wiring`, { headers: html });
    assert.equal(two.headers.get('x-amoxi-cache'), 'HIT');
    const n1 = /'nonce-([^']+)'/.exec(one.headers.get('content-security-policy')!)![1];
    const n2 = /'nonce-([^']+)'/.exec(two.headers.get('content-security-policy')!)![1];
    assert.notEqual(n1, n2);
    const body = await two.text();
    assert.ok(body.includes(`nonce="${n2}"`) && !body.includes(`nonce="${n1}"`));
  });

  test('streaming SSR sends the page first and the slow section later', async () => {
    const res = await fetch(`${base}/status`, { headers: html });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value, { stream: true }));
    }
    const all = chunks.join('');
    assert.ok(chunks.length >= 2, 'response arrived in more than one chunk');
    assert.ok(chunks[0].includes('Running checks'), 'fallback is in the first chunk');
    assert.ok(!chunks[0].includes('Notification channels'), 'slow content is not in the first chunk');
    assert.match(all, /<template data-amoxi-for="ns\w+">.*Notification channels.*<\/template>/s);
    assert.ok(all.trimEnd().endsWith('</html>'));
  });

  test('error pages for HTML, JSON for APIs', async () => {
    const page = await fetch(`${base}/no-such-page`, { headers: html });
    assert.equal(page.status, 404);
    assert.match(await page.text(), /<h1>Page not found<\/h1>/);
    const api = await fetch(`${base}/no-such-page`);
    assert.equal(api.status, 404);
    assert.deepEqual(await api.json(), { error: 'Not Found' });
  });

  test('health endpoints', async () => {
    assert.deepEqual(await (await fetch(`${base}/amoxi/health/live`)).json(), { status: 'UP' });
    assert.deepEqual(await (await fetch(`${base}/amoxi/health/ready`)).json(), { status: 'UP' });
  });
});

describe('production profile', () => {
  test('500 page hides details and shows the request id; JSON hides the stack', async () => {
    const broken = { list: () => { throw new Error('database password is hunter2'); }, get: () => undefined };
    const { app, base } = await start({}, [[UserService, broken]], 'production');
    try {
      const page = await fetch(`${base}/people`, { headers: html });
      assert.equal(page.status, 500);
      const text = await page.text();
      assert.match(text, /Something went wrong/);
      assert.ok(text.includes(page.headers.get('x-request-id')!));
      assert.ok(!text.includes('hunter2'));
      const api = await fetch(`${base}/users`);
      const body = (await api.json()) as Record<string, unknown>;
      assert.equal(api.status, 500);
      assert.deepEqual(Object.keys(body).sort(), ['error', 'requestId']);
      assert.equal(page.headers.get('strict-transport-security'), null, 'HSTS only over HTTPS');
    } finally {
      await app.close();
    }
  });

  test('sessions work in production with no configuration, shared by every instance of the build', async () => {
    responseCache.clear();
    const run = (extra: Record<string, unknown> = {}) =>
      AmoxiApplication.run(applicationModule, {
        config: Config.of({ server: { port: 0, host: '127.0.0.1' }, ...extra }, 'production'),
        silent: true,
        shutdownHook: false,
      });
    // Two instances of the same build, as behind a load balancer. No AMOXI_SESSION_SECRET anywhere.
    const [a, b] = await Promise.all([run(), run()]);
    try {
      assert.ok(applicationModule.sessionKey && /^[0-9a-f]{64}$/.test(applicationModule.sessionKey), 'amoxi build embedded a key');
      const first = await fetch(`http://127.0.0.1:${a.port}/people/1`, { headers: { accept: 'text/html' } });
      assert.equal(first.status, 200);
      const jar = (first.headers.get('set-cookie') ?? '').split(';')[0];
      assert.match(jar, /^amoxi_session=/);
      const onOther = await (await fetch(`http://127.0.0.1:${b.port}/people/2`, { headers: { accept: 'text/html', cookie: jar } })).text();
      assert.match(onOther, /Recently viewed.*Ada Larkwhistle/s, 'the other instance can read the session');
    } finally {
      await Promise.all([a.close(), b.close()]);
    }

    // An explicit secret (to stay logged in across deploys) replaces the build key.
    const c = await run({ amoxi: { session: { secret: 'x'.repeat(40) } } });
    try {
      const first = await fetch(`http://127.0.0.1:${c.port}/people/1`, { headers: { accept: 'text/html' } });
      const jar = (first.headers.get('set-cookie') ?? '').split(';')[0];
      const d = await run();
      try {
        const page = await (await fetch(`http://127.0.0.1:${d.port}/people/2`, { headers: { accept: 'text/html', cookie: jar } })).text();
        assert.doesNotMatch(page, /Recently viewed/, 'a cookie sealed with another key is ignored');
      } finally {
        await d.close();
      }
    } finally {
      await c.close();
    }
  });

  test('HSTS behind a TLS-terminating proxy', async () => {
    const { app, base } = await start({ server: { port: 0, host: '127.0.0.1', 'trust-proxy': true } }, [], 'production');
    try {
      const res = await fetch(`${base}/amoxi/health/live`, { headers: { 'x-forwarded-proto': 'https' } });
      assert.match(res.headers.get('strict-transport-security') ?? '', /max-age=31536000/);
    } finally {
      await app.close();
    }
  });

  test('CORS preflight for configured origins only', async () => {
    const { app, base } = await start({ server: { port: 0, host: '127.0.0.1', cors: { origins: 'https://app.example' } } });
    try {
      const ok = await fetch(`${base}/users`, { method: 'OPTIONS', headers: { origin: 'https://app.example', 'access-control-request-method': 'POST' } });
      assert.equal(ok.status, 204);
      assert.equal(ok.headers.get('access-control-allow-origin'), 'https://app.example');
      const no = await fetch(`${base}/users`, { method: 'OPTIONS', headers: { origin: 'https://other.example', 'access-control-request-method': 'POST' } });
      assert.equal(no.headers.get('access-control-allow-origin'), null);
    } finally {
      await app.close();
    }
  });

  test('graceful shutdown: readiness fails while draining, in-flight requests finish', async () => {
    const { app, base } = await start({ server: { port: 0, host: '127.0.0.1', 'shutdown-delay': 300 } });
    const inflight = fetch(`${base}/status`, { headers: html }).then((r) => r.text());
    await new Promise((r) => setTimeout(r, 50));
    const closing = app.close();
    const ready = await fetch(`${base}/amoxi/health/ready`);
    assert.equal(ready.status, 503);
    assert.match(await inflight, /Notification channels/, 'streamed request completed during drain');
    await closing;
  });
});

test('brotli body decodes to the same page', async () => {
  const { app, base } = await start();
  try {
    const res = await fetch(`${base}/amoxi/info`, { headers: { 'accept-encoding': 'identity' } });
    assert.equal(res.headers.get('content-encoding'), null);
    const raw = await import('node:http').then(
      (http) =>
        new Promise<Buffer>((resolve) => {
          http.get(`${base}/people`, { headers: { 'accept-encoding': 'br', accept: 'text/html' } }, (r) => {
            const parts: Buffer[] = [];
            r.on('data', (c: Buffer) => parts.push(c)).on('end', () => resolve(Buffer.concat(parts)));
          });
        }),
    );
    assert.match(brotliDecompressSync(raw).toString(), /<h1>People<\/h1>/);
  } finally {
    await app.close();
  }
});

test('.env files load like Next.js, and real environment variables win', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'amoxi-env-'));
  writeFileSync(join(dir, '.env'), 'APP_NAME=from-env\nUSERS_MAXCOUNT=10\nSERVER_PORT=1111\n');
  writeFileSync(join(dir, '.env.local'), 'USERS_MAXCOUNT=20\n');
  writeFileSync(join(dir, '.env.production'), 'APP_NAME=from-production\n');
  const dev = Config.load({ cwd: dir, env: {}, argv: [], profile: 'development' });
  assert.equal(dev.string('app.name'), 'from-env');
  assert.equal(dev.number('users.max-count'), 20, '.env.local overrides .env');
  const prod = Config.load({ cwd: dir, env: { SERVER_PORT: '2222' }, argv: [], profile: 'production' });
  assert.equal(prod.string('app.name'), 'from-production');
  assert.equal(prod.number('server.port'), 2222, 'real environment beats .env files');
  const testProfile = Config.load({ cwd: dir, env: {}, argv: [], profile: 'test' });
  assert.equal(testProfile.number('users.max-count'), 10, '.env.local is ignored in tests');
});
