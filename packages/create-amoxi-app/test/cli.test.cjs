// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0
'use strict';
// Runs create-amoxi-app the way people do, without a network: only the steps before installing
// dependencies, or with an install that is made to fail.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'index.js');

function inTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'create-amoxi-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const create = (cwd, args, env = {}) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: { ...process.env, npm_config_user_agent: '', ...env }, timeout: 60_000 });

test('an unknown option is refused instead of swallowing the project name', () =>
  inTempDir((dir) => {
    const res = create(dir, ['--verbose', 'my-app', '--no-install', '--no-git']);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /Unknown option --verbose/);
    assert.equal(fs.existsSync(path.join(dir, 'my-app')), false);
    assert.equal(fs.existsSync(path.join(dir, '--verbose')), false);
  }));

test('--template=api and --template api both work, and a second name is an error', () =>
  inTempDir((dir) => {
    assert.equal(create(dir, ['one', '--template=api', '--no-install', '--no-git', '--framework', '^0.5.0']).status, 0);
    assert.ok(fs.existsSync(path.join(dir, 'one', 'src', 'notes', 'note-controller.ts')));
    assert.equal(create(dir, ['two', '--template', 'api', '--no-install', '--no-git', '--framework', '^0.5.0']).status, 0);
    const extra = create(dir, ['three', 'four', '--no-install', '--no-git']);
    assert.equal(extra.status, 1);
    assert.match(extra.stderr, /one project name/);
  }));

test('a run that fails partway removes what it created, so running it again works', () =>
  inTempDir((dir) => {
    // A --framework folder that isn't the amoxi package fails after the templates were copied.
    const notAmoxi = path.join(dir, 'not-amoxi');
    fs.mkdirSync(notAmoxi);
    fs.writeFileSync(path.join(notAmoxi, 'package.json'), '{"name":"something-else"}');
    const res = create(dir, ['my-app', '--template', 'web', '--no-install', '--no-git', '--framework', notAmoxi]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /is not the amoxi package/);
    assert.equal(fs.existsSync(path.join(dir, 'my-app')), false, 'a half-made project was left behind');
    assert.equal(create(dir, ['my-app', '--template', 'web', '--no-install', '--no-git', '--framework', '^0.5.0']).status, 0);
  }));

test('a failed install ends with a non-zero exit code but keeps the project', () =>
  inTempDir((dir) => {
    // Pretend pnpm started us, with no pnpm to be found: the install fails.
    const res = create(dir, ['my-app', '--template', 'api', '--no-git', '--framework', '^0.5.0'], {
      npm_config_user_agent: 'pnpm/9.0.0 node/v22',
      npm_execpath: '',
      PATH: path.join(dir, 'empty-bin'),
      Path: path.join(dir, 'empty-bin'),
    });
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stdout, /Installing dependencies failed/);
    assert.ok(fs.existsSync(path.join(dir, 'my-app', 'package.json')), 'the project was kept');
  }));

test('the Dockerfile installs from whichever lockfile the project has', () =>
  inTempDir((dir) => {
    assert.equal(create(dir, ['my-app', '--template', 'api', '--no-install', '--no-git', '--framework', '^0.5.0']).status, 0);
    const docker = fs.readFileSync(path.join(dir, 'my-app', 'Dockerfile'), 'utf8');
    for (const lockfile of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock']) assert.ok(docker.includes(`-f ${lockfile} ]`), lockfile);
    assert.match(docker, /No lockfile found/);
    assert.doesNotMatch(docker, /^RUN npm ci && /m);
  }));
