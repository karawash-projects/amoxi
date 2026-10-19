// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { COMPILER_VERSION } from './version';

const HELP = `Amoxi v${COMPILER_VERSION}

Usage:
  amoxi build [options]          Analyse, validate and generate the app (run before tsc)
  amoxi dev [options]            Development server: rebuild + restart + live reload on save
  amoxi start [entry] [options]  Production: run the compiled app on every CPU core
  amoxi export [options]         Render every page to static HTML in out/ (after building)

Build/dev options:
  -p, --project <file>      tsconfig.json of the application   (default: tsconfig.json)
  -o, --out <file>          generated module                    (default: src/generated/amoxi.generated.ts)
      --islands <dir>       island components (browser code)    (default: src/islands)
      --styles <dir>        global stylesheets to bundle        (default: src/styles)
      --client-out <dir>    browser bundle output               (default: public/_amoxi)
      --public-path <p>     URL of the browser bundles          (default: /_amoxi/)
      --runtime <spec>      runtime module specifier            (default: amoxi)
      --entry <file>        (dev) application entry             (default: src/main.ts)
      --i18n <dir>          translation bundles                 (default: src/i18n)
      --openapi <file>      (build) also write the OpenAPI document to a file

Export options:
      --out-dir <dir>       output directory                    (default: out)
      --module <file>       compiled generated module           (default: dist/src/generated/amoxi.generated.js)
      --routes <a,b,...>    extra paths to render (pages nothing links to)
      --base-path <path>    serve the site from a sub-path, e.g. /docs (like Next.js basePath)
      --site-url <url>      public URL, for absolute links in llms.txt and the .md copies of pages
      --strict              fail if a page depends on the request (session, cookies, query, headers, language)
      --verbose             (build) print the resolved bean graph

Start options:
      --workers <n|auto>    worker processes                    (default: auto = one per CPU)
      --shutdown-timeout <ms>                                   (default: 10000)

  -v, --version             print the version
  -h, --help                print this help
`;

const BUILD_OPTIONS = ['project', 'out', 'islands', 'styles', 'client-out', 'public-path', 'runtime', 'i18n'];
/** Options each command accepts (anything else is a mistake, reported instead of silently ignored). */
const OPTIONS: Record<string, readonly string[]> = {
  build: [...BUILD_OPTIONS, 'openapi', 'verbose'],
  dev: [...BUILD_OPTIONS, 'entry'],
  start: ['workers', 'shutdown-timeout'],
  export: ['out-dir', 'module', 'routes', 'base-path', 'site-url', 'strict'],
};
const FLAGS = new Set(['verbose', 'help', 'strict', 'version']);
const ALL_OPTIONS = new Set(Object.values(OPTIONS).flat());

function fail(message: string): never {
  process.stderr.write(`amoxi: ${message}\nRun "amoxi --help" for the options.\n`);
  process.exit(1);
}

function parseArgs(argv: string[]): { positionals: string[]; opts: Record<string, string | boolean> } {
  const positionals: string[] = [];
  const opts: Record<string, string | boolean> = {};
  const alias: Record<string, string> = { p: 'project', o: 'out', v: 'version', h: 'help' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('-') || a === '-') {
      positionals.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const rawName = (eq === -1 ? a : a.slice(0, eq)).replace(/^-+/, '');
    const inline = eq === -1 ? undefined : a.slice(eq + 1);
    const name = a.startsWith('--') ? rawName : (alias[rawName] ?? rawName);
    if (FLAGS.has(name)) {
      opts[name] = true;
      continue;
    }
    if (!ALL_OPTIONS.has(name)) fail(`unknown option ${a.startsWith('--') ? '--' : '-'}${rawName}`);
    const value = inline ?? argv[i + 1];
    if (inline === undefined) i++;
    if (value === undefined || (inline === undefined && value.startsWith('-'))) fail(`option ${a} needs a value`);
    opts[name] = value;
  }
  return { positionals, opts };
}

/** Rejects options the command doesn't know, and values that make no sense. */
function validate(command: string, opts: Record<string, string | boolean>): void {
  const allowed = new Set([...OPTIONS[command], 'help', 'version']);
  for (const name of Object.keys(opts)) {
    if (!allowed.has(name)) fail(`unknown option --${name} for "amoxi ${command}"`);
  }
  if (command === 'start') {
    const workers = opts.workers;
    if (workers !== undefined && workers !== 'auto' && !/^[1-9]\d{0,3}$/.test(String(workers))) fail(`--workers must be "auto" or a number of workers (got "${workers}")`);
    const timeout = opts['shutdown-timeout'];
    if (timeout !== undefined && !/^\d{1,7}$/.test(String(timeout))) fail(`--shutdown-timeout must be a number of milliseconds (got "${timeout}")`);
  }
}

// Output piped into a command that stops reading early (amoxi build --verbose | head): exit quietly.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

