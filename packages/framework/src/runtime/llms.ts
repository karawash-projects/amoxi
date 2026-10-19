// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

/**
 * `/llms.txt` and `/llms-full.txt` (https://llmstxt.org): a markdown index of the site for AI
 * agents. Format: `# Name`, a `> summary` blockquote, optional paragraphs, then `## Section` lists
 * of `- [Title](url): notes`; the `## Optional` section holds links an agent may skip.
 */

import { trimNewlines } from './html-markdown';

export interface LlmsSite {
  name: string;
  description?: string;
  /** Absolute origin (plus base path) of the site, e.g. `https://example.com`. */
  baseUrl: string;
  /** Page routes. Paths with parameters (`/people/:id`) are skipped. `optional` lists it under `## Optional`. */
  pages: Array<{ path: string; title?: string; description?: string; optional?: boolean }>;
  apis?: Array<{ method: string; path: string; summary?: string }>;
  agents?: Array<{ name: string; description: string; url: string }>;
  links?: { openapi?: string; mcp?: string; agentCard?: string; full?: string };
}

const MAX_ENTRIES = 1000;
const DEFAULT_FULL_MAX = 10 * 1024 * 1024;

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
const linkText = (s: string): string => oneLine(s).replace(/[\\[\]]/g, '\\$&');

function absolute(base: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${base.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}

function entry(title: string, url: string, notes?: string): string {
  const n = notes ? oneLine(notes) : '';
  return `- [${linkText(title) || url}](${url.replace(/[\s()]/g, encodeURIComponent)})${n ? `: ${n}` : ''}`;
}

/** `/` → `/index.md`, `/about` → `/about.md`. */
export function markdownUrlFor(path: string): string {
  const p = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  return p === '/' || p === '' ? '/index.md' : `${p}.md`;
}

/** A readable title from a path when the page has none: `/getting-started` → `Getting started`. */
function titleFromPath(path: string): string {
  if (path === '/' || path === '') return 'Home';
  const last = path.split('/').filter(Boolean).pop() ?? path;
  const words = decodeURIComponentSafe(last).replace(/[-_]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : path;
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function header(site: LlmsSite): string {
  let out = `# ${oneLine(site.name) || 'Site'}\n`;
  if (site.description) out += `\n> ${oneLine(site.description)}\n`;
  return out;
}

/** Builds `/llms.txt`. Page links point at the markdown versions (`/about.md`, `/index.md`). */
export function buildLlmsTxt(site: LlmsSite): string {
  const base = site.baseUrl;
  let out = header(site);
  out +=
    '\nEvery page is available as markdown: append `.md` to its path (`/index.md` for the home page) ' +
    'or request it with `Accept: text/markdown`. `Accept: application/json` returns a structured description ' +
    '(title, headings, content, links, forms and page data).\n';

  const seen = new Set<string>();
  const primary: string[] = [];
  const optional: string[] = [];
  for (const page of site.pages.slice(0, MAX_ENTRIES)) {
    if (/[:*{]/.test(page.path) || seen.has(page.path)) continue;
    seen.add(page.path);
    const line = entry(page.title ?? titleFromPath(page.path), absolute(base, markdownUrlFor(page.path)), page.description);
    (page.optional ? optional : primary).push(line);
  }
  if (primary.length > 0) out += `\n## Pages\n\n${primary.join('\n')}\n`;

  const api: string[] = [];
  if (site.links?.openapi) api.push(entry('OpenAPI specification', absolute(base, site.links.openapi), 'Machine-readable description of every API endpoint'));
  for (const a of (site.apis ?? []).slice(0, MAX_ENTRIES)) {
    const method = a.method.toUpperCase();
    api.push(entry(`${method} ${a.path}`, absolute(base, a.path), a.summary));
  }
  if (api.length > 0) out += `\n## API\n\n${api.join('\n')}\n`;

  const agents: string[] = [];
  for (const a of (site.agents ?? []).slice(0, MAX_ENTRIES)) agents.push(entry(a.name, absolute(base, a.url), a.description));
  if (site.links?.mcp) agents.push(entry('MCP server', absolute(base, site.links.mcp), 'Model Context Protocol endpoint exposing this site’s tools'));
  if (site.links?.agentCard) agents.push(entry('Agent card', absolute(base, site.links.agentCard), 'A2A agent card describing the agents and their skills'));
  if (agents.length > 0) out += `\n## Agents\n\n${agents.join('\n')}\n`;

  if (site.links?.full) optional.push(entry('Full content', absolute(base, site.links.full), 'Every page’s markdown in one file'));
  if (optional.length > 0) out += `\n## Optional\n\n${optional.join('\n')}\n`;
  return out;
}

/**
 * Builds `/llms-full.txt`: the llms.txt header followed by every page's markdown, separated by
 * horizontal rules. Output is capped at `maxBytes` (default 10 MB); later pages are omitted.
 */
export function buildLlmsFullTxt(site: LlmsSite, pages: Array<{ url: string; markdown: string }>, options: { maxBytes?: number } = {}): string {
  const max = options.maxBytes ?? DEFAULT_FULL_MAX;
  const parts = [header(site)];
  let size = Buffer.byteLength(parts[0]);
  let omitted = 0;
  for (const page of pages) {
    const md = trimNewlines(page.markdown);
    const body = /^(?:#[^\n]*\n+)?Source: /.test(md) ? md : `Source: ${page.url}\n\n${md}`;
    const chunk = `\n---\n\n${body}\n`;
    const bytes = Buffer.byteLength(chunk);
    if (size + bytes > max) {
      omitted++;
      continue;
    }
    parts.push(chunk);
    size += bytes;
  }
  if (omitted > 0) parts.push(`\n---\n\n${omitted} more page(s) omitted (size limit); fetch them individually from llms.txt.\n`);
  return parts.join('');
}
