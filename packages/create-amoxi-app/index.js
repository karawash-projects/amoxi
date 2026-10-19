#!/usr/bin/env node
// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

'use strict';
/**
 * create-amoxi-app: scaffolds a ready-to-run Amoxi project.
 *
 *   npx create-amoxi-app@latest my-app
 *   npx create-amoxi-app@latest my-api --template api
 *
 * No dependencies; works on Windows, macOS and Linux.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const VERSION = require('./package.json').version;
const isWin = process.platform === 'win32';
const tty = process.stdout.isTTY;
const paint = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = paint(1);
const dim = paint(2);
const green = paint(32);
const red = paint(31);
const cyan = paint(36);

const TEMPLATES = {
  web: 'Pages, islands and a JSON API (full-stack)',
  agent: 'The web template plus an AI agent with tools, streaming chat and generative UI',
  api: 'JSON API only (backend service)',
};
/** Templates built on top of another one: copied in order, later files win. */
const LAYERS = { web: ['web'], agent: ['web', 'agent'], api: ['api'] };

const HELP = `
${bold('create-amoxi-app')} v${VERSION}

Usage:
  create-amoxi-app <project-name> [options]

Options:
  --template <web|agent|api>
                         web: pages, islands and a JSON API (default)
                         agent: web plus an AI agent with a streaming chat
                         api: a JSON API only
  --framework <spec>     Where amoxi comes from: a version range, a path to the
                         framework package or a .tgz (default: the local monorepo copy if
                         found, otherwise ^${VERSION} from npm)
  --no-install           Don't install dependencies
  --no-git               Don't initialise a git repository
  -y, --yes              Accept defaults without asking
  -h, --help             Show this help
`;

/** The project folder while it is being created: removed again if creating it fails partway. */
let unfinished;

function removeUnfinished() {
  if (!unfinished) return;
  const { target, existed } = unfinished;
  unfinished = undefined;
  try {
    if (existed) for (const entry of fs.readdirSync(target)) fs.rmSync(path.join(target, entry), { recursive: true, force: true });
    else fs.rmSync(target, { recursive: true, force: true });
  } catch {
    // Best effort: the message below still names the folder.
  }
}

function fail(message) {
  removeUnfinished();
  process.stderr.write(`\n${red('error')} ${message}\n\n`);
  process.exit(1);
}

// Ctrl+C while the files are being written: don't leave a half-made project behind.
process.once('SIGINT', () => {
  removeUnfinished();
  process.exit(130);
});

/** Options that take a value (--template web or --template=web). */
const VALUE_OPTIONS = new Set(['template', 'framework']);

function parseArgs(argv) {
  const positionals = [];
  const flags = { install: true, git: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') flags.help = true;
    else if (a === '-y' || a === '--yes') flags.yes = true;
    else if (a === '--no-install') flags.install = false;
    else if (a === '--no-git') flags.git = false;
    else if (a.startsWith('-') && a !== '-') {
      const eq = a.indexOf('=');
      const option = eq === -1 ? a : a.slice(0, eq);
      const name = option.replace(/^--/, '');
      // An unknown option is an error, not a reason to take the next argument (the project name) as its value.
      if (!option.startsWith('--') || !VALUE_OPTIONS.has(name)) fail(`Unknown option ${option}. Run create-amoxi-app --help to see the options.`);
      const value = eq === -1 ? argv[++i] : a.slice(eq + 1);
      if (value === undefined || value === '' || (eq === -1 && value.startsWith('-'))) fail(`Missing value for --${name}`);
      flags[name] = value;
    } else positionals.push(a);
  }
  if (positionals.length > 1) fail(`Expected one project name, got ${positionals.length}: ${positionals.join(' ')}`);
  return { positionals, flags };
}

/**
 * How to start a package manager without a shell. On Windows npm, npx, pnpm and yarn are .cmd
 * files, which only a shell can run, and handing argument lists to a shell is unsafe (Node warns
 * about it, DEP0190). So they are started as Node scripts instead: the one the running package
 * manager names in npm_execpath, or npm's own script next to node.exe. Elsewhere they run as usual.
 */
