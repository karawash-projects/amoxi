import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Config, AmoxiApplication, type RunningApplication } from 'amoxi';
import { SECTORS } from '../src/content/sectors';
import { applicationModule } from '../src/generated/amoxi.generated';

// Tests run from dist/test; the project root is two levels up.
const ROOT = resolve(__dirname, '..', '..');

let app: RunningApplication;
let base: string;

before(async () => {
  app = await AmoxiApplication.run(applicationModule, {
    config: Config.of({ server: { port: 0, host: '127.0.0.1', 'static-dir': join(ROOT, 'public') } }, 'test'),
    silent: true,
    shutdownHook: false,
  });
  base = `http://127.0.0.1:${app.port}`;
});

after(() => app.close());

const html = async (path: string): Promise<{ status: number; body: string; headers: Headers }> => {
  const res = await fetch(base + path, { headers: { accept: 'text/html' } });
  return { status: res.status, body: await res.text(), headers: res.headers };
};

describe('pages', () => {
  test('the home page presents every sector and links to its example page', async () => {
    const { status, body } = await html('/');
    assert.equal(status, 200);
    for (const s of SECTORS) {
      assert.match(body, new RegExp(s.brand));
      assert.match(body, new RegExp(`href="/examples/${s.slug}"`));
    }
    assert.match(body, /npx create-amoxi-app@latest my-app/);
  });

  test('each example page renders its screenshots viewer and feature table', async () => {
    for (const s of SECTORS) {
      const { status, body } = await html(`/examples/${s.slug}`);
      assert.equal(status, 200, s.slug);
      assert.match(body, /<amoxi-island data-c="ScreenshotViewer"/);
      for (const f of s.features) assert.ok(body.includes(f.feature.replace(/</g, '&lt;').replace(/>/g, '&gt;')), `${s.slug}: ${f.feature}`);
    }
  });

  test('an unknown example is a 404 page', async () => {
    const { status, body } = await html('/examples/aerospace');
    assert.equal(status, 404);
    assert.match(body, /This page doesn(&#39;|')t exist/);
  });

  test('pages are protected by a nonce-based Content Security Policy', async () => {
    const { headers, body } = await html('/');
    const csp = headers.get('content-security-policy') ?? '';
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    assert.ok(nonce, csp);
    for (const m of body.matchAll(/<script\b([^>]*)>/g)) assert.ok(m[1].includes(`nonce="${nonce}"`), m[1]);
  });
});

describe('documentation page', () => {
  test('covers every README section, without the table of contents', async () => {
    const readme = readFileSync(join(ROOT, '..', 'README.md'), 'utf8');
    const sections = [...readme.matchAll(/^## (.+)$/gm)].map((m) => m[1].replace(/`/g, '')).filter((t) => t !== 'Contents');
    const { status, body } = await html('/docs');
    assert.equal(status, 200);
    for (const title of sections) assert.ok(body.includes(`>${title.replace(/&/g, '&amp;')}</a>`), `missing from the contents: ${title}`);
    assert.doesNotMatch(body, /<h2 id="contents">/);
    assert.match(body, /<a href="\/docs" aria-current="page">/);
  });

  test("doesn't send readers to GitHub, and every in-page link has a target", async () => {
    const { body } = await html('/docs');
    const article = body.slice(body.indexOf('<article class="docs-body">'), body.indexOf('</article>'));
    assert.doesNotMatch(article, /github\.com/);
    const ids = new Set([...body.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]));
    const missing = [...body.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]).filter((id) => !ids.has(id));
    assert.deepEqual([...new Set(missing)], []);
  });
});

describe('links and files', () => {
  test('every internal link resolves and every image and font exists', async () => {
    const pages = ['/', '/docs', ...SECTORS.map((s) => `/examples/${s.slug}`)];
    const links = new Set<string>();
    for (const page of pages) {
      const { body } = await html(page);
      for (const m of body.matchAll(/href="(\/[^"#]*)/g)) links.add(m[1]);
      for (const m of body.matchAll(/src="(\/[^"]+)"/g)) links.add(m[1]);
    }
    for (const link of links) {
      const res = await fetch(base + link);
      assert.equal(res.status, 200, link);
      await res.arrayBuffer();
    }
  });

  test('both sizes of every screenshot are present', () => {
    for (const s of SECTORS) {
      for (const screen of s.screens) {
        for (const size of ['desktop', 'mobile']) {
          assert.ok(existsSync(join(ROOT, 'public', 'shots', `${screen.file}-${size}.jpg`)), `${screen.file}-${size}.jpg`);
        }
      }
    }
  });
});

describe('static export for GitHub Pages', () => {
  test('amoxi export --base-path prefixes every link, asset and island bundle', () => {
    const out = mkdtempSync(join(tmpdir(), 'amoxi-site-'));
    try {
      const cli = require.resolve('amoxi/bin/amoxi.js');
      const res = spawnSync(process.execPath, [cli, 'export', '--strict', '--base-path', '/amoxi', '--out-dir', out], { cwd: ROOT, encoding: 'utf8' });
      assert.equal(res.status, 0, res.stderr + res.stdout);

      const home = readFileSync(join(out, 'index.html'), 'utf8');
      assert.match(home, /<meta name="amoxi-base-path" content="\/amoxi">/);
      assert.match(home, /href="\/amoxi\/examples\/finance"/);
      assert.match(home, /"\/amoxi\/_amoxi\/CopyCommand-[A-Z0-9]+\.js"/);
      // No root-relative URL is left without the prefix.
      assert.deepEqual([...home.matchAll(/(?:href|src)="(\/(?!amoxi\/|\/)[^"]*)"/g)].map((m) => m[1]), []);

      for (const s of SECTORS) assert.ok(existsSync(join(out, 'examples', s.slug, 'index.html')), s.slug);
      assert.ok(existsSync(join(out, '404.html')));
      const css = readFileSync(join(out, ...(/href="\/amoxi\/(_amoxi\/[^"]+\.css)"/.exec(home)![1].split('/'))), 'utf8');
      assert.match(css, /url\(\/amoxi\/fonts\//);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
