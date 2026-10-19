// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export class ConfigurationError extends Error {
  override name = 'ConfigurationError';
}

export interface ConfigLoadOptions {
  /** Directory containing the config file. Default: process.cwd() */
  cwd?: string;
  /** Config file name. Default: application.json */
  file?: string;
  env?: NodeJS.ProcessEnv;
  argv?: readonly string[];
  /** Active profile; defaults to AMOXI_ENV, else 'production' when NODE_ENV=production, else 'development'. */
  profile?: string;
}

/**
 * Relaxed binding (like Micronaut/Spring): keys are lower-cased and hyphens removed,
 * so `users.max-count`, `users.maxCount` and env `USERS_MAXCOUNT` are the same key.
 */
function canonical(key: string): string {
  return key.toLowerCase().replace(/-/g, '');
}

/**
 * Parses a .env file: KEY=value lines, `#` comments, optional `export ` prefix,
 * single/double quotes (double quotes support \n escapes).
 */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2];
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.lastIndexOf(quote) > 0) {
      value = value.slice(1, value.lastIndexOf(quote));
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    out[m[1]] = value;
  }
  return out;
}

/**
 * Loads .env files like Next.js: `.env.<profile>.local`, `.env.local`, `.env.<profile>`, `.env`
 * (first wins). `.env.local` files are skipped for the test profile. Real environment
 * variables always take precedence over files.
 */
function loadDotenv(dir: string, profile: string): Record<string, string> {
  const names = [`.env.${profile}.local`, ...(profile === 'test' ? [] : ['.env.local']), `.env.${profile}`, '.env'];
  const merged: Record<string, string> = {};
  for (const name of names.reverse()) {
    try {
      Object.assign(merged, parseDotenv(readFileSync(resolve(dir, name), 'utf8')));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new ConfigurationError(`Cannot read ${name}: ${(err as Error).message}`);
    }
  }
  return merged;
}

function flatten(value: unknown, prefix: string, out: Map<string, string>): void {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else if (prefix) {
    out.set(canonical(prefix), Array.isArray(value) ? JSON.stringify(value) : String(value));
  }
}

/**
 * Precedence (highest first): command line `--key=value`, environment variables, application.json.
 * Loading is a single synchronous file read: no YAML parser, no classpath scanning.
 */
export class Config {
  private constructor(
    private readonly values: Map<string, string>,
    /** e.g. 'development', 'production', 'test'. `application-<profile>.json` is layered on top of application.json. */
    readonly profile: string,
  ) {}

  get isProduction(): boolean {
    return this.profile === 'production';
  }

  static load(options: ConfigLoadOptions = {}): Config {
    const values = new Map<string, string>();
    const realEnv = options.env ?? process.env;
    const profile = options.profile ?? realEnv.AMOXI_ENV ?? (realEnv.NODE_ENV === 'production' ? 'production' : 'development');
    const env: NodeJS.ProcessEnv = { ...loadDotenv(options.cwd ?? process.cwd(), profile), ...realEnv };
    const base = options.file ?? 'application.json';
    const files = [base, base.replace(/\.json$/, `-${profile}.json`)];
    for (const name of files) {
      const file = resolve(options.cwd ?? process.cwd(), name);
      try {
        flatten(JSON.parse(readFileSync(file, 'utf8')), '', values);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new ConfigurationError(`Invalid configuration file ${file}: ${(err as Error).message}`);
        }
      }
    }
    for (const [k, v] of Object.entries(env)) {
      if (v !== undefined && /^[A-Z][A-Z0-9_]*$/.test(k)) values.set(canonical(k.replace(/_/g, '.')), v);
    }
    for (const arg of options.argv ?? process.argv.slice(2)) {
      const m = /^--([^=]+)=(.*)$/.exec(arg);
      if (m) values.set(canonical(m[1]), m[2]);
    }
    return new Config(values, profile);
  }

  /** Build a config from an in-memory map: handy for tests. Nested objects are flattened. */
  static of(values: Record<string, unknown> = {}, profile = 'test'): Config {
    const map = new Map<string, string>();
    flatten(values, '', map);
    return new Config(map, profile);
  }

  has(key: string): boolean {
    return this.values.has(canonical(key));
  }

  /**
   * The names directly under `prefix`, e.g. keys('ai.mcp.callers') gives ['partner'] for
   * ai.mcp.callers.partner. Names come back in canonical form: lower case, dashes removed.
   */
  keys(prefix: string): string[] {
    const start = `${canonical(prefix)}.`;
    const names = new Set<string>();
    for (const key of this.values.keys()) {
      if (!key.startsWith(start)) continue;
      const name = key.slice(start.length).split('.')[0];
      if (name) names.add(name);
    }
    return [...names].sort();
  }

  private raw(key: string, fallback: string | undefined): string {
    const v = this.values.get(canonical(key)) ?? fallback;
    if (v === undefined) {
      throw new ConfigurationError(`Missing required configuration property '${key}' (and no default was given)`);
    }
    return v;
  }

  string(key: string, fallback?: string): string {
    return this.raw(key, fallback);
  }

  number(key: string, fallback?: string): number {
    const raw = this.raw(key, fallback);
    const n = Number(raw);
    if (raw.trim() === '' || Number.isNaN(n)) {
      throw new ConfigurationError(`Configuration property '${key}' must be a number, got '${raw}'`);
    }
    return n;
  }

  boolean(key: string, fallback?: string): boolean {
    const raw = this.raw(key, fallback).toLowerCase();
    if (raw === 'true' || raw === '1' || raw === 'yes') return true;
    if (raw === 'false' || raw === '0' || raw === 'no') return false;
    throw new ConfigurationError(`Configuration property '${key}' must be a boolean, got '${raw}'`);
  }
}
