/*! amoxi | Copyright 2026 Ahmad Karawash | Apache-2.0 */
/**
 * Browser client for Amoxi agents: token streaming over Server-Sent Events (with automatic
 * resume after a dropped connection), a signals-based chat state for islands, human approvals,
 * and generative UI (agents show your @generative islands by name).
 */
import { hasIsland, activateIslands } from './hydrate';
import { withBasePath } from './router';
import { signal, type Getter } from './signals';

/** One event of the agent stream protocol (see amoxi/ai RunEventType). */
export interface AgentEvent {
  readonly seq: number;
  readonly type: string;
  readonly data: Record<string, any>;
}

/** What a chat UI shows; the same shape the server's toChatItems() returns. */
export type ChatItem =
  | { readonly kind: 'user'; readonly id: string; readonly text: string }
  | { readonly kind: 'assistant'; readonly id: string; readonly text: string; readonly streaming?: boolean }
  | { readonly kind: 'tool'; readonly id: string; readonly tool: string; readonly input: unknown; readonly status: 'running' | 'done' | 'error'; readonly output?: unknown }
  | { readonly kind: 'ui'; readonly id: string; readonly component: string; readonly props: Record<string, unknown> }
  | { readonly kind: 'approval'; readonly id: string; readonly callId: string; readonly tool: string; readonly input: unknown; readonly reason?: string; readonly status: 'pending' | 'approved' | 'denied' }
  | { readonly kind: 'progress'; readonly id: string; readonly text: string }
  | { readonly kind: 'error'; readonly id: string; readonly text: string };

export type ChatStatus = 'idle' | 'working' | 'awaiting_approval';

const ENDS = new Set(['run.completed', 'run.failed']);
const isEnd = (e: AgentEvent): boolean => ENDS.has(e.type) || (e.type === 'run.status' && ['cancelled', 'awaiting_approval', 'completed', 'failed'].includes(e.data.status));

/** Reads a text/event-stream response body, calling onEvent for each event. Returns the last seq. */
async function readStream(res: Response, onEvent: (e: AgentEvent) => void, after: number): Promise<{ last: number; ended: boolean }> {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let last = after;
  let ended = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let cut: number;
    while ((cut = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + (buffer[cut] === '\r' ? 4 : 2));
      let type = 'message';
      let id: string | undefined;
      const data: string[] = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        const v = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') type = v;
        else if (field === 'id') id = v;
        else if (field === 'data') data.push(v);
      }
      if (data.length === 0) continue;
      let parsed: Record<string, any>;
      try {
        parsed = JSON.parse(data.join('\n')) as Record<string, any>;
      } catch {
        continue;
      }
      const seq = id !== undefined ? Number(id) : Number(parsed.seq ?? last);
      if (seq <= last && type !== 'error') continue;
      last = seq;
      const event = { seq, type, data: parsed };
      onEvent(event);
      if (isEnd(event)) ended = true;
    }
  }
  return { last, ended };
}

async function errorText(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string; details?: Array<{ path: string; message: string }> };
    return body.details?.length ? `${body.error}: ${body.details.map((d) => `${d.path} ${d.message}`).join('; ')}` : (body.error ?? res.statusText);
  } catch {
    return res.statusText || `Request failed (${res.status})`;
  }
}

/**
 * Follows a run's event stream until it finishes or pauses for approval. Reconnects with
 * Last-Event-ID after network errors (up to `retries` times in a row), so a flaky connection
 * or a server restart doesn't lose the answer.
 */
export async function followRun(eventsUrl: string, options: { after?: number; signal?: AbortSignal; onEvent: (e: AgentEvent) => void; retries?: number }): Promise<number> {
  let last = options.after ?? 0;
  let failures = 0;
  // Streams in a row that closed without bringing anything new (a proxy that cuts idle streams,
  // say): each one waits longer before reconnecting, so the client never reconnects in a tight loop.
  let quiet = 0;
  while (!options.signal?.aborted) {
    try {
      const before = last;
      const res = await fetch(withBasePath(eventsUrl), { headers: { accept: 'text/event-stream', 'last-event-id': String(last) }, signal: options.signal });
      if (!res.ok) throw new Error(await errorText(res));
      const r = await readStream(res, options.onEvent, last);
      last = r.last;
      if (r.ended) return last;
      failures = 0;
      quiet = last > before ? 0 : quiet + 1;
      await delay(quiet === 0 ? 250 : Math.min(8000, 500 * 2 ** Math.min(quiet, 4)), options.signal);
    } catch (err) {
      if (options.signal?.aborted) return last;
      if (++failures > (options.retries ?? 5)) throw err;
      await delay(Math.min(8000, 500 * 2 ** failures), options.signal);
    }
  }
  return last;
}

