// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders, IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { ApplicationContext } from './container';
import type { ContextSettings } from './context';
import { HttpContext } from './context';
import type { Cookies } from './cookies';
import type { Logger } from './logger';
import { Session } from './session';
import type { WebSocketDefinition } from './types';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa } as const;

/** One connected client. Passed to @WebSocketEndpoint handlers. */
export interface WebSocketConnection {
  readonly id: string;
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  readonly headers: IncomingHttpHeaders;
  readonly cookies: Cookies;
  /** Session data as it was when the connection opened (read-only: a socket can't set cookies). */
  readonly session: Session;
  readonly open: boolean;
  /** Bytes queued for this client that it has not read yet. */
  readonly bufferedAmount: number;
  /** Send text, binary data, or any other value as JSON. */
  send(data: string | Buffer | unknown): void;
  /**
   * Closes the connection. `code` must be 1000-1003, 1007-1014 or 3000-4999 (RangeError otherwise);
   * `reason` is cut to the 123 bytes a close frame can carry.
   */
  close(code?: number, reason?: string): void;
}

export interface WebSocketOptions {
  maxMessageSize: number;
  pingIntervalMs: number;
  /** Origins allowed besides the server's own (from server.cors.origins). */
  allowedOrigins: readonly string[];
  /**
   * Most bytes a connection may have waiting to be sent. Past half of it the server stops reading from
   * that client until it catches up; past all of it the connection is dropped. Default 16 MB.
   */
  maxBufferedSize?: number;
  /** Most frames one message may be split into. Default 1024. */
  maxFragments?: number;
}

function frame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  const head = len < 126 ? Buffer.alloc(2) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  head[0] = 0x80 | opcode; // FIN + opcode; server frames are never masked
  if (len < 126) head[1] = len;
  else if (len < 65536) {
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

/** How long a closed connection may stay open waiting for the client to hang up. */
const CLOSE_TIMEOUT_MS = 5000;
/** A close frame's payload is at most 125 bytes: a 2-byte code and up to 123 bytes of reason. */
const MAX_CLOSE_REASON = 123;

/** Close codes an endpoint may send or receive on the wire (RFC 6455 section 7.4, IANA registry). */
export function isValidCloseCode(code: number): boolean {
  return Number.isInteger(code) && ((code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999));
}

/** Cuts a string to at most `max` UTF-8 bytes without splitting a character. */
function truncateUtf8(text: string, max: number): Buffer {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= max) return bytes;
  let end = max;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--; // step back to the start of a character
  return bytes.subarray(0, end);
}

class Connection implements WebSocketConnection {
  readonly id = randomUUID();
  open = true;
  alive = true;
  /** Received bytes not parsed yet, kept as a list so a frame sent in small pieces is copied once. */
  private chunks: Buffer[] = [];
  private buffered = 0;
  private fragments: Buffer[] = [];
  private fragmentCount = 0;
  private fragmentOpcode = 0;
  private fragmentSize = 0;
  private readingPaused = false;
  private readonly utf8 = new TextDecoder('utf-8', { fatal: true });

  constructor(
    private readonly socket: Duplex,
    readonly path: string,
    readonly params: Record<string, string>,
    readonly query: URLSearchParams,
    readonly headers: IncomingHttpHeaders,
    readonly cookies: Cookies,
    private readonly sessionFactory: () => Session,
    private readonly maxMessageSize: number,
    private readonly maxBufferedSize: number,
    private readonly maxFragments: number,
    private readonly onMessage: (data: string | Buffer) => void,
    private readonly onClose: (code: number, reason: string) => void,
  ) {
    socket.on('drain', () => this.resumeReading());
  }

  private _session?: Session;
  get session(): Session {
    return (this._session ??= this.sessionFactory());
  }

  get bufferedAmount(): number {
    return this.socket.writableLength;
  }

  send(data: string | Buffer | unknown): void {
    if (!this.open) return;
    if (Buffer.isBuffer(data)) this.write(frame(OP.binary, data));
    else this.write(frame(OP.text, Buffer.from(typeof data === 'string' ? data : JSON.stringify(data), 'utf8')));
  }

