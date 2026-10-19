// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0


/**
 * Turns a rendered Amoxi page into something an AI agent can read: clean markdown plus a
 * structured description (title, headings, links, forms).
 *
 * The pipeline is a small forgiving HTML tokenizer feeding a tree builder (implied end tags,
 * void elements, unclosed tags, a nesting cap), followed by tree walks. Every walk visits each
 * node once, so the cost is linear in the input. Streamed `<Await>` sections are put back where
 * they belong: the `<template data-amoxi-for="id">` chunk replaces `<amoxi-slot id="id">`.
 * No dependencies; safe on hostile input (size cap, depth caps, bounded output lists).
 */

import { isUnsafeUrl } from '../client/url-safety';

/** Removes trailing (and optionally leading) newlines in linear time. */
export function trimNewlines(text: string, leading = false): string {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 10) end--;
  let start = 0;
  if (leading) while (start < end && text.charCodeAt(start) === 10) start++;
  return text.slice(start, end);
}

export interface FormField {
  name: string;
  type: string;
  label?: string;
  required: boolean;
  options?: string[];
  pattern?: string;
  min?: string;
  max?: string;
  value?: string;
}

export interface FormDescription {
  action: string;
  method: string;
  name?: string;
  fields: FormField[];
}

export interface PageHeading {
  level: number;
  text: string;
  id?: string;
}

export interface PageLink {
  text: string;
  href: string;
}

export interface PageDocument {
  title: string;
  description?: string;
  lang?: string;
  markdown: string;
  headings: PageHeading[];
  links: PageLink[];
  forms: FormDescription[];
}

export interface HtmlToDocumentOptions {
  /** Absolute URL of the page; relative links, images and form actions are resolved against it. */
  baseUrl?: string;
}

/** Input beyond this many characters is ignored (the rest of the page is dropped). */
export const MAX_HTML_LENGTH = 5 * 1024 * 1024;

const MAX_DEPTH = 256; // tree depth; deeper tags are flattened into their ancestor
const MAX_WALK_DEPTH = 640; // walks that follow streamed slots into templates
const MAX_ATTRS = 64;
const MAX_NEST = 8; // nested lists/blockquotes that still get their own markers
const MAX_LINKS = 1000;
const MAX_HEADINGS = 1000;
const MAX_FORMS = 100;
const MAX_FIELDS = 300;
const MAX_OPTIONS = 500;
const MAX_COLS = 64;
const MAX_COLSPAN = 64;
const TEXT_BUDGET = 2000; // characters collected for a heading/link/label text
const NODE_BUDGET = 20_000; // nodes visited for one such text
const BR = ''; // hard line break marker inside inline buffers (stripped from input)

/* ------------------------------------------------------------------ */
/* Tree                                                                */
/* ------------------------------------------------------------------ */

interface El {
  readonly tag: string;
  readonly attrs: Record<string, string>;
  readonly children: Node[];
}
type Node = El | string;

