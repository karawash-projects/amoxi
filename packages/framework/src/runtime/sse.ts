// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

/** One Server-Sent Event. `data` that isn't a string is sent as JSON. */
export interface ServerSentEvent {
  readonly event?: string;
  readonly data: unknown;
  /** Lets the browser resume with `Last-Event-ID` after a reconnect. */
  readonly id?: string | number;
  /** Reconnection delay the browser should use, in ms. */
  readonly retry?: number;
}

export interface EventStreamOptions {
  /** Comment line sent when nothing else was sent for this long, so proxies keep the connection open. Default 15000 ms. */
  readonly heartbeatMs?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly status?: number;
}

/**
 * A streaming response of Server-Sent Events (text/event-stream). Return it from a route:
 *
 *   @Get('/ticks')
 *   ticks() {
 *     return eventStream(async function* (signal) {
 *       while (!signal.aborted) { yield { event: 'tick', data: { at: Date.now() } }; await sleep(1000); }
 *     });
 *   }
 *
 * The source receives an AbortSignal that fires when the client disconnects. Responses are
 * never compressed or buffered (proxies are told not to buffer either), and heartbeats keep
 * idle connections alive. Unlike JSON routes, there is no time limit on how long it runs.
 */
export class EventStreamResponse {
  constructor(
    readonly source: (signal: AbortSignal) => AsyncIterable<ServerSentEvent>,
    readonly options: EventStreamOptions = {},
  ) {}
}

export function eventStream(source: (signal: AbortSignal) => AsyncIterable<ServerSentEvent>, options?: EventStreamOptions): EventStreamResponse {
  return new EventStreamResponse(source, options);
}

/** Serialises one event in the text/event-stream format. */
export function formatEvent(e: ServerSentEvent): string {
  let out = '';
  if (e.id !== undefined) out += `id: ${String(e.id).replace(/[\r\n]/g, '')}\n`;
  if (e.event) out += `event: ${e.event.replace(/[\r\n]/g, '')}\n`;
  if (e.retry !== undefined) out += `retry: ${Math.max(0, Math.floor(e.retry))}\n`;
  const data = typeof e.data === 'string' ? e.data : JSON.stringify(e.data ?? null);
  for (const line of data.split(/\r\n|\r|\n/)) out += `data: ${line}\n`;
  return `${out}\n`;
}

/** The id the client sent when reconnecting (Last-Event-ID header, or ?lastEventId= for EventSource polyfills). */
export function lastEventId(headers: Readonly<Record<string, string | string[] | undefined>>, query?: URLSearchParams): string | undefined {
  const h = headers['last-event-id'];
  const v = Array.isArray(h) ? h[0] : h;
  return v ?? query?.get('lastEventId') ?? undefined;
}
