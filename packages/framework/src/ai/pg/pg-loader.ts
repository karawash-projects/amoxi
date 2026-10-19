// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from 'node:module';
import { join } from 'node:path';

/**
 * The part of a `pg` Pool or Client the stores use (Adapter seam): anything with a compatible
 * `query` works, e.g. PGlite in tests or a pool wrapped with tracing.
 */
export interface PgQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

/** A pg Pool as far as the factory needs it. */
export interface PgPoolLike extends PgQueryable {
  end(): Promise<void>;
}

/** The subset of the `pg` module the factory uses. */
export interface PgModule {
  Pool: new (config: { connectionString?: string; max?: number; [key: string]: unknown }) => PgPoolLike;
}

export const PG_MISSING_MESSAGE =
  "PostgreSQL support needs the 'pg' package, which is not installed in this app. " +
  'Install it with `npm install pg`. ' +
  'For vector search also enable the pgvector extension in your database: install pgvector on the server ' +
  '(e.g. the pgvector/pgvector Docker image, or your provider\'s "vector" extension) and run ' +
  '`CREATE EXTENSION IF NOT EXISTS vector;` as a user allowed to create extensions.';

/**
 * Loads the optional `pg` package from the app's own node_modules (resolved from `cwd`), so the
 * framework has no hard dependency on it and nothing is loaded until PostgreSQL is configured.
 */
export function loadPg(cwd: string = process.cwd()): PgModule {
  const req = createRequire(join(cwd, 'package.json'));
  let mod: any;
  try {
    mod = req('pg');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND') throw new Error(PG_MISSING_MESSAGE);
    throw err;
  }
  const pg = (mod?.Pool ? mod : mod?.default) as PgModule | undefined;
  if (!pg?.Pool) throw new Error("The installed 'pg' package has no Pool export. Reinstall it with `npm install pg`.");
  return pg;
}

/** Validates a table prefix (it is interpolated into SQL identifiers, so it must be strict). */
export function checkTablePrefix(prefix: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(prefix) || prefix.length > 40) {
    throw new Error(`Invalid table prefix '${prefix}': use lower-case letters, digits and underscores, starting with a letter or underscore (max 40 characters).`);
  }
  return prefix;
}

/** Runs `init` once; a failed initialisation is retried on the next call. */
export function once(init: () => Promise<void>): () => Promise<void> {
  let p: Promise<void> | undefined;
  return () =>
    (p ??= init().catch((err) => {
      p = undefined;
      throw err;
    }));
}