function newEl(tag: string, attrs: Record<string, string> = Object.create(null)): El {
  return { tag, attrs, children: [] };
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'keygen', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
/** Elements whose content is not markup. */
const RAW = new Set(['script', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'textarea', 'title', 'plaintext']);
/** Raw elements whose content still has entities decoded. */
const RCDATA = new Set(['textarea', 'title']);
const CLOSES_P = new Set([
  'address', 'article', 'aside', 'blockquote', 'details', 'dialog', 'div', 'dl', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul', 'search',
]);
const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const S = (...xs: string[]): Set<string> => new Set(xs);
const P_SET = S('p');
const P_SCOPE = S('button', 'table', 'td', 'th', 'caption', 'template', 'html', 'object', 'marquee', 'applet');
const LI_SET = S('li');
const LIST_SCOPE = S('ul', 'ol', 'menu', 'table', 'template');
const DTDD = S('dt', 'dd');
const DL_SCOPE = S('dl', 'table', 'template');
const TR_SET = S('tr');
const CELL_SET = S('td', 'th');
const SECTION_SET = S('thead', 'tbody', 'tfoot');
const TABLE_SCOPE = S('table', 'template');
const TR_SCOPE = S('table', 'thead', 'tbody', 'tfoot', 'template');
const CELL_SCOPE = S('tr', 'table', 'template');
const OPTION_SET = S('option');
const OPTGROUP_SET = S('optgroup');
const SELECT_SCOPE = S('select', 'datalist', 'optgroup', 'template');
const A_SET = S('a');
const NO_SCOPE = S('template', 'table');

class TreeBuilder {
  readonly root = newEl('#document');
  private readonly stack: El[] = [this.root];
  private readonly open = new Map<string, number>();

  private get cur(): El {
    return this.stack[this.stack.length - 1];
  }

  text(s: string): void {
    if (s) this.cur.children.push(s);
  }

  /** Adds an element; returns it so raw text can be attached. */
  start(tag: string, attrs: Record<string, string>, selfClosing: boolean): El {
    this.implied(tag);
    const el = newEl(tag, attrs);
    this.cur.children.push(el);
    if (!VOID.has(tag) && !selfClosing && !RAW.has(tag) && this.stack.length < MAX_DEPTH) {
      this.stack.push(el);
      this.open.set(tag, (this.open.get(tag) ?? 0) + 1);
    }
    return el;
  }

  end(tag: string): void {
    if (tag === 'br') {
      this.start('br', Object.create(null), true); // browsers treat </br> as <br>
      return;
    }
    if (!this.open.get(tag)) return; // stray end tag
    while (this.stack.length > 1) {
      const el = this.pop();
      if (el.tag === tag) break;
    }
  }

  private pop(): El {
    const el = this.stack.pop()!;
    this.open.set(el.tag, this.open.get(el.tag)! - 1);
    return el;
  }

  /** Closes the nearest open element in `targets` unless a `stops` element comes first. */
  private closeWithin(targets: Set<string>, stops: Set<string>): void {
    let any = false;
    for (const t of targets) if (this.open.get(t)) any = true;
    if (!any) return;
    for (let k = this.stack.length - 1, steps = 0; k > 0 && steps < 64; k--, steps++) {
      const t = this.stack[k].tag;
      if (targets.has(t)) {
        while (this.stack.length > k) this.pop();
        return;
      }
      if (stops.has(t)) return;
    }
  }

  private implied(tag: string): void {
    if (CLOSES_P.has(tag)) this.closeWithin(P_SET, P_SCOPE);
    switch (tag) {
      case 'li':
        return this.closeWithin(LI_SET, LIST_SCOPE);
      case 'dt':
      case 'dd':
        return this.closeWithin(DTDD, DL_SCOPE);
      case 'tr':
        return this.closeWithin(TR_SET, TR_SCOPE);
      case 'td':
      case 'th':
        return this.closeWithin(CELL_SET, CELL_SCOPE);
      case 'thead':
      case 'tbody':
      case 'tfoot':
        return this.closeWithin(SECTION_SET, TABLE_SCOPE);
      case 'option':
        return this.closeWithin(OPTION_SET, SELECT_SCOPE);
      case 'optgroup':
        this.closeWithin(OPTION_SET, SELECT_SCOPE);
        return this.closeWithin(OPTGROUP_SET, SELECT_SCOPE);
      case 'a':
        return this.closeWithin(A_SET, NO_SCOPE);
      default:
        if (HEADINGS.has(tag) && HEADINGS.has(this.cur.tag)) this.pop();
    }
  }
}

/* ------------------------------------------------------------------ */
/* Tokenizer                                                           */
/* ------------------------------------------------------------------ */

const isWs = (c: number): boolean => c === 32 || c === 9 || c === 10 || c === 12 || c === 13;
const isAlpha = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const rawEndCache = new Map<string, RegExp>();
// Control characters (except tab/newline), DEL and our private-use marker are removed from input.
const STRIP_RE = /[\u0000-\u0008\u000B\u000E-\u001F\u007F]/g;

function parseHtml(input: string): El {
  let html = input.length > MAX_HTML_LENGTH ? input.slice(0, MAX_HTML_LENGTH) : input;
  html = html.replace(/\r\n?/g, '\n').replace(STRIP_RE, '');
  const tb = new TreeBuilder();
  const n = html.length;
  let i = 0;
  const skipTo = (from: number, needle: string): number => {
    const e = html.indexOf(needle, from);
    return e === -1 ? n : e + needle.length;
  };

  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      tb.text(decodeEntities(html.slice(i), false));
      break;
    }
    if (lt > i) tb.text(decodeEntities(html.slice(i, lt), false));
    i = lt;
    const c = html.charCodeAt(i + 1);
    if (c === 33 /* ! */) {
      if (html.startsWith('<!--', i)) i = skipTo(i + 4, '-->');
      else if (html.startsWith('<![CDATA[', i)) {
        const e = html.indexOf(']]>', i + 9);
        tb.text(html.slice(i + 9, e === -1 ? n : e));
        i = e === -1 ? n : e + 3;
      } else i = skipTo(i + 2, '>'); // doctype and other markup declarations
      continue;
    }
    if (c === 63 /* ? */) {
      i = skipTo(i + 2, '>');
      continue;
    }
    if (c === 47 /* / */) {
      if (isAlpha(html.charCodeAt(i + 2))) {
        let j = i + 2;
        while (j < n && !isWs(html.charCodeAt(j)) && html[j] !== '/' && html[j] !== '>') j++;
        const name = html.slice(i + 2, j).toLowerCase();
        i = skipTo(j, '>');
        tb.end(name);
      } else i = skipTo(i + 2, '>'); // "</>" or a bogus comment
      continue;
    }
    if (!isAlpha(c)) {
      tb.text('<');
      i++;
      continue;
    }

    // Start tag
    let j = i + 1;
    while (j < n && !isWs(html.charCodeAt(j)) && html[j] !== '/' && html[j] !== '>') j++;
    const tag = html.slice(i + 1, j).toLowerCase();
    const attrs: Record<string, string> = Object.create(null);
    let count = 0;
    let selfClosing = false;
    while (j < n) {
      while (j < n && isWs(html.charCodeAt(j))) j++;
      if (j >= n) break;
      const ch = html[j];
      if (ch === '>') {
        j++;
        break;
      }
      if (ch === '/') {
        if (html[j + 1] === '>') {
          selfClosing = true;
          j += 2;
          break;
        }
        j++;
        continue;
      }
      const start = j;
      if (ch === '=') j++;
      while (j < n) {
        const cc = html.charCodeAt(j);
        if (isWs(cc) || cc === 47 || cc === 62 || cc === 61) break;
        j++;
      }
      const name = html.slice(start, j).toLowerCase();
      while (j < n && isWs(html.charCodeAt(j))) j++;
      let value = '';
      if (html[j] === '=') {
        j++;
        while (j < n && isWs(html.charCodeAt(j))) j++;
        const q = html[j];
        if (q === '"' || q === "'") {
          const e = html.indexOf(q, j + 1);
          value = html.slice(j + 1, e === -1 ? n : e);
          j = e === -1 ? n : e + 1;
        } else {
          const vs = j;
          while (j < n && !isWs(html.charCodeAt(j)) && html[j] !== '>') j++;
          value = html.slice(vs, j);
        }
      }
      if (!(name in attrs) && count < MAX_ATTRS) {
        attrs[name] = decodeEntities(value, true);
        count++;
      }
    }
    i = j;
    const el = tb.start(tag, attrs, selfClosing);
    if (RAW.has(tag) && !(selfClosing && tag !== 'script' && tag !== 'style')) {
      if (tag === 'plaintext') {
        el.children.push(html.slice(i));
        break;
      }
      let re = rawEndCache.get(tag);
      if (!re) rawEndCache.set(tag, (re = new RegExp(`</${tag}[\\s/>]`, 'gi')));
      re.lastIndex = i;
      const m = re.exec(html);
      const end = m ? m.index : n;
      const content = html.slice(i, end);
      el.children.push(RCDATA.has(tag) ? decodeEntities(content, false) : content);
      i = m ? skipTo(end + 2, '>') : n;
    }
  }
  return tb.root;
}

