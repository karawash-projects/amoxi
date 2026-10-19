// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import type ts from 'typescript';
import { analyzeProject, type AnalysisResult } from './analyzer';
import { bundleClient, type ClientBundleResult } from './client-bundler';
import { generateModule } from './codegen';
import { loadBundles } from './i18n';
import { generateOpenApi } from './openapi';
import type { Diagnostic } from './model';
import { validateGraph, type ResolvedGraph } from './validator';

export interface BuildOptions {
  project: string;
  outFile: string;
  islandsDir: string;
  stylesDir: string;
  clientOut: string;
  publicPath: string;
  runtime: string;
  precompress: boolean;
  /** Translation bundles directory (default src/i18n). */
  i18nDir?: string;
  /** Also write the OpenAPI document to this file. */
  openapiFile?: string;
  oldProgram?: ts.Program;
}

export interface BuildResult {
  ok: boolean;
  diagnostics: Diagnostic[];
  analysis: AnalysisResult;
  graph?: ResolvedGraph;
  client?: ClientBundleResult;
  /** Whether the generated module changed on disk. */
  changed: boolean;
  warnings: string[];
  ms: { total: number; client: number };
}

/**
 * The session key for this checkout: created once in .amoxi/session.key (git-ignored) and reused,
 * so dev restarts and rebuilds keep you logged in. A fresh checkout (CI, Docker) gets a new key,
 * just as Next.js generates its Server Actions key per build.
 */
function sessionKeyFor(projectDir: string): string {
  const file = path.join(projectDir, '.amoxi', 'session.key');
  try {
    const existing = readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(existing)) return existing;
  } catch {
    /* not created yet */
  }
  const key = randomBytes(32).toString('hex');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${key}\n`, { mode: 0o600 });
  return key;
}

/** Analysis -> validation -> browser bundles -> generated module. Shared by `build` and `dev`. */
export async function runBuild(o: BuildOptions): Promise<BuildResult> {
  const t0 = performance.now();
  const projectDir = path.dirname(o.project);
  const i18n = loadBundles(o.i18nDir ?? path.join(projectDir, 'src', 'i18n'));
  const analysis = analyzeProject(o.project, o.outFile, {
    islandsDir: existsSync(o.islandsDir) ? o.islandsDir : undefined,
    stylesDir: existsSync(o.stylesDir) ? o.stylesDir : undefined,
    oldProgram: o.oldProgram,
    i18nKeys: i18n.bundle ? new Set(Object.keys(i18n.bundle.messages[i18n.bundle.defaultLocale])) : undefined,
  });
  const graph = validateGraph(analysis.beans);
  const diagnostics = [...i18n.diagnostics, ...analysis.diagnostics, ...graph.diagnostics];

  let client: ClientBundleResult | undefined;
  const tClient = performance.now();
  if (diagnostics.length === 0) {
    client = await bundleClient({
      projectDir: path.dirname(o.project),
      islands: analysis.islands,
      outDir: o.clientOut,
      publicPath: o.publicPath,
      stylesDir: existsSync(o.stylesDir) ? o.stylesDir : undefined,
      precompress: o.precompress,
      mode: o.precompress ? 'production' : 'development', // amoxi dev keeps React's warnings
    });
    diagnostics.push(...client.diagnostics);
  }
  const clientMs = performance.now() - tClient;

  let changed = false;
  if (diagnostics.length === 0) {
    let info = { title: path.basename(projectDir), version: '0.0.0' };
    try {
      const pkg = JSON.parse(readFileSync(path.join(projectDir, 'package.json'), 'utf8')) as { name?: string; version?: string };
      info = { title: pkg.name ?? info.title, version: pkg.version ?? info.version };
    } catch {
      /* no package.json */
    }
    const openapi = generateOpenApi(graph.ordered, info);
    if (o.openapiFile) writeFileSync(o.openapiFile, `${JSON.stringify(openapi, null, 2)}\n`);
    const hasApi = Object.keys((openapi as { paths: object }).paths).length > 0;
    const code = generateModule(graph, {
      outFile: o.outFile,
      runtimeModule: o.runtime,
      client: client?.manifest,
      i18n: i18n.bundle,
      openapi: hasApi ? openapi : undefined,
      sessionKey: sessionKeyFor(projectDir),
      reactIslands: analysis.islands.filter((i) => i.react),
      ai: analysis.usesAi ? { islands: analysis.islands } : undefined,
    });
    mkdirSync(path.dirname(o.outFile), { recursive: true });
    const strip = (s: string): string => s.replace(/generatedAt: "[^"]*"/, '');
    if (!existsSync(o.outFile) || strip(readFileSync(o.outFile, 'utf8')) !== strip(code)) {
      writeFileSync(o.outFile, code);
      changed = true;
    }
  }
  return { ok: diagnostics.length === 0, diagnostics, analysis, graph, client, changed, warnings: i18n.warnings, ms: { total: performance.now() - t0, client: clientMs } };
}

export function formatDiagnostic(d: Diagnostic): string {
  return `  \x1b[31merror\x1b[0m AMOXI: ${d.loc ? `${d.loc.file}:${d.loc.line} - ` : ''}${d.message}`;
}
