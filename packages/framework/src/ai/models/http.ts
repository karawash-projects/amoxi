// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import { ModelError } from '../types';

/** HTTP statuses retried by default (Anthropic's 529 = overloaded). */
export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface RetryOptions {
  /** Retries after the first attempt. Default 2. */
  readonly maxRetries?: number;
  /** Time allowed per attempt until the response headers arrive (streaming is governed by an idle timeout). */
  readonly timeoutMs?: number;
  /** The caller's cancellation signal; never retried. */
  readonly signal?: AbortSignal;
  /** Overrides which statuses are retried. */
  readonly retryOn?: (status: number) => boolean;
  /** Prefix of error messages, e.g. 'Anthropic API'. Default 'Model API'. */
  readonly label?: string;
  /** Values (API keys) scrubbed from every error message, defensively. */
  readonly secrets?: readonly (string | undefined)[];
  /** First backoff step. Default 500 ms. */
  readonly baseDelayMs?: number;
  /** Backoff cap. Default 20 000 ms. */
  readonly maxDelayMs?: number;
  /** Injected randomness for the jitter (tests). Default Math.random. */
  readonly random?: () => number;
}

const MAX_ERROR_BODY = 64 * 1024;
/** retry-after values above this are ignored in favour of normal backoff. */
const MAX_RETRY_AFTER_MS = 60_000;

/** Waits `ms`, rejecting with the signal's reason when it aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Parses `retry-after-ms`, then `retry-after` (seconds or an HTTP date). Undefined when absent/unusable. */
export function retryAfterMs(headers: Headers, now = Date.now()): number | undefined {
  const ms = headers.get('retry-after-ms');
  if (ms !== null && ms.trim() !== '' && Number.isFinite(Number(ms))) return Math.max(0, Number(ms));
  const ra = headers.get('retry-after');
  if (ra === null || ra.trim() === '') return undefined;
  const seconds = Number(ra);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(ra);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function redact(message: string, secrets: RetryOptions['secrets']): string {
  let out = message;
  for (const s of secrets ?? []) if (s && s.length >= 4) out = out.split(s).join('[redacted]');
  return out;
}

/** Extracts the provider's error message from an error body (Anthropic, OpenAI, Ollama, FastAPI shapes). */
export function extractErrorMessage(text: string): string | undefined {
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    const err = json.error;
    if (typeof err === 'string') return err;
    if (err && typeof err === 'object') {
      const e = err as Record<string, unknown>;
      const msg = typeof e.message === 'string' ? e.message : undefined;
      const type = typeof e.type === 'string' ? e.type : typeof e.code === 'string' ? e.code : undefined;
      if (msg) return type && !msg.includes(type) ? `${msg} (${type})` : msg;
    }
    if (typeof json.message === 'string') return json.message;
    if (typeof json.detail === 'string') return json.detail;
  } catch {
    /* not JSON */
  }
  const trimmed = text.trim();
  return trimmed ? trimmed.slice(0, 300) : undefined;
}

async function readBounded(res: Response): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
      if (out.length > MAX_ERROR_BODY) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  } catch {
    /* best effort */
  }
  return out.slice(0, MAX_ERROR_BODY);
}

function backoff(attempt: number, options: RetryOptions): number {
  const base = options.baseDelayMs ?? 500;
  const cap = options.maxDelayMs ?? 20_000;
  return Math.floor((options.random ?? Math.random)() * Math.min(cap, base * 2 ** attempt));
}

/**
 * Fetch with retries (exponential backoff with full jitter, capped at 20 s) for 408/409/429/5xx/529
 * and network errors, honouring `retry-after-ms`, `retry-after` and `x-should-retry`. Resolves
 * with the first 2xx response; the body is never touched, so nothing is retried once streaming
 * has begun. The per-attempt time-out only covers waiting for the response headers.
 * Throws ModelError(message, status, retryable) with the provider's error message; request
 * headers (and so API keys) are never part of the message.
 */