  /**
   * Writes a frame with backpressure: a client that doesn't read what it is sent first stops being read
   * from (so it can't make the server queue more answers, such as pongs), then is dropped.
   */
  private write(data: Buffer): void {
    if (this.socket.destroyed) return;
    this.socket.write(data);
    const waiting = this.socket.writableLength;
    if (waiting > this.maxBufferedSize) {
      this.terminate();
      return;
    }
    if (waiting > this.maxBufferedSize / 2 && !this.readingPaused) {
      this.readingPaused = true;
      this.socket.pause();
    }
  }

  private resumeReading(): void {
    if (!this.readingPaused) return;
    this.readingPaused = false;
    this.socket.resume();
  }

  close(code = 1000, reason = ''): void {
    if (!isValidCloseCode(code)) throw new RangeError(`WebSocket close code ${code} is reserved or invalid; use 1000-1003, 1007-1014 or 3000-4999`);
    if (!this.open) return;
    this.open = false;
    const text = truncateUtf8(reason, MAX_CLOSE_REASON);
    const payload = Buffer.alloc(2 + text.length);
    payload.writeUInt16BE(code, 0);
    text.copy(payload, 2);
    if (!this.socket.destroyed) this.socket.end(frame(OP.close, payload));
    this.release();
    this.resumeReading(); // keep draining (and discarding) input until the client hangs up
    // The client should answer with its own close frame and hang up; if it keeps the connection open
    // (or keeps sending), drop it shortly after instead of holding the socket.
    setTimeout(() => this.socket.destroy(), CLOSE_TIMEOUT_MS).unref();
    this.onClose(code, text.toString('utf8'));
  }

  /** Frees buffered input; nothing received after closing is kept. */
  private release(): void {
    this.chunks = [];
    this.buffered = 0;
    this.fragments = [];
    this.fragmentCount = 0;
    this.fragmentSize = 0;
  }

  ping(): void {
    if (this.open) this.write(frame(OP.ping, Buffer.alloc(0)));
  }

  terminate(): void {
    this.release();
    if (this.open) {
      this.open = false;
      this.onClose(1006, 'connection lost');
    }
    this.socket.destroy();
  }

  /** The first `n` received bytes as one buffer (joins only the chunks needed for them). */
  private peek(n: number): Buffer {
    if (this.chunks[0].length < n) {
      let k = 0;
      let size = 0;
      while (size < n) size += this.chunks[k++].length;
      this.chunks.splice(0, k, Buffer.concat(this.chunks.slice(0, k), size));
    }
    return this.chunks[0];
  }

  /** Removes and returns the first `n` received bytes. */
  private take(n: number): Buffer {
    if (n === 0) return Buffer.alloc(0);
    this.buffered -= n;
    const first = this.chunks[0];
    if (first.length >= n) {
      if (first.length === n) this.chunks.shift();
      else this.chunks[0] = first.subarray(n);
      return first.subarray(0, n);
    }
    const out = Buffer.allocUnsafe(n);
    let filled = 0;
    while (filled < n) {
      const c = this.chunks[0];
      const used = Math.min(c.length, n - filled);
      c.copy(out, filled, 0, used);
      filled += used;
      if (used === c.length) this.chunks.shift();
      else this.chunks[0] = c.subarray(used);
    }
    return out;
  }

