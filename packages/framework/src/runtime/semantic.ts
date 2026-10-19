// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

/**
 * Agent-readable representations of pages: content negotiation between HTML, markdown and JSON,
 * the `/path.md` alias, and `withData()` so a @Page can expose structured data alongside its view.
 */
import { trimNewlines, type PageDocument } from './html-markdown';

// The converter is loaded on the first markdown/JSON request, so start-up doesn't pay for it.
let converter: typeof import('./html-markdown') | undefined;
/** Parses rendered HTML into a PageDocument (title, markdown, headings, links, forms). Loaded on first use. */
export const htmlToDocument: typeof import('./html-markdown').htmlToDocument = (html, options) => (converter ??= require('./html-markdown') as typeof import('./html-markdown')).htmlToDocument(html, options);

export type Representation = 'html' | 'markdown' | 'json';

const MAX_ACCEPT = 4096;
const MAX_ACCEPT_ENTRIES = 64;

/**
 * Picks the representation for an Accept header. `text/markdown` / `text/x-markdown` win when they
 * rank at least as high as HTML; `application/json` only when it ranks strictly above HTML (so
 * `application/json, text/plain, *\/*` from generic HTTP clients still gets the page). Browsers
 * never list markdown and always rank text/html first, so they always get HTML.
 */
export function negotiateRepresentation(accept: string | undefined): Representation {
  if (!accept) return 'html';
  let md = 0;
  let json = 0;
  let html = 0;
  let wildcard = 0;
  const entries = accept.slice(0, MAX_ACCEPT).split(',', MAX_ACCEPT_ENTRIES);
  for (const entry of entries) {
    const [range, ...params] = entry.split(';');
    const type = range.trim().toLowerCase();
    if (!type) continue;
    let q = 1;
    for (const p of params) {
      const [k, v] = p.split('=');
      if (k.trim().toLowerCase() === 'q') {
        const n = Number((v ?? '').trim());
        q = Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0;
      }
    }
    switch (type) {
      case 'text/markdown':
      case 'text/x-markdown':
        md = Math.max(md, q);
        break;
      case 'application/json':
        json = Math.max(json, q);
        break;
      case 'text/html':
      case 'application/xhtml+xml':
        html = Math.max(html, q);
        break;
      case '*/*':
      case 'text/*':
        wildcard = Math.max(wildcard, q);
        break;
    }
  }
  const htmlQ = Math.max(html, wildcard);
  if (md > 0 && md >= htmlQ && md >= json) return 'markdown';
  if (json > 0 && json > htmlQ) return 'json';
  return 'html'; // also when nothing we offer is acceptable: HTML is the default
}

/**
 * `/about.md` → `/about`, `/index.md` → `/`, `/docs/index.md` → `/docs`; undefined for anything
 * else. Call it only after the router found no route (or static file) for the `.md` path itself.
 */
export function markdownPath(path: string): string | undefined {
  if (!path.startsWith('/') || !path.endsWith('.md') || path.length <= 4) return undefined;
  const stem = path.slice(0, -3);
  if (stem.endsWith('/')) return undefined;
  if (stem === '/index') return '/';
  if (stem.endsWith('/index')) return stem.slice(0, -6) || '/';
  return stem;
}

/** A page view plus structured data for agents (included in the JSON representation). */
export class PageWithData<D> {
  constructor(
    readonly view: unknown,
    readonly data: D,
  ) {}
}

/**
 * Returns a page that renders `view` for browsers and also exposes `data` to agents asking for
 * JSON: `return withData(<Product p={p} />, { id: p.id, price: p.price })`. Data must be
 * JSON-serialisable; it is sent to anyone who can read the page, so never include secrets.
 */
export function withData<D>(view: unknown, data: D): PageWithData<D> {
  return new PageWithData(view, data);
}

export function isPageWithData(x: unknown): x is PageWithData<unknown> {
  return x instanceof PageWithData;
}

/** The JSON representation of a page. */
export interface PageJson {
  url: string;
  title: string;
  description?: string;
  lang?: string;
  headings: PageDocument['headings'];
  content: string;
  links: PageDocument['links'];
  forms: PageDocument['forms'];
  data?: unknown;
}

export function toJson(doc: PageDocument, url: string, data?: unknown): PageJson {
  const out: PageJson = {
    url,
    title: doc.title,
    ...(doc.description !== undefined ? { description: doc.description } : {}),
    ...(doc.lang !== undefined ? { lang: doc.lang } : {}),
    headings: doc.headings,
    content: doc.markdown,
    links: doc.links,
    forms: doc.forms,
  };
  if (data !== undefined) out.data = data;
  return out;
}

/** Prepends `# Title` (when the content has no h1) and a `Source:` line to converted markdown. */
export function markdownWithFront(doc: PageDocument, url: string): string {
  const source = `Source: ${url}`;
  const md = trimNewlines(doc.markdown);
  if (!doc.headings.some((h) => h.level === 1)) {
    const title = doc.title.replace(/\s+/g, ' ').trim();
    const head = title ? `# ${title.replace(/(\s)(#+)$/, (_m, s: string, h: string) => s + '\\#'.repeat(h.length))}\n\n` : '';
    return `${head}${source}${md ? `\n\n${md}` : ''}\n`;
  }
  if (md.startsWith('# ')) {
    const cut = md.indexOf('\n\n');
    return cut === -1 ? `${md}\n\n${source}\n` : `${md.slice(0, cut)}\n\n${source}${md.slice(cut)}\n`;
  }
  return `${source}\n\n${md}\n`;
}

/**
 * Converts a fully rendered HTML page (streamed sections included) into the markdown or JSON
 * representation. `url` is the absolute page URL; it is the base for links and the `Source:` line.
 */
export function renderRepresentation(html: string, rep: 'markdown' | 'json', options: { url: string; data?: unknown }): { body: string; contentType: string } {
  const doc = htmlToDocument(html, { baseUrl: options.url });
  if (rep === 'markdown') return { body: markdownWithFront(doc, options.url), contentType: 'text/markdown; charset=utf-8' };
  let body: string;
  try {
    body = JSON.stringify(toJson(doc, options.url, options.data));
  } catch (err) {
    throw new Error(`withData() data for ${options.url} is not JSON-serialisable (${err instanceof Error ? err.message : String(err)}); pass plain objects, arrays, strings, numbers and booleans`);
  }
  return { body, contentType: 'application/json' };
}

export type { PageDocument };
