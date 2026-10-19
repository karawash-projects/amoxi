// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

/** Processes and ports, the same way on Windows, macOS and Linux. */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

const isWin = process.platform === 'win32';

/** A free TCP port on 127.0.0.1. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
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

/**
 * Runs a command to completion and captures its output, without a shell (see
 * packageManagerCommand). Never throws for a non-zero exit: the caller decides.
 */
export function run(cmd, args, { cwd, env, timeoutMs = 10 * 60_000, input } = {}) {
  return new Promise((resolve) => {
    let command;
    try {
      command = packageManagerCommand(cmd, args);
    } catch (err) {
      resolve({ code: 1, signal: null, output: String(err.message) });
      return;
    }
    const child = spawn(command.file, command.args, { cwd, env: { ...process.env, ...env }, windowsHide: true, windowsVerbatimArguments: command.windowsVerbatimArguments });
    let out = '';
    const append = (d) => {
      out += d;
      if (out.length > 4_000_000) out = out.slice(-2_000_000);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
    const timer = setTimeout(() => {
      append(`\n[verify] timed out after ${timeoutMs} ms\n`);
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (err) => append(`\n[verify] ${err.message}\n`));
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? (signal ? 1 : 0), signal, output: out.replace(/\x1b\[[0-9;]*m/g, '') });
    });
  });
}

/**
 * A long-running server process with an IPC channel, so it can be stopped gracefully on every
 * OS (Amoxi processes accept { type: 'amoxi:shutdown' }).
 */
export class ServerProcess {
  constructor(name, child) {
    this.name = name;
    this.child = child;
    this.log = '';
    this.exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
    const append = (d) => {
      this.log += d;
      if (this.log.length > 2_000_000) this.log = this.log.slice(-1_000_000);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
  }

  /** Starts `node <args>` in `cwd`; resolves once `readyUrl` answers 2xx. */
  static async start(name, args, { cwd, env, readyUrl, timeoutMs = 30_000 }) {
    const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
    const server = new ServerProcess(name, child);
    const deadline = Date.now() + timeoutMs;
    let exited = false;
    server.exited.then(() => (exited = true));
    while (Date.now() < deadline) {
      if (exited) throw new Error(`${name} exited during start-up:\n${server.tail()}`);
      try {
        const res = await fetch(readyUrl, { signal: AbortSignal.timeout(2000) });
        await res.arrayBuffer();
        if (res.ok) return server;
      } catch {
        /* not listening yet */
      }
      await sleep(150);
    }
    server.kill();
    throw new Error(`${name} did not become ready within ${timeoutMs} ms:\n${server.tail()}`);
  }

  get pid() {
    return this.child.pid;
  }

  tail(lines = 30) {
    return this.log.replace(/\x1b\[[0-9;]*m/g, '').trim().split('\n').slice(-lines).join('\n');
  }

  /** Graceful stop over IPC; resolves with the exit code, or kills after `timeoutMs`. */
  async stop(timeoutMs = 15_000) {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return this.exited;
    try {
      this.child.send({ type: 'amoxi:shutdown' });
    } catch {
      this.child.kill();
    }
    const timer = setTimeout(() => this.kill(), timeoutMs);
    const result = await this.exited;
    clearTimeout(timer);
    return result;
  }

  /** Hard kill (simulates a crash). */
  kill() {
    try {
      this.child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    return this.exited;
  }
}

export { sleep };
