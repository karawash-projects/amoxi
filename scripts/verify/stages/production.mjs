// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import * as path from 'node:path';
import { APPS, loadModule, pagePaths, signIn, startArgs } from '../lib/apps.mjs';
import { Client } from '../lib/http.mjs';
import { freePort } from '../lib/proc.mjs';

/** Starts an app in production (cluster) with throw-away storage. Shared by several stages. */
export async function startProduction(ctx, app, { workers = app.workers ?? 1, env = {}, cluster = true } = {}) {
  const port = await freePort();
  const server = await ctx.server(app.id, startArgs(ctx.root, app, { workers, cluster }), {
    cwd: path.join(ctx.root, app.dir),
    env: { NODE_ENV: 'production', SERVER_PORT: String(port), AI_STORE_DIR: ctx.tmp(`amoxi-${app.id}-data-`), ...(app.env ?? {}), ...env },
    readyUrl: `http://127.0.0.1:${port}/amoxi/health/ready`,
    timeoutMs: 45_000,
  });
  return { server, port, base: `http://127.0.0.1:${port}` };
}

const SECURITY_HEADERS = { 'x-content-type-options': ['nosniff'], 'x-frame-options': ['DENY', 'SAMEORIGIN'], 'referrer-policy': ['strict-origin-when-cross-origin', 'no-referrer', 'same-origin', 'strict-origin'] };

/** Text a page should never show: values that leaked into markup by mistake. */
const RENDER_BUGS = [/>\s*undefined\s*</, /\[object Object\]/, />\s*NaN\s*</, /\bInvalid Date\b/, />\s*null\s*</];

