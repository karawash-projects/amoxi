// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';

export interface ExportOptions {
  projectDir: string;
  /** Compiled generated module, e.g. dist/src/generated/amoxi.generated.js */
  moduleFile: string;
  outDir: string;
  publicDir: string;
  /** Extra paths to render (pages with parameters that no link points to). */
  routes: string[];
  /** Fail (and remove the output) when a page depends on request-specific data, like Next.js does. */
  strict?: boolean;
  /**
   * Sub-path the site is served from (e.g. "/docs" for https://example.github.io/docs/), like
   * Next.js basePath. Links, assets and island bundles in the exported files are prefixed with it.
   */
  basePath?: string;
  /** Public URL of the site (e.g. https://example.com/docs), used for absolute links in the markdown copies and llms.txt. */
  siteUrl?: string;
}

/** Normalises a base path to "/a/b" (no trailing slash), or "" for the site root. */
export function normalizeBasePath(input: string | undefined): string {
  const trimmed = (input ?? '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  if (!/^\/[A-Za-z0-9._~\-/]*$/.test(trimmed) || trimmed.includes('//')) {
    throw new Error(`--base-path must look like /docs (got "${input}")`);
  }
  return trimmed;
}

/**
 * Prefixes root-relative URLs ("/x", not "//host/x") in exported HTML with the base path: link,
 * script, image and form URLs, srcset entries, meta refresh targets and the island manifest. A
 * <meta name="amoxi-base-path"> tag lets navigate() in islands resolve "/x" the same way.
 */
export function applyBasePathToHtml(html: string, base: string): string {
  if (!base) return html;
  const fix = (url: string): string => (url.startsWith('/') && !url.startsWith('//') && !url.startsWith(`${base}/`) && url !== base ? base + url : url);
  let out = html.replace(/(\s(?:href|src|action|poster|formaction)=")([^"]*)"/g, (_m, pre: string, url: string) => `${pre}${fix(url)}"`);
  out = out.replace(/(\ssrcset=")([^"]*)"/g, (_m, pre: string, list: string) => `${pre}${list.split(',').map((part) => part.trim().replace(/^\S+/, (u) => fix(u))).join(', ')}"`);
  out = out.replace(/(content="\d+;\s*url=)([^"]*)"/gi, (_m, pre: string, url: string) => `${pre}${fix(url)}"`);
  out = out.replace(/"\/_amoxi\//g, `"${base}/_amoxi/`); // island manifest in the inline bootstrap script
  out = out.replace(/(url\(\s*['"]?)(\/[^/'")][^'")]*)/g, (_m, pre: string, url: string) => `${pre}${fix(url)}`); // inline styles
  const meta = `<meta name="amoxi-base-path" content="${base}">`;
  return /<head[^>]*>/i.test(out) ? out.replace(/<head[^>]*>/i, (h) => `${h}${meta}`) : meta + out;
}

