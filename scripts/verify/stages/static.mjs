// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { run } from '../lib/proc.mjs';
import { commitsIn, problemsIn } from '../../check-commit-messages.mjs';

const IGNORED_DIRS = new Set(['node_modules', 'dist', 'generated', '_amoxi', '.amoxi', 'data', 'out', '.git', 'verify-report', '.generated-app', 'vendor', 'coverage']);

/** Files that would be committed: `git ls-files` in a clone, otherwise a walk that skips build output. */
export async function projectFiles(root) {
  if (existsSync(path.join(root, '.git'))) {
    const r = await run('git', ['ls-files', '-co', '--exclude-standard'], { cwd: root });
    if (r.code === 0) return r.output.split('\n').filter(Boolean);
  }
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name)) walk(path.join(dir, e.name));
      } else if (!/\.(log|tgz|tsbuildinfo)$/.test(e.name) && !/^\.env.*\.local$/.test(e.name) && e.name !== 'docs.generated.ts') {
        out.push(path.relative(root, path.join(dir, e.name)).split(path.sep).join('/'));
      }
    }
  };
  walk(root);
  return out;
}

const TEXT = /\.(ts|tsx|mts|cts|js|mjs|cjs|json|md|yml|yaml|css|html|txt|svg)$|^(LICENSE|NOTICE|Dockerfile|_gitignore|_dockerignore|_env\.example)$/;

export const environment = {
  id: 'environment',
  title: 'Environment',
  description: 'Node.js and npm versions the framework supports',
  quick: true,
  async run(ctx) {
    await ctx.check('Node.js 22 or newer', () => {
      const major = Number(process.versions.node.split('.')[0]);
      ctx.assert.ok(major >= 22, `Node.js ${process.version} is too old: Amoxi needs 22+`);
    });
    await ctx.check('npm is available', async () => {
      const r = await run('npm', ['--version']);
      ctx.assert.equal(r.code, 0, r.output);
      ctx.note(`npm ${r.output.trim()}`);
    });
    await ctx.check('dependencies are installed', () => {
      ctx.assert.ok(existsSync(path.join(ctx.root, 'node_modules', 'typescript')), 'run npm ci (or npm install) first');
    });
  },
};