export const production = {
  id: 'production',
  title: 'Production smoke test',
  description: 'every app under amoxi start (cluster mode): pages, headers, errors, representations, clean shutdown',
  quick: true,
  needs: ['build'],
  async run(ctx) {
    const startups = {};
    for (const app of APPS) {
      const module = loadModule(ctx.root, app);
      const started = await ctx.check(`${app.id}: starts in production (amoxi start, ${app.workers ?? 1} worker${app.workers > 1 ? 's' : ''})`, () => startProduction(ctx, app));
      if (!started) continue;
      const { server, base } = started;
      const c = new Client(base);
      await signIn(c, app);

      await ctx.check(`${app.id}: liveness and readiness probes answer UP`, async () => {
        for (const p of ['/amoxi/health/live', '/amoxi/health/ready']) {
          const { res, data } = await c.json(p);
          ctx.assert.equal(res.status, 200);
          ctx.assert.equal(data?.status, 'UP');
          ctx.assert.equal(res.headers.get('cache-control'), 'no-store');
        }
      });

      const pages = pagePaths(module);
      await ctx.check(`${app.id}: all ${pages.length} pages render with security headers, a nonce CSP and no render bugs`, async () => {
        const problems = [];
        for (const p of pages) {
          const { res, text } = await c.text(p, { headers: { accept: 'text/html' } });
          if (res.status >= 300 && res.status < 400) continue; // e.g. a page that needs sign-in
          if (res.status !== 200) {
            problems.push(`${p}: status ${res.status}`);
            continue;
          }
          if (!/text\/html/.test(res.headers.get('content-type') ?? '')) problems.push(`${p}: content-type ${res.headers.get('content-type')}`);
          for (const [h, allowed] of Object.entries(SECURITY_HEADERS)) if (!allowed.includes(res.headers.get(h) ?? '')) problems.push(`${p}: ${h} is ${res.headers.get(h)}`);
          if (res.headers.get('x-powered-by')) problems.push(`${p}: x-powered-by leaks the server`);
          const csp = res.headers.get('content-security-policy') ?? '';
          const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
          if (!nonce || /'unsafe-inline'[^;]*script|script-src[^;]*'unsafe-eval'/.test(csp)) problems.push(`${p}: weak or missing CSP: ${csp}`);
          for (const m of text.matchAll(/<script\b([^>]*)>/g)) if (!/\bsrc=/.test(m[1]) && !m[1].includes(`nonce="${nonce}"`)) problems.push(`${p}: inline script without the request nonce`);
          if (!/<html[^>]* lang="[a-z]{2}/.test(text)) problems.push(`${p}: <html> has no lang`);
          if (!/<title>[^<]+<\/title>/.test(text)) problems.push(`${p}: no <title>`);
          // Code samples (the documentation page) may show these words on purpose.
          const visible = text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<pre[\s\S]*?<\/pre>|<code[^>]*>[\s\S]*?<\/code>/g, '');
          for (const re of RENDER_BUGS) if (re.test(visible)) problems.push(`${p}: renders ${re}`);
        }
        ctx.assert.deepEqual(problems, []);
      });

      await ctx.check(`${app.id}: large responses are compressed, HEAD has no body`, async () => {
        const home = pages.includes('/') ? '/' : pages[0];
        const res = await fetch(base + home, { headers: { accept: 'text/html', 'accept-encoding': 'gzip', cookie: c.cookieHeader() }, redirect: 'manual' });
        const len = (await res.arrayBuffer()).byteLength;
        if (res.status === 200 && len > 1024) ctx.assert.equal(res.headers.get('content-encoding'), 'gzip');
        const head = await fetch(base + home, { method: 'HEAD', headers: { accept: 'text/html', cookie: c.cookieHeader() }, redirect: 'manual' });
        ctx.assert.equal((await head.arrayBuffer()).byteLength, 0);
      });

      await ctx.check(`${app.id}: browser bundles are served immutable and precompressed`, async () => {
        const { text } = await c.text(pages.includes('/') ? '/' : pages[0], { headers: { accept: 'text/html' }, redirect: 'follow' });
        const asset = /(?:href|src)="(\/_amoxi\/[^"]+\.(?:js|css))"/.exec(text)?.[1];
        if (!asset) return ctx.note(`${app.id}: no bundled assets on the first page`);
        const res = await fetch(base + asset, { headers: { 'accept-encoding': 'br, gzip' } });
        await res.arrayBuffer();
        ctx.assert.equal(res.status, 200);
        ctx.assert.match(res.headers.get('cache-control') ?? '', /immutable/);
        ctx.assert.ok(['br', 'gzip'].includes(res.headers.get('content-encoding') ?? ''), `content-encoding ${res.headers.get('content-encoding')}`);
      });

      await ctx.check(`${app.id}: unknown URLs give a 404 page (HTML) or JSON without internals`, async () => {
        const html = await c.text('/definitely-not-here-404', { headers: { accept: 'text/html' } });
        ctx.assert.equal(html.res.status, 404);
        ctx.assert.match(html.res.headers.get('content-type') ?? '', /text\/html/);
        const json = await c.json('/definitely-not-here-404', { headers: { accept: 'application/json' } });
        ctx.assert.equal(json.res.status, 404);
        ctx.assert.ok(!/stack|at \w+ \(|node_modules|\/src\//.test(json.text), `404 body leaks internals: ${json.text}`);
      });

      await ctx.check(`${app.id}: /llms.txt and the markdown versions of pages are served`, async () => {
        const { res, text } = await c.text('/llms.txt');
        ctx.assert.equal(res.status, 200);
        ctx.assert.match(text, /^# .+/m);
        const page = pages.find((p) => p !== '/') ?? '/';
        const md = await c.text(page === '/' ? '/index.md' : `${page}.md`);
        if (md.res.status >= 300 && md.res.status < 400) return; // behind sign-in
        ctx.assert.equal(md.res.status, 200, `${page}.md: ${md.res.status}`);
        ctx.assert.match(md.res.headers.get('content-type') ?? '', /text\/markdown/);
        ctx.assert.ok(!/<script|<style|nonce=/.test(md.text), 'markdown contains markup');
      });

      await ctx.check(`${app.id}: development-only endpoints are off in production`, async () => {
        const openapi = await c.request('/amoxi/openapi.json');
        await openapi.arrayBuffer();
        ctx.assert.equal(openapi.status, 404, 'OpenAPI document is served in production (set amoxi.openapi.enabled explicitly if intended)');
        const dev = await c.request('/_amoxi/dev/events');
        await dev.arrayBuffer();
        ctx.assert.notEqual(dev.status, 200);
      });

      const exit = await ctx.check(`${app.id}: shuts down gracefully (exit 0, no errors logged)`, async () => {
        const result = await server.stop(20_000);
        ctx.assert.equal(result.code, 0, `exit ${result.code} ${result.signal ?? ''}`);
        const errors = server.log.split('\n').filter((l) => /"level":"error"|\bERROR\b|Unhandled|uncaught/i.test(l));
        ctx.assert.deepEqual(errors, []);
        return result;
      });
      const startup = [...server.log.matchAll(/"startupMs":([\d.]+)|framework: ([\d.]+)ms/g)].map((m) => Number(m[1] ?? m[2]));
      if (startup.length) startups[app.id] = Math.max(...startup);
      void exit;
    }
    ctx.shared.startups = startups;
    for (const [id, msValue] of Object.entries(startups)) ctx.metric(`${id} framework start-up (slowest worker)`, msValue.toFixed(1), 'ms', '< 250 ms');
    await ctx.check('framework start-up stays under 250 ms for every app', () => {
      const slow = Object.entries(startups).filter(([, v]) => v >= 250);
      ctx.assert.deepEqual(slow, []);
    });
  },
};