async function main(): Promise<void> {
  const { positionals, opts } = parseArgs(process.argv.slice(2));
  if (opts.version) {
    process.stdout.write(`${COMPILER_VERSION}\n`);
    return;
  }
  const command = positionals[0] ?? 'build';
  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }
  if (!(command in OPTIONS)) fail(`unknown command "${command}" (use build, dev, start or export)`);
  validate(command, opts);
  const extra = positionals.slice(command === 'start' ? 2 : 1);
  if (extra.length > 0) fail(`unexpected argument "${extra[0]}" for "amoxi ${command}"`);

  if (command === 'start') {
    // Loaded lazily so production start-up never pulls in the TypeScript compiler.
    const { runCluster } = await import('./start');
    return runCluster(positionals[1] ?? 'dist/src/main.js', String(opts.workers ?? 'auto'), Number(opts['shutdown-timeout'] ?? 10000));
  }

  if (command === 'export') {
    const { runExport } = await import('./export');
    return runExport({
      projectDir: process.cwd(),
      moduleFile: (opts.module as string) ?? 'dist/src/generated/amoxi.generated.js',
      outDir: (opts['out-dir'] as string) ?? 'out',
      publicDir: 'public',
      routes: String(opts.routes ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      strict: opts.strict === true,
      basePath: typeof opts['base-path'] === 'string' ? opts['base-path'] : undefined,
      siteUrl: typeof opts['site-url'] === 'string' ? opts['site-url'] : undefined,
    });
  }

  const project = path.resolve((opts.project as string) ?? 'tsconfig.json');
  if (!existsSync(project)) {
    process.stderr.write(`amoxi: cannot find ${project}\n`);
    process.exit(1);
  }
  const common = {
    project,
    outFile: path.resolve((opts.out as string) ?? 'src/generated/amoxi.generated.ts'),
    islandsDir: path.resolve((opts.islands as string) ?? 'src/islands'),
    stylesDir: path.resolve((opts.styles as string) ?? 'src/styles'),
    clientOut: path.resolve((opts['client-out'] as string) ?? 'public/_amoxi'),
    publicPath: (opts['public-path'] as string) ?? '/_amoxi/',
    runtime: (opts.runtime as string) ?? 'amoxi',
    i18nDir: opts.i18n ? path.resolve(opts.i18n as string) : undefined,
  };

  if (command === 'dev') {
    const { runDev } = await import('./dev');
    return runDev({ ...common, entry: (opts.entry as string) ?? 'src/main.ts' });
  }

  const { runBuild, formatDiagnostic } = await import('./build');
  const result = await runBuild({ ...common, precompress: true, openapiFile: opts.openapi ? path.resolve(opts.openapi as string) : undefined });
  for (const w of result.warnings) process.stderr.write(`\x1b[33mwarning\x1b[0m ${w}\n`);
  if (!result.ok) {
    process.stderr.write(`\nAmoxi found ${result.diagnostics.length} problem(s):\n\n${result.diagnostics.map(formatDiagnostic).join('\n')}\n\n`);
    process.exit(1);
  }
  const { analysis, graph, client } = result;

  if (opts.verbose && graph) {
    const byIndex = new Map(analysis.beans.map((b) => [b.index, b]));
    process.stdout.write('\nResolved bean graph (topological order):\n');
    for (const bean of graph.ordered) {
      const deps = (graph.dependencies.get(bean.index) ?? []).map((i) => byIndex.get(i)!.name);
      const flags = [bean.scope, bean.eager && 'eager', bean.primary && 'primary', bean.qualifier && `named=${bean.qualifier}`, bean.middlewareOrder !== undefined && `middleware(${bean.middlewareOrder})`]
        .filter(Boolean)
        .join(', ');
      process.stdout.write(`  #${graph.idOf.get(bean.index)} ${bean.name} [${flags}]${deps.length ? ` <- ${deps.join(', ')}` : ''}\n`);
      for (const r of bean.routes) process.stdout.write(`       ${r.method.padEnd(6)} ${r.path}  -> ${r.methodName}()${r.page ? ' [page]' : ''}${r.cache ? ` [cached ${r.cache.ttl}s]` : ''}\n`);
    }
    process.stdout.write('\n');
  }

  const routes = analysis.beans.reduce((n, b) => n + b.routes.length, 0);
  const pages = analysis.beans.reduce((n, b) => n + b.routes.filter((r) => r.page).length, 0);
  const validated = analysis.beans.reduce((n, b) => n + b.routes.filter((r) => r.params.some((p) => p.kind === 'body' && p.schema)).length, 0);
  process.stdout.write(
    `\x1b[32mok\x1b[0m Amoxi AOT: ${analysis.beans.length} beans, ${routes} routes (${pages} pages, ${validated} validated bodies) ` +
      `from ${analysis.filesAnalyzed} files in ${result.ms.total.toFixed(0)}ms -> ${path.relative(process.cwd(), common.outFile)}\n`,
  );
  if (client?.files.length) {
    const kb = (n: number): string => `${(n / 1024).toFixed(1)} kB`;
    const sum = (list: typeof client.files): number => list.reduce((n, f) => n + f.gzip, 0);
    const js = client.files.filter((f) => f.name.endsWith('.js') && !f.reactOnly);
    const reactJs = client.files.filter((f) => f.reactOnly);
    const css = client.files.filter((f) => f.name.endsWith('.css'));
    const reactCount = analysis.islands.filter((i) => i.react).length;
    process.stdout.write(
      `\x1b[32mok\x1b[0m Browser: ${analysis.islands.length} islands${reactCount ? ` (${reactCount} React)` : ''}, ${css.length} stylesheet(s) in ${result.ms.client.toFixed(0)}ms; ` +
        `JS ${kb(sum(js))} + CSS ${kb(sum(css))} gzipped (precompressed .br/.gz written)\n`,
    );
    if (reactJs.length) process.stdout.write(`  React islands add ${kb(sum(reactJs))} gzipped, loaded only on pages that render one\n`);
    for (const f of client.files) process.stdout.write(`    ${f.name.padEnd(48)} ${kb(f.gzip).padStart(8)} gz${f.reactOnly ? '  (React)' : ''}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`amoxi: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
