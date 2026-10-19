import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import {
  ApplicationContext,
  Config,
  AmoxiApplication,
  createContext,
  formatMessage,
  negotiateLocale,
  parseMultipart,
  responseCache,
  sanitizeFilename,
  type ApplicationModule,
  type RunningApplication,
} from 'amoxi';
import { applicationModule } from '../src/generated/amoxi.generated';
import type { Notifier } from '../src/notification/notifier';
import { NotificationService } from '../src/notification/notification-service';
import { UserService } from '../src/service/user-service';

const SECRET = 'test-secret-that-is-at-least-32-characters-long';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake image body')]);

async function start(extra: Record<string, unknown> = {}, profile = 'test'): Promise<{ app: RunningApplication; base: string; avatars: string }> {
  responseCache.clear();
  const avatars = mkdtempSync(join(tmpdir(), 'amoxi-avatars-'));
  const app = await AmoxiApplication.run(applicationModule, {
    config: Config.of({ server: { port: 0, host: '127.0.0.1', 'static-dir': 'public' }, amoxi: { session: { secret: SECRET } }, avatars: { dir: avatars }, ...extra }, profile),
    silent: true,
    shutdownHook: false,
  });
  return { app, base: `http://127.0.0.1:${app.port}`, avatars };
}

describe('@Requires (conditional beans)', () => {
  test('SlackNotifier exists only when its webhook is configured', () => {
    const off = createContext(applicationModule, { config: Config.of({}) });
    assert.deepEqual(off.getBeansOfType<Notifier>('Notifier').map((n) => n.channel).sort(), ['email', 'log']);
    assert.throws(() => off.getBean('SlackNotifier'), /No bean/);

    const on = createContext(applicationModule, { config: Config.of({ notifications: { slack: { webhook: 'https://hooks.example/x' } } }) });
    const channels = on.getBean(NotificationService).broadcast('hi');
    assert.deepEqual(channels.sort(), ['email', 'log', 'slack']);
  });

  test('alternatives: one conditional candidate wins, an unconditional bean is the default, failures surface at startup', () => {
    const def = (id: number, name: string, extra: object = {}) => ({ id, name, scope: 'singleton' as const, eager: false, primary: false, types: ['Mailer', name], create: () => ({ name }), ...extra });
    const module: ApplicationModule = {
      beans: [
        def(0, 'SmtpMailer', { condition: (c: Config) => c.has('mail.smtp') }),
        def(1, 'SesMailer', { condition: (c: Config) => c.has('mail.ses') }),
        def(2, 'LogMailer'),
        { id: 3, name: 'Signup', scope: 'singleton', eager: false, primary: false, types: ['Signup'], needs: [[0, 1, 2]], create: (r) => ({ mailer: r.pick([0, 1, 2]) }) },
      ],
      typeIndex: {},
      routes: [],
      buildInfo: { generatedAt: '', compilerVersion: '' },
    };
    const mailerOf = (cfg: Record<string, unknown>) => (new ApplicationContext(module, Config.of(cfg)).get(3) as { mailer: { name: string } }).mailer.name;
    assert.equal(mailerOf({}), 'LogMailer', 'unconditional default');
    assert.equal(mailerOf({ mail: { smtp: 'x' } }), 'SmtpMailer');
    assert.throws(() => new ApplicationContext(module, Config.of({ mail: { smtp: 'x', ses: 'y' } })), /several enabled candidates: SmtpMailer, SesMailer/);
    // Bean ids are array positions, so switch the default off instead of removing it.
    const noDefault: ApplicationModule = { ...module, beans: module.beans.map((b) => (b.id === 2 ? { ...b, condition: () => false } : b)) };
    assert.throws(() => new ApplicationContext(noDefault, Config.of({})), /disabled all of them/);
  });
});

