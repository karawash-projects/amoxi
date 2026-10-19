// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import { randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { performance } from 'node:perf_hooks';
import { responseCache } from './cache';
import { compressible, compressStream, compressSync, negotiate } from './compression';
import { ConfigurationError, type Config } from './config';
import type { ApplicationContext } from './container';
import { HttpContext, type ContextSettings } from './context';
import type { Logger } from './logger';
import { parseMultipart, type UploadLimits } from './multipart';
import { withRequestScope } from './scope';
import { EventStreamResponse, formatEvent } from './sse';
import { pageDataOf } from './jsx';
import { buildLlmsTxt, markdownUrlFor } from './llms';
import { markdownPath, negotiateRepresentation, renderRepresentation, type Representation } from './semantic';
import { SessionCodec } from './session';
import { attachWebSockets } from './websocket';
import type { StaticFiles } from './static-files';
import type { ExtensionDescription, ExtensionRoute, HttpMiddleware, RequestContext, RouteDefinition } from './types';

/** Request bodies up to this size are read and discarded before an early error response (see discardBody). */
const MAX_DISCARD_BYTES = 16 * 1024 * 1024;
const DISCARD_TIMEOUT_MS = 5000;

export class HttpError extends Error {
  override name = 'HttpError';
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

export type ResponseBody = string | Buffer | AsyncIterable<string | Buffer>;

export class HttpResponse<T = unknown> {
  constructor(
    readonly status: number,
    readonly body?: T,
    readonly headers: Readonly<Record<string, string>> = {},
  ) {}

  static ok<T>(body: T): HttpResponse<T> {
    return new HttpResponse(200, body);
  }
  static created<T>(body: T, location?: string): HttpResponse<T> {
    return new HttpResponse(201, body, location ? { location } : {});
  }
  static noContent(): HttpResponse<never> {
    return new HttpResponse(204);
  }
  static redirect(location: string, status: 301 | 302 | 303 | 307 | 308 = 302): HttpResponse<undefined> {
    return new HttpResponse(status, undefined, { location });
  }
  static badRequest(message: string): HttpResponse<{ error: string }> {
    return new HttpResponse(400, { error: message });
  }
  static notFound(message = 'Not Found'): HttpResponse<{ error: string }> {
    return new HttpResponse(404, { error: message });
  }
  static status<T>(status: number, body?: T): HttpResponse<T> {
    return new HttpResponse(status, body);
  }