/* ------------------------------------------------------------------ */
/* Entities                                                            */
/* ------------------------------------------------------------------ */

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '\u00A9', reg: '\u00AE', trade: '\u2122', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„', laquo: '«', raquo: '»', lsaquo: '‹', rsaquo: '›', bull: '•',
  middot: '·', deg: '°', plusmn: '±', times: '×', divide: '÷', euro: '€', pound: '£', yen: '¥', cent: '¢', curren: '¤', sect: '§',
  para: '¶', shy: '­', zwj: '\u200D', zwnj: '‌', thinsp: ' ', ensp: ' ', emsp: ' ', larr: '\u2190', rarr: '\u2192',
  uarr: '\u2191', darr: '\u2193', harr: '\u2194', lArr: '\u21D0', rArr: '\u21D2', hArr: '\u21D4', le: '≤', ge: '≥', ne: '≠', asymp: '≈', equiv: '≡', infin: '∞',
  minus: '−', sup1: '¹', sup2: '²', sup3: '³', frac12: '½', frac14: '¼', frac34: '¾', iexcl: '¡', iquest: '¿', dagger: '†',
  Dagger: '‡', permil: '‰', prime: '′', Prime: '″', micro: 'µ', ordf: 'ª', ordm: 'º', not: '¬', macr: '¯', acute: '´', cedil: '¸',
  uml: '¨', brvbar: '¦', hearts: '\u2665', spades: '\u2660', clubs: '\u2663', diams: '\u2666', check: '\u2713', star: '\u2606', starf: '\u2605', sum: '∑', prod: '∏',
  radic: '√', part: '∂', nabla: '∇', isin: '∈', notin: '∉', cap: '∩', cup: '∪', and: '∧', or: '∨', forall: '∀', exist: '∃',
  empty: '∅', alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', lambda: 'λ', mu: 'μ', pi: 'π', sigma: 'σ', tau: 'τ',
  phi: 'φ', omega: 'ω', Delta: 'Δ', Sigma: 'Σ', Omega: 'Ω', Agrave: 'À', Aacute: 'Á', Acirc: 'Â', Atilde: 'Ã', Auml: 'Ä', Aring: 'Å',
  AElig: 'Æ', Ccedil: 'Ç', Egrave: 'È', Eacute: 'É', Ecirc: 'Ê', Euml: 'Ë', Igrave: 'Ì', Iacute: 'Í', Icirc: 'Î', Iuml: 'Ï', Ntilde: 'Ñ',
  Ograve: 'Ò', Oacute: 'Ó', Ocirc: 'Ô', Otilde: 'Õ', Ouml: 'Ö', Oslash: 'Ø', Ugrave: 'Ù', Uacute: 'Ú', Ucirc: 'Û', Uuml: 'Ü', Yacute: 'Ý',
  szlig: 'ß', agrave: 'à', aacute: 'á', acirc: 'â', atilde: 'ã', auml: 'ä', aring: 'å', aelig: 'æ', ccedil: 'ç', egrave: 'è',
  eacute: 'é', ecirc: 'ê', euml: 'ë', igrave: 'ì', iacute: 'í', icirc: 'î', iuml: 'ï', ntilde: 'ñ', ograve: 'ò', oacute: 'ó',
  ocirc: 'ô', otilde: 'õ', ouml: 'ö', oslash: 'ø', ugrave: 'ù', uacute: 'ú', ucirc: 'û', uuml: 'ü', yacute: 'ý', yuml: 'ÿ',
  OElig: 'Œ', oelig: 'œ', Scaron: 'Š', scaron: 'š', eth: 'ð', thorn: 'þ', ETH: 'Ð', THORN: 'Þ', lowast: '∗', sdot: '⋅', loz: '\u25CA',
  oline: '‾', frasl: '⁄', grave: '`', lpar: '(', rpar: ')', lsqb: '[', rsqb: ']', lcub: '{', rcub: '}', vert: '|', ast: '*',
  num: '#', excl: '!', quest: '?', colon: ':', semi: ';', comma: ',', period: '.', sol: '/', bsol: '\\', equals: '=', plus: '+',
  percnt: '%', dollar: '$', commat: '@', lowbar: '_', Tab: '\t', NewLine: '\n',
};
/** Entities browsers also recognise without the trailing semicolon. */
const LEGACY = new Set(['amp', 'lt', 'gt', 'quot', 'nbsp', 'copy', 'reg', 'AMP', 'LT', 'GT', 'QUOT']);
const C1: Record<number, string> = { 0x80: '€', 0x85: '…', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x99: '\u2122' };
const ENTITY_RE = /&(?:#[xX]([0-9a-fA-F]{1,8});?|#([0-9]{1,10});?|([A-Za-z][A-Za-z0-9]{0,31})(;?))/g;

function decodeEntities(s: string, inAttr: boolean): string {
  if (s.indexOf('&') === -1) return s;
  return s.replace(ENTITY_RE, (m: string, hex: string | undefined, dec: string | undefined, name: string | undefined, semi: string, offset: number) => {
    if (hex !== undefined || dec !== undefined) {
      const code = hex !== undefined ? parseInt(hex, 16) : parseInt(dec!, 10);
      if (C1[code]) return C1[code];
      if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
      if (code < 32 && code !== 9 && code !== 10) return '';
      if (code === 0xe000) return '';
      return String.fromCodePoint(code);
    }
    const key = name!;
    if (semi) {
      const v = NAMED[key] ?? NAMED[key.toLowerCase()];
      return v === undefined ? m : v;
    }
    if (!LEGACY.has(key)) return m;
    if (inAttr) {
      const next = s.charCodeAt(offset + m.length);
      if (next === 61 || (next >= 48 && next <= 57) || isAlpha(next)) return m;
    }
    return NAMED[key.toLowerCase()];
  });
}

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

/** Never part of the readable page. */
const DROP = new Set([
  'script', 'style', 'template', 'noscript', 'svg', 'math', 'iframe', 'canvas', 'head', 'title', 'meta', 'link', 'base', 'object',
  'embed', 'audio', 'video', 'xmp', 'noembed', 'noframes', 'plaintext', 'datalist', 'map', 'param', 'source', 'track',
]);
const WS_RE = /[ \t\n\r\f]+/g;

function isHidden(el: El): boolean {
  const a = el.attrs;
  if (a.hidden !== undefined || (a['aria-hidden'] ?? '').toLowerCase() === 'true') return true;
  const style = a.style;
  return style !== undefined && /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(style);
}

function hasClass(el: El, re: RegExp): boolean {
  const c = el.attrs.class;
  return c !== undefined && re.test(c);
}

/** Collapsed visible text of a subtree, bounded in size and work. Streamed slots show their fallback. */
function plainText(el: Node, budget = TEXT_BUDGET, skip?: Set<string>): string {
  const parts: string[] = [];
  let len = 0;
  let nodes = 0;
  const visit = (node: Node, depth: number): void => {
    if (len > budget || ++nodes > NODE_BUDGET || depth > MAX_WALK_DEPTH) return;
    if (typeof node === 'string') {
      parts.push(node);
      len += node.length;
      return;
    }
    if (DROP.has(node.tag) || isHidden(node) || skip?.has(node.tag)) return;
    if (node.tag === 'br') parts.push(' ');
    if (node.tag === 'img' && node.attrs.alt) parts.push(node.attrs.alt);
    for (const c of node.children) visit(c, depth + 1);
    if (node.tag !== 'br' && !INLINE.has(node.tag)) parts.push(' ');
  };
  visit(el, 0);
  return parts.join('').replace(WS_RE, ' ').replace(/ /g, ' ').trim().slice(0, budget);
}

function isSkipLink(el: El): boolean {
  if (el.tag !== 'a') return false;
  const href = el.attrs.href;
  if (href === undefined || !href.startsWith('#')) return false;
  return hasClass(el, /skip/i) || /^\s*skip\b/i.test(plainText(el, 60));
}

/** Resolves a URL against the base; undefined for script URLs and other unsafe schemes. */
function resolveUrl(href: string | undefined, base: string | undefined, allowData = false): string | undefined {
  if (href === undefined) return undefined;
  const trimmed = href.trim();
  if (isUnsafeUrl(trimmed, allowData)) return undefined;
  if (!base) return trimmed;
  try {
    return new URL(trimmed, base).href;
  } catch {
    return trimmed;
  }
}

function mdUrl(url: string): string {
  return url.replace(/[\s()<>]/g, (c) => (c === ' ' ? '%20' : c === '(' ? '%28' : c === ')' ? '%29' : c === '<' ? '%3C' : c === '>' ? '%3E' : ''));
}

/** Escapes characters that would otherwise turn plain text into markdown syntax. */
function escapeMd(s: string): string {
  let out = s.replace(/[\\`*[\]]/g, '\\$&');
  if (out.indexOf('_') !== -1) {
    out = out.replace(/_/g, (_m: string, off: number, str: string) =>
      /[A-Za-z0-9]/.test(str[off - 1] ?? '') && /[A-Za-z0-9]/.test(str[off + 1] ?? '') ? '_' : '\\_',
    );
  }
  if (out.indexOf('<') !== -1) out = out.replace(/<(?=[A-Za-z/!?])/g, '\\<');
  if (out.indexOf('&') !== -1) out = out.replace(/&(?=#?[A-Za-z0-9]+;)/g, '\\&');
  return out;
}

function codeSpan(text: string): string {
  let longest = 0;
  for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** Escapes what would start a block construct at the beginning of a paragraph line. */
function escapeLineStart(line: string): string {
  const m = /^(\d{1,9})([.)])(\s|$)/.exec(line);
  if (m) return `${m[1]}\\${line.slice(m[1].length)}`;
  if (/^(?:#{1,6}(?:\s|$)|>|[-+](?:\s|$)|=+\s*$|-{3,}\s*$|~~~|\|)/.test(line)) return `\\${line}`;
  return line;
}

/* ------------------------------------------------------------------ */
/* Markdown writers                                                    */
/* ------------------------------------------------------------------ */

/** Accumulates inline markdown with browser-like whitespace collapsing. */
class InlineBuffer {
  private parts: string[] = [];
  constructor(public space = true) {}

  text(raw: string): void {
    let s = raw.replace(WS_RE, ' ');
    if (this.space && s.charCodeAt(0) === 32) s = s.slice(1);
    if (!s) return;
    this.parts.push(escapeMd(s));
    this.space = s.charCodeAt(s.length - 1) === 32;
  }

  /** Appends already-formatted markdown. */
  md(s: string): void {
    if (this.space && s.charCodeAt(0) === 32) s = s.slice(1);
    if (!s) return;
    this.parts.push(s);
    this.space = s.charCodeAt(s.length - 1) === 32 || s.endsWith(BR);
  }

  take(): string {
    const s = this.parts.join('');
    this.parts = [];
    this.space = true;
    return s;
  }
}

interface Block {
  text: string;
  list?: boolean;
}

/** Collects blocks (paragraphs, headings, lists...) in order. */
class Writer {
  readonly blocks: Block[] = [];
  readonly buf = new InlineBuffer();

  flush(): void {
    const s = this.buf.take();
    if (!s) return;
    const lines = s
      .split(BR)
      .map((l) => l.trim())
      .filter((l, idx, all) => l !== '' || (idx > 0 && idx < all.length - 1));
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    if (lines.length === 0) return;
    this.blocks.push({ text: lines.map(escapeLineStart).filter((l) => l !== '').join('  \n') });
  }

  push(text: string, list = false): void {
    this.flush();
    const t = trimNewlines(text, true);
    if (t.trim()) this.blocks.push({ text: t, list });
  }

  /** Markdown for the collected blocks. `tight` keeps nested lists directly under their item text. */
  join(tight = false): string {
    this.flush();
    let out = '';
    for (let i = 0; i < this.blocks.length; i++) {
      if (i > 0) out += tight && this.blocks[i].list ? '\n' : '\n\n';
      out += this.blocks[i].text;
    }
    return out;
  }
}

function wrap(inner: string, open: string, close = open): string {
  const lead = inner.charCodeAt(0) === 32 ? ' ' : '';
  const trail = inner.length > 1 && inner.charCodeAt(inner.length - 1) === 32 ? ' ' : '';
  const core = inner.trim();
  if (!core || core === BR) return lead || trail ? ' ' : '';
  return lead + open + core + close + trail;
}

const INLINE = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'font', 'i', 'img', 'ins', 'kbd', 'label', 'mark', 'q',
  's', 'samp', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'time', 'tt', 'u', 'var', 'wbr', 'br', 'big', 'amoxi-island',
  'amoxi-slot', 'button', 'output', 'input', 'select', 'textarea',
]);
const BLOCKISH = new Set([
  'p', 'div', 'section', 'article', 'header', 'footer', 'main', 'nav', 'aside', 'address', 'figure', 'figcaption', 'fieldset', 'legend',
  'details', 'summary', 'center', 'hgroup', 'search', 'dialog', 'body', 'html', 'caption', 'li', 'dd', 'dt', 'tr', 'td', 'th',
  'tbody', 'thead', 'tfoot', 'option', 'optgroup', 'menu',
]);
const CHROME = new Set(['header', 'footer', 'nav', 'aside']);
const CHROME_ROLES = new Set(['banner', 'navigation', 'contentinfo', 'complementary', 'search']);
const FORM_CONTROLS = new Set(['input', 'select', 'textarea', 'datalist', 'option', 'optgroup']);

interface Flags {
  link?: boolean;
  em?: boolean;
  strong?: boolean;
  del?: boolean;
}

interface Context {
  base?: string;
  templates: Map<string, El>;
  forms: Map<El, FormDescription>;
}

/** Walks the content tree once and produces markdown and the heading outline. */
class MarkdownRenderer {
  readonly headings: PageHeading[] = [];
  private readonly used = new Set<string>();
  private nest = 0;
  private article = 0;
  private inForm = 0;

  constructor(
    private readonly ctx: Context,
    private readonly dropChrome: boolean,
  ) {}

  render(root: El): string {
    const w = new Writer();
    this.children(root, w, 0);
    return w.join().replace(/ /g, ' ');
  }

  /** Effective children: a streamed slot shows its delivered content (once) instead of the fallback. */
  private kids(el: El): Node[] {
    if (el.tag === 'amoxi-slot') {
      const id = el.attrs.id;
      const t = id === undefined ? undefined : this.ctx.templates.get(id);
      if (t && !this.used.has(id!)) {
        this.used.add(id!);
        return t.children;
      }
    }
    return el.children;
  }

  private skip(el: El): boolean {
    if (DROP.has(el.tag) || FORM_CONTROLS.has(el.tag) || isHidden(el) || isSkipLink(el)) return true;
    if (this.inForm > 0 && (el.tag === 'label' || el.tag === 'button')) return true;
    if (this.dropChrome && this.article === 0) {
      if (CHROME.has(el.tag) || CHROME_ROLES.has((el.attrs.role ?? '').toLowerCase())) return true;
    }
    return false;
  }

  private children(el: El, w: Writer, depth: number): void {
    for (const c of this.kids(el)) this.block(c, w, depth + 1);
  }

  private block(node: Node, w: Writer, depth: number): void {
    if (typeof node === 'string') return w.buf.text(node);
    if (depth > MAX_WALK_DEPTH || this.skip(node)) return;
    const tag = node.tag;
    if (INLINE.has(tag) && tag !== 'amoxi-island' && tag !== 'amoxi-slot' && tag !== 'span' && tag !== 'font') {
      return this.inline(node, w.buf, {}, depth);
    }
    if (HEADINGS.has(tag)) return this.heading(node, w, depth);
    switch (tag) {
      case 'pre':
        return w.push(this.pre(node));
      case 'blockquote':
        return this.quote(node, w, depth);
      case 'ul':
      case 'ol':
      case 'menu':
        return this.list(node, w, depth);
      case 'dl':
        return this.dl(node, w, depth);
      case 'table':
        return this.table(node, w, depth);
      case 'hr':
        return w.push('---');
      case 'form':
        return this.form(node, w, depth);
      case 'article':
        this.article++;
        w.flush();
        this.children(node, w, depth);
        w.flush();
        this.article--;
        return;
      case 'summary':
      case 'legend':
      case 'caption':
      case 'figcaption': {
        w.flush();
        const sub = new InlineBuffer();
        for (const c of this.kids(node)) this.inline(c, sub, { strong: tag !== 'figcaption' }, depth + 1);
        const s = sub.take();
        w.push(tag === 'figcaption' ? wrap(s, '*') : wrap(s, '**'));
        return;
      }
    }
    if (BLOCKISH.has(tag)) {
      w.flush();
      this.children(node, w, depth);
      w.flush();
      return;
    }
    this.children(node, w, depth); // span, islands, slots, custom elements: transparent
  }

  private inline(node: Node, buf: InlineBuffer, f: Flags, depth: number): void {
    if (typeof node === 'string') return buf.text(node);
    if (depth > MAX_WALK_DEPTH || this.skip(node)) return;
    const tag = node.tag;
    const kids = (flags: Flags, into: InlineBuffer = buf): void => {
      for (const c of this.kids(node)) this.inline(c, into, flags, depth + 1);
    };
    const wrapped = (open: string, flags: Flags, close = open): void => {
      const sub = new InlineBuffer(buf.space);
      kids(flags, sub);
      buf.md(wrap(sub.take(), open, close));
    };
    switch (tag) {
      case 'br':
        return buf.md(BR);
      case 'wbr':
        return;
      case 'a': {
        const href = f.link ? undefined : resolveUrl(node.attrs.href, this.ctx.base);
        if (href === undefined || href === '') return kids(f);
        const sub = new InlineBuffer(buf.space);
        kids({ ...f, link: true }, sub);
        let inner = sub.take().split(BR).join(' ');
        if (!inner.trim()) inner = escapeMd(node.attrs['aria-label'] ?? node.attrs.title ?? '');
        if (!inner.trim()) return;
        buf.md(wrap(inner, '[', `](${mdUrl(href)})`));
        return;
      }
      case 'em':
      case 'i':
      case 'cite':
      case 'dfn':
      case 'var':
        return f.em ? kids(f) : wrapped('*', { ...f, em: true });
      case 'strong':
      case 'b':
        return f.strong ? kids(f) : wrapped('**', { ...f, strong: true });
      case 'del':
      case 's':
      case 'strike':
        return f.del ? kids(f) : wrapped('~~', { ...f, del: true });
      case 'q':
        return wrapped('“', f, '”');
      case 'code':
      case 'kbd':
      case 'samp':
      case 'tt': {
        const text = plainText(node, 100_000);
        if (!text) return;
        const lead = buf.space ? '' : /^\s/.test(this.rawFirst(node)) ? ' ' : '';
        buf.md(lead + codeSpan(text));
        return;
      }
      case 'img': {
        const alt = (node.attrs.alt ?? '').replace(WS_RE, ' ').trim();
        const src = resolveUrl(node.attrs.src, this.ctx.base);
        if (!src) {
          if (alt) buf.text(alt);
          return;
        }
        buf.md(`![${escapeMd(alt)}](${mdUrl(src)})`);
        return;
      }
    }
    if (HEADINGS.has(tag) || BLOCKISH.has(tag) || tag === 'pre' || tag === 'blockquote' || tag === 'ul' || tag === 'ol' || tag === 'table' || tag === 'dl' || tag === 'form') {
      buf.text(' ');
      kids(f);
      buf.text(' ');
      return;
    }
    kids(f);
  }

  /** First raw character of an element (to keep a space before an inline code span). */
  private rawFirst(el: El): string {
    const first = el.children[0];
    return typeof first === 'string' ? first : '';
  }

  private heading(node: El, w: Writer, depth: number): void {
    w.flush();
    const sub = new InlineBuffer();
    for (const c of this.kids(node)) this.inline(c, sub, {}, depth + 1);
    let md = sub.take().split(BR).join(' ').replace(/ {2,}/g, ' ').trim();
    if (!md) return;
    md = md.replace(/(\s)(#+)$/, (_m, s: string, h: string) => `${s}${'\\#'.repeat(h.length)}`);
    const level = Number(node.tag[1]);
    w.push(`${'#'.repeat(level)} ${md}`);
    if (this.headings.length < MAX_HEADINGS) {
      const h: PageHeading = { level, text: plainText(node) };
      if (node.attrs.id) h.id = node.attrs.id;
      this.headings.push(h);
    }
  }

  private pre(node: El): string {
    const parts: string[] = [];
    const visit = (n: Node, depth: number): void => {
      if (typeof n === 'string') return void parts.push(n);
      if (depth > MAX_WALK_DEPTH || DROP.has(n.tag) || isHidden(n)) return;
      if (n.tag === 'br') parts.push('\n');
      for (const c of this.kids(n)) visit(c, depth + 1);
    };
    for (const c of this.kids(node)) visit(c, 1);
    let text = parts.join('').replace(/ /g, ' ');
    if (text.startsWith('\n')) text = text.slice(1);
    text = text.trimEnd();
    const code = node.children.find((c): c is El => typeof c !== 'string' && c.tag === 'code');
    const cls = `${node.attrs.class ?? ''} ${code?.attrs.class ?? ''} ${node.attrs['data-lang'] ?? ''}`;
    const lang = /(?:^|\s)(?:lang(?:uage)?-)([\w+#.-]{1,30})/.exec(cls)?.[1] ?? '';
    let longest = 0;
    for (const m of text.matchAll(/`{3,}/g)) longest = Math.max(longest, m[0].length);
    const fence = '`'.repeat(Math.max(3, longest + 1));
    return `${fence}${lang}\n${text}\n${fence}`;
  }

  private quote(node: El, w: Writer, depth: number): void {
    w.flush();
    if (this.nest >= MAX_NEST) return this.children(node, w, depth);
    this.nest++;
    const sub = new Writer();
    this.children(node, sub, depth);
    this.nest--;
    const md = sub.join();
    if (md) w.push(md.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n'));
  }

  private list(node: El, w: Writer, depth: number): void {
    w.flush();
    if (this.nest >= MAX_NEST) return this.children(node, w, depth);
    this.nest++;
    const ordered = node.tag === 'ol';
    let n = ordered ? Number.parseInt(node.attrs.start ?? '1', 10) : 0;
    if (!Number.isFinite(n) || n < 0 || n > 999_999_999) n = 1;
    const items: string[] = [];
    let stray: Writer | undefined;
    const addItem = (md: string): void => {
      const marker = ordered ? `${n++}. ` : '- ';
      const pad = ' '.repeat(marker.length);
      items.push(md ? marker + md.split('\n').map((l, i) => (i === 0 || !l ? l : pad + l)).join('\n') : marker.trimEnd());
    };
    const endStray = (): void => {
      if (stray) {
        const md = stray.join(true);
        if (md) addItem(md);
        stray = undefined;
      }
    };
    for (const c of this.kids(node)) {
      if (typeof c !== 'string' && c.tag === 'li') {
        endStray();
        if (this.skip(c)) continue;
        const sub = new Writer();
        this.children(c, sub, depth + 1);
        addItem(sub.join(true));
      } else if (typeof c !== 'string' && (c.tag === 'ul' || c.tag === 'ol') && items.length > 0 && !stray) {
        // Invalid but common: a nested list placed directly in the parent list.
        const sub = new Writer();
        this.list(c, sub, depth + 1);
        const md = sub.join();
        if (md) {
          const marker = items[items.length - 1].match(/^(\d+\. |- )/)![1];
          items[items.length - 1] += '\n' + md.split('\n').map((l) => (l ? ' '.repeat(marker.length) + l : l)).join('\n');
        }
      } else {
        if (typeof c === 'string' && !c.trim()) continue;
        stray ??= new Writer();
        this.block(c, stray, depth + 1);
      }
    }
    endStray();
    this.nest--;
    if (items.length === 0) return;
    const loose = items.some((it) => /\n\n/.test(it));
    w.push(items.join(loose ? '\n\n' : '\n'), true);
  }

  private dl(node: El, w: Writer, depth: number): void {
    w.flush();
    const groups: Array<{ terms: string[]; descs: string[] }> = [];
    let g: { terms: string[]; descs: string[] } | undefined;
    const inlineOf = (el: El): string => {
      const sub = new InlineBuffer();
      for (const c of this.kids(el)) this.inline(c, sub, {}, depth + 2);
      return sub.take().split(BR).join(' ').trim();
    };
    const visit = (el: El, d: number): void => {
      for (const c of this.kids(el)) {
        if (typeof c === 'string' || this.skip(c)) continue;
        if (c.tag === 'dt') {
          if (!g || g.descs.length > 0) groups.push((g = { terms: [], descs: [] }));
          const t = inlineOf(c);
          if (t) g.terms.push(t);
        } else if (c.tag === 'dd') {
          if (!g) groups.push((g = { terms: [], descs: [] }));
          const d2 = inlineOf(c);
          if (d2) g.descs.push(d2);
        } else if (d < 4) visit(c, d + 1); // <div> wrappers
      }
    };
    visit(node, 0);
    for (const grp of groups) {
      const term = grp.terms.length > 0 ? `**${grp.terms.join(', ').replace(/^\*\*|\*\*$/g, '')}**` : '';
      const desc = grp.descs.join('; ');
      w.push(term && desc ? `${term}: ${desc}` : term || desc);
    }
  }

  private table(node: El, w: Writer, depth: number): void {
    w.flush();
    const role = (node.attrs.role ?? '').toLowerCase();
    if (role === 'presentation' || role === 'none') {
      const walk = (el: El, d: number): void => {
        for (const c of this.kids(el)) {
          if (typeof c !== 'string' && !this.skip(c) && ['tbody', 'thead', 'tfoot', 'tr', 'td', 'th'].includes(c.tag)) {
            w.flush();
            if (c.tag === 'td' || c.tag === 'th') this.children(c, w, depth + d);
            else walk(c, d + 1);
            w.flush();
          }
        }
      };
      return walk(node, 1);
    }
    const head: El[] = [];
    const body: El[] = [];
    const foot: El[] = [];
    let caption = '';
    for (const c of this.kids(node)) {
      if (typeof c === 'string' || this.skip(c)) continue;
      if (c.tag === 'tr') body.push(c);
      else if (c.tag === 'thead' || c.tag === 'tbody' || c.tag === 'tfoot') {
        const into = c.tag === 'thead' ? head : c.tag === 'tfoot' ? foot : body;
        for (const r of this.kids(c)) if (typeof r !== 'string' && r.tag === 'tr' && !this.skip(r)) into.push(r);
      } else if (c.tag === 'caption') caption = plainText(c);
    }
    const rows = [...head, ...body, ...foot].map((r) => this.row(r, depth));
    if (rows.length === 0) return;
    const cols = Math.min(MAX_COLS, Math.max(1, ...rows.map((r) => r.length)));
    if (rows.every((r) => r.every((c) => c === ''))) return;
    const line = (cells: string[]): string => {
      const out: string[] = [];
      for (let i = 0; i < cols; i++) out.push(cells[i] ?? '');
      return `| ${out.join(' | ')} |`;
    };
    const lines = [line(rows[0]), line(new Array(cols).fill('---')), ...rows.slice(1).map(line)];
    if (caption) w.push(`**${escapeMd(caption)}**`);
    w.push(lines.join('\n'));
  }

  private row(tr: El, depth: number): string[] {
    const cells: string[] = [];
    for (const c of this.kids(tr)) {
      if (typeof c === 'string' || (c.tag !== 'td' && c.tag !== 'th') || this.skip(c)) continue;
      const sub = new InlineBuffer();
      for (const k of this.kids(c)) this.inline(k, sub, {}, depth + 2);
      const md = sub.take().split(BR).join('<br>').replace(/\|/g, '\\|').trim();
      cells.push(md);
      const span = Math.min(MAX_COLSPAN, Math.max(1, Number.parseInt(c.attrs.colspan ?? '1', 10) || 1));
      for (let i = 1; i < span; i++) cells.push('');
      if (cells.length >= MAX_COLS) break;
    }
    return cells;
  }

  private form(node: El, w: Writer, depth: number): void {
    w.flush();
    this.inForm++;
    this.children(node, w, depth);
    this.inForm--;
    w.flush();
    const desc = this.ctx.forms.get(node);
    if (desc) w.push(formSummary(desc));
  }
}

