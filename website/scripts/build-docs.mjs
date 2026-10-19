// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

// Builds the website's documentation page from the repository README, so the two never drift apart.
// Writes src/content/docs.generated.ts (git-ignored); `npm run build` and `npm run dev` run it first.
//
// The converter handles the markdown the README uses: headings, paragraphs, fenced code, tables,
// lists, emphasis, inline code and links. Links to files in the repository become links to the
// matching page of this site, or plain text: the documentation page doesn't send readers elsewhere.
import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const site = path.resolve(here, '..');
const readme = readFileSync(path.resolve(site, '..', 'README.md'), 'utf8').replace(/\r\n/g, '\n');
const sectorsSource = readFileSync(path.join(site, 'src', 'content', 'sectors.ts'), 'utf8');

/** examples/<folder> -> /examples/<slug>, from the site's own list of sector pages. */
const examplePages = new Map();
for (const m of sectorsSource.matchAll(/slug: '([^']+)'[\s\S]*?folder: '([^']+)'/g)) examplePages.set(m[2], `/examples/${m[1]}`);

/** Sections left out of the page: the README's own table of contents (the page has a sidebar). */
const SKIPPED_SECTIONS = new Set(['contents']);

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** GitHub's heading anchors, so the README's own #links keep working. */
export function slug(text) {
  return text
    .replace(/`/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/** Where a README link points on this site, or undefined for plain text. */
function linkTarget(url) {
  if (url.startsWith('#')) return url;
  if (/^https?:\/\/github\.com\/karawash-projects\/amoxi\b/.test(url)) return undefined;
  if (/^https?:\/\/karawash-projects\.github\.io\/amoxi\/?$/.test(url)) return '/';
  if (/^https?:\/\//.test(url)) return url;
  const clean = url.replace(/\/$/, '');
  return examplePages.get(clean);
}

/** Keywords coloured in code samples (TypeScript, plus the few the shell samples use). */
const KEYWORDS = new Set('import export from default class interface type extends implements new return const let var function async await if else for of in while throw try catch finally private readonly public protected static this true false null undefined void typeof keyof as satisfies'.split(' '));

/**
 * Colours a code sample at build time (no script in the browser): comments, strings, keywords,
 * decorators, numbers and type names. Unknown languages and plain text are left as they are.
 */
function highlight(code, lang) {
  if (!['ts', 'tsx', 'js', 'json', 'bash', 'sh'].includes(lang)) return escapeHtml(code);
  const shell = lang === 'bash' || lang === 'sh';
  const token = shell
    ? /(#[^\n]*)|("(?:[^"\\\n]|\\.)*"|'[^'\n]*')|(--?[A-Za-z][\w-]*)/g
    : /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|(@[A-Za-z]\w*)|\b(\d[\d_.]*)\b|\b([A-Za-z_$][\w$]*)\b/g;
  let out = '';
  let last = 0;
  for (const m of code.matchAll(token)) {
    out += escapeHtml(code.slice(last, m.index));
    last = m.index + m[0].length;
    const text = escapeHtml(m[0]);
    let cls;
    if (m[1]) cls = 'c';
    else if (m[2]) cls = lang === 'json' && /^\s*:/.test(code.slice(last)) ? 'p' : 's';
    else if (shell) cls = 'o';
    else if (m[3]) cls = 'd';
    else if (m[4]) cls = 'n';
    else if (KEYWORDS.has(m[5])) cls = 'k';
    else if (/^[A-Z]/.test(m[5])) cls = 't';
    out += cls ? `<span class="tok-${cls}">${text}</span>` : text;
  }
  return out + escapeHtml(code.slice(last));
}

/** Names shown above code blocks. */
const LANGUAGES = { bash: 'Terminal', sh: 'Terminal', ts: 'TypeScript', tsx: 'TSX', js: 'JavaScript', json: 'JSON', sql: 'SQL', yaml: 'YAML', html: 'HTML', css: 'CSS', dockerfile: 'Dockerfile' };

/** A link to a heading, shown when the heading is hovered or focused. */
const anchor = (id) => ` <a class="docs-anchor" href="#${id}" aria-label="Link to this section">#</a>`;

/** Inline markdown: code spans, links, bold and italics. Code spans are protected from the rest. */
function inline(text) {
  const codes = [];
  let out = text.replace(/`([^`]+)`/g, (_m, code) => {
    codes.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  out = escapeHtml(out);
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, url) => {
    const target = linkTarget(url.replace(/&amp;/g, '&'));
    if (target === undefined) return label;
    const external = /^https?:\/\//.test(target);
    return `<a href="${escapeHtml(target)}"${external ? ' rel="noopener"' : ''}>${label}</a>`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^\w*])\*([^*\s][^*]*?)\*(?=[^\w*]|$)/g, '$1<em>$2</em>');
  return out.replace(/\u0000(\d+)\u0000/g, (_m, i) => codes[Number(i)]);
}

/** Splits a table row into cells, keeping pipes inside code spans. */
function cells(row) {
  const out = [];
  let cell = '';
  let inCode = false;
  const body = row.trim().replace(/^\|/, '').replace(/\|$/, '');
  for (const ch of body) {
    if (ch === '`') inCode = !inCode;
    if (ch === '|' && !inCode) {
      out.push(cell.trim());
      cell = '';
    } else cell += ch;
  }
  out.push(cell.trim());
  return out;
}

