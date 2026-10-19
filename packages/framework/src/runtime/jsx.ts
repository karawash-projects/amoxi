// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

/**
 * Server JSX runtime: JSX evaluates directly to HTML strings. There is no virtual DOM and
 * no reconciliation, so rendering a page is string concatenation with escaping.
 */
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { isPageWithData, withData } from './semantic';
import * as path from 'node:path';
import { HttpResponse } from './http';
import type { ClientManifest, RequestContext } from './types';
import { isUnsafeUrl, URL_ATTRIBUTES } from '../client/url-safety';

interface Pending {
  readonly id: string;
  /** The exact placeholder markup, replaced when resolving inline. */
  readonly slot: string;
  readonly promise: Promise<unknown>;
  readonly render: (value: any) => unknown;
  readonly error?: (err: unknown) => unknown;
}

/** Markup that is already safe to emit (rendered elements, or `raw()` content). */
export class SafeHtml {
  /** @internal Streamed sections (<Await>) contained in this markup. */
  pending?: Pending[];
  constructor(readonly html: string) {}
  toString(): string {
    return this.html;
  }
}

export type Child = string | number | boolean | null | undefined | SafeHtml | Child[] | (() => Child);
export type Component<P = any> = (props: P) => unknown;
export type { ClientManifest };

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const ESCAPE_RE = /[&<>"']/;
const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(s: string): string {
  return ESCAPE_RE.test(s) ? s.replace(/[&<>"']/g, (c) => ESCAPES[c]) : s;
}

/** Emit trusted HTML without escaping (inline scripts, pre-rendered markup). Never pass user input. */
export function raw(html: string): SafeHtml {
  return new SafeHtml(html);
}

/**
 * Inline <script> elements written in JSX (and the framework's own) carry this marker, which is
 * replaced with the request's CSP nonce. HTML from raw() or other strings never gets a nonce, so
 * injected markup can't run. The marker is random per process and never leaves it.
 */
const NONCE_MARK = `amoxi-nonce-${randomBytes(18).toString('base64url')}`;
const NONCE_ATTR = ` nonce="${NONCE_MARK}"`;

/** Renders JSX (or any child) to an HTML string. */
export function renderToString(child: unknown, pending?: Pending[]): string {
  return stripNonce(renderChild(child, pending));
}

function stripNonce(html: string): string {
  return html.includes(NONCE_MARK) ? html.split(NONCE_ATTR).join('') : html;
}

function renderChild(child: unknown, pending?: Pending[]): string {
  if (child == null || child === false || child === true) return '';
  if (typeof child === 'string') return escapeHtml(child);
  if (typeof child === 'number') return String(child);
  if (child instanceof SafeHtml) {
    if (pending && child.pending) pending.push(...child.pending);
    return child.html;
  }
  if (Array.isArray(child)) {
    let out = '';
    for (const c of child) out += renderChild(c, pending);
    return out;
  }
  // Reactive getters (signals) are evaluated once on the server.
  if (typeof child === 'function') return renderChild((child as () => unknown)(), pending);
  return escapeHtml(String(child));
}

function withPending(html: string, pending: Pending[]): SafeHtml {
  const out = new SafeHtml(html);
  if (pending.length > 0) out.pending = pending;
  return out;
}

function styleString(style: Record<string, unknown>): string {
  let out = '';
  for (const k in style) {
    if (style[k] == null) continue;
    out += `${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}:${style[k]};`;
  }
  return out;
}

/** Valid HTML/SVG attribute names (letters, digits and - _ : . after a letter, underscore or colon). */
const ATTRIBUTE_NAME = /^[A-Za-z_:][A-Za-z0-9_:.-]*$/;
/** Valid element names, for the same reason. */
const TAG_NAME = /^[A-Za-z][A-Za-z0-9-]*$/;

export function jsx(type: string | Component, props: Record<string, unknown>, key?: unknown): SafeHtml {
  if (typeof type === 'function') {
    // The automatic JSX runtime passes `key` separately; components like <For key={...}> need it.
    const out = type(key === undefined ? props : { ...props, key });
    if (out instanceof SafeHtml) return out;
    const pending: Pending[] = [];
    return withPending(renderChild(out, pending), pending);
  }
  if (!TAG_NAME.test(type)) throw new Error(`Invalid element name: ${JSON.stringify(type).slice(0, 60)}`);
  let html = `<${type}`;
  for (const key in props) {
    if (key === 'children' || key === 'key' || key === 'ref') continue;
    let value = props[key];
    if (typeof value === 'function') {
      if (key.startsWith('on')) continue; // event handlers only exist in the browser
      value = (value as () => unknown)();
    }
    if (value == null || value === false) continue;
    // Attribute names can't be escaped, only checked: spreading untrusted props ({...userData}) must not
    // let a key such as 'onload=alert(1) x' or '><script>' inject markup. Invalid names are dropped.
    if (!ATTRIBUTE_NAME.test(key)) continue;
    // Event handlers are functions (attached in the browser). A string value would become an inline
    // script attribute, which is how injected props run code, so it's dropped (React rejects these too).
    if (key.length > 2 && (key[0] === 'o' || key[0] === 'O') && (key[1] === 'n' || key[1] === 'N')) continue;
    const name = key === 'className' ? 'class' : key === 'htmlFor' ? 'for' : key;
    if (value === true) {
      html += ` ${name}`;
      continue;
    }
    const str = name === 'style' && typeof value === 'object' ? styleString(value as Record<string, unknown>) : String(value);
    // A script URL in href or src runs code when clicked or loaded: drop it (data: images stay allowed in src).
    if (URL_ATTRIBUTES.has(name.toLowerCase()) && isUnsafeUrl(str, name.toLowerCase() !== 'href')) continue;
    html += ` ${name}="${escapeHtml(str)}"`;
  }
  if (type === 'script' && props.src == null && props.nonce == null) html += NONCE_ATTR;
  if (VOID.has(type)) return new SafeHtml(`${html}>`);
  const pending: Pending[] = [];
  const inner = renderChild(props.children, pending);
  return withPending(`${html}>${inner}</${type}>`, pending);
}

export function Fragment(props: { children?: unknown }): SafeHtml {
  const pending: Pending[] = [];
  return withPending(renderChild(props.children, pending), pending);
}

/** Server version: runs only in the browser, so it is a no-op here. */
export function onMount(_fn: () => void | (() => void)): void {}
/** Server version: no-op. */
export function onCleanup(_fn: () => void): void {}

/** Client-side navigation (browser only). Imported from islands; never call it on the server. */
export function navigate(_href: string, _options?: { replace?: boolean; keepScroll?: boolean }): Promise<void> {
  throw new Error('navigate() can only be called in the browser (inside an island event handler)');
}

/**
 * Root-relative URL ("/images/a.png") adjusted for a site exported with `amoxi export
 * --base-path`. Use it for URLs an island builds itself. On the server it returns the path
 * unchanged, because the exporter prefixes URLs in the rendered HTML.
 */
export function withBasePath(path: string): string {
  return path;
}

/** Keyed list (see the browser version). On the server it simply renders every item. */
export function For<T>(props: { each: () => readonly T[]; key: (item: T, index: number) => string | number; children: ((item: T) => unknown) | Array<(item: T) => unknown> }): unknown {
  const render = (Array.isArray(props.children) ? props.children[0] : props.children) as (item: T) => unknown;
  return props.each().map((item) => render(item));
}

export type IslandProps<P> = { of: Component<P>; load?: 'load' | 'visible' | 'idle' } & Omit<P, 'children'>;

/**
 * Server-renders an island and marks it for activation in the browser.
 * Props must be JSON-serialisable: they are embedded in the page for the client.
 */
export function Island<P>(props: IslandProps<P>): SafeHtml {
  const { of, load = 'load', ...rest } = props as IslandProps<P> & Record<string, unknown>;
  const pending: Pending[] = [];
  const inner = reactIslands.has(of) ? renderReact(of, rest) : renderChild(of(rest as P), pending);
  return withPending(
    `<amoxi-island data-c="${escapeHtml(of.name)}" data-load="${load}" data-p="${escapeHtml(JSON.stringify(rest))}">${inner}</amoxi-island>`,
    pending,
  );
}

/* React islands ----------------------------------------------------- */

const reactIslands = new WeakSet<Component>();
let reactServer: { createElement: (c: unknown, p: unknown) => unknown; renderToString: (e: unknown) => string } | undefined;

/** Used by generated code: marks a component from src/islands/<Name>.react.tsx as a React component. */
export function $reactIsland(component: Component): void {
  reactIslands.add(component);
}

/** Server-renders a React island with the app's own copy of react-dom/server (so hooks share one React). */
function renderReact(component: Component, props: Record<string, unknown>): string {
  if (!reactServer) {
    const load = (from: string): typeof reactServer => {
      const req = createRequire(from);
      const react = req('react') as { createElement: (c: unknown, p: unknown) => unknown };
      const server = req('react-dom/server') as { renderToString: (e: unknown) => string };
      return { createElement: react.createElement, renderToString: server.renderToString };
    };
    try {
      reactServer = load(path.join(process.cwd(), 'package.json'));
    } catch {
      try {
        reactServer = load(__filename);
      } catch {
        throw new Error('React islands need React installed in your app: npm install react react-dom');
      }
    }
  }
  return reactServer!.renderToString(reactServer!.createElement(component, props));
}

let slotSeq = 0;

/**
 * Streams a slow part of a page. The page is sent immediately with `fallback` in place;
 * when `promise` settles, the rendered `children(value)` is streamed and swapped in.
 *
 *   <Await promise={loadStats()} fallback={<p>Loading…</p>}>
 *     {(stats) => <Stats data={stats} />}
 *   </Await>
 */
export function Await<T>(props: {
  promise: Promise<T> | T;
  fallback?: unknown;
  error?: (err: unknown) => unknown;
  children: (value: T) => unknown;
}): SafeHtml {
  const id = `ns${(++slotSeq).toString(36)}`;
  const slot = `<amoxi-slot id="${id}">${renderChild(props.fallback ?? '')}</amoxi-slot>`;
  const out = new SafeHtml(slot);
  out.pending = [{ id, slot, promise: Promise.resolve(props.promise), render: props.children, error: props.error }];
  return out;
}

/* ------------------------------------------------------------------ */
/* Pages                                                               */
/* ------------------------------------------------------------------ */

export interface PageSettings {
  manifest?: ClientManifest;
  /** Content-Security-Policy template; `{nonce}` is replaced per request. Empty disables the header. */
  csp: string;
  /** Load the client runtime on every page so links navigate without full reloads. */
  navigation: boolean;
  streamTimeoutMs: number;
  dev?: { buildId: string };
  /** Resolve <Await> sections before responding instead of streaming them (static export). */
  inlineStreams: boolean;
  onStreamError: (err: unknown) => void;
  /**
   * Islands an agent may show at any time (@generative), so pages with islands (e.g. a chat)
   * can load them on demand. Only their URLs are listed; nothing is downloaded until used.
   */
  generativeIslands?: readonly string[];
}

const settings: PageSettings = {
  csp: '',
  navigation: true,
  streamTimeoutMs: 10_000,
  inlineStreams: false,
  onStreamError: (err) => console.error('[amoxi] streamed section failed', err),
};

export function configurePages(update: Partial<PageSettings>): void {
  Object.assign(settings, update);
}

/** @deprecated use configurePages({ manifest }) */
export function setClientManifest(m: ClientManifest | undefined): void {
  settings.manifest = m;
}

/** URL of a bundled stylesheet from `src/styles/` (content-hashed), or of a file in `public/`. */
export function asset(name: string): string {
  return settings.manifest?.styles?.[name] ?? `/${name.replace(/^\/+/, '')}`;
}

export const DEFAULT_CSP =
  "default-src 'self'; script-src 'self' 'nonce-{nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
  "font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

const ISLAND_RE = /<amoxi-island data-c="([A-Za-z0-9_$]+)"/g;
const scriptJson = (v: unknown): string => JSON.stringify(v).replace(/</g, '\\u003c');
const SWAP =
  'function __amoxiSwap(i){var t=document.querySelector(\'template[data-amoxi-for="\'+i+\'"]\'),s=document.getElementById(i);' +
  "if(t&&s){s.replaceWith(t.content);t.remove();document.dispatchEvent(new Event('amoxi:swap'))}}";
const STREAM_ERROR = raw('<p class="amoxi-error" role="alert">This section couldn’t be loaded. Try refreshing the page.</p>');

function devClient(buildId: string): string {
  // Live reload + build-error overlay for `amoxi dev`. Survives client-side navigations.
  return `(function(){var b=${scriptJson(buildId)},w=window;if(w.__amoxiDev){w.__amoxiDev.build=b;return}var d=w.__amoxiDev={build:b};
function overlay(list){var o=document.getElementById('amoxi-dev-overlay');if(!list||!list.length){if(o)o.remove();return}
if(!o){o=document.createElement('div');o.id='amoxi-dev-overlay';o.setAttribute('role','alert');o.style.cssText='position:fixed;inset:0;z-index:2147483647;background:rgba(18,23,34,.92);color:#fff;font:14px/1.5 ui-monospace,Menlo,Consolas,monospace;padding:2rem;overflow:auto';document.body.appendChild(o)}
o.textContent='';var h=document.createElement('h2');h.textContent='Build failed: '+list.length+' problem(s)';h.style.cssText='font:600 20px system-ui;color:#F2C94C;margin:0 0 1rem';o.appendChild(h);
list.forEach(function(e){var p=document.createElement('pre');p.style.cssText='white-space:pre-wrap;margin:0 0 1rem';p.textContent=(e.loc?e.loc.file+':'+e.loc.line+'  ':'')+e.message;o.appendChild(p)});
var f=document.createElement('p');f.textContent='Fix the problem and save; this page updates automatically.';f.style.color='#93A1B5';o.appendChild(f)}
function refresh(){var n=w.__amoxi&&w.__amoxi.navigate;if(n)n(location.href,{replace:true,keepScroll:true}).catch(function(){location.reload()});else location.reload()}
var s=new EventSource('/_amoxi/dev/events');s.addEventListener('hello',function(e){var m=JSON.parse(e.data);if(m.build!==d.build){d.build=m.build;refresh()}overlay(m.errors)});
s.addEventListener('errors',function(e){overlay(JSON.parse(e.data))})})();`;
}

class PageWithStatus {
  constructor(
    readonly status: number,
    readonly content: unknown,
  ) {}
}

/** Render a page with a specific HTTP status, e.g. `return withStatus(404, <NotFound />)`. */
export function withStatus(status: number, content: unknown): PageWithStatus {
  return new PageWithStatus(status, content);
}

function addNonce(html: string, nonce: string): string {
  return html.includes(NONCE_MARK) ? html.split(NONCE_ATTR).join(nonce ? ` nonce="${nonce}"` : '') : html;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Streamed section timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function* streamPage(first: string, tail: string, pending: Pending[], nonce: string): AsyncGenerator<string> {
  yield first;
  interface Settled {
    p: Pending;
    ok: boolean;
    value: unknown;
    self: Promise<Settled>;
  }
  const inflight = new Set<Promise<Settled>>();
  const add = (p: Pending): void => {
    const holder: { self?: Promise<Settled> } = {};
    holder.self = withTimeout(p.promise, settings.streamTimeoutMs).then(
      (value) => ({ p, ok: true, value, self: holder.self! }),
      (value) => ({ p, ok: false, value, self: holder.self! }),
    );
    inflight.add(holder.self);
  };
  pending.forEach(add);
  while (inflight.size > 0) {
    const r = await Promise.race(inflight);
    inflight.delete(r.self);
    const inner: Pending[] = [];
    let html: string;
    try {
      if (!r.ok) settings.onStreamError(r.value);
      html = renderChild(r.ok ? r.p.render(r.value) : r.p.error ? r.p.error(r.value) : STREAM_ERROR, inner);
    } catch (err) {
      settings.onStreamError(err);
      html = STREAM_ERROR.html;
    }
    inner.forEach(add);
    yield `<template data-amoxi-for="${r.p.id}">${addNonce(html, nonce)}</template><script nonce="${nonce}">__amoxiSwap("${r.p.id}")</script>`;
  }
  yield tail;
}

/** Resolves every pending section and substitutes it for its placeholder (used for static export). */
async function inlinePending(html: string, pending: Pending[]): Promise<string> {
  const queue = [...pending];
  while (queue.length > 0) {
    const p = queue.shift()!;
    let rendered: string;
    const inner: Pending[] = [];
    try {
      rendered = renderChild(p.render(await withTimeout(p.promise, settings.streamTimeoutMs)), inner);
    } catch (err) {
      settings.onStreamError(err);
      rendered = renderChild(p.error ? p.error(err) : STREAM_ERROR, inner);
    }
    html = html.replace(p.slot, () => rendered);
    queue.push(...inner);
  }
  return html;
}

/** Structured data a page attached with withData(), for its JSON representation. */
const pageData = new WeakMap<HttpResponse, unknown>();
export function pageDataOf(res: HttpResponse): unknown {
  return pageData.get(res);
}

function toPage(result: unknown, rc?: RequestContext): unknown {
  if (isPageWithData(result)) {
    const data = result.data;
    const rendered = toPage(result.view, rc);
    const attach = (r: unknown): unknown => {
      if (r instanceof HttpResponse) pageData.set(r, data);
      return r;
    };
    return rendered instanceof Promise ? rendered.then(attach) : attach(rendered);
  }
  if (result instanceof PageWithStatus && isPageWithData(result.content)) {
    return toPage(withData(withStatus(result.status, result.content.view), result.content.data), rc);
  }
  if (settings.inlineStreams && !(result instanceof HttpResponse)) {
    const status = result instanceof PageWithStatus ? result.status : 200;
    const content = result instanceof PageWithStatus ? result.content : result;
    const pending: Pending[] = [];
    const html = renderChild(content, pending);
    if (pending.length > 0) {
      return inlinePending(html, pending).then((full) => toPage(withStatus(status, raw(full)), rc));
    }
  }
  if (result instanceof HttpResponse) return result;
  let status = 200;
  if (result instanceof PageWithStatus) {
    status = result.status;
    result = result.content;
  }
  const pending: Pending[] = [];
  let html = renderChild(result, pending);
  const nonce = rc?.nonce ?? '';
  const manifest = settings.manifest;

  let head = '';
  let body = '';
  if (manifest) {
    const used = new Set<string>();
    for (const m of html.matchAll(ISLAND_RE)) used.add(m[1]);
    // Streamed sections may contain islands we can't see yet, so expose the full map.
    const islands: Record<string, string> = pending.length > 0 ? { ...manifest.islands } : {};
    for (const name of used) if (manifest.islands[name]) islands[name] = manifest.islands[name];
    if (used.size > 0) for (const name of settings.generativeIslands ?? []) if (manifest.islands[name]) islands[name] = manifest.islands[name];
    if (used.size > 0 || pending.length > 0 || settings.navigation) {
      head += '<style>amoxi-island,amoxi-slot{display:contents}</style>';
      head += `<link rel="modulepreload" href="${escapeHtml(manifest.hydrate)}">`;
      for (const name of used) if (islands[name]) head += `<link rel="modulepreload" href="${escapeHtml(islands[name])}">`;
      body += `<script${NONCE_ATTR} type="application/json" id="amoxi-data">${scriptJson({ islands, navigation: settings.navigation })}</script>`;
      body += `<script${NONCE_ATTR} type="module" async>import{start}from${scriptJson(manifest.hydrate)};start()</script>`;
    }
  }
  if (pending.length > 0) body = `<script${NONCE_ATTR}>${SWAP}</script>${body}`;
  if (settings.dev) body += `<script${NONCE_ATTR}>${devClient(settings.dev.buildId)}</script>`;

  if (head) html = html.includes('</head>') ? html.replace('</head>', `${head}</head>`) : head + html;
  if (body) html = html.includes('</body>') ? html.replace('</body>', `${body}</body>`) : html + body;
  if (/^\s*<html[\s>]/i.test(html)) html = `<!doctype html>${html}`;

  const headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8' };
  html = addNonce(html, nonce); // without a request (no nonce) the markers are simply removed
  if (rc) {
    if (settings.csp) headers['content-security-policy'] = settings.csp.split('{nonce}').join(nonce);
  }
  if (pending.length === 0) return new HttpResponse(status, html, headers);

  const cut = html.lastIndexOf('</body>');
  const first = cut === -1 ? html : html.slice(0, cut);
  const tail = cut === -1 ? '' : html.slice(cut);
  headers['cache-control'] = 'no-store';
  return new HttpResponse(status, streamPage(first, tail, pending, nonce), headers);
}

/** Used by generated code for @Page routes: renders JSX (sync or async) into an HTML response. */
export function $page(result: unknown, rc?: RequestContext): unknown {
  return result instanceof Promise ? result.then((r) => toPage(r, rc)) : toPage(result, rc);
}

/* ------------------------------------------------------------------ */
/* JSX types                                                           */
/* ------------------------------------------------------------------ */

export declare namespace JSX {
  // Elements are opaque: SafeHtml on the server, DOM nodes in the browser.
  // eslint-disable-next-line @typescript-eslint/no-empty-interface
  interface Element {}
  type ElementType = string | ((props: any) => unknown);
  interface IntrinsicElements {
    [tag: string]: Record<string, unknown>;
  }
  interface ElementChildrenAttribute {
    children: unknown;
  }
}