export const hygiene = {
  id: 'hygiene',
  title: 'Repository hygiene',
  description: 'licence headers, versions, links, secrets, leftovers',
  quick: true,
  async run(ctx) {
    const root = ctx.root;
    const files = await projectFiles(root);
    const read = (f) => readFileSync(path.join(root, f), 'utf8');
    ctx.metric('files checked', files.length);

    await ctx.check('framework, generator and script sources carry the Apache-2.0 header', () => {
      const sources = files.filter((f) => /^(packages\/framework\/(src|bin|test)|packages\/create-amoxi-app\/index\.js|scripts)\/?.*\.(ts|tsx|js|mjs|cjs)$/.test(f) && !f.includes('/templates/'));
      const missing = sources.filter((f) => !/SPDX-License-Identifier: Apache-2\.0|\| Apache-2\.0 \*\//.test(read(f).slice(0, 400)));
      ctx.assert.deepEqual(missing, [], `missing header in: ${missing.join(', ')}`);
    });

    await ctx.check('versions agree (packages, compiler, changelog, security policy)', () => {
      const fw = JSON.parse(read('packages/framework/package.json')).version;
      const gen = JSON.parse(read('packages/create-amoxi-app/package.json')).version;
      const compiler = /COMPILER_VERSION = '([^']+)'/.exec(read('packages/framework/src/compiler/version.ts'))?.[1];
      const changelog = /^## (\d+\.\d+\.\d+)/m.exec(read('CHANGELOG.md'))?.[1];
      const supported = /^\| (\d+\.\d+)\.x \| Yes \|/m.exec(read('SECURITY.md'))?.[1];
      ctx.assert.equal(gen, fw, 'create-amoxi-app and amoxi versions differ');
      ctx.assert.equal(compiler, fw, 'COMPILER_VERSION differs from the package version');
      ctx.assert.equal(changelog, fw, 'the latest CHANGELOG release heading differs from the package version');
      ctx.assert.equal(supported, fw.split('.').slice(0, 2).join('.'), 'SECURITY.md does not list the current version as supported');
      ctx.note(`version ${fw}`);
    });

    await ctx.check('every package is Apache-2.0 (templates 0BSD) and requires Node 22+', () => {
      const pkgs = files.filter((f) => f.endsWith('package.json') && !f.includes('/templates/') && 'name' in JSON.parse(read(f)));
      const bad = [];
      for (const f of pkgs) {
        const p = JSON.parse(read(f));
        if (p.license !== 'Apache-2.0') bad.push(`${f}: license ${p.license}`);
        if (p.engines?.node && !/>=\s*22/.test(p.engines.node)) bad.push(`${f}: engines.node ${p.engines.node}`);
      }
      ctx.assert.ok(read('packages/create-amoxi-app/templates/LICENSE').includes('Zero-Clause BSD') || read('packages/create-amoxi-app/templates/LICENSE').includes('Permission to use, copy, modify, and/or distribute'), 'templates/LICENSE is not 0BSD');
      ctx.assert.deepEqual(bad, []);
    });

    await ctx.check('relative links in Markdown files resolve', () => {
      const broken = [];
      for (const f of files.filter((x) => x.endsWith('.md') && !x.includes('/templates/'))) {
        const text = read(f).replace(/```[\s\S]*?```/g, '');
        for (const m of text.matchAll(/\]\((?!https?:|mailto:|#)([^)\s]+)\)/g)) {
          const target = decodeURIComponent(m[1].split('#')[0]);
          if (!target) continue;
          const resolved = path.join(root, path.dirname(f), target);
          if (!existsSync(resolved)) broken.push(`${f} -> ${m[1]}`);
        }
      }
      ctx.assert.deepEqual(broken, [], `broken links: ${broken.join(', ')}`);
    });

    await ctx.check('no secrets, private keys or personal e-mail addresses are committed', () => {
      const patterns = [
        [/sk-ant-[A-Za-z0-9_-]{20,}/, 'Anthropic API key'],
        [/\bsk-(proj-)?[A-Za-z0-9_-]{32,}/, 'OpenAI API key'],
        [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key'],
        [/-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----/, 'private key'],
        [/\bgh[pousr]_[A-Za-z0-9]{36}\b/, 'GitHub token'],
        [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
        [/[A-Za-z0-9._%+-]+@(gmail|googlemail|outlook|hotmail|yahoo|icloud|proton(mail)?)\.(com|me)\b/i, 'personal e-mail address'],
      ];
      const hits = [];
      for (const f of files.filter((x) => TEXT.test(path.basename(x)) && !x.endsWith('package-lock.json'))) {
        const text = read(f);
        for (const [re, what] of patterns) if (re.test(text)) hits.push(`${f}: ${what}`);
      }
      const envFiles = files.filter((f) => /(^|\/)\.env(\.[\w-]+)?$/.test(f) && !f.endsWith('.example'));
      ctx.assert.deepEqual([...hits, ...envFiles.map((f) => `${f}: .env file`)], []);
    });

    await ctx.check('commit messages have no AI co-author or session trailers', () => {
      // A copy without git history (a downloaded archive) has no commits to check.
      if (!existsSync(path.join(ctx.root, '.git'))) return;
      const bad = [];
      for (const c of commitsIn('HEAD', ctx.root)) for (const p of problemsIn(c.message)) bad.push(`${c.sha.slice(0, 10)} ${c.subject}: ${p.line}`);
      ctx.assert.deepEqual(bad, [], 'remove these lines from the commit messages (see CONTRIBUTING.md)');
    });

    await ctx.check('no emoji or pictographic symbols in code, docs or output messages', () => {
      // Emoji, dingbats (check marks, crosses), warning signs, pictographs and their joiners. Typographic
      // arrows and bullets are fine; characters a program needs (an HTML entity table) are written as \u escapes.
      const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2300}-\u{23FF}\u{25A0}-\u{25FF}\u{FE0F}\u{200D}\u{2139}]/u;
      const hits = [];
      for (const f of files.filter((x) => TEXT.test(path.basename(x)) && !x.endsWith('package-lock.json'))) {
        const lines = read(f).split('\n');
        lines.forEach((line, i) => {
          const m = EMOJI.exec(line);
          if (m) hits.push(`${f}:${i + 1} U+${m[0].codePointAt(0).toString(16).toUpperCase()}`);
        });
      }
      ctx.assert.deepEqual(hits, []);
    });

    await ctx.check('child processes are started without a shell (no shell option with arguments)', () => {
      // Passing argument lists through a shell is unsafe and deprecated (Node.js DEP0190).
      const bad = files.filter((f) => /\.(ts|tsx|js|mjs|cjs)$/.test(f) && /\bshell:\s*(true|isWin|process\.platform)/.test(read(f)));
      ctx.assert.deepEqual(bad, []);
    });

    await ctx.check('no focused or skipped tests and no debugger statements', () => {
      const bad = [];
      for (const f of files.filter((x) => /\.(ts|tsx|js|mjs|cjs)$/.test(x))) {
        const text = read(f);
        if (/(^|\/)test\//.test(f) && /\b(test|it|describe)\.only\(|\{\s*only:\s*true\s*\}/.test(text)) bad.push(`${f}: .only`);
        if (f.startsWith('packages/framework/src/') && /^\s*debugger;/m.test(text)) bad.push(`${f}: debugger`);
      }
      ctx.assert.deepEqual(bad, []);
    });

    await ctx.check('CLI entry points have LF line endings and a node shebang', () => {
      for (const f of ['packages/framework/bin/amoxi.js', 'packages/create-amoxi-app/index.js']) {
        const text = read(f);
        ctx.assert.ok(text.startsWith('#!/usr/bin/env node\n'), `${f} must start with "#!/usr/bin/env node" and LF`);
        ctx.assert.ok(!text.includes('\r'), `${f} contains CR characters`);
      }
    });

    await ctx.check('required project files exist', () => {
      const required = ['LICENSE', 'NOTICE', 'README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'SECURITY.md', 'RELEASING.md', '.gitignore', '.gitattributes', '.github/workflows/ci.yml'];
      const missing = required.filter((f) => !existsSync(path.join(root, f)) || statSync(path.join(root, f)).size === 0);
      ctx.assert.deepEqual(missing, []);
    });
  },
};