/** Block-level markdown of one section, as HTML. Headings get GitHub's ids. */
function blocks(lines) {
  const html = [];
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    if (line.trim() === '' || line.trim() === '---' || line.trim() === '<!-- screenshots -->') {
      i++;
      continue;
    }
    const fence = /^```(\w*)/.exec(line);
    if (fence) {
      const code = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) code.push(lines[i++]);
      i++;
      const lang = LANGUAGES[fence[1]] ?? fence[1];
      // The copy button is shown by the DocsNav island; without JavaScript the code stays selectable.
      html.push(
        `<div class="docs-code"><div class="docs-code-bar"><span>${escapeHtml(lang)}</span><button type="button" class="docs-copy" hidden>Copy</button></div>` +
          `<pre><code${fence[1] ? ` class="language-${fence[1]}"` : ''}>${highlight(code.join('\n'), fence[1])}</code></pre></div>`,
      );
      continue;
    }
    const heading = /^(#{3,4}) (.+)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const id = slug(heading[2]);
      html.push(`<h${level} id="${id}">${inline(heading[2])}${anchor(id)}</h${level}>`);
      i++;
      continue;
    }
    if (line.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]);
      // The README's screenshot gallery is raw HTML in a table: the site shows the examples itself.
      if (rows.some((r) => r.includes('<img'))) continue;
      const [head, , ...body] = rows;
      const th = cells(head).map((c) => `<th scope="col">${inline(c)}</th>`).join('');
      const trs = body.map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('');
      html.push(`<div class="docs-table"><table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table></div>`);
      continue;
    }
    const bullet = /^(- |\d+\. )/.exec(line);
    if (bullet) {
      const ordered = bullet[1] !== '- ';
      const items = [];
      while (i < lines.length && (/^(- |\d+\. )/.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length > 0))) {
        if (/^(- |\d+\. )/.test(lines[i])) items.push(lines[i].replace(/^(- |\d+\. )/, ''));
        else items[items.length - 1] += ` ${lines[i].trim()}`;
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      html.push(`<${tag}>${items.map((it) => `<li>${inline(it)}</li>`).join('')}</${tag}>`);
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() !== '' && !/^(```|#{2,4} |\||- |\d+\. |---$)/.test(lines[i])) para.push(lines[i++].trim());
    if (para.length > 0) html.push(`<p>${inline(para.join(' '))}</p>`);
    else i++;
  }
  return html.join('\n');
}

// Split the README into its intro (before the first ## heading) and its ## sections.
const lines = readme.split('\n');
const sections = [];
let current = { title: '', lines: [] };
let inFence = false;
for (const line of lines) {
  if (line.startsWith('```')) inFence = !inFence;
  if (!inFence && line.startsWith('## ')) {
    sections.push(current);
    current = { title: line.slice(3).trim(), lines: [] };
    continue;
  }
  if (!inFence && line.startsWith('# ')) continue; // the page has its own title
  current.lines.push(line);
}
sections.push(current);

const [introSection, ...rest] = sections;
// The intro without the badges and the link to this very site.
const intro = blocks(introSection.lines.filter((l) => !l.startsWith('[![') && !l.includes('karawash-projects.github.io/amoxi')));
const docs = rest
  .filter((s) => !SKIPPED_SECTIONS.has(slug(s.title)))
  .map((s) => ({
    id: slug(s.title),
    title: s.title.replace(/`/g, ''),
    titleHtml: inline(s.title) + anchor(slug(s.title)),
    html: blocks(s.lines),
    children: s.lines
      .filter((l, i, all) => /^### /.test(l) && all.slice(0, i).filter((x) => x.startsWith('```')).length % 2 === 0)
      .map((l) => ({ id: slug(l.slice(4)), title: l.slice(4).replace(/`/g, '') })),
  }));

const out = `// Generated by scripts/build-docs.mjs from README.md. Do not edit: change README.md instead.

export interface DocsSection {
  readonly id: string;
  readonly title: string;
  readonly titleHtml: string;
  readonly html: string;
  readonly children: readonly { readonly id: string; readonly title: string }[];
}

export const DOCS_INTRO: string = ${JSON.stringify(intro)};

export const DOCS: readonly DocsSection[] = ${JSON.stringify(docs, null, 2)};
`;
writeFileSync(path.join(site, 'src', 'content', 'docs.generated.ts'), out);
console.log(`docs: ${docs.length} sections from README.md`);
