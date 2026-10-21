// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { Client } from '../lib/http.mjs';
import { freePort, run, ServerProcess } from '../lib/proc.mjs';
import { loadPlaywright } from './e2e.mjs';

const pack = async (ctx, workspace, dest) => {
  const r = await run('npm', ['pack', '-w', workspace, '--json', '--pack-destination', dest], { cwd: ctx.root });
  if (r.code !== 0) throw Object.assign(new Error(`npm pack ${workspace} failed`), { detail: r.output });
  const json = JSON.parse(r.output.slice(r.output.indexOf('[')));
  return { file: path.join(dest, json[0].filename), files: json[0].files.map((f) => f.path), unpacked: json[0].unpackedSize };
};

/** The packages as npm would publish them, installed into a brand-new project. */
export const packaging = {
  id: 'package',
  title: 'Published packages',
  description: 'npm pack, install the tarballs into a fresh project, import with CJS, ESM and TypeScript',
  quick: true,
  needs: ['build'],
  async run(ctx) {
    const dest = ctx.tmp('amoxi-pack-');
    const fw = await ctx.check('amoxi packs', () => pack(ctx, 'amoxi', dest));
    const gen = await ctx.check('create-amoxi-app packs', () => pack(ctx, 'create-amoxi-app', dest));
    if (!fw || !gen) return;
    ctx.shared.tarballs = { framework: fw.file, generator: gen.file };
    ctx.metric('amoxi unpacked size', (fw.unpacked / 1024 / 1024).toFixed(2), 'MB', '< 5 MB');

    await ctx.check('amoxi contains what it needs and nothing it shouldn\'t', () => {
      const need = ['LICENSE', 'NOTICE', 'README.md', 'package.json', 'bin/amoxi.js', 'dist/runtime/index.js', 'dist/runtime/index.d.ts', 'dist/ai/index.js', 'dist/ai/index.d.ts', 'dist/compiler/cli.js', 'src/client/index.ts', 'src/client/agent.ts', 'ai/package.json', 'jsx-runtime/package.json'];
      const missing = need.filter((f) => !fw.files.includes(f));
      // Source maps would point at src/ files the package doesn't ship.
      const forbidden = fw.files.filter((f) => /(^|\/)(test|tests)\/|\.test\.|\.env|\.tsbuildinfo$|node_modules\/|\.map$/.test(f));
      ctx.assert.deepEqual({ missing, forbidden }, { missing: [], forbidden: [] });
      ctx.assert.ok(fw.unpacked < 5 * 1024 * 1024, 'package is larger than 5 MB');
    });
    await ctx.check('create-amoxi-app contains its templates and licences', () => {
      const need = ['LICENSE', 'NOTICE', 'README.md', 'index.js', 'templates/LICENSE', 'templates/web/src/pages/home-page.tsx', 'templates/agent/src/agent/assistant.ts', 'templates/api/src/notes/note-controller.ts', 'templates/shared/_gitignore'];
      ctx.assert.deepEqual(need.filter((f) => !gen.files.includes(f)), []);
    });

    // A consumer project, installed from the tarballs (dependencies come from the registry).
    const consumer = ctx.tmp('amoxi-consumer-');
    writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ name: 'consumer', version: '1.0.0', private: true }));
    const installed = await ctx.check('the tarball installs into a fresh project', async () => {
      const r = await run('npm', ['install', '--no-audit', '--no-fund', fw.file, 'typescript@~5.9.3', '@types/node@^22'], { cwd: consumer, timeoutMs: 5 * 60_000 });
      if (r.code !== 0) throw Object.assign(new Error('npm install failed'), { detail: r.output.slice(-4000) });
      return true;
    });
    if (!installed) return;

    await ctx.check('CommonJS: require() of every public entry point', async () => {
      const code = `const n=require('amoxi');const ai=require('amoxi/ai');const j=require('amoxi/jsx-runtime');
for (const k of ['AmoxiApplication','Singleton','Controller','Page','Island','eventStream','withData','agentChat','For'])if(!(k in n))throw new Error('amoxi lacks '+k);
for (const k of ['Agent','Tool','aiExtension','AnthropicChatModel','OpenAiChatModel','OfflineChatModel','PgVectorStore','mcpRoutes','a2aRoutes','userOwner'])if(!(k in ai))throw new Error('amoxi/ai lacks '+k);
if(typeof j.jsx!=='function')throw new Error('jsx-runtime');console.log('ok')`;
      const r = await run('node', ['-e', code], { cwd: consumer });
      ctx.assert.equal(r.output.trim(), 'ok', r.output);
    });
    await ctx.check('ES modules: import of every public entry point', async () => {
      const code = `import * as n from 'amoxi'; import { Agent, aiExtension } from 'amoxi/ai'; import { jsx } from 'amoxi/jsx-runtime';
if (!n.AmoxiApplication || !Agent || !aiExtension || !jsx) throw new Error('missing export'); console.log('ok')`;
      const r = await run('node', ['--input-type=module', '-e', code], { cwd: consumer });
      ctx.assert.equal(r.output.trim(), 'ok', r.output);
    });
    await ctx.check('amoxi/ai loads without its optional peers (pg, react)', async () => {
      const r = await run('node', ['-e', "require('amoxi/ai');const l=Object.keys(require.cache);if(l.some(f=>/node_modules[\\\\/](pg|react)[\\\\/]/.test(f)))throw new Error('optional peer loaded');console.log('ok')"], { cwd: consumer });
      ctx.assert.equal(r.output.trim(), 'ok', r.output);
    });
    await ctx.check('private files are not importable (exports map)', async () => {
      const r = await run('node', ['-e', "try{require('amoxi/dist/runtime/http');console.log('importable')}catch(e){console.log(e.code)}"], { cwd: consumer });
      ctx.assert.equal(r.output.trim(), 'ERR_PACKAGE_PATH_NOT_EXPORTED');
    });
    for (const [label, opts] of [
      ['node16', { module: 'node16', moduleResolution: 'node16' }],
      ['bundler', { module: 'esnext', moduleResolution: 'bundler' }],
      ['node10', { module: 'commonjs', moduleResolution: 'node10' }],
    ]) {
      await ctx.check(`TypeScript resolves the types (moduleResolution ${label})`, async () => {
        const dir = path.join(consumer, `ts-${label}`);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          path.join(dir, 'index.ts'),
          `import { AmoxiApplication, eventStream, type RequestContext } from 'amoxi';
import { Agent, Tool, type ToolContext, type AgentRunContext } from 'amoxi/ai';
export const types: [typeof AmoxiApplication, typeof eventStream, typeof Agent, typeof Tool] = [AmoxiApplication, eventStream, Agent, Tool];
export type T = [RequestContext, ToolContext, AgentRunContext];
`,
        );
        writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { ...opts, target: 'es2022', strict: true, noEmit: true, skipLibCheck: false, types: ['node'], experimentalDecorators: true }, files: ['index.ts'] }));
        const r = await run('npx', ['tsc', '-p', dir], { cwd: consumer });
        if (r.code !== 0) throw Object.assign(new Error('type errors'), { detail: r.output.slice(-4000) });
      });
    }
    await ctx.check('the amoxi CLI runs from the installed package: --help, --version, and errors for unknown options', async () => {
      const help = await run('npx', ['amoxi', '--help'], { cwd: consumer });
      ctx.assert.match(help.output, /amoxi build/);
      const version = await run('npx', ['amoxi', '--version'], { cwd: consumer });
      ctx.assert.equal(version.output.trim(), JSON.parse(readFileSync(path.join(ctx.root, 'packages/framework/package.json'), 'utf8')).version);
      const unknown = await run('npx', ['amoxi', 'start', '--wrokers', '2'], { cwd: consumer });
      ctx.assert.notEqual(unknown.code, 0, 'an unknown option must fail');
      ctx.assert.match(unknown.output, /unknown option --wrokers/);
      const bad = await run('npx', ['amoxi', 'start', '--shutdown-timeout', 'soon'], { cwd: consumer });
      ctx.assert.notEqual(bad.code, 0, 'an invalid value must fail');
    });
  },
};

