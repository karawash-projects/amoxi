// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import type { Diagnostic } from './model';

export interface ClientBundleResult {
  readonly manifest?: { hydrate: string; islands: Record<string, string>; styles: Record<string, string> };
  readonly files: ReadonlyArray<{ name: string; bytes: number; gzip: number; reactOnly?: boolean }>;
  readonly diagnostics: Diagnostic[];
}

export interface ClientBundleOptions {
  readonly projectDir: string;
  readonly islands: ReadonlyArray<{ name: string; file: string; react?: boolean }>;
  /** Absolute output directory, e.g. <project>/public/_amoxi */
  readonly outDir: string;
  /** URL prefix the output directory is served under, e.g. /_amoxi/ */
  readonly publicPath: string;
  /** Global stylesheets: every *.css directly in this directory (except _partials) is bundled. */
  readonly stylesDir?: string;
  /** Write .br and .gz next to each output (production builds). */
  readonly precompress?: boolean;
  /** 'development' keeps React's development build (better warnings); default 'production'. */
  readonly mode?: 'development' | 'production';
}

const REACT_ENTRY = 'amoxi-react-island:';

/**
 * Bundles every island (plus the tiny hydration runtime) for the browser with esbuild.
 *
 * Inside these bundles `amoxi` resolves to the browser runtime, which contains
 * only signals, JSX-to-DOM and island helpers. Importing server-only APIs (decorators, HTTP,
 * the container) or Node built-ins from an island therefore fails the build, so server code
 * can never leak into the browser.
 */
