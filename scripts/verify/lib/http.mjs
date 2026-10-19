// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

/** HTTP helpers for black-box checks: a cookie-keeping client, raw requests, SSE. */
import { connect } from 'node:net';

/** A browser-like client: keeps cookies, sends same-origin headers on writes. */
export class Client {
  constructor(base) {
    this.base = base;
    this.cookies = new Map();
  }

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async request(path, { method = 'GET', headers = {}, body, json, redirect = 'manual', timeoutMs = 15_000 } = {}) {
    const h = { ...headers };
    if (this.cookies.size && !('cookie' in h)) h.cookie = this.cookieHeader();
    if (json !== undefined) {
      h['content-type'] ??= 'application/json';
      body = JSON.stringify(json);
    }
    if (method !== 'GET' && method !== 'HEAD' && !('sec-fetch-site' in h) && !('origin' in h) && !('referer' in h)) h['sec-fetch-site'] = 'same-origin';
    const res = await fetch(this.base + path, { method, headers: h, body, redirect, signal: AbortSignal.timeout(timeoutMs) });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (/max-age=0|expires=thu, 01 jan 1970/i.test(c) || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  }

  async text(path, opts) {
    const res = await this.request(path, opts);
    return { res, text: await res.text() };
  }

  async json(path, opts) {
    const res = await this.request(path, opts);
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
    return { res, data, text };
  }

  /** Reads a Server-Sent Events response to its end (or `timeoutMs`), returning parsed events. */
  async sse(path, opts = {}) {
    const res = await this.request(path, { ...opts, headers: { accept: 'text/event-stream', ...(opts.headers ?? {}) }, timeoutMs: opts.timeoutMs ?? 60_000 });
    if (!res.ok) return { res, events: [], text: await res.text() };
    return { res, events: parseSse(await res.text()) };
  }
}

export function parseSse(text) {
  const events = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    let event = 'message';
    let id;
    const data = [];
    for (const line of block.split(/\r?\n/)) {
      if (!line || line.startsWith(':')) continue;
      const i = line.indexOf(':');
      const field = i === -1 ? line : line.slice(0, i);
      const value = i === -1 ? '' : line.slice(i + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'id') id = value;
      else if (field === 'data') data.push(value);
    }
    if (data.length === 0) continue;
    let parsed;
    try {
      parsed = JSON.parse(data.join('\n'));
    } catch {
      parsed = data.join('\n');
    }
    events.push({ event, id, data: parsed });
  }
  return events;
}

/**
 * Sends bytes exactly as given (fetch normalises paths and refuses bad headers) and returns the
 * raw response head and body. Resolves when the server closes or after `timeoutMs`.
 */
export function rawRequest(port, payload, { timeoutMs = 8000, host = '127.0.0.1', endAfterWrite = false } = {}) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let data = Buffer.alloc(0);
    let closed = false;
    const started = Date.now();
    const finish = () => {
      if (closed) return;
      closed = true;
      socket.destroy();
      const text = data.toString('latin1');
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(text)?.[1] ?? 0);
      const cut = text.indexOf('\r\n\r\n');
      resolve({ status, head: cut === -1 ? text : text.slice(0, cut), body: cut === -1 ? '' : text.slice(cut + 4), closedAfterMs: Date.now() - started, raw: text });
    };
    socket.on('data', (d) => (data = Buffer.concat([data, d])));
    socket.on('close', finish);
    socket.on('error', finish);
    socket.setTimeout(timeoutMs, finish);
    socket.on('connect', () => {
      if (payload) socket.write(payload);
      if (endAfterWrite) socket.end();
    });
  });
}

export function header(head, name) {
  const m = new RegExp(`^${name}:\\s*(.*)$`, 'im').exec(head);
  return m ? m[1].trim() : undefined;
}