/** Waits `ms`, or less if the signal fires. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

export interface AgentChat {
  readonly items: Getter<ChatItem[]>;
  readonly status: Getter<ChatStatus>;
  readonly error: Getter<string | undefined>;
  readonly threadId: Getter<string | undefined>;
  readonly runId: Getter<string | undefined>;
  /** Sends a message and streams the agent's work into `items`. */
  send(text: string): Promise<void>;
  /** Approves or declines an action the agent asked to take. */
  decide(callId: string, approved: boolean, note?: string): Promise<void>;
  cancel(): Promise<void>;
}

export interface AgentChatOptions {
  /** Where the agent endpoints live (ai.path). Default '/agents'. */
  basePath?: string;
  /** Continue an existing conversation. */
  threadId?: string;
  /** Items to start with, e.g. from the server's toChatItems() for a reload. */
  initial?: ChatItem[];
  /** Called for every raw event (analytics, custom rendering). */
  onEvent?: (e: AgentEvent) => void;
  /**
   * Continue a run that is still in progress after a page reload, e.g. one waiting for approval:
   * pass `activeRun` from GET /agents/<name>/threads/<id> (with `initial` set to its `items`).
   */
  resume?: { id: string; status: string; lastSeq?: number } | null;
}

/**
 * Chat state for an island, driven by the agent stream:
 *
 *   const chat = agentChat('banking-assistant');
 *   <For each={chat.items} key={(i) => i.id}>{(item) => ...}</For>
 *   <button onClick={() => chat.send(text)}>Send</button>
 */