function packageManagerCommand(cmd, args) {
  if (!isWin || !['npm', 'npx', 'pnpm', 'yarn'].includes(cmd)) return { file: cmd, args };
  const execPath = process.env.npm_execpath;
  if (execPath && fs.existsSync(execPath) && /\.(c?js|mjs)$/.test(execPath)) {
    const base = path.basename(execPath).toLowerCase();
    if (cmd === 'npm' && base.startsWith('npm-cli')) return { file: process.execPath, args: [execPath, ...args] };
    const npxCli = path.join(path.dirname(execPath), 'npx-cli.js');
    if (cmd === 'npx' && base.startsWith('npm-cli') && fs.existsSync(npxCli)) return { file: process.execPath, args: [npxCli, ...args] };
    if (cmd !== 'npm' && cmd !== 'npx' && base.startsWith(cmd)) return { file: process.execPath, args: [execPath, ...args] };
  }
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', `${cmd === 'npx' ? 'npx' : 'npm'}-cli.js`);
  if ((cmd === 'npm' || cmd === 'npx') && fs.existsSync(npmCli)) return { file: process.execPath, args: [npmCli, ...args] };
  // Last resort: cmd.exe with every argument quoted; refuse characters cmd.exe would still interpret.
  for (const a of args) {
    if (/[%!"\r\n]/.test(a)) throw new Error(`Refusing to pass ${JSON.stringify(a)} to ${cmd} through cmd.exe`);
  }
  const line = [cmd, ...args].map((a) => (/^[\w./:=@\\-]+$/.test(a) ? a : `"${a}"`)).join(' ');
  return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], windowsVerbatimArguments: true };
}

/** Runs a command without a shell (see packageManagerCommand) and waits for it. */
function run(cmd, args, options = {}) {
  const command = packageManagerCommand(cmd, args);
  return spawnSync(command.file, command.args, { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: command.windowsVerbatimArguments, ...options });
}

async function ask(question, fallback) {
  if (!process.stdin.isTTY) return fallback;
  const readline = require('node:readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} ${dim(`(${fallback})`)} `)).trim();
  rl.close();
  return answer || fallback;
}

function validateName(name) {
  if (name.length > 214) return 'must be at most 214 characters';
  if (!/^[a-z0-9][a-z0-9._~-]*$/.test(name)) return 'may only contain lowercase letters, digits, "-", "_", "." and "~", and must start with a letter or digit';
  if (['node_modules', 'favicon.ico'].includes(name)) return 'is a reserved name';
  return undefined;
}

const DOTFILES = { _gitignore: '.gitignore', _dockerignore: '.dockerignore', '_env.example': '.env.example' };

function copyTemplate(src, dest, vars) {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, DOTFILES[entry.name] ?? entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(to, { recursive: true });
      copyTemplate(from, to, vars);
    } else {
      let text = fs.readFileSync(from, 'utf8');
      for (const [key, value] of Object.entries(vars)) text = text.split(`{{${key}}}`).join(value);
      fs.writeFileSync(to, text);
    }
  }
}

/** Decides how the new app depends on amoxi. */
function resolveFramework(spec, target) {
  // Running from a clone of the Amoxi repository (packages/create-amoxi-app next to
  // packages/framework): use that framework build, so unreleased changes can be tried.
  // Installed from npm, there is no such sibling and the published framework is used.
  if (!spec) {
    const localMonorepo = path.resolve(__dirname, '..', 'framework');
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(localMonorepo, 'package.json'), 'utf8'));
      if (pkg.name === 'amoxi' && fs.existsSync(path.join(localMonorepo, 'src', 'runtime'))) spec = localMonorepo;
    } catch {
      /* not a repository checkout */
    }
  }
  if (!spec) return { dependency: `^${VERSION}`, note: `from npm (^${VERSION})` };

  const abs = path.resolve(spec);
  const vendor = path.join(target, 'vendor');
  if (fs.existsSync(abs) && fs.statSync(abs).isFile() && abs.endsWith('.tgz')) {
    fs.mkdirSync(vendor, { recursive: true });
    fs.copyFileSync(abs, path.join(vendor, path.basename(abs)));
    return { dependency: `file:vendor/${path.basename(abs)}`, note: `vendored from ${abs}` };
  }
  if (fs.existsSync(path.join(abs, 'package.json'))) {
    const pkg = JSON.parse(fs.readFileSync(path.join(abs, 'package.json'), 'utf8'));
    if (pkg.name !== 'amoxi') fail(`${abs} is not the amoxi package`);
    if (!fs.existsSync(path.join(abs, 'dist', 'runtime', 'index.js'))) {
      fail(`The framework at ${abs} hasn't been built yet. Run "npm run build" in the Amoxi repository first.`);
    }
    // Pack it into the new project so the app is self-contained and portable (no symlinks).
    fs.mkdirSync(vendor, { recursive: true });
    const res = run('npm', ['pack', '--json', '--pack-destination', vendor], { cwd: abs });
    if (res.status !== 0) fail(`Couldn't pack the framework:\n${res.stderr || res.stdout}`);
    const filename = JSON.parse(res.stdout.slice(res.stdout.indexOf('[')))[0].filename;
    return { dependency: `file:vendor/${filename}`, note: `packed from ${abs}` };
  }
  return { dependency: spec, note: `from npm (${spec})` };
}

function detectPackageManager() {
  const agent = process.env.npm_config_user_agent ?? '';
  for (const pm of ['pnpm', 'yarn', 'bun']) if (agent.startsWith(pm)) return pm;
  return 'npm';
}