  /** Parses as many complete frames as have arrived. */
  receive(chunk: Buffer): void {
    if (!this.open) return; // closed: ignore anything the client still sends
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    while (this.open && this.buffered >= 2) {
      const first = this.peek(2);
      const b0 = first[0];
      const b1 = first[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if ((b0 & 0x70) !== 0) return this.close(1002, 'reserved bits set');
      if (!masked) return this.close(1002, 'client frames must be masked');
      if (len === 126) {
        if (this.buffered < 4) return;
        len = this.peek(4).readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buffered < 10) return;
        const big = this.peek(10).readBigUInt64BE(2);
        if (big > BigInt(this.maxMessageSize)) return this.close(1009, 'message too big');
        len = Number(big);
        offset = 10;
      }
      if (len > this.maxMessageSize) return this.close(1009, 'message too big');
      if (opcode < 0x8 && this.fragmentSize + len > this.maxMessageSize) return this.close(1009, 'message too big');
      if (this.buffered < offset + 4 + len) return; // wait for the rest of the frame
      const mask = Buffer.from(this.take(offset + 4).subarray(offset, offset + 4));
      const payload = Buffer.from(this.take(len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];

      if (opcode >= 0x8) {
        if (!fin || len > 125) return this.close(1002, 'invalid control frame');
        if (opcode === OP.close) return this.receiveClose(payload);
        if (opcode === OP.ping) this.write(frame(OP.pong, payload));
        else if (opcode === OP.pong) this.alive = true;
        else return this.close(1002, 'unknown opcode');
        continue;
      }
      if (opcode === OP.continuation) {
        if (this.fragmentCount === 0) return this.close(1002, 'unexpected continuation frame');
      } else if (opcode === OP.text || opcode === OP.binary) {
        if (this.fragmentCount > 0) return this.close(1002, 'expected continuation frame');
        this.fragmentOpcode = opcode;
        this.fragmentSize = 0;
      } else {
        return this.close(1002, 'unknown opcode');
      }
      // Every frame counts, empty ones included: a message can't be split into endless pieces.
      if (++this.fragmentCount > this.maxFragments) return this.close(1009, 'message split into too many frames');
      this.fragmentSize += payload.length;
      if (payload.length > 0) this.fragments.push(payload);
      if (!fin) continue;

      const message = this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments, this.fragmentSize);
      this.fragments = [];
      this.fragmentCount = 0;
      this.fragmentSize = 0;
      if (this.fragmentOpcode === OP.text) {
        let text: string;
        try {
          text = this.utf8.decode(message);
        } catch {
          return this.close(1007, 'invalid UTF-8');
        }
        this.onMessage(text);
      } else {
        this.onMessage(message);
      }
    }
  }

  /** Answers the client's close frame, refusing reserved codes and malformed payloads. */
  private receiveClose(payload: Buffer): void {
    if (payload.length === 0) return this.close(1000, '');
    if (payload.length === 1) return this.close(1002, 'invalid close frame');
    const code = payload.readUInt16BE(0);
    if (!isValidCloseCode(code)) return this.close(1002, 'invalid close code');
    let reason: string;
    try {
      reason = this.utf8.decode(payload.subarray(2));
    } catch {
      return this.close(1007, 'invalid UTF-8');
    }
    this.close(code, reason);
  }
}

/**
 * Adds WebSocket support to an HTTP server: matches upgrade requests against
 * @WebSocketEndpoint routes, checks the Origin (cross-site connections are refused unless
 * listed in server.cors.origins), performs the RFC 6455 handshake and dispatches messages.
 */
