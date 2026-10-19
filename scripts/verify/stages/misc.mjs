// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { run } from '../lib/proc.mjs';

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** Static export (`amoxi export`) with a base path, as GitHub Pages hosts the website. */
export const exportStage = {
  id: 'export',
  title: 'Static export',
  description: 'website and reference app exported to static files; every link and asset resolves',
  quick: true,
  needs: ['build'],
  async run(ctx) {
    const bin = path.join(ctx.root, 'packages', 'framework', 'bin', 'amoxi.js');
    for (const [id, dir, args] of [
      ['website', 'website', ['--strict', '--base-path', '/amoxi', '--site-url', 'https://example.github.io/amoxi']],
      ['user-service', 'examples/user-service', []],
    ]) {
      const out = ctx.tmp(`amoxi-export-${id}-`);
      const ok = await ctx.check(`${id}: amoxi export ${args.join(' ')} succeeds`, async () => {
        const r = await run('node', [bin, 'export', '--out-dir', out, ...args], { cwd: path.join(ctx.root, dir), timeoutMs: 5 * 60_000 });
        if (r.code !== 0) throw Object.assign(new Error('export failed'), { detail: r.output.slice(-4000) });
        ctx.assert.ok(existsSync(path.join(out, 'index.html')), 'no index.html');
        return true;
      });
      if (!ok) continue;
      const base = args.includes('--base-path') ? args[args.indexOf('--base-path') + 1] : '';
      await ctx.check(`${id}: every local link, script, stylesheet and image in the export resolves to a file`, () => {
        const missing = new Set();
        const htmlFiles = walk(out).filter((f) => f.endsWith('.html'));
        for (const file of htmlFiles) {
          const html = readFileSync(file, 'utf8');
          for (const m of html.matchAll(/(?:href|src)="([^"#?]+)/g)) {
            let url = m[1];
            if (/^(https?:|mailto:|data:|\/\/)/.test(url)) continue;
            if (!url.startsWith('/')) url = path.posix.join(path.posix.dirname(`/${path.relative(out, file).split(path.sep).join('/')}`), url);
            if (base) {
              if (!url.startsWith(`${base}/`) && url !== base) {
                missing.add(`${path.relative(out, file)}: ${url} (not under ${base})`);
                continue;
              }
              url = url.slice(base.length) || '/';
            }
            const target = path.join(out, decodeURIComponent(url));
            const candidates = [target, path.join(target, 'index.html'), `${target}.html`];
            if (!candidates.some((f) => existsSync(f) && statSync(f).isFile())) missing.add(`${path.relative(out, file)}: ${m[1]}`);
          }
        }
        ctx.assert.deepEqual([...missing], []);
        ctx.metric(`${id}: exported HTML pages`, htmlFiles.length);
      });
      if (id === 'website') {
        await ctx.check('website: llms.txt and markdown copies use the public URL', () => {
          const llms = readFileSync(path.join(out, 'llms.txt'), 'utf8');
          ctx.assert.match(llms, /https:\/\/example\.github\.io\/amoxi\//);
          ctx.assert.ok(!/127\.0\.0\.1|localhost/.test(llms), 'llms.txt points at the exporter');
          ctx.assert.ok(existsSync(path.join(out, 'index.md')), 'no index.md');
        });
      }
    }
  },
};

/** Start-up time with many services: the framework's headline promise. */
export const performanceStage = {
  id: 'performance',
  title: 'Start-up performance',
  description: 'benchmark app with 300 services: framework start-up time, lazy and eager',
  quick: false,
  needs: ['build'],
  async run(ctx) {
    const r = await ctx.check('the start-up benchmark runs (300 services, 5 runs)', async () => {
      const res = await run('node', ['bench/startup-bench.mjs', '300', '5'], { cwd: ctx.root, timeoutMs: 5 * 60_000 });
      if (res.code !== 0) throw Object.assign(new Error('benchmark failed'), { detail: res.output.slice(-3000) });
      return res.output;
    });
    if (!r) return;
    const lazy = Number(/lazy singletons.*?framework\s+([\d.]+)ms/.exec(r)?.[1]);
    const eager = Number(/eager: instantiate all.*?framework\s+([\d.]+)ms/.exec(r)?.[1]);
    ctx.metric('framework start-up, 300 services created on demand', lazy, 'ms', '< 50 ms');
    ctx.metric('framework start-up, 300 services created eagerly', eager, 'ms', '< 100 ms');
    await ctx.check('start-up with 300 services is under 50 ms (lazy) and 100 ms (eager)', () => {
      ctx.assert.ok(lazy < 50, `lazy ${lazy} ms`);
      ctx.assert.ok(eager < 100, `eager ${eager} ms`);
    });
  },
};
