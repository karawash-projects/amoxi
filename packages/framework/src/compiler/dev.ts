// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import { fork, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, rmSync, statSync, watch, type FSWatcher } from 'node:fs';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import ts from 'typescript';
import { runBuild, formatDiagnostic, type BuildOptions } from './build';

export interface DevOptions extends Omit<BuildOptions, 'oldProgram' | 'precompress'> {
  /** Application entry source file, e.g. src/main.ts */
  entry: string;
}

/**
 * Watches a directory tree. Windows and macOS have native recursive watching. On Linux, Node
 * emulates it and loses track of files that editors save by replacing them (write + rename),
 * so there we watch every directory individually, which inotify handles reliably.
 */
function watchTree(root: string, isIgnored: (file: string) => boolean, onFile: (file: string) => void): () => void {
  if (process.platform !== 'linux') {
    const w = watch(root, { recursive: true }, (_event, name) => {
      if (name) onFile(path.resolve(root, name.toString()));
    });
    return () => w.close();
  }
  const watchers = new Map<string, FSWatcher>();
  const addTree = (dir: string): void => {
    if (watchers.has(dir) || isIgnored(dir)) return;
    try {
      const w = watch(dir, (_event, name) => {
        if (!name) return;
        const full = path.join(dir, name.toString());
        let isDir = false;
        try {
          isDir = statSync(full).isDirectory();
        } catch {
          const gone = watchers.get(full); // a watched directory was deleted
          if (gone) {
            gone.close();
            watchers.delete(full);
          }
        }
        if (isDir) addTree(full); // new directory: start watching it (and report its files below)
        onFile(full);
      });
      w.on('error', () => {
        w.close();
        watchers.delete(dir);
      });
      watchers.set(dir, w);
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) addTree(path.join(dir, entry.name));
      }
    } catch {
      /* directory vanished while scanning */
    }
  };
  addTree(root);
  return () => {
    for (const w of watchers.values()) w.close();
    watchers.clear();
  };
}

const time = (): string => new Date().toTimeString().slice(0, 8);
const log = (msg: string): void => void process.stdout.write(`\x1b[2m${time()}\x1b[0m ${msg}\n`);

/**
 * `amoxi dev`: watch sources, rebuild incrementally (reusing the previous TypeScript program),
 * transpile server code with esbuild (no type-check on the hot path), restart the app and
 * refresh connected browsers in place. Type errors are reported in the background.
 */