/** New projects from the published generator, installed, tested, built and run in production. */
export const scaffold = {
  id: 'scaffold',
  title: 'New projects (create-amoxi-app)',
  description: 'web, agent and api templates from the packed generator: install, test, production start',
  quick: false,
  needs: ['package'],
  async run(ctx) {
    const t = ctx.shared.tarballs;
    if (!t) ctx.skip('the package stage did not produce tarballs (run it too)');
    const parent = ctx.tmp('amoxi-scaffold-');
    for (const template of ['web', 'agent', 'api']) {
      const name = `${template}-app`;
      const dir = path.join(parent, name);
      const created = await ctx.check(`${template}: npx create-amoxi-app creates and installs the project`, async () => {
        const r = await run('npx', ['--yes', `--package=${t.generator}`, 'create-amoxi-app', name, '--template', template, '--framework', t.framework, '--no-git'], { cwd: parent, timeoutMs: 8 * 60_000 });
        if (r.code !== 0 || !readdirSync(dir).includes('node_modules')) throw Object.assign(new Error('generator failed'), { detail: r.output.slice(-4000) });
        return true;
      });
      if (!created) continue;
      await ctx.check(`${template}: secrets in .env files are git-ignored, the Docker image can save data, public/ is kept`, async () => {
        const git = await run('git', ['init', '-q'], { cwd: dir });
        if (git.code !== 0) return ctx.note('git is not installed, so .gitignore was not checked');
        for (const f of ['.env', '.env.production', '.env.local']) {
          const r = await run('git', ['check-ignore', '-q', f], { cwd: dir });
          ctx.assert.equal(r.code, 0, `${f} is not git-ignored`);
        }
        ctx.assert.notEqual((await run('git', ['check-ignore', '-q', '.env.example'], { cwd: dir })).code, 0, '.env.example must be committed');
        const dockerignore = readFileSync(path.join(dir, '.dockerignore'), 'utf8');
        ctx.assert.match(dockerignore, /^\.env$/m, '.env is not excluded from the Docker build context');
        ctx.assert.match(readFileSync(path.join(dir, 'Dockerfile'), 'utf8'), /mkdir -p \/app\/data && chown node:node \/app\/data[\s\S]*USER node/);
        ctx.assert.ok(readdirSync(path.join(dir, 'public')).length > 0, 'public/ is empty, so git would drop it and the Docker build would fail');
      });
      await ctx.check(`${template}: npm test passes`, async () => {
        const r = await run('npm', ['test'], { cwd: dir, timeoutMs: 8 * 60_000 });
        if (r.code !== 0) throw Object.assign(new Error('tests failed'), { detail: r.output.slice(-4000) });
      });
      await ctx.check(`${template}: production start (amoxi start) serves, then shuts down cleanly`, async () => {
        const port = await freePort();
        const server = await ServerProcess.start(name, [path.join(dir, 'node_modules', 'amoxi', 'bin', 'amoxi.js'), 'start', 'dist/src/main.js', '--workers', '2'], {
          cwd: dir,
          env: { SERVER_PORT: String(port), NODE_ENV: 'production' },
          readyUrl: `http://127.0.0.1:${port}/amoxi/health/ready`,
        });
        try {
          const c = new Client(`http://127.0.0.1:${port}`);
          if (template === 'api') {
            const { res } = await c.json('/api/notes');
            ctx.assert.equal(res.status, 200);
          } else {
            const { res, text } = await c.text('/', { headers: { accept: 'text/html' } });
            ctx.assert.equal(res.status, 200);
            ctx.assert.match(text, /<html lang=/);
          }
          if (template === 'agent') {
            const { events } = await c.sse('/agents/assistant/runs', { method: 'POST', json: { input: 'Show my notes' } });
            ctx.assert.equal(events.at(-1)?.event, 'run.completed', `last event: ${JSON.stringify(events.at(-1))}`);
          }
        } finally {
          const exit = await server.stop();
          ctx.assert.equal(exit.code, 0, `exit code ${exit.code} ${exit.signal ?? ''}\n${server.tail()}`);
        }
      });
      const pw = template === 'agent' ? loadPlaywright(ctx.root) : undefined;
      if (pw) {
        await ctx.check('agent: in a browser, answers are bubbles sized to their text, narration is a status line, and the chat follows the newest message', async () => {
          const port = await freePort();
          const server = await ServerProcess.start(name, [path.join(dir, 'node_modules', 'amoxi', 'bin', 'amoxi.js'), 'start', 'dist/src/main.js', '--workers', '1'], {
            cwd: dir,
            env: { SERVER_PORT: String(port), NODE_ENV: 'production' },
            readyUrl: `http://127.0.0.1:${port}/amoxi/health/ready`,
          });
          const browser = await pw.chromium.launch({ timeout: 60_000 });
          try {
            const page = await browser.newPage({ viewport: { width: 1440, height: 700 } });
            page.setDefaultTimeout(20_000);
            await page.goto(`http://127.0.0.1:${port}/assistant`);
            const ask = async (n) => {
              await page.click(`.examples button >> nth=${n}`);
              await page.waitForSelector('.composer button[type=submit]:not([disabled])');
              await page.waitForTimeout(300);
            };
            // Enough turns that the conversation has to scroll.
            await ask(0);
            await ask(1);
            await ask(0);
            await ask(0);
            const r = await page.evaluate(() => {
              const log = document.querySelector('.conversation');
              const box = (sel) => [...log.querySelectorAll(sel)].map((e) => Math.round(e.getBoundingClientRect().height));
              return { texts: box('.msg:not(.ui):not(.approval)'), answers: box('.msg.answer'), narration: box('.msg.narration'), fromBottom: Math.round(log.scrollHeight - log.scrollTop - log.clientHeight) };
            });
            // Every text message (whatever its class) is sized to its text: none takes the chat panel's height.
            ctx.assert.ok(r.texts.length >= 8 && r.texts.every((h) => h < 120), `message too tall: ${JSON.stringify(r)}`);
            ctx.assert.ok(r.answers.length >= 4, `answers: ${JSON.stringify(r)}`);
            // A one-line answer is about 45 px; a message styled like the chat panel would be 384 px.
            ctx.assert.ok(r.answers.every((h) => h < 120), `answer bubbles too tall: ${JSON.stringify(r)}`);
            ctx.assert.ok(r.narration.length >= 3 && r.narration.every((h) => h < 60), `narration lines: ${JSON.stringify(r)}`);
            ctx.assert.ok(r.fromBottom <= 5, `the chat is not at the newest message: ${JSON.stringify(r)}`);
          } finally {
            await browser.close();
            await server.stop();
          }
        });
      }
    }
  },
};
