// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared JSON-RPC 2.0 plumbing for the MCP and A2A servers: envelope validation, response
 * builders, standard error codes and a few HTTP helpers both protocols need (single-valued
 * headers, constant-time bearer token checks, request abort signals).
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestContext } from '../../runtime/types';

export const JSONRPC_VERSION = '2.0';

/** Standard JSON-RPC 2.0 error codes. */
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

export type JsonRpcId = string | number | null;

export interface JsonRpcErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface JsonRpcSuccess {
  readonly jsonrpc: '2.0';
  readonly id: JsonRpcId;
  readonly result: unknown;
}

export interface JsonRpcFailure {
  readonly jsonrpc: '2.0';
  readonly id: JsonRpcId;
  readonly error: JsonRpcErrorObject;
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

/** A parsed incoming JSON-RPC message. */
export type IncomingMessage =
  | { readonly kind: 'request'; readonly id: string | number; readonly method: string; readonly params: Record<string, unknown> }
  | { readonly kind: 'notification'; readonly method: string; readonly params: Record<string, unknown> }
  | { readonly kind: 'response' }
  | { readonly kind: 'invalid'; readonly id: JsonRpcId; readonly error: JsonRpcErrorObject };

/**
 * An error a method handler throws to answer with a JSON-RPC error. `httpStatus` lets transports
 * that map errors to HTTP statuses (MCP 2026-07-28) pick one; the default is 200.
 */
export class RpcError extends Error {
  override name = 'RpcError';
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
    readonly httpStatus = 200,
  ) {
    super(message);
  }
}

const MAX_METHOD_LENGTH = 256;
const MAX_ID_LENGTH = 512;

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Validates a JSON-RPC 2.0 envelope. Batches (arrays) are rejected: neither MCP (since
 * 2025-06-18) nor A2A uses them. Positional (array) params are rejected too, as both protocols
 * use named params; a missing `params` becomes `{}`.
 */
export function parseMessage(body: unknown): IncomingMessage {
  if (body === undefined || body === null) return invalid(null, INVALID_REQUEST, 'Request body is empty: send one JSON-RPC 2.0 object');
  if (Array.isArray(body)) return invalid(null, INVALID_REQUEST, 'JSON-RPC batches are not supported: send one message per request');
  if (!isPlainObject(body)) return invalid(null, INVALID_REQUEST, 'Request body must be a JSON-RPC 2.0 object');
  const rawId = body.id;
  const idOk = typeof rawId === 'string' ? rawId.length <= MAX_ID_LENGTH : typeof rawId === 'number' && Number.isFinite(rawId);
  const id: JsonRpcId = idOk ? (rawId as string | number) : null;
  if (body.jsonrpc !== JSONRPC_VERSION) return invalid(id, INVALID_REQUEST, 'Missing or wrong "jsonrpc" member: it must be "2.0"');
  if (body.method === undefined && ('result' in body || 'error' in body)) return { kind: 'response' };
  if (typeof body.method !== 'string' || body.method.length === 0 || body.method.length > MAX_METHOD_LENGTH) {
    return invalid(id, INVALID_REQUEST, '"method" must be a non-empty string');
  }
  if (body.params !== undefined && !isPlainObject(body.params)) return invalid(id, INVALID_PARAMS, '"params" must be an object');
  const params = (body.params as Record<string, unknown> | undefined) ?? {};
  if (!('id' in body)) return { kind: 'notification', method: body.method, params };
  if (!idOk) return invalid(null, INVALID_REQUEST, '"id" must be a string or a number');
  return { kind: 'request', id: rawId as string | number, method: body.method, params };
}

function invalid(id: JsonRpcId, code: number, message: string): IncomingMessage {
  return { kind: 'invalid', id, error: { code, message } };
}