  /**
   * Streams a file from disk. Never pass a path built from user input without validating it.
   * `downloadName` sends it as an attachment with that file name.
   */
  static file(filePath: string, options: { contentType?: string; cacheControl?: string; downloadName?: string } = {}): HttpResponse<FileBody> {
    const size = statSync(filePath).size;
    const headers: Record<string, string> = {
      'content-type': options.contentType ?? 'application/octet-stream',
      'content-length': String(size),
      'cache-control': options.cacheControl ?? 'no-cache',
    };
    if (options.downloadName) headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(options.downloadName)}`;
    return new HttpResponse(200, new FileBody(filePath), headers);
  }
}

/**
 * A file sent as a response body. The file is opened only when the body is actually sent, so a HEAD request, a
 * cached response or a client that leaves early never holds a file handle open.
 */
export class FileBody implements AsyncIterable<Buffer> {
  private stream: Readable | undefined;
  constructor(readonly path: string) {}
  [Symbol.asyncIterator](): AsyncIterator<Buffer> {
    this.stream ??= createReadStream(this.path);
    return this.stream[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  }
  /** Closes the file if it was opened. */
  destroy(): void {
    this.stream?.destroy();
  }
}

/** Frees a streaming body that will not be (fully) sent: closes files and ends generators. */
export function releaseBody(body: unknown): void {
  if (!body || typeof body !== 'object') return;
  try {
    if (typeof (body as { destroy?: unknown }).destroy === 'function') {
      (body as { destroy(): void }).destroy();
      return;
    }
    const iterator = (body as { [Symbol.asyncIterator]?: () => AsyncIterator<unknown> })[Symbol.asyncIterator];
    if (typeof iterator === 'function') void iterator.call(body).return?.()?.catch?.(() => undefined);
  } catch {
    // Releasing is best effort.
  }
}

/* ------------------------------------------------------------------ */
/* Argument coercion helpers used by generated route handlers          */
/* ------------------------------------------------------------------ */

type Raw = string | null | undefined;

function missing(name: string, where: string): never {
  throw new HttpError(400, `Missing required ${where} parameter '${name}'`);
}

export function $str(v: Raw, name: string, where: string): string {
  return v ?? missing(name, where);
}
export function $optStr(v: Raw, _name?: string, _where?: string): string | undefined {
  return v ?? undefined;
}
export function $num(v: Raw, name: string, where: string): number {
  if (v == null) missing(name, where);
  const n = Number(v);
  if (v.trim() === '' || Number.isNaN(n)) throw new HttpError(400, `${where} parameter '${name}' must be a number`);
  return n;
}
export function $optNum(v: Raw, name: string, where: string): number | undefined {
  return v == null ? undefined : $num(v, name, where);
}
export function $bool(v: Raw, name: string, where: string): boolean {
  if (v == null) missing(name, where);
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  throw new HttpError(400, `${where} parameter '${name}' must be a boolean`);
}
export function $optBool(v: Raw, name: string, where: string): boolean | undefined {
  return v == null ? undefined : $bool(v, name, where);
}
export function $header(ctx: RequestContext, name: string): string | undefined {
  const h = ctx.headers[name];
  return Array.isArray(h) ? h.join(', ') : h;
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

export class Router {
  private readonly staticRoutes = new Map<string, RouteDefinition>();
  private readonly dynamicRoutes = new Map<string, RouteDefinition[]>();
  private readonly methods = new Set<string>();

  constructor(routes: readonly RouteDefinition[]) {
    for (const route of routes) {
      this.methods.add(route.method);
      if (route.pattern === null) {
        this.staticRoutes.set(`${route.method} ${route.path}`, route);
      } else {
        const list = this.dynamicRoutes.get(route.method) ?? [];
        list.push(route);
        this.dynamicRoutes.set(route.method, list);
      }
    }
  }

  match(method: string, path: string): { route: RouteDefinition; params: Record<string, string> } | undefined {
    const route = this.staticRoutes.get(`${method} ${path}`);
    if (route) return { route, params: {} };
    const candidates = this.dynamicRoutes.get(method);
    if (!candidates) return undefined;
    for (const r of candidates) {
      const m = r.pattern!.exec(path);
      if (m) {
        const params: Record<string, string> = {};
        for (let i = 0; i < r.paramNames.length; i++) {
          try {
            params[r.paramNames[i]] = decodeURIComponent(m[i + 1]);
          } catch {
            throw new HttpError(400, 'Malformed URL encoding');
          }
        }
        return { route: r, params };
      }
    }
    return undefined;
  }

  /** Methods that would match this path (for 405 responses). */
  allowedMethods(path: string): string[] {
    return [...this.methods].filter((m) => this.match(m, path));
  }
}

/* ------------------------------------------------------------------ */
/* Server                                                              */
/* ------------------------------------------------------------------ */

export interface HealthState {
  ready: boolean;
}

export interface DevHooks {
  /** Serves /_amoxi/dev/* endpoints; returns true when handled. */
  handle(req: IncomingMessage, res: ServerResponse, path: string): boolean;
  close(): void;
}

const webSocketClosers = new WeakMap<Server, () => void>();

/** Closes every WebSocket connection of a server created by createHttpServer (used on shutdown). */
export function closeWebSockets(server: Server): void {
  webSocketClosers.get(server)?.();
}

export interface HttpServerOptions {
  config: Config;
  logger: Logger;
  staticFiles?: StaticFiles;
  /** Answers GET /amoxi/* management paths; returns undefined for unknown paths. */
  management?: (path: string) => unknown;
  health?: HealthState;
  dev?: DevHooks;
  /** Routes added by extensions (e.g. amoxi/ai); they run through the same middleware. */
  extensionRoutes?: readonly ExtensionRoute[];
  /** What extensions add to /llms.txt (agents, MCP and A2A endpoints). */
  extensionInfo?: () => readonly ExtensionDescription[];
}

/** Adds a token to the Vary header instead of replacing what is there. */
function appendVary(res: ServerResponse, value: string): void {
  const current = String(res.getHeader('vary') ?? '');
  const parts = current.split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.some((p) => p.toLowerCase() === value.toLowerCase())) parts.push(value);
  res.setHeader('vary', parts.join(', '));
}

async function collectBody(body: ResponseBody | undefined): Promise<string> {
  if (body === undefined) return '';
  if (typeof body === 'string') return body;
  if (Buffer.isBuffer(body)) return body.toString('utf8');
  let out = '';
  for await (const chunk of body) {
    out += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (out.length > 5 * 1024 * 1024) break; // the converter's input limit (MAX_HTML_LENGTH)
  }
  return out;
}

/** Turns an extension route into a RouteDefinition (beanId -1: the handler needs no bean). */
export function compileExtensionRoute(r: ExtensionRoute): RouteDefinition {
  const paramNames: string[] = [];
  const source = r.path
    .split('/')
    .filter(Boolean)
    .map((seg) => {
      if (seg.startsWith(':')) {
        paramNames.push(seg.slice(1));
        return '\\/([^/]+)';
      }
      return '\\/' + seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  return {
    method: r.method,
    path: r.path,
    pattern: paramNames.length ? new RegExp(`^${source}$`) : null,
    paramNames,
    beanId: -1,
    needsBody: !!r.needsBody,
    handler: (_bean: unknown, ctx: RequestContext) => r.handler(ctx),
  };
}

interface Parts {
  status: number;
  headers: Record<string, string>;
  body?: ResponseBody;
}

/** Marks a handler result that is already in wire form (used by the cache). */
class PreparedResponse {
  constructor(readonly parts: Parts) {}
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const REQUEST_ID = /^[\w.:-]{1,128}$/;
const SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ['x-content-type-options', 'nosniff'],
  ['referrer-policy', 'strict-origin-when-cross-origin'],
  ['x-frame-options', 'DENY'],
  ['cross-origin-opener-policy', 'same-origin'],
  ['permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()'],
];

function normalizePath(p: string): string {
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > limit) return Promise.reject(new HttpError(413, `Request body exceeds ${limit} bytes`));
  const type = req.headers['content-type'];
  if (type && !/^application\/([\w.+-]*\+)?json\b/i.test(type)) {
    return Promise.reject(new HttpError(415, 'Request body must be JSON (Content-Type: application/json)'));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (c: Buffer): void => {
      size += c.length;
      if (size > limit) {
        // Stop buffering and discard the rest, so the 413 response can still be sent
        // (destroying the socket here would leave the client without an answer).
        chunks.length = 0;
        req.off('data', onData);
        req.resume();
        reject(new HttpError(413, `Request body exceeds ${limit} bytes`));
      } else chunks.push(c);
    };
    req.on('data', onData);
    req.on('end', () => {
      if (size === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'Malformed JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/** Resolves when `out` can take more data, or when the response is closed. */
function drained(out: NodeJS.WritableStream, res: ServerResponse): Promise<void> {
  if (res.destroyed) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = (): void => {
      out.removeListener('drain', done);
      res.removeListener('close', done);
      resolve();
    };
    out.once('drain', done);
    res.once('close', done);
  });
}

function isAsyncIterable(x: unknown): x is AsyncIterable<string | Buffer> {
  return x != null && typeof (x as AsyncIterable<string>)[Symbol.asyncIterator] === 'function';
}

function wantsHtml(req: IncomingMessage): boolean {
  return (req.headers.accept ?? '').includes('text/html');
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Converts a handler result into status, headers and an encoded body. */
function toParts(result: unknown): Parts {
  if (result instanceof PreparedResponse) return result.parts;
  if (result instanceof HttpResponse) {
    const headers: Record<string, string> = { ...result.headers };
    return { status: result.status, headers, body: encodeBody(result.body, headers) };
  }
  if (result === undefined) return { status: 204, headers: {} };
  const headers: Record<string, string> = {};
  return { status: 200, headers, body: encodeBody(result, headers) };
}

function encodeBody(body: unknown, headers: Record<string, string>): ResponseBody | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') {
    headers['content-type'] ??= 'text/plain; charset=utf-8';
    return body;
  }
  if (Buffer.isBuffer(body)) {
    headers['content-type'] ??= 'application/octet-stream';
    return body;
  }
  if (body instanceof Readable || body instanceof FileBody) {
    headers['content-type'] ??= 'application/octet-stream';
    return body;
  }
  if (isAsyncIterable(body)) {
    headers['content-type'] ??= 'text/html; charset=utf-8';
    return body as AsyncIterable<string>;
  }
  headers['content-type'] ??= 'application/json';
  return JSON.stringify(body);
}

export function createHttpServer(ctx: ApplicationContext, options: HttpServerOptions): Server {
  const { config, logger, staticFiles, management, health, dev } = options;
  // Beans switched off by @Requires contribute no routes, middleware or error pages.
  const routes = [...ctx.module.routes.filter((r) => ctx.isEnabled(r.beanId)), ...(options.extensionRoutes ?? []).map(compileExtensionRoute)];
  const router = new Router(routes);
  const middleware = (ctx.module.middleware ?? []).filter((id) => ctx.isEnabled(id));
  const errorPages = Object.fromEntries(Object.entries(ctx.module.errorPages ?? {}).filter(([, p]) => ctx.isEnabled(p.beanId)));
  const requestScoped = ctx.usesRequestScope;
  const openapiEnabled = !!ctx.module.openapi && config.boolean('amoxi.openapi.enabled', config.isProduction ? 'false' : 'true');
  const uploadLimits: UploadLimits = {
    maxFileSize: config.number('server.upload.max-file-size', String(10 * 1024 * 1024)),
    maxFiles: config.number('server.upload.max-files', '10'),
    maxFields: config.number('server.upload.max-fields', '100'),
    maxFieldSize: config.number('server.upload.max-field-size', String(64 * 1024)),
  };
  const production = config.isProduction;

  const maxBody = config.number('server.max-body-size', '1048576');
  const compression = config.boolean('server.compression', 'true');
  const securityHeaders = config.boolean('server.security-headers', 'true');
  const hsts = config.boolean('server.hsts', production ? 'true' : 'false');
  // server.trust-proxy: false (default), true (one proxy) or the number of proxies in front of the app.
  const trustProxySetting = config.string('server.trust-proxy', 'false').trim().toLowerCase();
  const trustProxy = trustProxySetting === 'true' ? 1 : /^\d+$/.test(trustProxySetting) ? Number(trustProxySetting) : 0;
  if (trustProxySetting !== 'false' && trustProxySetting !== 'true' && !/^\d+$/.test(trustProxySetting)) {
    throw new Error(`server.trust-proxy must be true, false or a number of proxies (got "${trustProxySetting}")`);
  }
  const multilingual = (ctx.module.i18n?.locales.length ?? 0) > 1;
  // The public origin for absolute links in llms.txt and the markdown/JSON page views. When it is not
  // configured it comes from the request, and cached views are then keyed by that origin, so a forged
  // Host header can't poison what other visitors get.
  const configuredOrigin = config.string('app.url', '').replace(/\/+$/, '');
  const publicOrigin = (rc: HttpContext): string => {
    if (configuredOrigin) return configuredOrigin;
    const host = rc.req.headers.host ?? '';
    return `${rc.protocol}://${/^[A-Za-z0-9.-]{1,253}(:\d{1,5})?$|^\[[0-9A-Fa-f:.]{2,45}\](:\d{1,5})?$/.test(host) ? host.toLowerCase() : 'localhost'}`;
  };
  const csrf = config.boolean('amoxi.csrf.enabled', 'true');
  const requestLog = config.boolean('server.request-log', 'true');
  const corsOrigins = config
    .string('server.cors.origins', '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const healthEnabled = config.boolean('amoxi.health.enabled', 'true');
  // Pages for AI agents: markdown and JSON versions of every page, and /llms.txt.
  const semantic = config.boolean('amoxi.agent-readable.enabled', 'true');
  const llmsEnabled = semantic && config.boolean('amoxi.llms-txt.enabled', 'true') && !routes.some((r) => r.path === '/llms.txt');
  const exporting = config.boolean('amoxi.export', 'false');

  // Sessions: an explicit secret is mandatory in production; development gets a per-process one.
  let contextSettings: ContextSettings;
  {
    const cookie = config.string('amoxi.session.cookie', 'amoxi_session');
    const maxAge = config.number('amoxi.session.max-age', String(7 * 24 * 3600));
    const base = { trustProxy, secureCookies: production, i18n: ctx.module.i18n };
    // Key precedence: AMOXI_SESSION_SECRET (optional, keeps users logged in across deploys) >
    // the key embedded by `amoxi build` (shared by every instance of a build) > a per-process
    // key (only for hand-written modules without a build key, e.g. unit tests).
    let secret: string;
    if (config.has('amoxi.session.secret')) {
      secret = config.string('amoxi.session.secret');
      if (secret.length < 32) throw new ConfigurationError('amoxi.session.secret must be at least 32 characters');
    } else {
      secret = ctx.module.sessionKey ?? randomBytes(32).toString('hex');
    }
    contextSettings = { ...base, session: { codec: new SessionCodec(secret), cookie, maxAge } };
  }

  function applyCors(req: IncomingMessage, res: ServerResponse): boolean {
    const origin = req.headers.origin;
    if (!origin || corsOrigins.length === 0) return false;
    const any = corsOrigins.includes('*');
    if (!any && !corsOrigins.includes(origin)) return false;
    res.setHeader('access-control-allow-origin', any ? '*' : origin);
    if (!any) res.setHeader('access-control-allow-credentials', 'true');
    appendVary(res, 'Origin');
    if (req.method === 'OPTIONS' && req.headers['access-control-request-method']) {
      res.setHeader('access-control-allow-methods', 'GET, HEAD, POST, PUT, PATCH, DELETE');
      const reqHeaders = req.headers['access-control-request-headers'];
      if (reqHeaders) res.setHeader('access-control-allow-headers', reqHeaders);
      res.setHeader('access-control-max-age', '600');
      res.writeHead(204).end();
      return true;
    }
    return false;
  }

  /** Blocks cross-site, cookie-bearing, state-changing requests (defence against CSRF). */
  function sameOrigin(req: IncomingMessage): boolean {
    const site = req.headers['sec-fetch-site'];
    if (site === 'same-origin' || site === 'none') return true;
    const host = req.headers.host;
    const source = req.headers.origin ?? req.headers.referer;
    if (!source || !host) return false;
    try {
      const url = new URL(source);
      return url.host === host || corsOrigins.includes(url.origin);
    } catch {
      return false;
    }
  }

  async function write(rc: HttpContext, parts: Parts): Promise<void> {
    const { req, res } = rc;
    // Static export: tell the exporter which request-specific data the page depended on.
    if (exporting && rc.used.size > 0) res.setHeader('x-amoxi-export-uses', [...rc.used].sort().join(','));
    rc.commit();
    for (const k in parts.headers) res.setHeader(k, parts.headers[k]);
    // A response that sets a cookie (a session, say) must never be stored by a shared cache (CDN), or
    // the cache would hand one visitor's cookie to everyone.
    if (res.hasHeader('set-cookie') && /\b(public|s-maxage)\b/i.test(String(res.getHeader('cache-control') ?? ''))) res.setHeader('cache-control', 'private, no-store');
    const head = req.method === 'HEAD';
    const body = parts.body;
    if (body === undefined) {
      res.writeHead(parts.status).end();
      return;
    }
    const type = String(res.getHeader('content-type') ?? '');
    const enc = compression && compressible(type) && !res.hasHeader('content-encoding') ? negotiate(req.headers['accept-encoding'], 'gzip') : null;

    if (typeof body !== 'string' && !Buffer.isBuffer(body)) {
      // Streaming body (a page with <Await> sections, or a file)
      if (enc) {
        res.setHeader('content-encoding', enc);
        res.removeHeader('content-length');
      }
      appendVary(res, 'Accept-Encoding');
      res.writeHead(parts.status);
      if (head) {
        // HEAD sends headers only: never open (or keep open) the body's file or generator.
        releaseBody(body);
        return void res.end();
      }
      const sink = enc ? compressStream(enc) : undefined;
      if (sink) sink.pipe(res);
      const out = sink ?? res;
      try {
        for await (const chunk of body) {
          if (res.destroyed) break;
          // Respect backpressure: a client that reads slowly (or stops) must not make the server
          // buffer the rest of the body (a large file) in memory.
          if (!out.write(chunk)) await drained(out, res);
        }
      } finally {
        out.end();
      }
      return;
    }

    let buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    if (enc && buf.length >= 1024) {
      buf = compressSync(buf, enc);
      res.setHeader('content-encoding', enc);
    }
    if (compression && compressible(type)) appendVary(res, 'Accept-Encoding');
    res.setHeader('content-length', buf.length);
    res.writeHead(parts.status);
    res.end(head ? undefined : buf);
  }

  /** Converts a rendered page into markdown or JSON for AI agents (other results pass through). */
  async function toRepresentation(result: unknown, representation: Representation, rc: HttpContext, htmlPath: string): Promise<unknown> {
    const parts = toParts(result);
    const type = parts.headers['content-type'] ?? '';
    if (parts.status < 200 || parts.status >= 300 || !type.startsWith('text/html')) return new PreparedResponse(parts);
    const html = await collectBody(parts.body);
    const url = `${publicOrigin(rc)}${htmlPath}${rc.search ? `?${rc.search}` : ''}`;
    const out = renderRepresentation(html, representation as 'markdown' | 'json', { url, data: result instanceof HttpResponse ? pageDataOf(result) : undefined });
    const headers: Record<string, string> = { ...parts.headers, 'content-type': out.contentType };
    delete headers['content-security-policy'];
    delete headers['content-length'];
    if (representation === 'markdown') headers.link = `<${htmlPath}>; rel="canonical"`;
    return new PreparedResponse({ status: parts.status, headers, body: out.body });
  }

  function llmsTxt(rc: HttpContext): string {
    const baseUrl = publicOrigin(rc);
    const info = options.extensionInfo?.() ?? [];
    const pageRoutes = routes.filter((r) => r.page && r.method === 'GET' && r.pattern === null);
    const apiRoutes = routes.filter((r) => !r.page && r.beanId >= 0);
    return buildLlmsTxt({
      name: config.string('app.name', 'Amoxi app'),
      description: config.string('app.description', '') || undefined,
      baseUrl,
      pages: pageRoutes.map((r) => ({ path: r.path })),
      apis: apiRoutes.map((r) => ({ method: r.method, path: r.path })),
      agents: info.flatMap((i) => i.agents ?? []),
      links: {
        openapi: openapiEnabled ? '/amoxi/openapi.json' : undefined,
        mcp: info.map((i) => i.links?.mcp).find(Boolean),
        agentCard: info.map((i) => i.links?.agentCard).find(Boolean),
      },
    });
  }

  /** Sends Server-Sent Events until the source ends or the client disconnects. */
  async function streamEvents(rc: HttpContext, stream: EventStreamResponse): Promise<void> {
    const { res } = rc;
    rc.commit();
    res.setHeader('content-type', 'text/event-stream; charset=utf-8');
    res.setHeader('cache-control', 'no-cache, no-transform');
    res.setHeader('x-accel-buffering', 'no'); // nginx: don't buffer
    for (const [k, v] of Object.entries(stream.options.headers ?? {})) res.setHeader(k, v);
    res.writeHead(stream.options.status ?? 200);
    res.flushHeaders();
    rc.req.socket?.setNoDelay(true);
    const abort = new AbortController();
    const onClose = (): void => abort.abort();
    res.once('close', onClose);
    const heartbeatMs = stream.options.heartbeatMs ?? 15000;
    let last = Date.now();
    const beat = setInterval(() => {
      if (Date.now() - last >= heartbeatMs && !res.writableEnded) {
        res.write(': keep-alive\n\n');
        last = Date.now();
      }
    }, Math.min(heartbeatMs, 5000));
    try {
      for await (const event of stream.source(abort.signal)) {
        if (abort.signal.aborted || res.writableEnded) break;
        if (!res.write(formatEvent(event))) await drained(res, res);
        last = Date.now();
      }
    } catch (err) {
      if (!abort.signal.aborted) {
        logger.error('Event stream failed', { requestId: rc.id, path: rc.path, err });
        if (!res.writableEnded) res.write(formatEvent({ event: 'error', data: { error: production ? 'Stream failed' : err instanceof Error ? err.message : String(err) } }));
      }
    } finally {
      clearInterval(beat);
      res.off('close', onClose);
      if (!res.writableEnded) res.end();
    }
  }

  /** @Cached routes: fresh hit, stale-while-revalidate, or render and store. */
  async function cached(route: RouteDefinition, rc: HttpContext, invoke: () => unknown, representation: Representation, pagePath = rc.path): Promise<PreparedResponse> {
    // Keyed by the page's path (not /x.md), so revalidatePath('/x') clears every representation.
    const path = rc.search ? `${pagePath}?${rc.search}` : pagePath;
    // Each representation of a page (HTML, markdown, JSON) is cached separately.
    // Markdown and JSON views contain absolute URLs, so they are also keyed by the public origin.
    let key = representation === 'html' ? path : `${representation}|${configuredOrigin ? '' : publicOrigin(rc)}|${path}`;
    // A page in several languages is cached once per language (the locale comes from ?lang=, the
    // locale cookie or Accept-Language), and shared caches (CDNs) are told the page varies by them.
    if (multilingual) {
      key = `lang=${rc.locale}|${key}`;
      appendVary(rc.res, 'Accept-Language');
      appendVary(rc.res, 'Cookie');
    }
    const { ttl, swr } = route.cache!;
    const cacheControl = `public, max-age=0, s-maxage=${ttl}${swr ? `, stale-while-revalidate=${swr}` : ''}`;

    const store = (parts: Parts): void => {
      if (parts.status !== 200 || (parts.body !== undefined && typeof parts.body !== 'string' && !Buffer.isBuffer(parts.body))) return;
      const nonce = parts.headers['content-security-policy']?.match(/'nonce-([^']+)'/)?.[1];
      const headers = { ...parts.headers };
      delete headers['x-amoxi-cache'];
      responseCache.set(key, { status: 200, headers, body: parts.body as string | Buffer | undefined, nonce, storedAt: Date.now(), ttlMs: ttl * 1000, swrMs: swr * 1000 });
    };

    // A page that read the visitor's cookies or session is personal: it is never stored, and neither
    // the browser nor a CDN may keep it.
    const render = async (): Promise<{ parts: Parts; personal: boolean }> => {
      const before = rc.personalReads;
      const parts = toParts(await invoke());
      return { parts, personal: rc.personalReads > before };
    };

    const hit = responseCache.get(key);
    if (hit) {
      const age = Date.now() - hit.storedAt;
      if (age < hit.ttlMs + hit.swrMs) {
        if (age >= hit.ttlMs && responseCache.beginRefresh(key)) {
          // Refresh after this response is sent, but as part of this request: its request-scoped beans
          // (a database transaction, say) stay open until the refresh has finished.
          rc.waitUntil(
            (async () => {
              try {
                const fresh = await render();
                if (!fresh.personal) store(fresh.parts);
                else releaseBody(fresh.parts.body);
              } catch (err) {
                logger.warn('Background revalidation failed', { path: key, err });
              } finally {
                responseCache.endRefresh(key);
              }
            })(),
          );
        }
        let body = hit.body;
        const headers: Record<string, string> = { ...hit.headers, 'x-amoxi-cache': age < hit.ttlMs ? 'HIT' : 'STALE', age: String(Math.floor(age / 1000)), 'cache-control': cacheControl };
        if (hit.nonce && typeof body === 'string') {
          // Never reuse a CSP nonce across responses.
          const fresh = rc.nonce;
          body = body.split(`nonce="${hit.nonce}"`).join(`nonce="${fresh}"`);
          headers['content-security-policy'] = headers['content-security-policy'].split(`'nonce-${hit.nonce}'`).join(`'nonce-${fresh}'`);
        }
        return new PreparedResponse({ status: hit.status, headers, body });
      }
    }
    const { parts, personal } = await render();
    if (personal) {
      parts.headers['cache-control'] = 'private, no-store';
      return new PreparedResponse(parts);
    }
    store(parts);
    parts.headers['x-amoxi-cache'] = 'MISS';
    parts.headers['cache-control'] ??= cacheControl;
    return new PreparedResponse(parts);
  }

