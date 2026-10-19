// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto';
import { createWriteStream, type WriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { HttpError } from './http';

export interface UploadedFile {
  /** Form field name. */
  readonly field: string;
  /** Client-supplied file name, reduced to a safe base name (never trust it for paths). */
  readonly filename: string;
  /** Client-supplied content type (verify the bytes if it matters). */
  readonly contentType: string;
  readonly size: number;
  /** Temporary file; deleted after the request unless you call moveTo(). */
  readonly path: string;
  read(): Promise<Buffer>;
  /** Move the upload to a permanent location (creates parent directories). */
  moveTo(destination: string): Promise<void>;
}

export interface MultipartForm {
  readonly fields: Readonly<Record<string, string>>;
  readonly files: readonly UploadedFile[];
  /** First file uploaded under a field name. */
  file(field: string): UploadedFile | undefined;
}

export interface UploadLimits {
  maxFileSize: number;
  maxFiles: number;
  maxFields: number;
  maxFieldSize: number;
}

class TempFile implements UploadedFile {
  moved = false;
  constructor(
    readonly field: string,
    readonly filename: string,
    readonly contentType: string,
    public size: number,
    public path: string,
  ) {}

  read(): Promise<Buffer> {
    return readFile(this.path);
  }

  async moveTo(destination: string): Promise<void> {
    const dest = path.resolve(destination);
    await mkdir(path.dirname(dest), { recursive: true });
    try {
      await rename(this.path, dest);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
      await copyFile(this.path, dest); // different drive/volume (common on Windows and in containers)
      await rm(this.path, { force: true });
    }
    this.path = dest;
    this.moved = true;
  }
}

/** Keeps only a safe base name: no directories, no control characters, bounded length. */
export function sanitizeFilename(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').replace(/^\.+/, '').trim();
  return clean.slice(-200) || 'upload';
}

function parseDisposition(header: string): { name?: string; filename?: string } {
  const out: { name?: string; filename?: string } = {};
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  for (const m of header.matchAll(/;\s*(name|filename)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/gi)) {
    const value = (m[2] ?? m[3] ?? '').replace(/\\(.)/g, '$1').trim();
    out[m[1].toLowerCase() as 'name' | 'filename'] = value;
  }
  if (star) {
    try {
      out.filename = decodeURIComponent(star[1]);
    } catch {
      /* keep the plain filename */
    }
  }
  return out;
}

const uploadDir = path.join(tmpdir(), 'amoxi-uploads');

/**
 * Streams a multipart/form-data body: file parts go straight to temporary files, fields stay
 * in memory. Every limit is enforced while streaming, so oversized uploads are rejected
 * without being buffered. Returns the form plus a cleanup function for the temp files.
 */
export async function parseMultipart(req: IncomingMessage, limits: UploadLimits): Promise<{ form: MultipartForm; cleanup: () => Promise<void> }> {
  const type = req.headers['content-type'] ?? '';
  const boundaryMatch = /^multipart\/form-data\s*;.*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(type);
  if (!boundaryMatch) throw new HttpError(415, 'Request body must be multipart/form-data');
  const boundary = boundaryMatch[1] ?? boundaryMatch[2];
  const delimiter = Buffer.from(`\r\n--${boundary}`);
  await mkdir(uploadDir, { recursive: true });

  const fields: Record<string, string> = Object.create(null);
  const files: TempFile[] = [];
  let fieldCount = 0;
  const cleanup = async (): Promise<void> => {
    await Promise.all(files.filter((f) => !f.moved).map((f) => rm(f.path, { force: true })));
  };

  let buffer: Buffer = Buffer.from('\r\n'); // lets the first boundary match the same delimiter
  let state: 'preamble' | 'boundary' | 'headers' | 'body' | 'done' = 'preamble';
  let part: { name: string; file?: TempFile; stream?: WriteStream; chunks?: Buffer[]; size: number } | undefined;
  // A failed temp-file write (disk full, quota, EIO) must reject this upload, not crash the process.
  let writeError: Error | undefined;
  const writeFailed = (): HttpError => Object.assign(new HttpError(500, 'Could not store the uploaded file'), { cause: writeError });

  const writeFile = async (data: Buffer): Promise<void> => {
    if (!part?.file || data.length === 0) return;
    part.size += data.length;
    if (part.size > limits.maxFileSize) throw new HttpError(413, `File '${part.file.filename}' exceeds ${limits.maxFileSize} bytes`);
    if (writeError) throw writeFailed();
    const stream = part.stream!;
    if (!stream.write(data)) {
      await new Promise<void>((resolve) => {
        const done = (): void => {
          stream.off('drain', done);
          stream.off('error', done);
          stream.off('close', done);
          resolve();
        };
        stream.once('drain', done).once('error', done).once('close', done);
      });
      if (writeError) throw writeFailed();
    }
  };
  const writeField = (data: Buffer): void => {
    if (!part || part.file || data.length === 0) return;
    part.size += data.length;
    if (part.size > limits.maxFieldSize) throw new HttpError(413, `Field '${part.name}' exceeds ${limits.maxFieldSize} bytes`);
    part.chunks!.push(data);
  };
  const finishPart = async (): Promise<void> => {
    if (!part) return;
    if (part.file) {
      const stream = part.stream!;
      if (writeError || stream.destroyed) throw writeFailed();
      await new Promise<void>((resolve, reject) => {
        stream.once('error', reject);
        stream.end(() => resolve());
      });
      if (writeError) throw writeFailed();
      part.file.size = part.size;
    } else {
      fields[part.name] = Buffer.concat(part.chunks!).toString('utf8');
    }
    part = undefined;
  };

  try {
    for await (const chunk of req as AsyncIterable<Buffer>) {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      for (;;) {
        if (state === 'preamble') {
          const i = buffer.indexOf(delimiter);
          if (i === -1) {
            buffer = buffer.subarray(Math.max(0, buffer.length - delimiter.length));
            break;
          }
          buffer = buffer.subarray(i + delimiter.length);
          state = 'boundary';
        } else if (state === 'boundary') {
          if (buffer.length < 2) break;
          if (buffer[0] === 0x2d && buffer[1] === 0x2d) {
            state = 'done'; // closing "--"
            break;
          }
          const lineEnd = buffer.indexOf('\r\n');
          if (lineEnd === -1) {
            // Only optional whitespace ("transport padding") may follow a boundary; refuse to buffer more.
            if (buffer.length > 1024) throw new HttpError(400, 'Malformed multipart boundary line');
            break;
          }
          if (lineEnd > 1024) throw new HttpError(400, 'Malformed multipart boundary line');
          buffer = buffer.subarray(lineEnd + 2); // skip transport padding + CRLF
          state = 'headers';
        } else if (state === 'headers') {
          const end = buffer.indexOf('\r\n\r\n');
          if (end === -1) {
            if (buffer.length > 16 * 1024) throw new HttpError(400, 'Multipart part headers too large');
            break;
          }
          const headers: Record<string, string> = {};
          for (const line of buffer.subarray(0, end).toString('utf8').split('\r\n')) {
            const c = line.indexOf(':');
            if (c > 0) headers[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim();
          }
          buffer = buffer.subarray(end + 4);
          const disposition = parseDisposition(headers['content-disposition'] ?? '');
          if (!disposition.name) throw new HttpError(400, 'Multipart part without a field name');
          if (disposition.filename !== undefined) {
            if (files.length >= limits.maxFiles) throw new HttpError(413, `Too many files (limit ${limits.maxFiles})`);
            const file = new TempFile(disposition.name, sanitizeFilename(disposition.filename), headers['content-type'] ?? 'application/octet-stream', 0, path.join(uploadDir, randomUUID()));
            files.push(file);
            const stream = createWriteStream(file.path, { flags: 'wx' });
            stream.on('error', (err) => {
              writeError ??= err;
            });
            part = { name: disposition.name, file, stream, size: 0 };
          } else {
            if (++fieldCount > limits.maxFields) throw new HttpError(413, `Too many fields (limit ${limits.maxFields})`);
            part = { name: disposition.name, chunks: [], size: 0 };
          }
          state = 'body';
        } else if (state === 'body') {
          const i = buffer.indexOf(delimiter);
          if (i === -1) {
            // Keep a tail that could be the start of a delimiter split across chunks.
            const safe = buffer.length - (delimiter.length - 1);
            if (safe > 0) {
              const data = buffer.subarray(0, safe);
              if (part?.file) await writeFile(data);
              else writeField(data);
              buffer = buffer.subarray(safe);
            }
            break;
          }
          const data = buffer.subarray(0, i);
          if (part?.file) await writeFile(data);
          else writeField(data);
          await finishPart();
          buffer = buffer.subarray(i + delimiter.length);
          state = 'boundary';
        } else {
          break;
        }
      }
      if (state === 'done') break;
    }
    if (state !== 'done') throw new HttpError(400, 'Malformed multipart body (missing closing boundary)');
  } catch (err) {
    part?.stream?.destroy();
    await cleanup();
    req.resume(); // drain the rest of the request
    throw err;
  }

  const form: MultipartForm = {
    fields,
    files,
    file: (field) => files.find((f) => f.field === field),
  };
  return { form, cleanup };
}