export function agentChat(agent: string, options: AgentChatOptions = {}): AgentChat {
  const base = `${options.basePath ?? '/agents'}/${encodeURIComponent(agent)}`;
  const [items, setItems] = signal<ChatItem[]>(options.initial ?? []);
  const [status, setStatus] = signal<ChatStatus>('idle');
  const [error, setError] = signal<string | undefined>(undefined);
  const [threadId, setThreadId] = signal<string | undefined>(options.threadId);
  const [runId, setRunId] = signal<string | undefined>(undefined);
  let last = 0;
  let controller: AbortController | undefined;
  let streaming: string | undefined;
  // Event numbers restart with every run: prefix item ids so runs in one conversation never collide.
  let prefix = 'r0-';
  let runCount = 0;

  const update = (fn: (list: ChatItem[]) => ChatItem[]): void => setItems(fn(items()));
  const replace = (id: string, next: (item: ChatItem) => ChatItem): void => update((list) => list.map((i) => (i.id === id ? next(i) : i)));

  const apply = (e: AgentEvent): void => {
    options.onEvent?.(e);
    const d = e.data;
    switch (e.type) {
      case 'run.status':
        if (d.runId) setRunId(d.runId);
        if (d.threadId) setThreadId(d.threadId);
        if (d.status === 'queued' || d.status === 'running') setStatus('working');
        else if (d.status === 'awaiting_approval') setStatus('awaiting_approval');
        else if (d.status === 'cancelled') {
          setStatus('idle');
          update((l) => [...l, { kind: 'progress', id: `${prefix}p${e.seq}`, text: 'Cancelled' }]);
        }
        break;
      case 'message.delta': {
        if (!streaming) {
          streaming = `${prefix}a${Math.floor(e.seq)}`;
          update((l) => [...l, { kind: 'assistant', id: streaming!, text: '', streaming: true }]);
        }
        const id = streaming;
        replace(id, (i) => ({ ...(i as Extract<ChatItem, { kind: 'assistant' }>), text: (i as Extract<ChatItem, { kind: 'assistant' }>).text + String(d.text ?? '') }));
        break;
      }
      case 'message.completed': {
        const text = String(d.text ?? '');
        if (streaming) replace(streaming, () => ({ kind: 'assistant', id: streaming!, text }));
        else update((l) => [...l, { kind: 'assistant', id: `${prefix}a${e.seq}`, text }]);
        streaming = undefined;
        break;
      }
      case 'tool.started':
        update((l) => [...l, { kind: 'tool', id: `${prefix}${d.callId}`, tool: String(d.tool), input: d.input, status: 'running' }]);
        break;
      case 'tool.completed':
        if (items().some((i) => i.id === `${prefix}${d.callId}` && i.kind === 'tool')) {
          replace(`${prefix}${d.callId}`, (i) => ({ ...(i as Extract<ChatItem, { kind: 'tool' }>), status: d.isError ? 'error' : 'done', output: d.output }));
        }
        update((l) => l.map((i) => (i.kind === 'approval' && i.callId === d.callId && i.status === 'pending' ? { ...i, status: d.output?.declined ? 'denied' : 'approved' } : i)));
        break;
      case 'ui':
        update((l) => [...l, { kind: 'ui', id: String(d.id), component: String(d.component), props: (d.props ?? {}) as Record<string, unknown> }]);
        break;
      case 'approval.required':
        update((l) => [...l, { kind: 'approval', id: `${prefix}ap-${d.callId}`, callId: String(d.callId), tool: String(d.tool), input: d.input, reason: d.reason ?? undefined, status: 'pending' }]);
        break;
      case 'progress':
        update((l) => [...l, { kind: 'progress', id: `${prefix}p${e.seq}`, text: String(d.message ?? '') }]);
        break;
      case 'run.completed':
        setStatus('idle');
        break;
      case 'run.failed':
        setStatus('idle');
        setError(String(d.error ?? 'The agent failed'));
        update((l) => [...l, { kind: 'error', id: `${prefix}e${e.seq}`, text: String(d.error ?? 'The agent failed') }]);
        break;
    }
  };

  const consume = async (res: Response): Promise<void> => {
    if (!res.ok) throw new Error(await errorText(res));
    const run = res.headers.get('x-amoxi-run-id');
    if (run) setRunId(run);
    const r = await readStream(res, apply, last);
    last = r.last;
    // The connection dropped mid-run: resume from the last event.
    if (!r.ended && runId()) last = await followRun(`${base}/runs/${runId()}/events`, { after: last, onEvent: apply, signal: controller?.signal });
  };

  const guard = async (work: () => Promise<void>): Promise<void> => {
    setError(undefined);
    try {
      await work();
    } catch (err) {
      if (controller?.signal.aborted) return;
      setStatus('idle');
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      update((l) => [...l, { kind: 'error', id: `e${Date.now()}`, text: message }]);
    }
  };

  if (options.resume && typeof window !== 'undefined') {
    const run = options.resume;
    setRunId(run.id);
    last = run.lastSeq ?? 0;
    if (run.status === 'awaiting_approval') setStatus('awaiting_approval');
    else if (run.status === 'queued' || run.status === 'running') {
      setStatus('working');
      controller = new AbortController();
      void guard(async () => {
        last = await followRun(`${base}/runs/${run.id}/events`, { after: last, onEvent: apply, signal: controller!.signal });
      });
    }
  }

  return {
    items,
    status,
    error,
    threadId,
    runId,
    send: (text) =>
      guard(async () => {
        const input = text.trim();
        if (!input || status() !== 'idle') return;
        controller = new AbortController();
        last = 0;
        streaming = undefined;
        prefix = `r${++runCount}-${Date.now().toString(36)}-`;
        update((l) => [...l, { kind: 'user', id: `u${Date.now()}`, text: input }]);
        setStatus('working');
        const res = await fetch(withBasePath(`${base}/runs`), {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
          body: JSON.stringify({ input, ...(threadId() ? { threadId: threadId() } : {}) }),
          signal: controller.signal,
        });
        await consume(res);
      }),
    decide: (callId, approved, note) =>
      guard(async () => {
        const id = runId();
        if (!id) return;
        update((l) => l.map((i) => (i.kind === 'approval' && i.callId === callId ? { ...i, status: approved ? 'approved' : 'denied' } : i)));
        setStatus('working');
        controller = new AbortController();
        const res = await fetch(withBasePath(`${base}/runs/${id}/approvals/${encodeURIComponent(callId)}?after=${last}`), {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
          body: JSON.stringify({ approved, ...(note ? { note } : {}) }),
          signal: controller.signal,
        });
        await consume(res);
      }),
    cancel: async () => {
      const id = runId();
      controller?.abort();
      setStatus('idle');
      if (id) await fetch(withBasePath(`${base}/runs/${id}/cancel`), { method: 'POST' }).catch(() => undefined);
    },
  };
}

/**
 * Shows a generative UI component (one of the app's @generative islands) inside `host`.
 * The island's bundle loads on first use. Returns false when the page doesn't know it.
 */
export function mountComponent(host: Element, component: string, props: Record<string, unknown>): boolean {
  if (!hasIsland(component)) return false;
  const el = document.createElement('amoxi-island');
  el.setAttribute('data-c', component);
  el.setAttribute('data-load', 'load');
  el.setAttribute('data-p', JSON.stringify(props));
  host.replaceChildren(el);
  // After the current render, so the host is attached to the document.
  queueMicrotask(activateIslands);
  return true;
}
