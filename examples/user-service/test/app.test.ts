import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Config, AmoxiApplication, createContext } from 'amoxi';
import { applicationModule } from '../src/generated/amoxi.generated';
import { EmailNotifier } from '../src/notification/email-notifier';
import type { Notifier } from '../src/notification/notifier';
import { UserService } from '../src/service/user-service';

test('wires the full graph from generated code (no reflection)', () => {
  const ctx = createContext(applicationModule, { config: Config.of({ users: { 'max-count': 3 } }) });
  const service = ctx.getBean(UserService);

  // Resolving UserService lazily created its dependency chain, including the repository's @PostConstruct seed.
  assert.equal(service.list().length, 2);
  assert.equal(ctx.getBean(UserService), service, 'singletons are shared');

  service.register({ name: 'Lina', email: 'lina@example.com' });
  assert.throws(() => service.register({ name: 'Too many', email: 'x@example.com' }), /limit of 3/);
});

test('collection and qualified injection', () => {
  const ctx = createContext(applicationModule, { config: Config.of({}) });
  const all = ctx.getBeansOfType<Notifier>('Notifier');
  assert.deepEqual(all.map((n) => n.channel).sort(), ['email', 'log']);
  assert.equal(ctx.getBean<Notifier>('Notifier', 'email').channel, 'email');
  assert.throws(() => ctx.getBean<Notifier>('Notifier'), /Multiple beans/);
});

test('@Value defaults and configuration overrides', () => {
  const ctx = createContext(applicationModule, { config: Config.of({ notifications: { email: { from: 'qa@test' } } }) });
  const email = ctx.getBean(EmailNotifier);
  email.notify('hi');
  assert.equal(email.outbox[0], '[from qa@test] hi');
});

test('beans can be replaced for tests', () => {
  const sent: string[] = [];
  const fake: Notifier = { channel: 'fake', notify: (m) => sent.push(m) };
  const ctx = createContext(applicationModule, { config: Config.of({}), overrides: [['Notifier', fake]] });
  ctx.getBean(UserService).register({ name: 'Mock', email: 'mock@example.com' });
  assert.ok(sent.some((m) => m.includes('Welcome aboard, Mock')));
});