export function attachWebSockets(
  server: Server,
  ctx: ApplicationContext,
  endpoints: readonly WebSocketDefinition[],
  settings: ContextSettings,
  options: WebSocketOptions,
  logger: Logger,
): { closeAll: () => void; count: () => number } {
  const connections = new Set<Connection>();
  const reject = (socket: Duplex, status: number, text: string): void => {
    socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    // An exception thrown from an 'upgrade' listener is uncaught and would end the process.
    try {
      onUpgrade(req, socket, head);
    } catch (err) {
      logger.error(`WebSocket upgrade failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!socket.destroyed) reject(socket, 400, 'Bad Request');
    }
  });

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    socket.on('error', () => socket.destroy());
    const url = req.url ?? '/';
    const q = url.indexOf('?');
    const path = q === -1 ? url : url.slice(0, q);
    let match: { def: WebSocketDefinition; params: Record<string, string> } | undefined;
    for (const def of endpoints) {
      if (!ctx.isEnabled(def.beanId)) continue;
      if (def.pattern === null) {
        if (def.path === path) match = { def, params: {} };
      } else {
        const m = def.pattern.exec(path);
        if (m) {
          const params: Record<string, string> = {};
          for (let i = 0; i < def.paramNames.length; i++) {
            try {
              params[def.paramNames[i]] = decodeURIComponent(m[i + 1]);
            } catch {
              return reject(socket, 400, 'Bad Request'); // malformed %-encoding
            }
          }
          match = { def, params };
        }
      }
      if (match) break;
    }
    if (!match) return reject(socket, 404, 'Not Found');
    if ((req.headers.upgrade ?? '').toLowerCase() !== 'websocket' || req.headers['sec-websocket-version'] !== '13' || !req.headers['sec-websocket-key']) {
      return reject(socket, 400, 'Bad Request');
    }
    const origin = req.headers.origin;
    if (origin) {
      let ok = false;
      try {
        ok = new URL(origin).host === req.headers.host || options.allowedOrigins.includes(origin) || options.allowedOrigins.includes('*');
      } catch {
        ok = false;
      }
      if (!ok) return reject(socket, 403, 'Forbidden');
    }

    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}${GUID}`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    (socket as Duplex & { setNoDelay?: (v: boolean) => void }).setNoDelay?.(true);

    const http = new HttpContext(req, undefined as never, 'GET', path, q === -1 ? '' : url.slice(q + 1), randomUUID(), settings);
    const def = match.def;
    const bean = ctx.get(def.beanId);
    const fail = (where: string, err: unknown): void => {
      logger.error(`WebSocket ${where} handler failed`, { path, err });
      conn.close(1011, 'internal error');
    };
    const run = (where: string, fn: () => unknown): void => {
      try {
        const r = fn();
        if (r instanceof Promise) r.catch((err) => fail(where, err));
      } catch (err) {
        fail(where, err);
      }
    };
    const conn: Connection = new Connection(
      socket,
      path,
      match.params,
      http.query,
      req.headers,
      http.cookies,
      () => {
        try {
          return http.session;
        } catch {
          return new Session(undefined); // sessions not configured: an empty, read-only session
        }
      },
      options.maxMessageSize,
      options.maxBufferedSize ?? 16 * 1024 * 1024,
      options.maxFragments ?? 1024,
      (data) => deliver(data),
      (code, reason) => {
        connections.delete(conn);
        if (def.close) run('close', () => def.close!(bean, conn, code, reason));
      },
    );
    // Messages wait until the open handler has finished (including any it sent with the upgrade request).
    let queued: (string | Buffer)[] | undefined = [];
    const dispatch = (data: string | Buffer): void => run('message', () => def.message(bean, conn, data));
    const deliver = (data: string | Buffer): void => {
      if (queued) queued.push(data);
      else dispatch(data);
    };
    const opened = (): void => {
      const waiting = queued ?? [];
      queued = undefined;
      for (const data of waiting) if (conn.open) dispatch(data);
    };
    connections.add(conn);
    socket.on('data', (chunk: Buffer) => conn.receive(chunk));
    socket.on('error', () => conn.terminate());
    socket.on('close', () => conn.terminate());
    if (head.length) conn.receive(head);
    if (!def.open) opened();
    else {
      let result: unknown;
      try {
        result = def.open(bean, conn);
      } catch (err) {
        fail('open', err);
      }
      if (result instanceof Promise)
        result.then(opened, (err) => {
          fail('open', err);
          opened();
        });
      else opened();
    }
  };

  // Heartbeat: ping everyone; drop connections that didn't answer the previous ping.
  const heartbeat = setInterval(() => {
    for (const c of connections) {
      if (!c.alive) {
        c.terminate();
        continue;
      }
      c.alive = false;
      c.ping();
    }
  }, options.pingIntervalMs);
  heartbeat.unref();

  return {
    closeAll: () => {
      clearInterval(heartbeat);
      for (const c of [...connections]) c.close(1001, 'server shutting down');
    },
    count: () => connections.size,
  };
}
