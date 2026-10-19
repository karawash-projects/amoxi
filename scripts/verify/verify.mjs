#!/usr/bin/env node
// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

/**
 * Amoxi release verification: everything a company would want checked before running the
 * framework in production, in one command.
 *
 *   npm run verify                 full run (about 10-20 minutes)
 *   npm run verify -- --quick      static checks, build, unit tests, packaging, production smoke
 *   npm run verify -- --list       list the stages
 *   npm run verify -- --only security,load
 *   npm run verify -- --skip e2e
 *
 * Each stage runs named checks; a failed check fails the run (exit code 1) but later checks and
 * stages still run, so one report lists every problem. A Markdown and JSON report is written to
 * verify-report/ (or --report <dir>).
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, tmpdir, totalmem } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { ServerProcess } from './lib/proc.mjs';
import { STAGES } from './stages/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const green = paint(32);
const red = paint(31);
const yellow = paint(33);
const dim = paint(2);
const bold = paint(1);

function parseArgs(argv) {
  const o = { quick: false, only: undefined, skip: [], report: path.join(ROOT, 'verify-report'), keep: false, list: false, bail: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => (a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[++i]);
    if (a === '--quick') o.quick = true;
    else if (a === '--keep') o.keep = true;
    else if (a === '--list') o.list = true;
    else if (a === '--bail') o.bail = true;
    else if (a.startsWith('--only')) o.only = value().split(',').map((s) => s.trim());
    else if (a.startsWith('--skip')) o.skip = value().split(',').map((s) => s.trim());
    else if (a.startsWith('--report')) o.report = path.resolve(value());
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new Error(`Unknown option ${a} (see --help)`);
  }
  return o;
}

/**
 * In GitHub Actions, a failed check is also written as an error annotation, so the failure and
 * its details show on the run's summary page (and through the API) without opening the logs.
 */
function githubAnnotation(title, text) {
  if (process.env.GITHUB_ACTIONS !== 'true') return;
  const esc = (v) => v.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  const body = text.length > 6000 ? `...${text.slice(-6000)}` : text;
  process.stdout.write(`::error title=${esc(title).replace(/:/g, '%3A').replace(/,/g, '%2C')}::${esc(body)}\n`);
}

const ms = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`);

/** What a stage gets: named checks, metrics, temp folders and servers that are always stopped. */
class StageContext {
  constructor(stage, run) {
    this.stage = stage;
    this.runState = run;
    this.root = ROOT;
    this.options = run.options;
    this.shared = run.shared;
    this.assert = assert;
    this.result = { id: stage.id, title: stage.title, status: 'passed', checks: [], metrics: [], notes: [], ms: 0 };
    this.servers = [];
    this.tmpDirs = [];
  }

  /** A temporary directory removed after the run (unless --keep). */
  tmp(prefix = 'amoxi-verify-') {
    const dir = mkdtempSync(path.join(tmpdir(), prefix));
    this.runState.tmpDirs.push(dir);
    return dir;
  }

  /** Runs one named check. Failures are recorded, never thrown. Returns the check's value. */
  /** Runs one check. A check that takes longer than `timeoutMs` (default 10 minutes) fails instead of hanging the suite. */
  async check(name, fn, { timeoutMs = 10 * 60_000 } = {}) {
    const t0 = performance.now();
    let timer;
    try {
      const value = await Promise.race([
        fn(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timed out after ${ms(timeoutMs)}`)), timeoutMs);
          timer.unref?.();
        }),
      ]);
      clearTimeout(timer);
      const took = performance.now() - t0;
      this.result.checks.push({ name, status: 'passed', ms: took });
      process.stdout.write(`  ${green('PASS')} ${name} ${dim(`(${ms(took)})`)}\n`);
      return value;
    } catch (err) {
      clearTimeout(timer);
      const took = performance.now() - t0;
      const message = err instanceof assert.AssertionError ? (err.message.split('\n')[0] || 'assertion failed') : err instanceof Error ? err.message : String(err);
      const detail = err?.detail ?? (err instanceof assert.AssertionError && err.actual !== undefined ? `expected: ${short(err.expected)}\nactual:   ${short(err.actual)}` : undefined);
      this.result.checks.push({ name, status: 'failed', ms: took, message, detail });
      githubAnnotation(`${this.stage.title}: ${name}`, `${message}${detail ? `\n${detail}` : ''}`);
      this.result.status = 'failed';
      process.stdout.write(`  ${red('FAIL')} ${name}: ${message}\n`);
      if (detail) process.stdout.write(`${dim(indent(detail, 6))}\n`);
      if (this.options.bail) throw new BailOut();
      return undefined;
    }
  }

  metric(name, value, unit = '', limit) {
    this.result.metrics.push({ name, value, unit, limit });
    process.stdout.write(`  ${dim('•')} ${name}: ${bold(`${value}${unit ? ` ${unit}` : ''}`)}${limit ? dim(` (limit ${limit})`) : ''}\n`);
  }

  note(text) {
    this.result.notes.push(text);
    process.stdout.write(`  ${dim('i')} ${dim(text)}\n`);
  }

  /** Skips the rest of the stage with a reason (e.g. an optional tool isn't installed). */
  skip(reason) {
    throw new SkipStage(reason);
  }

  /** Starts a server process that is stopped when the stage ends. */
  async server(name, args, opts) {
    const s = await ServerProcess.start(name, args, opts);
    this.servers.push(s);
    return s;
  }

  async cleanup() {
    for (const s of this.servers.reverse()) await s.stop(10_000).catch(() => undefined);
  }
}