describe('request scope, Provider<T> and AOP interceptors', () => {
  let app: RunningApplication;
  let base: string;
  before(async () => ({ app, base } = await start()));
  after(() => app.close());

  test('intercepted methods are timed into a per-request bean and reported in Server-Timing', async () => {
    const res = await fetch(`${base}/users/1`);
    const timing = res.headers.get('server-timing') ?? '';
    assert.match(timing, /^app;dur=[\d.]+, UserService\.get;dur=[\d.]+$/);
  });

  test('concurrent requests get their own request-scoped instance', async () => {
    const [a, b] = await Promise.all([fetch(`${base}/users/1`), fetch(`${base}/people`, { headers: { accept: 'text/html' } })]);
    const ta = a.headers.get('server-timing')!;
    const tb = b.headers.get('server-timing')!;
    assert.ok(ta.includes('UserService.get') && !ta.includes('UserService.list'), ta);
    assert.ok(tb.includes('UserService.list') && !tb.includes('UserService.get;'), tb);
  });

  test('outside a request the interceptor still works (Provider.getIfAvailable returns undefined)', () => {
    const ctx = createContext(applicationModule, { config: Config.of({ avatars: { dir: mkdtempSync(join(tmpdir(), 'amoxi-a-')) } }) });
    assert.equal(ctx.getBean(UserService).list().length, 2);
    assert.throws(() => ctx.getBean('RequestTimings'), /outside an HTTP request/);
  });
});

describe('WebSockets', () => {
  let app: RunningApplication;
  let base: string;
  before(async () => ({ app, base } = await start()));
  after(() => app.close());

  test('clients receive history and live events', async () => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/activity`);
    const messages: Array<{ type: string; event?: { kind: string; name: string } }> = [];
    const next = (n: number) =>
      new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timed out waiting for message ${n}`)), 3000);
        const check = () => (messages.length >= n ? (clearTimeout(t), resolve()) : setTimeout(check, 10));
        check();
      });
    ws.onmessage = (e) => messages.push(JSON.parse(String(e.data)));
    await next(1);
    assert.equal(messages[0].type, 'history');

    await fetch(`${base}/users`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Live Person', email: 'live@example.com' }) });
    await next(2);
    assert.deepEqual({ type: messages[1].type, kind: messages[1].event?.kind, name: messages[1].event?.name }, { type: 'event', kind: 'added', name: 'Live Person' });

    ws.send('ping');
    await next(3);
    assert.equal(messages[2].type, 'pong');
    ws.close();
  });

  test('cross-site WebSocket connections and unknown paths are refused', async () => {
    const handshake = (path: string, origin?: string) =>
      new Promise<number>((resolve) => {
        const req = request(`${base}${path}`, {
          headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', ...(origin ? { origin } : {}) },
        });
        req.on('upgrade', (res, socket) => {
          socket.destroy();
          resolve(res.statusCode ?? 0);
        });
        req.on('response', (res) => resolve(res.statusCode ?? 0));
        req.end();
      });
    assert.equal(await handshake('/ws/activity', 'https://evil.example'), 403);
    assert.equal(await handshake('/ws/nope'), 404);
    assert.equal(await handshake('/ws/activity', base), 101);
  });
});