test('HTTP end to end', async () => {
  const app = await AmoxiApplication.run(applicationModule, {
    config: Config.of({ server: { port: 0, host: '127.0.0.1' } }),
    silent: true,
    shutdownHook: false,
  });
  const base = `http://127.0.0.1:${app.port}`;
  try {
    const one = await fetch(`${base}/users/1`);
    assert.equal(one.status, 200);
    assert.equal(((await one.json()) as { name: string }).name, 'Ada Larkwhistle');

    assert.equal((await fetch(`${base}/users/abc`)).status, 400, 'path param coerced to number');
    assert.equal((await fetch(`${base}/users/999`)).status, 404);
    assert.equal(((await (await fetch(`${base}/users?limit=1`)).json()) as unknown[]).length, 1);

    const created = await fetch(`${base}/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Margaret Hartwindle', email: 'margaret@example.com' }),
    });
    assert.equal(created.status, 201);
    assert.equal(created.headers.get('location'), '/users/3');

    const health = (await (await fetch(`${base}/health`, { headers: { 'user-agent': 'test' } })).json()) as Record<string, unknown>;
    assert.equal(health.status, 'UP');
    assert.equal(health.agent, 'test');
    assert.ok(app.startupMs < 100, `framework startup took ${app.startupMs}ms`);
  } finally {
    await app.close();
  }
});

test('static UI, management endpoints and path-traversal protection', async () => {
  const app = await AmoxiApplication.run(applicationModule, {
    config: Config.of({ server: { port: 0, host: '127.0.0.1', 'static-dir': 'public' }, amoxi: { management: { enabled: true } } }),
    silent: true,
    shutdownHook: false,
  });
  const base = `http://127.0.0.1:${app.port}`;
  try {
    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type') ?? '', /text\/html/);
    assert.equal((await fetch(`${base}/icon.svg`)).headers.get('content-type'), 'image/svg+xml');

    const etag = (await fetch(`${base}/icon.svg`)).headers.get('etag')!;
    assert.equal((await fetch(`${base}/icon.svg`, { headers: { 'if-none-match': etag } })).status, 304);

    for (const evil of ['/..%2f..%2fpackage.json', '/%5c..%5capplication.json', '/C:%2fWindows%2fwin.ini', '/.env', '/%00']) {
      assert.equal((await fetch(`${base}${evil}`)).status, 404, `must not serve ${evil}`);
    }

    const beans = (await (await fetch(`${base}/amoxi/beans`)).json()) as Array<{ name: string; dependencies: number[] }>;
    const svc = beans.find((b) => b.name === 'NotificationService')!;
    // SlackNotifier is a candidate too (its @Requires condition is evaluated at startup).
    assert.deepEqual(svc.dependencies.map((d) => beans[d].name).sort(), ['EmailNotifier', 'LogNotifier', 'SlackNotifier']);
    const info = (await (await fetch(`${base}/amoxi/info`)).json()) as { status: string; beans: { total: number } };
    assert.equal(info.status, 'UP');
    assert.equal(info.beans.total, beans.length);

    assert.equal((await fetch(`${base}/users/1`, { method: 'DELETE' })).status, 204);
    assert.equal((await fetch(`${base}/users/1`, { method: 'DELETE' })).status, 404);
    const bad = await fetch(`${base}/users`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"A","email":"nope"}' });
    assert.equal(bad.status, 400);
  } finally {
    await app.close();
  }
});

test('management endpoints are off unless enabled', async () => {
  const app = await AmoxiApplication.run(applicationModule, {
    config: Config.of({ server: { port: 0, host: '127.0.0.1' } }),
    silent: true,
    shutdownHook: false,
  });
  try {
    assert.equal((await fetch(`http://127.0.0.1:${app.port}/amoxi/info`)).status, 404);
  } finally {
    await app.close();
  }
});

test('server-rendered pages with islands and middleware', async () => {
  const app = await AmoxiApplication.run(applicationModule, {
    config: Config.of({ server: { port: 0, host: '127.0.0.1', 'static-dir': 'public' } }),
    silent: true,
    shutdownHook: false,
  });
  const base = `http://127.0.0.1:${app.port}`;
  try {
    const res = await fetch(`${base}/people/2`);
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /<h2 id="person-name">Grace Hollowmere<\/h2>/, 'content is in the HTML, no JavaScript needed');
    assert.match(res.headers.get('server-timing') ?? '', /^app;dur=/, '@Middleware ran');

    // Only the islands this page uses are loaded, from content-hashed bundles.
    const used = [...html.matchAll(/<amoxi-island data-c="(\w+)"/g)].map((m) => m[1]).sort();
    assert.deepEqual(used, ['AddPerson', 'AvatarUpload', 'DeletePerson', 'LiveActivity', 'PeopleList', 'ThemeToggle']);
    assert.ok(!html.includes('WiringDiagram'));
    const bundle = /import\{start\}from"([^"]+)"/.exec(html)![1];
    const js = await fetch(`${base}${bundle}`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('cache-control') ?? '', /immutable/);

    // Untrusted text is escaped, including inside island props.
    await fetch(`${base}/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '<script>alert(1)</script>', email: 'x@example.com' }),
    });
    const list = await (await fetch(`${base}/people`)).text();
    assert.ok(!list.includes('<script>alert(1)</script>'));
    assert.ok(list.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));

    assert.equal((await fetch(`${base}/people/999`)).status, 404, 'withStatus(404, page)');
    const home = await fetch(`${base}/`, { redirect: 'manual' });
    assert.equal(home.status, 302);
    assert.equal(home.headers.get('location'), '/people');
  } finally {
    await app.close();
  }
});