class SkipStage extends Error {}
class BailOut extends Error {}

function short(v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > 300 ? `${s.slice(0, 300)}…` : s;
}
function indent(s, n) {
  return String(s)
    .split('\n')
    .map((l) => ' '.repeat(n) + l)
    .join('\n');
}

function writeReport(run, dir) {
  mkdirSync(dir, { recursive: true });
  const summary = summarize(run.results);
  const json = { ...run.meta, summary, stages: run.results };
  writeFileSync(path.join(dir, 'report.json'), `${JSON.stringify(json, null, 2)}\n`);
  const lines = [];
  lines.push(`# Amoxi verification report`, '');
  lines.push(`**Result: ${summary.failed === 0 ? 'PASSED' : 'FAILED'}** (${summary.checksPassed} of ${summary.checks} checks passed, ${summary.skipped} stage(s) skipped)`, '');
  lines.push(`| | |`, `|---|---|`);
  for (const [k, v] of Object.entries(run.meta)) lines.push(`| ${k} | ${String(v).replace(/\|/g, '\\|')} |`);
  lines.push('', '## Stages', '', '| Stage | Result | Checks | Time |', '|---|---|---|---|');
  for (const r of run.results) {
    const passed = r.checks.filter((c) => c.status === 'passed').length;
    lines.push(`| ${r.title} | ${r.status === 'passed' ? 'Passed' : r.status === 'skipped' ? `Skipped: ${r.reason}` : '**Failed**'} | ${passed}/${r.checks.length} | ${ms(r.ms)} |`);
  }
  const failures = run.results.flatMap((r) => r.checks.filter((c) => c.status === 'failed').map((c) => ({ stage: r.title, ...c })));
  if (failures.length) {
    lines.push('', '## Failures', '');
    for (const f of failures) {
      lines.push(`### ${f.stage}: ${f.name}`, '', f.message, '');
      if (f.detail) lines.push('```', String(f.detail).slice(0, 6000), '```', '');
    }
  }
  for (const r of run.results) {
    if (!r.metrics.length && !r.notes.length) continue;
    lines.push('', `## ${r.title}`, '');
    if (r.metrics.length) {
      lines.push('| Metric | Value | Limit |', '|---|---|---|');
      for (const m of r.metrics) lines.push(`| ${m.name} | ${m.value}${m.unit ? ` ${m.unit}` : ''} | ${m.limit ?? ''} |`);
      lines.push('');
    }
    for (const n of r.notes) lines.push(`- ${n}`);
  }
  lines.push('', '## All checks', '');
  for (const r of run.results) {
    lines.push(`**${r.title}**`, '');
    for (const c of r.checks) lines.push(`- ${c.status === 'passed' ? 'PASS' : 'FAIL'} ${c.name}${c.status === 'failed' ? `: ${c.message}` : ''}`);
    lines.push('');
  }
  writeFileSync(path.join(dir, 'report.md'), `${lines.join('\n')}\n`);
}