describe('file uploads (multipart)', () => {
  let app: RunningApplication;
  let base: string;
  let avatars: string;
  before(async () => ({ app, base, avatars } = await start({ server: { port: 0, host: '127.0.0.1', upload: { 'max-file-size': 4096 } } })));
  after(() => app.close());

  const upload = (data: Buffer, name = 'me.png') => {
    const form = new FormData();
    form.append('avatar', new Blob([new Uint8Array(data)]), name);
    return fetch(`${base}/users/1/avatar`, { method: 'POST', body: form });
  };

  test('an image is stored by its real type and served back', async () => {
    const res = await upload(PNG, '../../etc/passwd.png');
    assert.equal(res.status, 201);
    const got = await fetch(`${base}/users/1/avatar`);
    assert.equal(got.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), PNG);
    assert.deepEqual(readdirSync(avatars), ['1.png'], 'stored under our own name, not the client-supplied path');
  });

  test('non-images, oversized files and wrong content types are rejected', async () => {
    assert.equal((await upload(Buffer.from('<script>alert(1)</script>'), 'x.png')).status, 415);
    assert.equal((await upload(Buffer.alloc(5000, 1))).status, 413);
    assert.equal((await fetch(`${base}/users/1/avatar`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 415);
  });

  test('the parser handles parts split across arbitrary chunk boundaries', async () => {
    const boundary = 'XyZ';
    const body = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\nHello world\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="doc"; filename="a\\\\b/notes.txt"\r\nContent-Type: text/plain\r\n\r\nline1\r\n--not-a-boundary\r\nline2\r\n` +
        `--${boundary}--\r\n`,
    );
    const chunks = [...body].map((b) => Buffer.from([b])); // one byte at a time
    const req = Object.assign(Readable.from(chunks), { headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } });
    const { form, cleanup } = await parseMultipart(req as never, { maxFileSize: 1e6, maxFiles: 5, maxFields: 5, maxFieldSize: 1e4 });
    assert.equal(form.fields.title, 'Hello world');
    const file = form.file('doc')!;
    assert.equal(file.filename, 'notes.txt');
    assert.equal((await file.read()).toString(), 'line1\r\n--not-a-boundary\r\nline2');
    await cleanup();
    assert.equal(existsSync(file.path), false, 'temp file removed');
    assert.equal(sanitizeFilename('..\\..\\Windows\\win.ini'), 'win.ini');
  });
});

describe('i18n', () => {
  let app: RunningApplication;
  let base: string;
  before(async () => ({ app, base } = await start()));
  after(() => app.close());

  test('locale from Accept-Language, ?lang= remembered in a cookie', async () => {
    const fr = await (await fetch(`${base}/people`, { headers: { accept: 'text/html', 'accept-language': 'fr-CA,fr;q=0.9,en;q=0.5' } })).text();
    assert.match(fr, /<html lang="fr">/);
    assert.match(fr, /<h1>Personnes<\/h1>/);
    assert.match(fr, /2 personnes, gardées en mémoire/);

    const switched = await fetch(`${base}/people?lang=en`, { headers: { accept: 'text/html', 'accept-language': 'fr' } });
    assert.match(await switched.text(), /<h1>People<\/h1>/);
    const cookie = (switched.headers.get('set-cookie') ?? '').split(', ').find((c) => c.startsWith('amoxi_locale='))!;
    assert.match(cookie, /^amoxi_locale=en;/);
    const remembered = await (await fetch(`${base}/people`, { headers: { accept: 'text/html', 'accept-language': 'fr', cookie: cookie.split(';')[0] } })).text();
    assert.match(remembered, /<h1>People<\/h1>/);
  });

  test('plurals and negotiation', () => {
    const msg = '{n, plural, =0 {none} one {# item} other {# items}}';
    assert.equal(formatMessage(msg, { n: 0 }, 'en'), 'none');
    assert.equal(formatMessage(msg, { n: 1 }, 'en'), '1 item');
    assert.equal(formatMessage(msg, { n: 1234 }, 'en'), '1,234 items');
    assert.equal(formatMessage(msg, { n: 1234 }, 'fr'), '1\u202f234 items');
    assert.equal(negotiateLocale('de, fr;q=0.8', ['en', 'fr'], 'en'), 'fr');
    assert.equal(negotiateLocale('de', ['en', 'fr'], 'en'), 'en');
  });
});

describe('OpenAPI', () => {
  test('generated from routes and types, served outside production', async () => {
    const { app, base } = await start();
    try {
      const doc = (await (await fetch(`${base}/amoxi/openapi.json`)).json()) as any;
      assert.equal(doc.openapi, '3.1.0');
      assert.ok(doc.paths['/users/{id}'].get);
      assert.equal(doc.paths['/users'].post.requestBody.content['application/json'].schema.$ref, '#/components/schemas/NewUser');
      assert.deepEqual(doc.components.schemas.NewUser.properties.email, { type: 'string', maxLength: 254, format: 'email' });
      assert.equal(doc.paths['/users/{id}/avatar'].post.summary, 'Upload a profile photo.');
      assert.ok(doc.paths['/users/{id}/avatar'].post.requestBody.content['multipart/form-data']);
      assert.equal(doc.paths['/people'], undefined, 'HTML pages are not API operations');
    } finally {
      await app.close();
    }
    const prod = await start({}, 'production');
    try {
      assert.equal((await fetch(`${prod.base}/amoxi/openapi.json`)).status, 404);
    } finally {
      await prod.app.close();
    }
  });
});

describe('static export', () => {
  test('amoxi export renders reachable pages to static HTML', () => {
    const out = mkdtempSync(join(tmpdir(), 'amoxi-out-'));
    const cli = require.resolve('amoxi/bin/amoxi.js');
    const res = spawnSync(process.execPath, [cli, 'export', '--out-dir', out], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, AMOXI_ENV: 'development' } });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    for (const f of ['index.html', 'people/index.html', 'people/1/index.html', 'people/2/index.html', 'wiring/index.html', 'status/index.html', '404.html']) {
      assert.ok(existsSync(join(out, f)), `missing ${f}`);
    }
    const status = readFileSync(join(out, 'status/index.html'), 'utf8');
    assert.match(status, /Notification channels/, 'streamed section is inlined');
    assert.ok(!status.includes('data-amoxi-for') && !status.includes('nonce='), 'no streaming templates or CSP nonces');
    assert.match(readFileSync(join(out, 'index.html'), 'utf8'), /http-equiv="refresh" content="0; url=\/people"/);
    assert.ok(readdirSync(join(out, '_amoxi')).some((f) => f.startsWith('hydrate-')), 'island bundles copied');
    // The report explains what a static copy can't do, like any static export.
    assert.match(res.stdout, /\/people\/1, \/people\/2: read the session/);
    assert.match(res.stdout, /read query parameters/);
    assert.match(res.stdout, /chose a language per visitor/);
    assert.match(res.stdout, /API routes: .*POST \/users\/:id\/avatar \(upload\)/);
    assert.match(res.stdout, /WebSockets: \/ws\/activity/);
    assert.doesNotMatch(res.stdout, /\/wiring[^\n]*read the session/, 'pages that do not use the session are not listed');
    rmSync(out, { recursive: true, force: true });
  });

  test('--strict fails and leaves no output when pages depend on the request', () => {
    const out = join(tmpdir(), `amoxi-strict-${process.pid}`);
    const cli = require.resolve('amoxi/bin/amoxi.js');
    const res = spawnSync(process.execPath, [cli, 'export', '--out-dir', out, '--strict'], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, AMOXI_ENV: 'development' } });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /Export failed \(--strict\)/);
    assert.equal(existsSync(out), false);
  });
});

describe('port check', () => {
  test('a busy port moves to the next one in development and fails clearly otherwise', async () => {
    const { createServer } = await import('node:net');
    const { choosePort, PortInUseError } = await import('amoxi');
    const other = createServer();
    await new Promise<void>((r) => other.listen(0, '127.0.0.1', () => r()));
    const busy = (other.address() as { port: number }).port;
    try {
      const next = await choosePort(busy, '0.0.0.0', true);
      assert.ok(next > busy && next < busy + 10);
      await assert.rejects(choosePort(busy, '0.0.0.0', false), (e: unknown) => e instanceof PortInUseError && /already in use/.test((e as Error).message));
    } finally {
      other.close();
    }
  });
});

describe('React islands', () => {
  test('server-rendered with react-dom/server, hydrated with React only where used', async () => {
    const { app, base } = await start();
    try {
      const status = await (await fetch(`${base}/status`, { headers: { accept: 'text/html' } })).text();
      // react-colorful's markup, rendered by React on the server inside the island element.
      assert.match(status, /<amoxi-island data-c="AccentPicker"[^>]*><div class="accent-picker"><div class="react-colorful/);
      assert.match(status, /"AccentPicker":"\/_amoxi\/AccentPicker\.react-[A-Z0-9]+\.js"/);
      const bundle = /"AccentPicker":"([^"]+)"/.exec(status)![1];
      const js = await (await fetch(`${base}${bundle}`)).text();
      assert.match(js, /hydrateRoot/, 'the browser bundle hydrates with React');

      const people = await (await fetch(`${base}/people`, { headers: { accept: 'text/html' } })).text();
      assert.ok(!people.includes('AccentPicker'), 'pages without React islands never reference React');
    } finally {
      await app.close();
    }
  });
});