export async function fetchWithRetry(fetchFn: FetchFn, url: string, init: RequestInit, options: RetryOptions = {}): Promise<Response> {
  const maxRetries = Math.max(0, options.maxRetries ?? 2);
  const label = options.label ?? 'Model API';
  const isRetryable = options.retryOn ?? ((s: number) => RETRYABLE_STATUSES.has(s));
  const callerSignal = options.signal;

  for (let attempt = 0; ; attempt++) {
    if (callerSignal?.aborted) throw callerSignal.reason;
    const attemptCtl = new AbortController();
    let timedOut = false;
    const timer =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            attemptCtl.abort(new ModelError(`${label} request timed out after ${options.timeoutMs} ms`, undefined, true));
          }, options.timeoutMs)
        : undefined;
    const signal = callerSignal ? AbortSignal.any([callerSignal, attemptCtl.signal]) : attemptCtl.signal;
    const canRetry = attempt < maxRetries;

    let res: Response;
    try {
      res = await fetchFn(url, { ...init, signal });
    } catch (err) {
      if (timer) clearTimeout(timer);
      if (callerSignal?.aborted) throw callerSignal.reason;
      const error = timedOut
        ? (attemptCtl.signal.reason as ModelError)
        : new ModelError(redact(`${label} request failed: ${(err as Error)?.message ?? String(err)}`, options.secrets), undefined, true);
      if (!canRetry) {
        if (!timedOut) (error as { cause?: unknown }).cause = err;
        throw error;
      }
      await sleep(backoff(attempt, options), callerSignal);
      continue;
    }
    if (timer) clearTimeout(timer);

    if (res.ok) return res;

    const shouldRetryHeader = res.headers.get('x-should-retry');
    const retryable = shouldRetryHeader === 'true' ? true : shouldRetryHeader === 'false' ? false : isRetryable(res.status);
    if (retryable && canRetry) {
      await res.body?.cancel().catch(() => undefined);
      const hinted = retryAfterMs(res.headers);
      const delay = hinted !== undefined && hinted <= MAX_RETRY_AFTER_MS ? hinted : backoff(attempt, options);
      await sleep(delay, callerSignal);
      continue;
    }
    const text = await readBounded(res);
    const detail = extractErrorMessage(text) ?? res.statusText ?? 'request failed';
    throw new ModelError(redact(`${label} error ${res.status}: ${detail}`, options.secrets), res.status, retryable);
  }
}

/**
 * Reads a response body, failing with a retryable ModelError when no chunk arrives for
 * `idleMs` (a stalled connection); the stream is cancelled so the socket is released.
 */
export async function* readWithIdleTimeout(body: ReadableStream<Uint8Array>, idleMs: number, label = 'Model API'): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  let finished = false;
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<never>((_, reject) => {
        if (idleMs > 0) {
          timer = setTimeout(() => reject(new ModelError(`${label} stream stalled: no data for ${idleMs} ms`, undefined, true)), idleMs);
        }
      });
      let r: ReadableStreamReadResult<Uint8Array>;
      try {
        r = await Promise.race([reader.read(), idle]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (r.done) {
        finished = true;
        return;
      }
      yield r.value;
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      /* a pending read may still hold it */
    }
  }
}

/** Key added to a tool call's input when the model sent arguments that are not valid JSON. */
export const INVALID_JSON_KEY = '__invalid_json';
const MAX_INVALID_ECHO = 2000;

/**
 * Parses streamed tool arguments. Empty → {}. Invalid JSON (or a non-object) →
 * `{ __invalid_json: <raw text, truncated> }`, so the agent loop's validator rejects the call
 * and reports the problem back to the model instead of crashing the run.
 */
export function parseToolArguments(raw: string): unknown {
  if (raw.trim() === '') return {};
  try {
    const value = JSON.parse(raw) as unknown;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {
    /* fall through */
  }
  return { [INVALID_JSON_KEY]: raw.slice(0, MAX_INVALID_ECHO) };
}

/** Removes trailing slashes from a base URL. */
export function trimBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}
