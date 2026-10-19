// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import { run } from '../lib/proc.mjs';

/** Builds everything, then runs every workspace's test suite and the dependency checks. */
export const build = {
  id: 'build',
  title: 'Build',
  description: 'type-check and build the framework, examples and website',
  quick: true,
  async run(ctx) {
    await ctx.check('framework type-checks with no errors (tsc --noEmit)', async () => {
      const r = await run('npx', ['tsc', '-p', 'tsconfig.json', '--noEmit'], { cwd: `${ctx.root}/packages/framework` });
      if (r.code !== 0) throw Object.assign(new Error('TypeScript errors'), { detail: r.output.slice(-6000) });
    });
    await ctx.check('npm run build succeeds for every workspace', async () => {
      const r = await run('npm', ['run', 'build'], { cwd: ctx.root, timeoutMs: 20 * 60_000 });
      if (r.code !== 0) throw Object.assign(new Error(`build failed (exit ${r.code})`), { detail: r.output.slice(-6000) });
      const warnings = r.output.split('\n').filter((l) => /warning AMOXI|\bwarning\b.*amoxi/i.test(l));
      if (warnings.length) ctx.note(`build warnings: ${warnings.join(' | ')}`);
    });
  },
};

export const unit = {
  id: 'unit',
  title: 'Unit and integration tests',
  description: 'every workspace test suite (framework, generator, examples, website)',
  quick: true,
  needs: ['build'],
  async run(ctx) {
    const workspaces = ['amoxi', 'create-amoxi-app', 'user-service', 'banking-assistant', 'clinic-assistant', 'shopping-assistant', 'dispatch-agent', 'website'];
    let total = 0;
    for (const ws of workspaces) {
      await ctx.check(`${ws} tests pass`, async () => {
        const r = await run('npm', ['test', '-w', ws], { cwd: ctx.root, timeoutMs: 15 * 60_000 });
        // node --test prints totals as "# tests 12" (TAP reporter) or "\u2139 tests 12" (spec reporter, the
        // default in newer Node.js versions and in terminals), depending on version and platform.
        const count = (name) => [...r.output.matchAll(new RegExp(`^\\s*(?:#|\u2139) ${name} (\\d+)\\s*$`, 'gm'))].reduce((n, m) => n + Number(m[1]), 0);
        const tests = count('tests');
        const failed = count('fail');
        total += tests;
        if (r.code !== 0 || failed > 0 || tests === 0) {
          const failing = r.output.split(/\r?\n/).filter((l) => /^\s*(not ok |\u2716 )/.test(l)).join('\n');
          throw Object.assign(new Error(`${failed} of ${tests} failed (exit ${r.code})`), { detail: `${failing}\n\n${r.output.slice(-4000)}` });
        }
        return tests;
      });
    }
    ctx.metric('tests run', total);
  },
};

export const supplyChain = {
  id: 'supply-chain',
  title: 'Dependencies',
  description: 'licences of runtime dependencies and known vulnerabilities',
  quick: true,
  async run(ctx) {
    await ctx.check('runtime dependencies use permissive licences', async () => {
      const r = await run('node', ['scripts/check-licenses.mjs'], { cwd: ctx.root });
      if (r.code !== 0) throw Object.assign(new Error('licence check failed'), { detail: r.output });
    });
    await ctx.check('npm audit finds no moderate or worse vulnerabilities in runtime dependencies', async () => {
      const r = await run('npm', ['audit', '--omit=dev', '--audit-level=moderate'], { cwd: ctx.root, timeoutMs: 120_000 });
      if (r.code !== 0) {
        // No network (e.g. an air-gapped runner) isn't a vulnerability: report it, don't fail.
        if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|audit endpoint returned an error/i.test(r.output)) return ctx.note('npm audit could not reach the registry; skipped');
        throw Object.assign(new Error('vulnerabilities found'), { detail: r.output.slice(-4000) });
      }
    });
  },
};