export async function bundleClient(options: ClientBundleOptions): Promise<ClientBundleResult> {
  rmSync(options.outDir, { recursive: true, force: true });
  const styles =
    options.stylesDir && existsSync(options.stylesDir)
      ? readdirSync(options.stylesDir)
          .filter((f) => f.endsWith('.css') && !f.startsWith('_'))
          .map((f) => path.join(options.stylesDir!, f))
      : [];
  if (options.islands.length === 0 && styles.length === 0) return { files: [], diagnostics: [] };

  // The browser runtime ships as TypeScript source so esbuild can tree-shake it as ESM.
  const clientDir = path.resolve(__dirname, '../../src/client');
  if (!existsSync(path.join(clientDir, 'index.ts'))) {
    return { files: [], diagnostics: [{ message: `Amoxi browser runtime not found at ${clientDir}` }] };
  }
  const hydrateEntry = path.join(clientDir, 'hydrate.ts');

  const react = options.islands.filter((i) => i.react);
  if (react.length > 0) {
    // Look the packages up the way the bundler will: node_modules folders from the project upwards.
    const installed = (pkg: string): boolean => {
      for (let dir = path.resolve(options.projectDir); ; dir = path.dirname(dir)) {
        if (existsSync(path.join(dir, 'node_modules', pkg, 'package.json'))) return true;
        if (path.dirname(dir) === dir) return false;
      }
    };
    const missing = ['react', 'react-dom'].filter((pkg) => !installed(pkg));
    if (missing.length > 0) {
      const file = path.relative(process.cwd(), react[0].file);
      return {
        files: [],
        diagnostics: [
          {
            message: `React islands (${react.map((i) => path.basename(i.file)).join(', ')}) need ${missing.join(' and ')} installed in your app: npm install react react-dom, then npm install -D @types/react @types/react-dom`,
            loc: { file, line: 1 },
          },
        ],
      };
    }
  }

  const esbuild = await import('esbuild');
  const amoxiClient = {
    name: 'amoxi-client',
    setup(build: import('esbuild').PluginBuild) {
      // url(/fonts/x.woff2) in a stylesheet refers to a file served from public/: keep it as is.
      build.onResolve({ filter: /^\/[^/]/ }, (args) => (args.kind === 'url-token' || args.kind === 'import-rule' ? { path: args.path, external: true } : undefined));
      build.onResolve({ filter: /^amoxi(\/jsx-(dev-)?runtime)?$/ }, (args) => ({
        path: path.join(clientDir, args.path.includes('jsx-') ? 'jsx-runtime.ts' : 'index.ts'),
      }));
      // React islands get a tiny entry that hydrates the server HTML with React. React itself
      // ends up in a chunk shared only by React islands, so other pages never download it.
      build.onResolve({ filter: /^amoxi-react-island:/ }, (args) => ({ path: args.path.slice(REACT_ENTRY.length), namespace: 'amoxi-react' }));
      build.onLoad({ filter: /.*/, namespace: 'amoxi-react' }, (args) => ({
        resolveDir: path.dirname(args.path),
        loader: 'js',
        contents:
          `import Component from ${JSON.stringify(args.path)};\n` +
          `import { createElement } from 'react';\n` +
          `import { createRoot, hydrateRoot } from 'react-dom/client';\n` +
          // Server-rendered markup is hydrated; an empty element (an island an agent just showed) is rendered fresh.
          `export default { __amoxiMount(el, props) { const node = createElement(Component, props); const ssr = el.firstChild !== null; const root = ssr ? hydrateRoot(el, node) : createRoot(el); if (!ssr) root.render(node); return () => root.unmount(); } };\n`,
      }));
    },
  };

  try {
    const result = await esbuild.build({
      absWorkingDir: options.projectDir,
      entryPoints: [hydrateEntry, ...options.islands.map((i) => (i.react ? REACT_ENTRY + path.resolve(i.file) : i.file)), ...styles],
      bundle: true,
      splitting: true,
      format: 'esm',
      platform: 'browser',
      target: ['es2020', 'chrome90', 'firefox90', 'safari15'],
      loader: { '.woff2': 'file', '.woff': 'file', '.svg': 'file', '.png': 'file', '.jpg': 'file', '.webp': 'file' },
      minify: true,
      sourcemap: false,
      jsx: 'automatic',
      jsxImportSource: 'amoxi', // React islands switch per file with /** @jsxImportSource react */
      define: { 'process.env.NODE_ENV': JSON.stringify(options.mode ?? 'production') },
      outdir: options.outDir,
      entryNames: '[name]-[hash]',
      chunkNames: 'chunks/[name]-[hash]',
      metafile: true,
      logLevel: 'silent',
      plugins: [amoxiClient],
    });

    const toUrl = (out: string): string =>
      options.publicPath + path.relative(options.outDir, path.resolve(options.projectDir, out)).split(path.sep).join('/');
    const manifest = { hydrate: '', islands: {} as Record<string, string>, styles: {} as Record<string, string> };
    const files: Array<{ name: string; bytes: number; gzip: number; reactOnly?: boolean }> = [];
    // Outputs reachable from the hydrate entry or an Amoxi island load on ordinary pages; anything
    // else (React island entries and React's own chunk) loads only where a React island is used.
    const outputs = result.metafile.outputs;
    const common = new Set<string>();
    const visit = (out: string): void => {
      if (common.has(out) || !outputs[out]) return;
      common.add(out);
      for (const imp of outputs[out].imports) visit(imp.path);
    };
    for (const [out, meta] of Object.entries(outputs)) {
      if (meta.entryPoint && !meta.entryPoint.startsWith('amoxi-react:') && !out.endsWith('.css')) visit(out);
    }

    for (const [out, meta] of Object.entries(result.metafile.outputs)) {
      const abs = path.resolve(options.projectDir, out);
      const content = readFileSync(abs);
      const gz = gzipSync(content, { level: 9 });
      files.push({ name: toUrl(out), bytes: content.length, gzip: gz.length, reactOnly: out.endsWith('.js') && !common.has(out) });
      if (options.precompress && /\.(js|css|svg|json)$/.test(out)) {
        writeFileSync(`${abs}.gz`, gz);
        writeFileSync(`${abs}.br`, brotliCompressSync(content, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }));
      }
      if (!meta.entryPoint) continue;
      const entry = meta.entryPoint.startsWith('amoxi-react:') ? meta.entryPoint.slice('amoxi-react:'.length) : path.resolve(options.projectDir, meta.entryPoint);
      if (entry === hydrateEntry) manifest.hydrate = toUrl(out);
      if (out.endsWith('.css') && styles.includes(entry)) manifest.styles[path.basename(entry)] = toUrl(out);
      const island = options.islands.find((i) => path.resolve(i.file) === entry);
      if (island) manifest.islands[island.name] = toUrl(out);
    }
    return { manifest, files, diagnostics: [] };
  } catch (err) {
    const errors = (err as { errors?: import('esbuild').Message[] }).errors ?? [];
    if (errors.length === 0) throw err;
    return {
      files: [],
      diagnostics: errors.map((e) => ({
        message: `Browser bundle: ${e.text}${
          /Could not resolve "react(-dom)?(\/[^"]*)?"/.test(e.text)
            ? '. React islands need React installed in your app: npm install react react-dom, plus npm install -D @types/react @types/react-dom'
            : /No matching export|Could not resolve "node:|Could not resolve "(fs|path|http)"/.test(e.text)
              ? ' (islands run in the browser and may only import browser-safe code)'
              : ''
        }`,
        loc: e.location ? { file: e.location.file, line: e.location.line } : undefined,
      })),
    };
  }
}