function formSummary(f: FormDescription): string {
  const head = `Form${f.name ? ` "${escapeMd(f.name)}"` : ''}: ${codeSpan(`${f.method} ${f.action || '(this page)'}`)}`;
  const lines = [head];
  for (const field of f.fields) {
    if (field.type === 'hidden') continue;
    const facts = [field.type];
    if (field.required) facts.push('required');
    const opts = field.options?.filter((o) => o !== '');
    if (opts && opts.length > 0) facts.push(`one of: ${opts.map((o) => codeSpan(o)).join(', ')}`);
    if (field.pattern) facts.push(`pattern ${codeSpan(field.pattern)}`);
    if (field.min !== undefined) facts.push(`min ${field.min}`);
    if (field.max !== undefined) facts.push(`max ${field.max}`);
    const label = field.label ? `**${escapeMd(field.label)}** ` : '';
    lines.push(`- ${label}(${codeSpan(field.name)}, ${facts.join(', ')})`);
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* Document-level passes                                               */
/* ------------------------------------------------------------------ */

interface Prepass {
  title?: string;
  ogTitle?: string;
  description?: string;
  lang?: string;
  body?: El;
  main?: El;
  templates: Map<string, El>;
  labelsFor: Map<string, string>;
  ids: Map<string, El>;
}

function prepass(root: El): Prepass {
  const p: Prepass = { templates: new Map(), labelsFor: new Map(), ids: new Map() };
  const visit = (el: El, depth: number, inTemplate: boolean, inSvg: boolean): void => {
    if (depth > MAX_DEPTH + 2) return;
    const a = el.attrs;
    switch (el.tag) {
      case 'html':
        if (a.lang && p.lang === undefined) p.lang = a.lang.trim();
        break;
      case 'body':
        p.body ??= el;
        break;
      case 'title':
        if (!inSvg && p.title === undefined) p.title = plainTextRaw(el);
        break;
      case 'meta': {
        const key = (a.name ?? a.property ?? '').toLowerCase();
        if (a.content !== undefined) {
          if (key === 'description' && p.description === undefined) p.description = a.content.trim();
          else if (key === 'og:description' && p.description === undefined) p.description = a.content.trim();
          else if (key === 'og:title' && p.ogTitle === undefined) p.ogTitle = a.content.trim();
        }
        break;
      }
      case 'template': {
        const id = a['data-amoxi-for'];
        if (id !== undefined && !p.templates.has(id)) p.templates.set(id, el);
        inTemplate = true;
        break;
      }
      case 'label':
        if (a.for !== undefined && !p.labelsFor.has(a.for)) p.labelsFor.set(a.for, labelText(el));
        break;
      case 'svg':
        inSvg = true;
        break;
    }
    if (a.id !== undefined && !p.ids.has(a.id) && p.ids.size < 50_000) p.ids.set(a.id, el);
    if (!inTemplate && !p.main && (el.tag === 'main' || (a.role ?? '').toLowerCase() === 'main') && !isHidden(el)) p.main = el;
    for (const c of el.children) if (typeof c !== 'string') visit(c, depth + 1, inTemplate, inSvg);
  };
  visit(root, 0, false, false);
  return p;
}

function plainTextRaw(el: El): string {
  return el.children
    .filter((c): c is string => typeof c === 'string')
    .join('')
    .replace(WS_RE, ' ')
    .replace(/ /g, ' ')
    .trim();
}

const LABEL_SKIP = new Set(['input', 'select', 'textarea', 'option', 'optgroup', 'button']);

function labelText(el: El): string {
  return plainText(el, 300, LABEL_SKIP).replace(/[\s:*]+$/, '').trim();
}

/** Visits every visible element of the body, following streamed slots (each at most once). */
function walkVisible(root: El, templates: Map<string, El>, visit: (el: El, enter: boolean) => boolean | void): void {
  const used = new Set<string>();
  const go = (el: El, depth: number): void => {
    if (depth > MAX_WALK_DEPTH) return;
    let kids = el.children;
    if (el.tag === 'amoxi-slot' && el.attrs.id !== undefined) {
      const t = templates.get(el.attrs.id);
      if (t && !used.has(el.attrs.id)) {
        used.add(el.attrs.id);
        kids = t.children;
      }
    }
    for (const c of kids) {
      if (typeof c === 'string') continue;
      if ((DROP.has(c.tag) && c.tag !== 'datalist') || isHidden(c)) continue;
      if (visit(c, true) === false) continue;
      go(c, depth + 1);
      visit(c, false);
    }
  };
  go(root, 0);
}

function collectLinks(root: El, p: Prepass, base: string | undefined): PageLink[] {
  const out: PageLink[] = [];
  const seen = new Set<string>();
  walkVisible(root, p.templates, (el, enter) => {
    if (!enter || el.tag !== 'a' || out.length >= MAX_LINKS) return;
    const raw = el.attrs.href;
    if (raw === undefined || raw.trim() === '' || raw.trim().startsWith('#') || isSkipLink(el)) return;
    const href = resolveUrl(raw, base);
    if (!href) return;
    let text = plainText(el, 300);
    if (!text) text = (el.attrs['aria-label'] ?? el.attrs.title ?? '').trim();
    const key = `${href}\n${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ text, href });
  });
  return out;
}

interface FormState {
  desc: FormDescription;
  byName: Map<string, FormField>;
}

function collectForms(root: El, p: Prepass, base: string | undefined): { list: FormDescription[]; byEl: Map<El, FormDescription> } {
  const list: FormDescription[] = [];
  const byEl = new Map<El, FormDescription>();
  const byId = new Map<string, FormState>();
  const formStack: FormState[] = [];
  const labelStack: El[] = [];
  const legendStack: string[] = [];
  /** Radio/checkbox groups whose label so far is just their first option's label. */
  const optionLabelled = new Set<FormField>();
  const deferred: Array<{ id: string; el: El; label?: El; legend?: string }> = [];

  const labelOf = (el: El, wrapping: El | undefined): string | undefined => {
    const a = el.attrs;
    if (a['aria-labelledby']) {
      const text = a['aria-labelledby']
        .split(/\s+/)
        .slice(0, 8)
        .map((id) => p.ids.get(id))
        .filter((x): x is El => x !== undefined)
        .map((x) => plainText(x, 300))
        .join(' ')
        .trim();
      if (text) return text;
    }
    if (a['aria-label']?.trim()) return a['aria-label'].trim();
    if (a.id !== undefined && p.labelsFor.get(a.id)) return p.labelsFor.get(a.id);
    if (wrapping) {
      const t = labelText(wrapping);
      if (t) return t;
    }
    return a.title?.trim() || a.placeholder?.trim() || undefined;
  };

  const addControl = (fs: FormState, el: El, wrapping: El | undefined, legend: string | undefined): void => {
    const a = el.attrs;
    const name = a.name;
    if (!name || a.disabled !== undefined) return;
    let type: string;
    let value: string | undefined;
    let options: string[] | undefined;
    if (el.tag === 'input') {
      type = (a.type ?? 'text').toLowerCase();
      if (type === 'reset' || type === 'button' || type === 'image') return;
      if (type === 'radio' || type === 'checkbox') {
        const v = a.value ?? 'on';
        const existing = fs.byName.get(name);
        if (existing && existing.type === type) {
          if (optionLabelled.delete(existing)) delete existing.label; // the group has several options
          if (existing.options && existing.options.length < MAX_OPTIONS) existing.options.push(v);
          if (a.checked !== undefined) existing.value = existing.value === undefined ? v : `${existing.value},${v}`;
          if (a.required !== undefined) existing.required = true;
          return;
        }
        options = [v];
        if (a.checked !== undefined) value = v;
      } else if (type !== 'password') value = a.value;
    } else if (el.tag === 'select') {
      type = a.multiple !== undefined ? 'select-multiple' : 'select';
      options = [];
      const visit = (n: El, d: number): void => {
        for (const c of n.children) {
          if (typeof c === 'string' || d > 3) continue;
          if (c.tag === 'option') {
            const v = c.attrs.value ?? plainText(c, 200);
            if (options!.length < MAX_OPTIONS && c.attrs.disabled === undefined) options!.push(v);
            if (c.attrs.selected !== undefined && value === undefined) value = v;
          } else if (c.tag === 'optgroup') visit(c, d + 1);
        }
      };
      visit(el, 0);
    } else if (el.tag === 'textarea') {
      type = 'textarea';
      const v = el.children.join('').replace(/^\n/, '');
      if (v) value = v;
    } else {
      // <button name=...>
      type = 'submit';
      value = a.value;
    }
    if (fs.byName.has(name) || fs.desc.fields.length >= MAX_FIELDS) return;
    const field: FormField = { name, type, required: a.required !== undefined };
    const group = el.tag === 'input' && (type === 'radio' || type === 'checkbox');
    const label = (group && legend) || labelOf(el, wrapping);
    if (label) field.label = label;
    if (group && label && !legend) optionLabelled.add(field);
    if (options) field.options = options;
    if (a.pattern !== undefined) field.pattern = a.pattern;
    if (a.min !== undefined) field.min = a.min;
    if (a.max !== undefined) field.max = a.max;
    if (value !== undefined && value !== '') field.value = value;
    fs.byName.set(name, field);
    fs.desc.fields.push(field);
  };

  walkVisible(p.body ?? root, p.templates, (el, enter) => {
    if (el.tag === 'form') {
      if (!enter) {
        formStack.pop();
        return;
      }
      if (list.length >= MAX_FORMS) return false;
      const a = el.attrs;
      let method = (a.method ?? 'get').toUpperCase();
      if (method !== 'GET' && method !== 'POST' && method !== 'DIALOG') method = 'GET';
      const action = a.action?.trim() ? (resolveUrl(a.action, base) ?? '') : (base ?? '');
      const desc: FormDescription = { action, method, fields: [] };
      const name = a.name ?? a.id ?? a['aria-label'];
      if (name) desc.name = name;
      const fs: FormState = { desc, byName: new Map() };
      list.push(desc);
      byEl.set(el, desc);
      if (a.id !== undefined && !byId.has(a.id)) byId.set(a.id, fs);
      formStack.push(fs);
      return;
    }
    if (el.tag === 'label') {
      if (enter) labelStack.push(el);
      else labelStack.pop();
      return;
    }
    if (el.tag === 'fieldset') {
      if (enter) {
        const legend = el.children.find((c): c is El => typeof c !== 'string' && c.tag === 'legend');
        legendStack.push(legend ? plainText(legend, 300) : '');
      } else legendStack.pop();
      return;
    }
    if (!enter) return;
    if (el.tag === 'input' || el.tag === 'select' || el.tag === 'textarea' || el.tag === 'button') {
      const wrapping = labelStack[labelStack.length - 1];
      const legend = legendStack[legendStack.length - 1] || undefined;
      if (el.attrs.form !== undefined) deferred.push({ id: el.attrs.form, el, label: wrapping, legend });
      else if (formStack.length > 0) addControl(formStack[formStack.length - 1], el, wrapping, legend);
      return el.tag === 'button'; // never descend into controls except buttons
    }
  });
  for (const d of deferred) {
    const fs = byId.get(d.id);
    if (fs) addControl(fs, d.el, d.label, d.legend);
  }
  return { list, byEl };
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Parses a rendered page and returns its readable content as markdown plus a structured outline.
 * Content comes from `<main>` when present; otherwise from `<body>` without header, nav, footer
 * and aside. Links and forms are collected from the whole body (navigation is useful to agents).
 */
export function htmlToDocument(html: string, options: HtmlToDocumentOptions = {}): PageDocument {
  const base = options.baseUrl;
  const root = parseHtml(typeof html === 'string' ? html : String(html ?? ''));
  const p = prepass(root);
  const forms = collectForms(root, p, base);
  const content = p.main ?? p.body ?? root;
  const renderer = new MarkdownRenderer({ base, templates: p.templates, forms: forms.byEl }, !p.main);
  const markdown = renderer.render(content);
  const title = p.title || p.ogTitle || renderer.headings.find((h) => h.level === 1)?.text || '';
  const doc: PageDocument = {
    title,
    markdown: markdown ? `${markdown}\n` : '',
    headings: renderer.headings,
    links: collectLinks(p.body ?? root, p, base),
    forms: forms.list,
  };
  if (p.description) doc.description = p.description;
  if (p.lang) doc.lang = p.lang;
  return doc;
}