async function main() {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  if (flags.help) {
    process.stdout.write(HELP);
    return;
  }
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) fail(`Amoxi needs Node.js 22 or newer; you have ${process.version}.`);

  process.stdout.write(`\n${bold('Create an Amoxi app')}\n\n`);
  const nameArg = positionals[0] ?? (flags.yes ? 'my-amoxi-app' : await ask('Project name?', 'my-amoxi-app'));
  const target = path.resolve(nameArg);
  const name = path.basename(target);
  const nameProblem = validateName(name);
  if (nameProblem) fail(`The project name "${name}" ${nameProblem}.`);
  if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
    fail(`The folder ${target} already exists and isn't empty. Choose another name or remove it.`);
  }

  let template = flags.template;
  if (!template) {
    // Asked whenever someone is at the terminal (also when the project name was given); `web` with --yes or in scripts.
    template = flags.yes ? 'web' : await ask(`Template? web = ${TEMPLATES.web}; agent = ${TEMPLATES.agent}; api = ${TEMPLATES.api}`, 'web');
  }
  if (!TEMPLATES[template]) fail(`Unknown template "${template}". Choose one of: ${Object.keys(TEMPLATES).join(', ')}.`);

  const title = name.replace(/[-_.~]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  unfinished = { target, existed: fs.existsSync(target) };
  fs.mkdirSync(target, { recursive: true });
  const vars = { APP_NAME: name, APP_TITLE: title };
  copyTemplate(path.join(__dirname, 'templates', 'shared'), target, vars);
  for (const layer of LAYERS[template]) copyTemplate(path.join(__dirname, 'templates', layer), target, vars);
  if (template === 'api') {
    // Git doesn't keep empty folders, and the Dockerfile copies public/: keep it in the repository.
    fs.mkdirSync(path.join(target, 'public'), { recursive: true });
    fs.writeFileSync(path.join(target, 'public', '.gitkeep'), '');
  }

  const framework = resolveFramework(flags.framework, target);
  const pkg = {
    name,
    version: '0.1.0',
    private: true,
    scripts: {
      dev: 'amoxi dev',
      build: 'amoxi build && tsc -p tsconfig.json',
      start: 'amoxi start dist/src/main.js',
      test: 'npm run build && node --test "dist/test/*.test.js"',
    },
    dependencies: { 'amoxi': framework.dependency },
    devDependencies: { '@types/node': '^22.0.0', typescript: '~5.9.3' },
    engines: { node: '>=22' },
  };
  fs.writeFileSync(path.join(target, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  // Every file is written: from here on the project stays, even if installing fails.
  unfinished = undefined;

  process.stdout.write(`${green('ok')} Created ${bold(name)} (${template} template) in ${target}\n`);
  process.stdout.write(`${green('ok')} amoxi ${framework.note}\n`);

  const pm = detectPackageManager();
  let installFailed = false;
  if (flags.install) {
    process.stdout.write(`\nInstalling dependencies with ${pm}...\n\n`);
    const res = run(pm, ['install'], { cwd: target, stdio: 'inherit' });
    if (res.status !== 0) {
      installFailed = true;
      process.stdout.write(`\n${red('error')} Installing dependencies failed. Fix the problem above, then run "${pm} install" in ${name}.\n`);
    } else {
      process.stdout.write(`\n${green('ok')} Dependencies installed\n`);
    }
  }

  if (flags.git && run('git', ['--version']).status === 0 && !fs.existsSync(path.join(target, '.git'))) {
    const inRepo = run('git', ['rev-parse', '--is-inside-work-tree'], { cwd: target }).stdout?.trim() === 'true';
    if (!inRepo && run('git', ['init', '-q'], { cwd: target }).status === 0) {
      run('git', ['add', '-A'], { cwd: target });
      const commit = run('git', ['commit', '-q', '-m', 'Initial commit from create-amoxi-app'], { cwd: target });
      process.stdout.write(`${green('ok')} Initialised a git repository${commit.status === 0 ? ' with an initial commit' : ''}\n`);
    }
  }

  const runCmd = pm === 'npm' ? 'npm run' : pm;
  const rel = path.relative(process.cwd(), target) || '.';
  process.stdout.write(`
${bold('Next steps')}

  ${cyan(`cd ${rel.includes(' ') ? `"${rel}"` : rel}`)}${flags.install && !installFailed ? '' : `\n  ${cyan(`${pm} install`)}`}
  ${cyan(`${runCmd} dev`)}      then open http://localhost:8080

  ${runCmd} build    production build
  ${pm === 'npm' ? 'npm start' : `${pm} start`}        run it on every CPU core
  ${pm === 'npm' ? 'npm test' : `${pm} test`}         build and run the tests

`);
  // The project was created, but it isn't ready: scripts and CI must see the failure.
  if (installFailed) process.exitCode = 1;
}

main().catch((err) => fail(err instanceof Error ? err.stack : String(err)));