/** Prefixes root-relative url(...) references in a stylesheet. */
export function applyBasePathToCss(css: string, base: string): string {
  if (!base) return css;
  return css.replace(/(url\(\s*['"]?)(\/(?!\/)[^'")]*)/g, (_m, pre: string, url: string) => (url.startsWith(`${base}/`) ? pre + url : pre + base + url));
}

/** What each kind of request-specific data turns into on a static host. */
const USAGE: Record<string, string> = {
  session: 'read the session; the static copy shows what a first-time visitor sees',
  cookies: 'read cookies; static hosts serve the same file to everyone',
  query: 'read query parameters (?...); static hosts ignore them, so these pages always render as if none were given',
  headers: 'read request headers; the static copy reflects the exporter\'s request, not the visitor\'s',
  locale: `chose a language per visitor; only the default language was exported, and ?lang= links won't switch it`,
};

/**
 * `amoxi export`: renders every reachable @Page to static HTML. Starts the compiled app in
 * export mode (streamed sections inlined, no CSP nonces), renders pages without parameters,
 * follows links to discover the rest (e.g. /people/1), writes 404.html from @ErrorPage(404),
 * and copies public/ (including island bundles). Islands and client navigation keep working
 * on any static host; JSON API routes and anything needing a server do not.
 */
export async function runExport(o: ExportOptions): Promise<void> {
  const t0 = performance.now();
  const projectDir = path.resolve(o.projectDir);
  const basePath = normalizeBasePath(o.basePath);
  // Use the app's own copy of the framework so module state (page settings) is shared.
  const fw = require(require.resolve('amoxi', { paths: [projectDir] })) as typeof import('../runtime');
  const modulePath = path.resolve(projectDir, o.moduleFile);
  if (!existsSync(modulePath)) throw new Error(`${o.moduleFile} not found. Run your build first (amoxi build, then tsc).`);
  const { applicationModule } = require(modulePath) as { applicationModule: import('../runtime').ApplicationModule };

  const config = fw.Config.load({
    cwd: projectDir,
    argv: ['--server.port=0', '--server.host=127.0.0.1', '--amoxi.export=true', '--server.request-log=false', '--amoxi.management.enabled=false', '--server.compression=false'],
  });
  const app = await fw.AmoxiApplication.run(applicationModule, { config, shutdownHook: false, logger: new fw.Logger('warn') });
  const base = `http://127.0.0.1:${app.port}`;
  const router = new fw.Router(applicationModule.routes.filter((r) => r.page));
  const outDir = path.resolve(projectDir, o.outDir);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const strip = (html: string): string => html.replace(/ nonce="[^"]*"/g, '');
  const finish = (html: string): string => applyBasePathToHtml(strip(html), basePath);
  // The exporter renders through a local server; links in markdown and llms.txt must point at the real site.
  const siteUrl = (o.siteUrl ?? '').replace(/\/+$/, '') || basePath;
  const publicUrls = (text: string): string => text.split(base).join(siteUrl);
  const queue = [...new Set([...applicationModule.routes.filter((r) => r.page && r.pattern === null).map((r) => r.path), ...o.routes])];
  const seen = new Set<string>();
  const written: string[] = [];
  const skipped: string[] = [];
  const usage = new Map<string, string[]>();

  try {
    while (queue.length > 0) {
      const route = queue.shift()!;
      if (seen.has(route)) continue;
      seen.add(route);
      const res = await fetch(base + route, { headers: { accept: 'text/html' }, redirect: 'manual' });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        const target = location ? new URL(location, base).pathname : '/';
        // A redirect becomes a tiny page that forwards the browser.
        const file = route === '/' ? path.join(outDir, 'index.html') : path.join(outDir, route, 'index.html');
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=${basePath}${target}"><link rel="canonical" href="${basePath}${target}">`);
        written.push(`${route} -> ${target}`);
        queue.push(target);
        continue;
      }
      const type = res.headers.get('content-type') ?? '';
      if (res.status !== 200 || !type.includes('text/html')) {
        skipped.push(`${route} (${res.status})`);
        continue;
      }
      for (const what of (res.headers.get('x-amoxi-export-uses') ?? '').split(',').filter(Boolean)) {
        usage.set(what, [...(usage.get(what) ?? []), route]);
      }
      const html = strip(await res.text());
      const file = route === '/' ? path.join(outDir, 'index.html') : path.join(outDir, ...route.split('/').filter(Boolean), 'index.html');
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, applyBasePathToHtml(html, basePath));
      written.push(route);
      // Markdown copy for AI agents (llms.txt convention): /about -> about.md, / -> index.md.
      const md = await fetch(base + route, { headers: { accept: 'text/markdown' } });
      if (md.ok && (md.headers.get('content-type') ?? '').startsWith('text/markdown')) {
        const mdFile = route === '/' ? path.join(outDir, 'index.md') : path.join(outDir, ...route.split('/').filter(Boolean)) + '.md';
        writeFileSync(mdFile, publicUrls(await md.text()));
      }
      for (const m of html.matchAll(/href="(\/[^"#?]*)/g)) {
        const link = m[1].length > 1 && m[1].endsWith('/') ? m[1].slice(0, -1) : m[1];
        if (!seen.has(link) && router.match('GET', link)) queue.push(link);
      }
    }
    const llms = await fetch(`${base}/llms.txt`);
    if (llms.ok) {
      writeFileSync(path.join(outDir, 'llms.txt'), publicUrls(await llms.text()));
      written.push('llms.txt');
    }
    const notFound = await fetch(`${base}/__amoxi_export_404__`, { headers: { accept: 'text/html' } });
    if (notFound.status === 404 && (notFound.headers.get('content-type') ?? '').includes('text/html')) {
      // The 404 page was rendered for an internal probe URL; links back to "this page" (such as
      // language switches) can't work on a static host, so they point at the home page instead.
      writeFileSync(path.join(outDir, '404.html'), finish((await notFound.text()).split('/__amoxi_export_404__').join('/')));
      written.push('404.html');
    }
  } finally {
    await app.close();
  }

  const publicDir = path.resolve(projectDir, o.publicDir);
  if (existsSync(publicDir)) cpSync(publicDir, outDir, { recursive: true });
  if (basePath) {
    // Stylesheets may reference fonts and images by root-relative URL; their precompressed
    // copies would now be stale, so they're removed (static hosts compress on their own).
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (entry.name.endsWith('.css')) {
          const css = readFileSync(file, 'utf8');
          const fixed = applyBasePathToCss(css, basePath);
          if (fixed !== css) {
            writeFileSync(file, fixed);
            rmSync(`${file}.br`, { force: true });
            rmSync(`${file}.gz`, { force: true });
          }
        }
      }
    };
    walk(outDir);
  }

  const yellow = (s: string): string => `\x1b[33m${s}\x1b[0m`;
  const list = (paths: string[]): string => (paths.length > 6 ? `${paths.slice(0, 6).join(', ')} and ${paths.length - 6} more` : paths.join(', '));

  if (o.strict && usage.size > 0) {
    rmSync(outDir, { recursive: true, force: true });
    process.stderr.write(`\n\x1b[31merror\x1b[0m Export failed (--strict): some pages depend on the request, which a static site can't reproduce:\n`);
    for (const [what, paths] of usage) process.stderr.write(`    ${list(paths)}: ${USAGE[what] ?? what}\n`);
    process.stderr.write(`  Remove those dependencies from exported pages, or export without --strict to accept the differences.\n\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `\x1b[32mok\x1b[0m Exported ${written.length} page(s) to ${path.relative(process.cwd(), outDir) || '.'}${basePath ? ` for ${basePath}/` : ''} in ${(performance.now() - t0).toFixed(0)}ms\n`,
  );
  for (const w of written) process.stdout.write(`    ${w}\n`);
  if (skipped.length) process.stdout.write(`  Skipped: ${skipped.join(', ')}\n`);

  // Like any static export (Next.js output: 'export' included), the result is files only.
  if (usage.size > 0) {
    process.stdout.write(`\n${yellow('warning')} These pages behave differently as static files:\n`);
    for (const [what, paths] of usage) process.stdout.write(`    ${list(paths)}: ${USAGE[what] ?? what}\n`);
  }
  const api = applicationModule.routes.filter((r) => !r.page);
  const sockets = applicationModule.websockets ?? [];
  if (api.length > 0 || sockets.length > 0) {
    process.stdout.write(`\n${yellow('warning')} Not included, because they need a running server (true of every static export):\n`);
    if (api.length) process.stdout.write(`    API routes: ${api.map((r) => `${r.method} ${r.path}${r.multipart ? ' (upload)' : ''}`).join(', ')}\n`);
    if (sockets.length) process.stdout.write(`    WebSockets: ${sockets.map((s) => s.path).join(', ')}\n`);
    process.stdout.write(`    Islands that call these will show errors. Host the API separately (allow the site in server.cors.origins), or run the app with amoxi start instead of exporting.\n`);
  }
}
