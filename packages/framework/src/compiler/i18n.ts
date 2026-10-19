// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { Diagnostic } from './model';

export interface LoadedBundles {
  bundle?: { defaultLocale: string; locales: string[]; messages: Record<string, Record<string, string>> };
  diagnostics: Diagnostic[];
  warnings: string[];
}

function flatten(value: unknown, prefix: string, out: Record<string, string>, file: string, diagnostics: Diagnostic[]): void {
  if (typeof value === 'string') {
    out[prefix] = value;
  } else if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out, file, diagnostics);
  } else {
    diagnostics.push({ message: `${file}: '${prefix}' must be a string or a nested object of strings`, loc: { file, line: 1 } });
  }
}

const placeholders = (s: string): string[] => [...new Set([...s.matchAll(/\{\s*(\w+)\s*[,}]/g)].map((m) => m[1]))].sort();

/**
 * Loads src/i18n/<locale>.json. The default locale is `en` when present, otherwise the first file.
 * Errors: invalid JSON or values. Warnings: keys missing from or extra in a locale, and
 * placeholders that differ from the default locale (the runtime falls back to the default).
 */
export function loadBundles(dir: string, defaultLocale?: string): LoadedBundles {
  const diagnostics: Diagnostic[] = [];
  const warnings: string[] = [];
  if (!existsSync(dir)) return { diagnostics, warnings };
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  if (files.length === 0) return { diagnostics, warnings };

  const messages: Record<string, Record<string, string>> = {};
  for (const f of files) {
    const rel = path.relative(process.cwd(), path.join(dir, f));
    try {
      const out: Record<string, string> = {};
      flatten(JSON.parse(readFileSync(path.join(dir, f), 'utf8')), '', out, rel, diagnostics);
      messages[f.slice(0, -5)] = out;
    } catch (err) {
      diagnostics.push({ message: `${rel}: invalid JSON (${(err as Error).message})`, loc: { file: rel, line: 1 } });
    }
  }
  const locales = Object.keys(messages);
  const def = defaultLocale && messages[defaultLocale] ? defaultLocale : messages.en ? 'en' : locales[0];
  if (!def) return { diagnostics, warnings };
  const base = messages[def];
  for (const locale of locales) {
    if (locale === def) continue;
    const m = messages[locale];
    const missing = Object.keys(base).filter((k) => !(k in m));
    const extra = Object.keys(m).filter((k) => !(k in base));
    if (missing.length) warnings.push(`i18n: '${locale}' is missing ${missing.length} key(s), shown in '${def}' instead: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', ...' : ''}`);
    if (extra.length) warnings.push(`i18n: '${locale}' has key(s) not in '${def}': ${extra.slice(0, 5).join(', ')}`);
    for (const k of Object.keys(base)) {
      if (k in m && placeholders(base[k]).join() !== placeholders(m[k]).join()) {
        warnings.push(`i18n: '${locale}.${k}' uses {${placeholders(m[k]).join('}, {')}} but '${def}' uses {${placeholders(base[k]).join('}, {')}}`);
      }
    }
  }
  return { bundle: { defaultLocale: def, locales, messages }, diagnostics, warnings };
}
