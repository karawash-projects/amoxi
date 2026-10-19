// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import cluster, { type Worker } from 'node:cluster';
import { availableParallelism } from 'node:os';
import * as path from 'node:path';
import { Config } from '../runtime/config';
import { isPortFree } from '../runtime/port';

const log = (msg: string): void =>
  void process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), level: 'info', msg: `[cluster] ${msg}`, pid: process.pid })}\n`);

/**
 * `amoxi start`: runs the app on every CPU core with node:cluster. Crashed workers are
 * restarted (with a crash-loop guard); SIGINT/SIGTERM drain all workers gracefully.
 * Shutdown is requested over IPC, which also works on Windows.
 */
export async function runCluster(entry: string, workersOption: string, shutdownTimeoutMs: number): Promise<void> {
  // Like `next start`: production unless told otherwise. Workers inherit this environment.
  process.env.NODE_ENV ??= 'production';

  // Check the port once, before starting any worker, so a busy port gives one clear message
  // instead of every worker crashing.
  const config = Config.load();
  const port = config.number('server.port', '8080');
  if (port !== 0 && !(await isPortFree(port, config.string('server.host', '0.0.0.0')))) {
    process.stderr.write(`\nPort ${port} is already in use by another program. Stop it, or choose another port with SERVER_PORT=<port> (or server.port in application.json).\n\n`);
    process.exit(1);
  }

  const count = workersOption === 'auto' ? availableParallelism() : Math.max(1, Number.parseInt(workersOption, 10) || 1);
  cluster.setupPrimary({ exec: path.resolve(entry) });

  let stopping = false;
  let exitCode = 0;
  const crashes: number[] = [];
  const workers = (): Worker[] => Object.values(cluster.workers ?? {}).filter((w): w is Worker => !!w);
  // Workers that started serving. A worker that dies before listening points to a startup problem
  // (bad config, port, missing file); one that dies later is a runtime crash.
  const served = new WeakSet<Worker>();
  let failedStarts = 0;
  cluster.on('listening', (worker) => {
    served.add(worker);
    failedStarts = 0;
  });

  // Workers learn how many of them there are (e.g. to warn about per-process state).
  const fork = (): Worker => cluster.fork({ AMOXI_WORKERS: String(count) });
  for (let i = 0; i < count; i++) fork();
  log(`started ${count} worker(s) for ${entry}`);

  cluster.on('exit', (worker, code, signal) => {
    if (stopping) {
      if (workers().length === 0) process.exit(exitCode);
      return;
    }
    if (!served.has(worker)) {
      // Nothing will get better by restarting a worker that can't start: give up after a few tries.
      if (++failedStarts >= Math.max(3, count)) {
        log('workers keep failing during startup; stopping. Check the logs above for the cause.');
        stop(1);
        return;
      }
    }
    // Running workers are always replaced, so a crash (even a repeated, remotely triggered one)
    // never leaves the service down; frequent crashes only slow the restarts down (up to 30 s).
    const now = Date.now();
    crashes.push(now);
    while (crashes.length && crashes[0] < now - 60_000) crashes.shift();
    const delay = crashes.length > 10 ? Math.min(30_000, 250 * 2 ** Math.min(7, crashes.length - 10)) : 250;
    if (crashes.length === 11) log('more than 10 worker crashes in a minute; check the logs for the cause. Restarts are now delayed.');
    log(`worker ${worker.process.pid} exited (${signal ?? code}); starting a replacement${delay > 250 ? ` in ${Math.round(delay / 1000)} s` : ''}`);
    setTimeout(() => {
      if (!stopping) fork();
    }, delay);
  });

  const stop = (code = 0): void => {
    if (stopping) return;
    stopping = true;
    exitCode = code;
    log('draining workers');
    for (const w of workers()) {
      if (w.isConnected()) w.send({ type: 'amoxi:shutdown' });
    }
    setTimeout(() => {
      for (const w of workers()) w.process.kill('SIGKILL');
      process.exit(code);
    }, shutdownTimeoutMs + 2000).unref();
    if (workers().length === 0) process.exit(code);
  };
  process.once('SIGINT', () => stop(0));
  process.once('SIGTERM', () => stop(0));
  // Process managers and tests that started us with an IPC channel can ask for a graceful stop.
  // This is the only graceful option on Windows, where signals can't be sent to other processes.
  process.on('message', (m: { type?: string }) => {
    if (m?.type === 'amoxi:shutdown') stop(0);
  });
}
