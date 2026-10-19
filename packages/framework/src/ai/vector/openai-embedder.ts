// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import { ModelError, type Embedder } from '../types';

export interface OpenAiEmbedderOptions {
  /** Sent as `authorization: Bearer <apiKey>`. Optional for local servers (Ollama, vLLM). */
  readonly apiKey?: string;
  /** e.g. https://api.openai.com/v1, http://localhost:11434/v1. `/embeddings` is appended. */
  readonly baseUrl: string;
  /** e.g. 'text-embedding-3-small'. */
  readonly model: string;
  /** Requested output size (models that support shortening, e.g. text-embedding-3-*). */
  readonly dimensions?: number;
  /** Texts per request. Default 96. */
  readonly batchSize?: number;
  /** Per-request time-out. Default 30 000 ms. */
  readonly timeoutMs?: number;
  /** Retries of 408/409/429/5xx and network errors. Default 3. */
  readonly maxRetries?: number;
  /** Injected fetch (tests, proxies). Default: global fetch. */
  readonly fetch?: typeof fetch;
}

const RETRYABLE = new Set([408, 409, 429]);
const MAX_BACKOFF_MS = 30_000;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Parses Retry-After (seconds or HTTP date) or retry-after-ms into milliseconds. */
function retryAfterMs(headers: Headers): number | undefined {
  const ms = headers.get('retry-after-ms');
  if (ms && Number.isFinite(Number(ms))) return Math.max(0, Number(ms));
  const ra = headers.get('retry-after');
  if (!ra) return undefined;
  const secs = Number(ra);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(ra);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/**
 * Embedder for any OpenAI-compatible `/embeddings` endpoint (Adapter): OpenAI, Azure OpenAI,
 * Voyage AI, Ollama, vLLM, LiteLLM...
 *
 * `dimensions` is the configured `dimensions` option when given; otherwise it is 0 until the
 * first successful response, then the length of the returned vectors. Callers that need the size
 * before embedding anything (e.g. to create a pgvector table) should set the option.
 */
export class OpenAiEmbedder implements Embedder {
  readonly model: string;
  /** A true private field: never shows up in JSON.stringify, console.log or util.inspect. */
  readonly #apiKey: string | undefined;
  private readonly requestedDims: number | undefined;
  private dims: number;
  private readonly url: string;
  private readonly batchSize: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: OpenAiEmbedderOptions) {
    if (!options.baseUrl) throw new Error('OpenAiEmbedder needs a baseUrl, e.g. https://api.openai.com/v1');
    if (!options.model) throw new Error("OpenAiEmbedder needs a model, e.g. 'text-embedding-3-small'");
    this.model = options.model;
    this.#apiKey = options.apiKey;
    this.requestedDims = options.dimensions;
    this.dims = options.dimensions ?? 0;
    this.url = `${options.baseUrl.replace(/\/+$/, '')}/embeddings`;
    this.batchSize = Math.max(1, Math.min(2048, Math.floor(options.batchSize ?? 96)));
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = Math.max(0, options.maxRetries ?? 3);
    this.fetchFn = options.fetch ?? fetch;
  }

  get dimensions(): number {
    return this.dims;
  }

  async embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize).map((t) => (t === '' ? ' ' : String(t)));
      out.push(...(await this.request(batch, signal)));
    }
    return out;
  }

  private async request(input: string[], signal?: AbortSignal): Promise<number[][]> {
    const body = JSON.stringify({
      model: this.model,
      input,
      ...(this.requestedDims ? { dimensions: this.requestedDims } : {}),
    });
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
    if (this.#apiKey) headers.authorization = `Bearer ${this.#apiKey}`;

    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      const timeout = AbortSignal.timeout(this.timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let res: Response;
      try {
        res = await this.fetchFn(this.url, { method: 'POST', headers, body, signal: combined });
      } catch (err) {
        if (signal?.aborted) throw signal.reason;
        const reason = timeout.aborted ? `timed out after ${this.timeoutMs} ms` : (err as Error).message;
        if (attempt < this.maxRetries) {
          await sleep(this.backoff(attempt), signal);
          continue;
        }
        throw new ModelError(`Embedding request to ${this.url} failed: ${reason}. Check ai.embeddings.base-url and that the server is reachable.`, undefined, true);
      }

      if (res.ok) return this.parse(res, input.length);

      const retryable = RETRYABLE.has(res.status) || res.status >= 500;
      const detail = await this.errorDetail(res);
      if (retryable && attempt < this.maxRetries) {
        const wait = Math.min(MAX_BACKOFF_MS, retryAfterMs(res.headers) ?? this.backoff(attempt));
        await sleep(wait, signal);
        continue;
      }
      throw new ModelError(this.describe(res.status, detail), res.status, retryable);
    }
  }

  private backoff(attempt: number): number {
    const base = Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt);
    return base / 2 + Math.random() * (base / 2);
  }

  private async errorDetail(res: Response): Promise<string> {
    try {
      const text = (await res.text()).slice(0, 2000);
      try {
        const json = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
        const msg = typeof json.error === 'string' ? json.error : (json.error?.message ?? json.message);
        if (msg) return String(msg).slice(0, 500);
      } catch {
        /* not JSON */
      }
      return text.slice(0, 500);
    } catch {
      return '';
    }
  }

  private describe(status: number, detail: string): string {
    const suffix = detail ? `: ${detail}` : '';
    if (status === 401 || status === 403) {
      return `Embedding API rejected the credentials (HTTP ${status})${suffix}. Set a valid key in ai.embeddings.api-key or OPENAI_API_KEY, or set ai.embeddings.provider=offline.`;
    }
    if (status === 404) {
      return `Embedding endpoint or model not found (HTTP 404)${suffix}. Check ai.embeddings.base-url (${this.url}) and ai.embeddings.model ('${this.model}').`;
    }
    if (status === 400) {
      return `Embedding request was rejected (HTTP 400)${suffix}. Check ai.embeddings.model and ai.embeddings.dimensions.`;
    }
    if (status === 429) return `Embedding API rate limit reached (HTTP 429) after ${this.maxRetries} retries${suffix}. Lower the request rate or raise your quota.`;
    return `Embedding API error (HTTP ${status})${suffix}`;
  }

  private async parse(res: Response, expected: number): Promise<number[][]> {
    let json: { data?: Array<{ index?: number; embedding?: unknown }> };
    try {
      json = (await res.json()) as typeof json;
    } catch {
      throw new ModelError(`Embedding API at ${this.url} returned invalid JSON. Is ai.embeddings.base-url an OpenAI-compatible endpoint?`, res.status);
    }
    const data = Array.isArray(json?.data) ? [...json.data] : undefined;
    if (!data || data.length !== expected) {
      throw new ModelError(`Embedding API returned ${data ? data.length : 'no'} embeddings for ${expected} inputs; expected { data: [{ index, embedding }] }.`, res.status);
    }
    data.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const vectors = data.map((d) => {
      if (!Array.isArray(d.embedding) || d.embedding.some((x) => typeof x !== 'number')) {
        throw new ModelError('Embedding API returned a non-numeric embedding (base64 encoding is not supported).', res.status);
      }
      return d.embedding as number[];
    });
    const len = vectors[0]?.length ?? 0;
    if (vectors.some((v) => v.length !== len)) throw new ModelError('Embedding API returned vectors of different lengths.', res.status);
    if (this.dims === 0) this.dims = len;
    else if (len !== this.dims) {
      throw new ModelError(`Embedding API returned ${len}-dimensional vectors but ${this.dims} were expected. Check ai.embeddings.dimensions.`, res.status);
    }
    return vectors;
  }
}