function summarize(results) {
  const checks = results.flatMap((r) => r.checks);
  return {
    stages: results.length,
    failed: results.filter((r) => r.status === 'failed').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    checks: checks.length,
    checksPassed: checks.filter((c) => c.status === 'passed').length,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`Usage: npm run verify -- [--quick] [--only a,b] [--skip a,b] [--report <dir>] [--keep] [--bail] [--list]\n`);
    return;
  }
  if (options.list) {
    for (const s of STAGES) process.stdout.write(`${s.id.padEnd(12)} ${s.quick ? 'quick' : 'full '}  ${s.title}: ${dim(s.description)}\n`);
    return;
  }
  const selected = STAGES.filter((s) => (options.only ? options.only.includes(s.id) : (!options.quick || s.quick) && !options.skip.includes(s.id)));
  if (options.only) for (const id of options.only) if (!STAGES.some((s) => s.id === id)) throw new Error(`Unknown stage '${id}' (see --list)`);

  const run = {
    options,
    shared: {},
    results: [],
    tmpDirs: [],
    meta: {
      Started: new Date().toISOString(),
      Mode: options.only ? `only ${options.only.join(', ')}` : options.quick ? 'quick' : 'full',
      'Node.js': process.version,
      Platform: `${platform()} ${release()} (${process.arch})`,
      CPUs: `${cpus().length} × ${cpus()[0]?.model ?? 'unknown'}`,
      Memory: `${Math.round(totalmem() / 1024 ** 3)} GB`,
    },
  };

  process.stdout.write(`\n${bold('Amoxi verification')} ${dim(`(${run.meta.Mode}, ${selected.length} stages)`)}\n`);
  const t0 = performance.now();
  let bailed = false;
  for (const stage of selected) {
    const ctx = new StageContext(stage, run);
    process.stdout.write(`\n${bold(`== ${stage.title}`)} ${dim(stage.description)}\n`);
    const started = performance.now();
    const missing = (stage.needs ?? []).filter((id) => run.results.some((r) => r.id === id && r.status === 'failed'));
    try {
      if (missing.length) ctx.skip(`needs ${missing.join(', ')}, which failed`);
      if (bailed) ctx.skip('stopped after the first failure (--bail)');
      await stage.run(ctx);
    } catch (err) {
      if (err instanceof SkipStage) {
        ctx.result.status = 'skipped';
        ctx.result.reason = err.message;
        process.stdout.write(`  ${yellow('-')} skipped: ${err.message}\n`);
      } else if (err instanceof BailOut) {
        bailed = true;
      } else {
        ctx.result.status = 'failed';
        ctx.result.checks.push({ name: 'stage crashed', status: 'failed', ms: 0, message: err instanceof Error ? err.message : String(err), detail: err?.stack });
        process.stdout.write(`  ${red('FAIL')} stage crashed: ${err instanceof Error ? err.stack : err}\n`);
        githubAnnotation(`${stage.title}: stage crashed`, String(err instanceof Error ? err.stack : err));
      }
    } finally {
      await ctx.cleanup();
    }
    ctx.result.ms = performance.now() - started;
    run.results.push(ctx.result);
  }

  run.meta.Duration = ms(performance.now() - t0);
  writeReport(run, options.report);
  if (!options.keep) for (const d of run.tmpDirs) rmSync(d, { recursive: true, force: true });

  const summary = summarize(run.results);
  process.stdout.write(`\n${bold('Summary')}\n`);
  for (const r of run.results) {
    const passed = r.checks.filter((c) => c.status === 'passed').length;
    const mark = r.status === 'passed' ? green('passed ') : r.status === 'skipped' ? yellow('skipped') : red('FAILED ');
    process.stdout.write(`  ${mark}  ${r.title.padEnd(34)} ${dim(`${passed}/${r.checks.length} checks, ${ms(r.ms)}`)}\n`);
  }
  const ok = summary.failed === 0;
  process.stdout.write(
    `\n${ok ? green(bold('PASSED')) : red(bold('FAILED'))}: ${summary.checksPassed}/${summary.checks} checks passed in ${run.meta.Duration}. Report: ${path.relative(process.cwd(), path.join(options.report, 'report.md'))}\n\n`,
  );
  process.exitCode = ok ? 0 : 1;
}

main().catch((err) => {
  process.stderr.write(`${red('verify failed to run:')} ${err instanceof Error ? err.stack : err}\n`);
  process.exitCode = 2;
});
