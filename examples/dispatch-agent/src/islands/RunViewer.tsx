import { For, followRun, navigate, onMount, signal, type AgentEvent, type ChatItem } from 'amoxi';
import { renderItem } from '../ui/chat-view';
import { STATUS_LABELS } from '../ui/labels';
import { requestRefresh } from '../ui/live';
import { applyEvent, foldEvents, statusFrom, suggestFrom, type FoldState, type StreamEvent } from '../ui/run-events';

interface Props {
  runId: string;
  status: string;
  /** The run's stored events so far (the page renders them; the island follows the rest live). */
  events: StreamEvent[];
  /** Earlier messages of the same conversation. */
  prior: ChatItem[];
  followUpHint: string;
}

const LIVE = new Set(['queued', 'running']);
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

/**
 * One agent run, live: replays what it did, follows its event stream while it works (resuming
 * after dropped connections or a server restart), and lets the dispatcher approve, decline,
 * cancel or follow up. Works for runs started by people, telematics, schedules or partners.
 */
export default function RunViewer(props: Props) {
  const fold: FoldState = {};
  const [items, setItems] = signal<ChatItem[]>(foldEvents(props.events));
  const [status, setStatus] = signal(statusFrom(props.events, props.status));
  const [busy, setBusy] = signal(false);
  const [error, setError] = signal<string | undefined>(undefined);
  let last = props.events.length ? props.events[props.events.length - 1].seq : 0;
  let controller: AbortController | undefined;
  let input: HTMLTextAreaElement | undefined;
  const base = `/api/runs/${encodeURIComponent(props.runId)}`;

  const follow = async (): Promise<void> => {
    controller?.abort();
    controller = new AbortController();
    try {
      last = await followRun(`${base}/events`, {
        after: last,
        signal: controller.signal,
        onEvent: (e: AgentEvent) => {
          setItems(applyEvent(items(), e as StreamEvent, fold));
          if (e.seq > last) last = e.seq;
          const next = statusFrom([e as StreamEvent], status());
          if (next !== status()) setStatus(next);
          if (e.type === 'tool.completed' || e.type === 'run.completed') requestRefresh();
        },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  onMount(() => {
    if (!TERMINAL.has(status())) void follow();
    return () => controller?.abort();
  });

  const post = async (path: string, body?: unknown): Promise<Response> =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body ?? {}) });

  const decide = async (callId: string, approved: boolean): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      const res = await post(`/approvals/${encodeURIComponent(callId)}`, { approved });
      if (!res.ok) {
        setError(((await res.json()) as { error?: string }).error ?? 'The decision was not recorded');
        return;
      }
      setItems(items().map((i) => (i.kind === 'approval' && i.callId === callId ? { ...i, status: approved ? 'approved' : 'denied' } : i)));
      setStatus('queued');
      await follow();
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (): Promise<void> => {
    setBusy(true);
    try {
      await post('/cancel');
    } finally {
      setBusy(false);
    }
  };

  const followUp = async (text: string): Promise<void> => {
    if (!text.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      const res = await post('/follow-up', { input: text.trim() });
      const body = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !body.url) setError(body.error ?? 'Could not send the message');
      else navigate(body.url);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="run-viewer" aria-label="Run activity">
      <div class="run-viewer-bar">
        <span class={() => `pill pill-${status()}`} role="status" aria-live="polite">
          {() => STATUS_LABELS[status()] ?? status()}
        </span>
        {() => (LIVE.has(status()) ? <span class="live-note">Following live; this keeps running if you leave.</span> : null)}
        {() =>
          !TERMINAL.has(status()) ? (
            <button type="button" class="btn btn-small btn-ghost" disabled={busy} onClick={() => void cancel()}>
              Cancel run
            </button>
          ) : null
        }
      </div>
      {props.prior.length > 0 ? (
        <details class="prior">
          <summary>Earlier in this conversation ({props.prior.length} items)</summary>
          <div class="planner-log static">{props.prior.map((i) => renderItem(i))}</div>
        </details>
      ) : null}
      <div class="planner-log run-log">
        <For each={items} key={(i) => i.id}>
          {(item: ChatItem) => renderItem(item, (callId, yes) => void decide(callId, yes), busy)}
        </For>
        {() => (LIVE.has(status()) ? <p class="progress-line working">Working…</p> : null)}
      </div>
      {() => (error() ? <p class="msg-error" role="alert">{error()}</p> : null)}
      {() =>
        TERMINAL.has(status()) && suggestFrom(items()).length > 0 ? (
          <div class="chips run-chips" role="group" aria-label="Suggested next steps">
            {suggestFrom(items()).map((s) => (
              <button type="button" class="chip chip-next" disabled={busy} onClick={() => void followUp(s)}>
                {s}
              </button>
            ))}
          </div>
        ) : null
      }
      {() =>
        TERMINAL.has(status()) ? (
          <form
            class="composer"
            onSubmit={(e: Event) => {
              e.preventDefault();
              if (input) void followUp(input.value);
            }}
          >
            <label for="follow-up" class="visually-hidden">
              Follow up in this conversation
            </label>
            <textarea id="follow-up" rows={1} ref={(el: HTMLTextAreaElement) => (input = el)} placeholder={props.followUpHint} />
            <button type="submit" class="btn btn-primary" disabled={busy}>
              Send
            </button>
          </form>
        ) : null
      }
    </section>
  );
}