  /**
   * An error was decided before the request body was read (413, 400, 405...). Closing the connection
   * while the client is still sending makes some systems (Windows in particular) reset it, and the
   * client never sees the response. So a body of known, reasonable size is read and thrown away
   * first (a "lingering close", as nginx does), and the connection is reused. A body of unknown or
   * very large size, or one that doesn't arrive in time, gets the response with `Connection: close`.
   */
  async function discardBody(rc: HttpContext): Promise<void> {
    const { req, res } = rc;
    if (req.complete) return;
    const length = Number(req.headers['content-length']);
    if (Number.isFinite(length) && length >= 0 && length <= MAX_DISCARD_BYTES && !req.headers['transfer-encoding']) {
      req.removeAllListeners('data');
      req.resume();
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer);
          req.off('end', done);
          req.off('close', done);
          req.off('error', done);
          resolve();
        };
        const timer = setTimeout(done, DISCARD_TIMEOUT_MS);
        req.once('end', done).once('close', done).once('error', done);
        if (req.readableEnded) done();
      });
    } else {
      req.resume();
    }
    if (!req.complete) res.setHeader('connection', 'close');
  }

  async function respondError(rc: HttpContext, err: unknown): Promise<void> {
    const { req, res } = rc;
    if (res.headersSent) {
      logger.error('Error after response started', { requestId: rc.id, err });
      res.destroy();
      return;
    }
    let status = 500;
    let body: unknown;
    if (err instanceof HttpError) {
      status = err.status;
      if (status === 413 || !req.complete) await discardBody(rc);
      body = err.body ?? { error: err.message };
    } else {
      logger.error('Unhandled error', { requestId: rc.id, method: rc.method, path: rc.path, err });
      body = production
        ? { error: 'Internal Server Error', requestId: rc.id }
        : { error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined, requestId: rc.id };
    }

    if (wantsHtml(req) && req.method !== 'HEAD') {
      const page = errorPages[status] ?? (status >= 500 ? errorPages[500] : undefined);
      if (page) {
        try {
          const parts = toParts(await page.handler(ctx.get(page.beanId), rc));
          parts.status = status;
          return await write(rc, parts);
        } catch (pageErr) {
          logger.error('Error page failed', { requestId: rc.id, err: pageErr });
        }
      }
      if (!production && status >= 500 && !(err instanceof HttpError)) {
        const e = err instanceof Error ? err : new Error(String(err));
        const html = `<!doctype html><meta charset="utf-8"><title>${escapeHtml(e.message)}</title><body style="font:15px/1.5 system-ui;margin:2rem;max-width:70rem"><h1 style="color:#B4423A">Unhandled error</h1><p>${escapeHtml(e.message)}</p><pre style="white-space:pre-wrap;background:#f4f4f4;padding:1rem;overflow:auto">${escapeHtml(e.stack ?? '')}</pre><p style="color:#666">Request ${escapeHtml(rc.id)}. This page is only shown in development.</p>`;
        return write(rc, { status, headers: { 'content-type': 'text/html; charset=utf-8' }, body: html });
      }
    }
    await write(rc, { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = performance.now();
    const url = req.url ?? '/';
    const q = url.indexOf('?');
    const path = normalizePath(q === -1 ? url : url.slice(0, q));
    const method = req.method ?? 'GET';
    const incoming = req.headers['x-request-id'];
    const id = typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
    const rc = new HttpContext(req, res, method, path, q === -1 ? '' : url.slice(q + 1), id, contextSettings);
    let kind: 'route' | 'static' | 'internal' = 'route';

    res.setHeader('x-request-id', id);
    if (securityHeaders) {
      for (const [k, v] of SECURITY_HEADERS) res.setHeader(k, v);
      if (hsts && rc.protocol === 'https') res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
    }
    if (requestLog) {
      res.once('finish', () => {
        const level = kind === 'route' ? 'info' : 'debug';
        if (kind === 'internal' || !logger.enabled(level)) return;
        const ms = Math.round((performance.now() - started) * 100) / 100;
        logger[level](`${method} ${path} ${res.statusCode} ${ms}ms`, logger.json ? { requestId: id, method, path, status: res.statusCode, durationMs: ms, ip: rc.ip } : undefined);
      });
    }

    try {
      if (dev?.handle(req, res, path)) {
        kind = 'internal';
        return;
      }
      if (healthEnabled && (path === '/amoxi/health/live' || path === '/amoxi/health/ready')) {
        kind = 'internal';
        const up = path.endsWith('/live') || (health?.ready ?? true);
        return await write(rc, { status: up ? 200 : 503, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify({ status: up ? 'UP' : 'DOWN' }) });
      }
      if (management && method === 'GET' && path.startsWith('/amoxi/')) {
        const data = management(path);
        if (data !== undefined) {
          kind = 'internal';
          return await write(rc, { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(data) });
        }
      }
      if (openapiEnabled && method === 'GET' && path === '/amoxi/openapi.json') {
        kind = 'internal';
        return await write(rc, { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-cache' }, body: JSON.stringify(ctx.module.openapi) });
      }
      if (llmsEnabled && method === 'GET' && path === '/llms.txt') {
        kind = 'internal';
        return await write(rc, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=300' }, body: llmsTxt(rc) });
      }
      if (applyCors(req, res)) return;
      if (csrf && !SAFE_METHODS.has(method) && req.headers.cookie && !sameOrigin(req)) {
        throw new HttpError(403, 'Cross-site request blocked (CSRF protection)');
      }

      let match: ReturnType<Router['match']>;
      let representation: Representation = 'html';
      let htmlPath = path;
      if (semantic && (method === 'GET' || method === 'HEAD') && path.endsWith('.md')) {
        // /about.md (and /index.md for /) is the markdown version of the page, as llms.txt suggests.
        // Checked first, so /products/:id pages also answer /products/42.md.
        const pagePath = markdownPath(path);
        const pageMatch = pagePath ? router.match('GET', pagePath) : undefined;
        if (pageMatch?.route.page) {
          match = pageMatch;
          representation = 'markdown';
          htmlPath = pagePath!;
        }
      }
      match ??= router.match(method === 'HEAD' ? 'GET' : method, path);
      if (match?.route.page && semantic && representation === 'html') representation = negotiateRepresentation(req.headers.accept);
      // Middleware and handlers see the page's own path, so a rule guarding /account also guards
      // /account.md and /account/index.md.
      rc.path = htmlPath;
      rc.representation = representation;
      if (!match) {
        if (staticFiles && (method === 'GET' || method === 'HEAD') && (await staticFiles.serve(req, res, path, compression))) {
          kind = 'static';
          return;
        }
        const allowed = router.allowedMethods(path);
        if (allowed.length > 0) {
          res.setHeader('allow', [...allowed, ...(allowed.includes('GET') ? ['HEAD'] : [])].join(', '));
          throw new HttpError(405, 'Method Not Allowed');
        }
        throw new HttpError(404, 'Not Found');
      }

      rc.params = match.params;
      const route = match.route;
      if (route.multipart) {
        const { form, cleanup } = await parseMultipart(req, uploadLimits);
        rc.body = form;
        res.once('close', () => void cleanup().catch((err) => logger.warn('Upload cleanup failed', { err })));
      } else if (route.needsBody) {
        rc.body = await readJson(req, maxBody);
      }
      const call = (): unknown => route.handler(route.beanId >= 0 ? ctx.get(route.beanId) : undefined, rc);
      const invoke = representation === 'html' ? call : async (): Promise<unknown> => toRepresentation(await call(), representation, rc, htmlPath);
      const handler = route.cache && (method === 'GET' || method === 'HEAD') ? () => cached(route, rc, invoke, representation, htmlPath) : invoke;
      if (route.page && semantic) {
        appendVary(res, 'Accept');
        if (representation === 'html') res.setHeader('link', `<${markdownUrlFor(htmlPath)}>; rel="alternate"; type="text/markdown"${llmsEnabled ? ', </llms.txt>; rel="describedby"' : ''}`);
      }

      const dispatch = async (): Promise<void> => {
        let result: unknown;
        if (middleware.length === 0) {
          result = handler();
          if (result instanceof Promise) result = await result;
        } else {
          const run = async (i: number): Promise<unknown> =>
            i < middleware.length ? ctx.get<HttpMiddleware>(middleware[i]).handle(rc, () => run(i + 1)) : handler();
          result = await run(0);
        }
        try {
          if (res.writableEnded) return;
          if (result instanceof EventStreamResponse) return streamEvents(rc, result);
          await write(rc, toParts(result));
        } finally {
          await rc.settled();
        }
      };
      if (requestScoped) await withRequestScope(rc, dispatch, (err) => logger.error('@PreDestroy of a request-scoped bean failed', { err }));
      else await dispatch();
    } catch (err) {
      await respondError(rc, err).catch((e) => {
        logger.error('Failed to send error response', { requestId: id, err: e });
        res.destroy();
      });
    }
  }

  const requestTimeout = config.number('server.request-timeout', '30000');
  const headersTimeout = Math.min(config.number('server.headers-timeout', '20000'), requestTimeout || Infinity);
  // Node enforces these timeouts on a periodic sweep (30 s by default); sweep often enough that
  // slow clients (slowloris) are cut off close to the configured limits.
  const connectionsCheckingInterval = Math.max(1000, Math.min(30_000, Math.floor(Math.min(headersTimeout, requestTimeout || headersTimeout) / 4)));
  const server = createServer({ connectionsCheckingInterval }, (req, res) => void handle(req, res));
  const sockets = (ctx.module.websockets ?? []).filter((w) => ctx.isEnabled(w.beanId));
  if (sockets.length > 0) {
    const ws = attachWebSockets(server, ctx, sockets, contextSettings, {
      maxMessageSize: config.number('server.websocket.max-message-size', String(1024 * 1024)),
      pingIntervalMs: config.number('server.websocket.ping-interval', '30000'),
      maxBufferedSize: config.number('server.websocket.max-buffered-size', String(16 * 1024 * 1024)),
      maxFragments: config.number('server.websocket.max-fragments', '1024'),
      allowedOrigins: corsOrigins,
    }, logger);
    webSocketClosers.set(server, ws.closeAll);
  }
  server.requestTimeout = requestTimeout;
  server.headersTimeout = headersTimeout;
  server.keepAliveTimeout = config.number('server.keep-alive-timeout', '5000');
  return server;
}
