// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import { createReadStream, statSync, type Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as path from 'node:path';
import { compressible, compressStream, negotiate } from './compression';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/**
 * Serves files from one directory, identically on Windows, macOS and Linux.
 *
 * URLs are normalised with POSIX rules (URLs always use '/') and only then mapped onto the
 * OS path, so a request can never escape the root via '..', '\', drive letters or
 * encoded separators. Dotfiles are never served.
 */
export class StaticFiles {
  private constructor(private readonly root: string) {}

  /** Returns undefined when the directory does not exist, so static serving is opt-in by convention. */
  static create(dir: string): StaticFiles | undefined {
    const root = path.resolve(dir);
    try {
      return statSync(root).isDirectory() ? new StaticFiles(root) : undefined;
    } catch {
      return undefined;
    }
  }

  get directory(): string {
    return this.root;
  }

  /** Returns true when the request was answered. */
  async serve(req: IncomingMessage, res: ServerResponse, urlPath: string, compress = true): Promise<boolean> {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;

    let file = this.resolve(urlPath);
    if (!file) return false;
    let st = await statOrNull(file);
    if (st?.isDirectory()) {
      file = path.join(file, 'index.html');
      st = await statOrNull(file);
    }
    if (!st?.isFile()) return false;

    const ext = path.extname(file).toLowerCase();
    const type = CONTENT_TYPES[ext] ?? 'application/octet-stream';
    // Prefer a precompressed sibling written by `amoxi build` (file.br / file.gz), else compress on the fly.
    const enc = compress && compressible(type) ? negotiate(req.headers['accept-encoding']) : null;
    let sendFile = file;
    let sendSize: number | undefined = st.size;
    let encoding: string | undefined;
    if (enc) {
      const sibling = await statOrNull(`${file}.${enc === 'br' ? 'br' : 'gz'}`);
      if (sibling?.isFile()) {
        sendFile = `${file}.${enc === 'br' ? 'br' : 'gz'}`;
        sendSize = sibling.size;
        encoding = enc;
      } else if (st.size >= 1024) {
        sendSize = undefined;
        encoding = negotiate(req.headers['accept-encoding'], 'gzip') ?? enc;
      }
    }
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}${encoding ? `-${encoding}` : ''}"`;
    const headers: Record<string, string> = {
      'content-type': type,
      // Island bundles are content-hashed by `amoxi build`, so they can be cached forever.
      'cache-control': ext === '.html' ? 'no-cache' : file.includes(`${path.sep}_amoxi${path.sep}`) ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
      'x-content-type-options': 'nosniff',
      etag,
    };
    if (compressible(type)) headers.vary = 'Accept-Encoding';
    if (encoding) headers['content-encoding'] = encoding;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers).end();
      return true;
    }
    res.writeHead(200, sendSize === undefined ? headers : { ...headers, 'content-length': String(sendSize) });
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    // pipeline() respects backpressure and closes the file when the client disconnects or an error occurs.
    const stream = createReadStream(sendFile);
    await (encoding && sendFile === file ? pipeline(stream, compressStream(encoding as 'br' | 'gzip'), res) : pipeline(stream, res)).catch(() => {
      if (!res.destroyed) res.destroy();
    });
    return true;
  }

  private resolve(urlPath: string): string | undefined {
    let decoded: string;
    try {
      decoded = decodeURIComponent(urlPath);
    } catch {
      return undefined;
    }
    // Reject characters that mean something to Windows paths but never appear in real asset URLs.
    if (/[\0\\:]/.test(decoded)) return undefined;
    const segments = path.posix.normalize(`/${decoded}`).split('/').filter(Boolean);
    if (segments.some((s) => s.startsWith('.'))) return undefined;
    const file = path.resolve(this.root, ...segments);
    return file === this.root || file.startsWith(this.root + path.sep) ? file : undefined;
  }
}

async function statOrNull(file: string): Promise<Stats | null> {
  try {
    return await stat(file);
  } catch {
    return null;
  }
}
