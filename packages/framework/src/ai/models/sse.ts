// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

/** One dispatched server-sent event. */
export interface SseEvent {
  /** The `event:` field, when the server set one. */
  readonly event?: string;
  /** All `data:` lines of the event joined with `\n`. */
  readonly data: string;
  /** The last event id seen on the stream (persists across events, as the spec says). */
  readonly id?: string;
  /** Reconnection time sent with this event (`retry:` field), in ms. */
  readonly retry?: number;
}

export interface SseOptions {
  /** Upper bound on one event (and on one unterminated line), in UTF-16 code units. Default 8 MiB. */
  readonly maxEventSize?: number;
}

const DEFAULT_MAX_EVENT = 8 * 1024 * 1024;

type ByteSource = ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;

/** Iterates a byte stream; a ReadableStream is cancelled when the consumer stops early. */
async function* bytesOf(body: ByteSource): AsyncGenerator<Uint8Array> {
  const maybeStream = body as ReadableStream<Uint8Array>;
  if (typeof maybeStream.getReader !== 'function') {
    yield* body as AsyncIterable<Uint8Array>;
    return;
  }
  const reader = maybeStream.getReader();
  let done = false;
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) {
        done = true;
        return;
      }
      yield r.value;
    }
  } finally {
    if (!done) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/**
 * Parses a `text/event-stream` body as specified by the WHATWG HTML standard (§9.2):
 * CRLF, LF and CR line endings; `:` comments; `event`, `data`, `id` and `retry` fields;
 * multi-line data joined with `\n`; events and UTF-8 characters split across chunks.
 * An event that is not terminated by a blank line before the stream ends is discarded.
 * Breaking out of the loop cancels the underlying stream.
 */
export async function* parseSse(body: ByteSource, options: SseOptions = {}): AsyncGenerator<SseEvent> {
  const maxSize = options.maxEventSize ?? DEFAULT_MAX_EVENT;
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let skipLf = false;
  let data: string[] = [];
  let dataSize = 0;
  let eventType: string | undefined;
  let lastId: string | undefined;
  let retry: number | undefined;
  const lineEnd = /[\r\n]/g;

  /** Processes one complete line; returns an event to dispatch, if any. */
  const onLine = (line: string): SseEvent | undefined => {
    if (line === '') {
      if (data.length === 0) {
        eventType = undefined;
        retry = undefined;
        return undefined;
      }
      const ev: SseEvent = {
        data: data.join('\n'),
        ...(eventType !== undefined ? { event: eventType } : {}),
        ...(lastId !== undefined ? { id: lastId } : {}),
        ...(retry !== undefined ? { retry } : {}),
      };
      data = [];
      dataSize = 0;
      eventType = undefined;
      retry = undefined;
      return ev;
    }
    if (line.charCodeAt(0) === 58 /* : */) return undefined;
    const colon = line.indexOf(':');
    let field: string;
    let value: string;
    if (colon === -1) {
      field = line;
      value = '';
    } else {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      if (value.charCodeAt(0) === 32) value = value.slice(1);
    }
    switch (field) {
      case 'data':
        dataSize += value.length + 1;
        if (dataSize > maxSize) throw new Error(`SSE event exceeds ${maxSize} characters`);
        data.push(value);
        break;
      case 'event':
        eventType = value;
        break;
      case 'id':
        if (!value.includes('\0')) lastId = value;
        break;
      case 'retry':
        if (/^\d+$/.test(value)) retry = Number(value);
        break;
      default:
        break; // unknown fields are ignored
    }
    return undefined;
  };

  for await (const chunk of bytesOf(body)) {
    let text = decoder.decode(chunk, { stream: true });
    if (text.length === 0) continue;
    if (skipLf) {
      skipLf = false;
      if (text.charCodeAt(0) === 10) text = text.slice(1);
    }
    buf += text;
    let start = 0;
    lineEnd.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = lineEnd.exec(buf)) !== null) {
      const i = m.index;
      const line = buf.slice(start, i);
      let next = i + 1;
      if (buf.charCodeAt(i) === 13) {
        if (i + 1 < buf.length) {
          if (buf.charCodeAt(i + 1) === 10) next = i + 2;
        } else {
          skipLf = true; // a CRLF may be split across chunks
        }
      }
      start = next;
      lineEnd.lastIndex = next;
      const ev = onLine(line);
      if (ev) yield ev;
    }
    buf = start === 0 ? buf : buf.slice(start);
    if (buf.length > maxSize) throw new Error(`SSE line exceeds ${maxSize} characters`);
  }
  // End of stream: any pending (unterminated) line or event is discarded, per the spec.
}
