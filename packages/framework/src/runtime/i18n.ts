// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

/**
 * Internationalisation: message bundles from src/i18n/<locale>.json (validated and embedded by
 * `amoxi build`), locale negotiation per request, and ICU-style plurals.
 *
 *   "people.count": "{count, plural, =0 {No people} one {# person} other {# people}}"
 *   "greeting": "Hello, {name}!"
 */

export interface I18nBundle {
  readonly defaultLocale: string;
  readonly locales: readonly string[];
  readonly messages: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export type MessageParams = Readonly<Record<string, string | number>>;

const pluralRules = new Map<string, Intl.PluralRules>();
const numberFormats = new Map<string, Intl.NumberFormat>();

function plural(locale: string): Intl.PluralRules {
  let r = pluralRules.get(locale);
  if (!r) pluralRules.set(locale, (r = new Intl.PluralRules(locale)));
  return r;
}

function number(locale: string): Intl.NumberFormat {
  let f = numberFormats.get(locale);
  if (!f) numberFormats.set(locale, (f = new Intl.NumberFormat(locale)));
  return f;
}

/** Finds the matching closing brace for the '{' at `start`. */
function closing(s: string, start: number): number {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}' && --depth === 0) return i;
  }
  return -1;
}

/** Formats a message with {param} substitution and {n, plural, ...} selection. */
export function formatMessage(template: string, params: MessageParams | undefined, locale: string): string {
  let out = '';
  let i = 0;
  while (i < template.length) {
    const open = template.indexOf('{', i);
    if (open === -1) {
      out += template.slice(i);
      break;
    }
    out += template.slice(i, open);
    const close = closing(template, open);
    if (close === -1) {
      out += template.slice(open);
      break;
    }
    const body = template.slice(open + 1, close);
    const pluralMatch = /^\s*(\w+)\s*,\s*plural\s*,(.*)$/s.exec(body);
    if (pluralMatch) {
      const value = Number(params?.[pluralMatch[1]] ?? 0);
      const options = new Map<string, string>();
      const spec = pluralMatch[2];
      let j = 0;
      while (j < spec.length) {
        const key = /^\s*(=\d+|\w+)\s*\{/.exec(spec.slice(j));
        if (!key) break;
        const start = j + key[0].length - 1;
        const end = closing(spec, start);
        if (end === -1) break;
        options.set(key[1], spec.slice(start + 1, end));
        j = end + 1;
      }
      const chosen = options.get(`=${value}`) ?? options.get(plural(locale).select(value)) ?? options.get('other') ?? '';
      out += formatMessage(chosen.replace(/#/g, number(locale).format(value)), params, locale);
    } else {
      const name = body.trim();
      const value = params?.[name];
      out += value === undefined ? `{${name}}` : typeof value === 'number' ? number(locale).format(value) : value;
    }
    i = close + 1;
  }
  return out;
}

/** Translates keys for one locale, falling back to the default locale, then to the key itself. */
export class Translator {
  constructor(
    private readonly bundle: I18nBundle | undefined,
    readonly locale: string,
  ) {}

  t(key: string, params?: MessageParams): string {
    const template = this.bundle?.messages[this.locale]?.[key] ?? this.bundle?.messages[this.bundle.defaultLocale]?.[key];
    return template === undefined ? key : formatMessage(template, params, this.locale);
  }

  has(key: string): boolean {
    return !!this.bundle?.messages[this.locale]?.[key];
  }
}

/** Picks the best locale from an Accept-Language header (exact match, then language prefix). */
export function negotiateLocale(acceptLanguage: string | undefined, locales: readonly string[], fallback: string): string {
  if (!acceptLanguage) return fallback;
  const wanted = acceptLanguage
    .split(',')
    .map((part) => {
      const [tag, ...rest] = part.trim().split(';');
      const q = rest.find((p) => p.trim().startsWith('q='));
      return { tag: tag.toLowerCase(), q: q ? Number(q.trim().slice(2)) : 1 };
    })
    .filter((w) => w.tag && w.q > 0)
    .sort((a, b) => b.q - a.q);
  const lower = locales.map((l) => l.toLowerCase());
  for (const { tag } of wanted) {
    const exact = lower.indexOf(tag);
    if (exact !== -1) return locales[exact];
    const base = tag.split('-')[0];
    const prefix = lower.findIndex((l) => l === base || l.split('-')[0] === base);
    if (prefix !== -1) return locales[prefix];
  }
  return fallback;
}