export async function runDev(o: DevOptions): Promise<void> {
  const projectDir = path.dirname(o.project);
  const devOut = path.join(projectDir, '.amoxi', 'dev');
  const entryJs = path.join(devOut, path.relative(projectDir, path.resolve(o.entry))).replace(/\.(tsx?|mts|cts)$/, '.js');
  const esbuild = await import('esbuild');
  rmSync(devOut, { recursive: true, force: true });

  let program: ts.Program | undefined;
  let child: ChildProcess | undefined;
  let building = false;
  let queued: string[] = [];
  let typecheckTimer: ReturnType<typeof setTimeout> | undefined;

  const stopChild = (): Promise<void> =>
    new Promise((resolve) => {
      const c = child;
      child = undefined;
      if (!c || c.exitCode !== null) return resolve();
      const timer = setTimeout(() => c.kill('SIGKILL'), 3000);
      c.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      if (c.connected) c.send({ type: 'amoxi:shutdown' });
      else c.kill('SIGTERM');
    });

  const startChild = (buildId: string): void => {
    const c = fork(entryJs, [], {
      cwd: projectDir,
      execArgv: ['--enable-source-maps'],
      env: { ...process.env, AMOXI_DEV: '1', AMOXI_BUILD_ID: buildId, AMOXI_ENV: process.env.AMOXI_ENV ?? 'development' },
      stdio: 'inherit',
    });
    c.on('exit', (code) => {
      if (child === c && code !== 0 && code !== null) log(`\x1b[31merror\x1b[0m app exited with code ${code}; waiting for changes`);
    });
    child = c;
  };

  const typecheck = (p: ts.Program): void => {
    clearTimeout(typecheckTimer);
    typecheckTimer = setTimeout(() => {
      const diags = ts.getPreEmitDiagnostics(p).filter((d) => !d.file || (!d.file.fileName.includes('/node_modules/') && path.resolve(d.file.fileName) !== path.resolve(o.outFile)));
      if (diags.length === 0) return;
      const host: ts.FormatDiagnosticsHost = { getCanonicalFileName: (f) => f, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n' };
      log(`\x1b[33mwarning\x1b[0m ${diags.length} type error(s) (the app is still running; fix before \`amoxi build\`)`);
      process.stdout.write(ts.formatDiagnosticsWithColorAndContext(diags.slice(0, 10), host));
    }, 300);
  };

  const build = async (reason: string): Promise<void> => {
    if (building) {
      queued.push(reason);
      return;
    }
    building = true;
    const t0 = performance.now();
    try {
      const result = await runBuild({ ...o, precompress: false, oldProgram: program });
      program = result.analysis.program;
      if (!result.ok) {
        log(`\x1b[31merror\x1b[0m ${result.diagnostics.length} problem(s) (${reason})`);
        process.stdout.write(result.diagnostics.map(formatDiagnostic).join('\n') + '\n');
        if (child?.connected) child.send({ type: 'amoxi:errors', errors: result.diagnostics });
        return;
      }
      // Fast server transpile (types are checked separately below).
      const files = [...program.getRootFileNames(), o.outFile].filter((f) => /\.(tsx?|mts|cts)$/.test(f) && !f.endsWith('.d.ts'));
      await esbuild.build({
        entryPoints: [...new Set(files)],
        outdir: devOut,
        outbase: projectDir,
        absWorkingDir: projectDir,
        format: 'cjs',
        platform: 'node',
        target: 'node22',
        sourcemap: 'inline',
        bundle: false,
        jsx: 'automatic',
        jsxImportSource: 'amoxi',
        tsconfig: o.project,
        logLevel: 'silent',
      });
      const tRestart = performance.now();
      await stopChild();
      startChild(Date.now().toString(36));
      log(`\x1b[32mok\x1b[0m ${reason}: rebuilt in ${(tRestart - t0).toFixed(0)}ms, restarted in ${(performance.now() - tRestart).toFixed(0)}ms`);
      // The analysis program was created before the generated module was (re)written, so it may
      // not contain it (always the case on a fresh project). Type-check a program that does,
      // and reuse it as the base for the next incremental rebuild.
      program = ts.createProgram({
        rootNames: [...new Set([...program.getRootFileNames(), o.outFile])],
        options: program.getCompilerOptions(),
        oldProgram: program,
      });
      typecheck(program);
    } catch (err) {
      log(`\x1b[31merror\x1b[0m build crashed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      building = false;
      if (queued.length > 0) {
        const next = queued[queued.length - 1];
        queued = [];
        void build(next);
      }
    }
  };

  log(`Amoxi dev server starting (${path.relative(process.cwd(), o.entry)})`);
  await build('startup');

  // Watch sources, public files and config. fs.watch is recursive on Windows, macOS and Linux (Node 20+).
  const ignored = [path.resolve(o.outFile), path.resolve(o.clientOut), path.join(projectDir, '.amoxi')];
  const generatedDir = path.dirname(path.resolve(o.outFile));
  if (generatedDir !== path.join(projectDir, 'src')) ignored.push(generatedDir); // output of our own builds
  const isIgnored = (f: string): boolean => ignored.some((i) => f === i || f.startsWith(i + path.sep)) || /[\\/](node_modules|dist)[\\/]/.test(f);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let changed = new Set<string>();
  const onFile = (full: string): void => {
    if (isIgnored(full) || /~$|\.swp$|\.tmp$|[\\/]\.#/.test(full)) return;
    changed.add(path.relative(projectDir, full));
    clearTimeout(timer);
    timer = setTimeout(() => {
      const list = [...changed];
      changed = new Set();
      void build(list.length === 1 ? list[0] : `${list.length} files changed`);
    }, 60);
  };
  const stops: Array<() => void> = [];
  for (const dir of ['src', 'public']) {
    const abs = path.join(projectDir, dir);
    if (existsSync(abs)) stops.push(watchTree(abs, isIgnored, onFile));
  }
  // Config and .env files in the project root (non-recursive).
  const rootWatcher: FSWatcher = watch(projectDir, (_event, filename) => {
    if (filename && /^(application.*\.json|\.env.*)$/.test(filename.toString())) onFile(path.join(projectDir, filename.toString()));
  });
  stops.push(() => rootWatcher.close());

  const exit = async (): Promise<void> => {
    stops.forEach((stop) => stop());
    await stopChild();
    process.exit(0);
  };
  process.once('SIGINT', () => void exit());
  process.once('SIGTERM', () => void exit());
}