export function success(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

export function failure(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcFailure {
  return { jsonrpc: JSONRPC_VERSION, id, error: data === undefined ? { code, message } : { code, message, data } };
}

/* ------------------------------------------------------------------ */
/* HTTP helpers shared by both protocol servers                        */
/* ------------------------------------------------------------------ */

/** A request header as a single string (first value when repeated). */
export function header(ctx: RequestContext, name: string): string | undefined {
  const v = ctx.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

const digest = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();

/**
 * Checks `Authorization: Bearer <token>` in constant time (both sides are hashed first, so
 * neither the content nor the length of the configured token leaks through timing).
 */
/**
 * Checks the bearer token against a shared `token` and per-caller `callers` (name -> token), each in
 * constant time. `ok` is true when nothing is configured; `caller` names whose token was sent.
 */
export function authenticate(ctx: RequestContext, token: string | undefined, callers: Readonly<Record<string, string>> = {}): { ok: boolean; caller?: string } {
  const named = Object.entries(callers);
  if (token === undefined && named.length === 0) return { ok: true };
  let caller: string | undefined;
  // Every token is compared (no early exit), so the time taken doesn't reveal which one matched.
  for (const [name, secret] of named) if (bearerMatches(ctx, secret) && caller === undefined) caller = name;
  const shared = token !== undefined && bearerMatches(ctx, token);
  return { ok: shared || caller !== undefined, caller };
}

/** Rejects tokens too short to be secrets. */
export function checkTokens(what: string, token: string | undefined, callers: Readonly<Record<string, string>> = {}): void {
  if (token !== undefined && token.length < 16) throw new Error(`${what}: options.token must be at least 16 characters; generate one with \`openssl rand -hex 32\``);
  for (const [name, secret] of Object.entries(callers)) {
    if (!/^[a-z0-9_]+$/i.test(name)) throw new Error(`${what}: caller name "${name}" may only use letters, digits and _`);
    if (secret.length < 16) throw new Error(`${what}: the token of caller "${name}" must be at least 16 characters; generate one with \`openssl rand -hex 32\``);
  }
}

export function bearerMatches(ctx: RequestContext, token: string): boolean {
  const auth = header(ctx, 'authorization');
  const m = auth ? /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(auth) : null;
  const presented = m ? m[1] : '';
  const ok = timingSafeEqual(digest(presented), digest(token));
  return ok && presented.length > 0;
}

/**
 * An AbortSignal that fires when the client goes away before the response is finished, so long
 * operations (agent runs) can stop. Works without a live response object (tests).
 */
export function requestSignal(ctx: RequestContext): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const res = ctx.res as RequestContext['res'] | undefined;
  if (!res || typeof res.once !== 'function') return { signal: controller.signal, dispose: () => undefined };
  const onClose = (): void => {
    if (!res.writableFinished) controller.abort();
  };
  res.once('close', onClose);
  return { signal: controller.signal, dispose: () => res.off('close', onClose) };
}

/** Aborted when any of the given signals aborts. */
export function anySignal(...signals: ReadonlyArray<AbortSignal | undefined>): AbortSignal {
  const list = signals.filter((s): s is AbortSignal => s !== undefined);
  return list.length === 1 ? list[0] : AbortSignal.any(list);
}

/** True when the Accept header lists the media type (or a wildcard covering it). */
export function accepts(ctx: RequestContext, mediaType: string): boolean {
  const accept = header(ctx, 'accept');
  if (!accept) return false;
  const [type] = mediaType.split('/');
  return accept.split(',').some((part) => {
    const t = part.split(';')[0].trim().toLowerCase();
    return t === mediaType || t === `${type}/*`;
  });
}

/** Opaque offset cursor (base64url of the offset), for paginated lists. Undefined when invalid. */
export function decodeCursor(cursor: unknown, total: number): number | undefined {
  if (cursor === undefined || cursor === null) return 0;
  if (typeof cursor !== 'string' || cursor.length > 64) return undefined;
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!/^\d{1,9}$/.test(raw)) return undefined;
  const n = Number(raw);
  return n <= total ? n : undefined;
}

export function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

/** "get_account-balance" -> "Get account balance". */
export function humanize(name: string): string {
  const words = name.replace(/[-_]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** JSON text for a tool output, truncated to keep responses bounded. */
export function toText(value: unknown, max = 200_000): string {
  let s: string;
  if (typeof value === 'string') s = value;
  else {
    try {
      s = JSON.stringify(value ?? null) ?? 'null';
    } catch {
      s = String(value);
    }
  }
  return s.length > max ? `${s.slice(0, max)}… [truncated]` : s;
}

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });

/**
 * A small unbounded-wait, bounded-size async queue (producer pushes, one consumer iterates). Used
 * to interleave progress notifications with a pending result on an SSE response.
 */
export class Channel<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private waiter: ((r: IteratorResult<T>) => void) | undefined;
  private closed = false;

  constructor(private readonly maxBuffered = 1000) {}

  push(value: T): void {
    if (this.closed) return;
    const w = this.waiter;
    if (w) {
      this.waiter = undefined;
      w({ value, done: false });
    } else if (this.items.length < this.maxBuffered) this.items.push(value);
  }

  close(): void {
    this.closed = true;
    const w = this.waiter;
    this.waiter = undefined;
    w?.({ value: undefined, done: true });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      if (this.items.length > 0) {
        yield this.items.shift() as T;
        continue;
      }
      if (this.closed) return;
      const r = await new Promise<IteratorResult<T>>((resolve) => (this.waiter = resolve));
      if (r.done) return;
      yield r.value;
    }
  }
}
