// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import { brotliCompressSync, constants, createBrotliCompress, createGzip, gzipSync, type BrotliCompress, type Gzip } from 'node:zlib';

export type Encoding = 'br' | 'gzip';

const COMPRESSIBLE = /^(text\/|application\/(json|javascript|xml|manifest\+json)|image\/svg\+xml)/;

export function compressible(contentType: string | undefined): boolean {
  return !!contentType && COMPRESSIBLE.test(contentType);
}

/**
 * Picks an encoding from Accept-Encoding (ignoring q=0). Precompressed static files prefer
 * brotli (smallest, costs nothing per request); dynamic responses prefer gzip, which is about
 * twice as fast as brotli at the same size for typical HTML/JSON.
 */
export function negotiate(accept: string | string[] | undefined, prefer: Encoding = 'br'): Encoding | null {
  if (!accept) return null;
  const a = (Array.isArray(accept) ? accept.join(',') : accept).toLowerCase();
  const allowed = (name: string): boolean => new RegExp(`(^|[,\\s])${name}(?![\\w-])(?!\\s*;\\s*q=0(\\.0+)?(\\s|,|$))`).test(a);
  const order: Encoding[] = prefer === 'br' ? ['br', 'gzip'] : ['gzip', 'br'];
  return order.find(allowed) ?? null;
}

/** Fast settings for dynamic responses (brotli quality 4 ≈ gzip speed, smaller output). */
export function compressSync(buf: Buffer, enc: Encoding): Buffer {
  return enc === 'br'
    ? brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 4, [constants.BROTLI_PARAM_LGWIN]: 18, [constants.BROTLI_PARAM_SIZE_HINT]: buf.length } })
    : gzipSync(buf, { level: 6 });
}

/** Streaming compressor that flushes after every write, so streamed HTML reaches the browser immediately. */
export function compressStream(enc: Encoding): BrotliCompress | Gzip {
  return enc === 'br'
    ? createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: 4 }, flush: constants.BROTLI_OPERATION_FLUSH })
    : createGzip({ level: 6, flush: constants.Z_SYNC_FLUSH });
}
