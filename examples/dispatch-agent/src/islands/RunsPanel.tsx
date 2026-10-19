import { For, navigate, onMount, signal } from 'amoxi';
import type { RunCard } from '../runs/run-board';
import { ago, SOURCE_LABELS, STATUS_LABELS } from '../ui/labels';
import { REFRESH_EVENT, requestRefresh } from '../ui/live';

interface Props {
  runs: RunCard[];
  now: number;
  /** Show the buttons that trigger an event-driven or scheduled run. */
  triggers: boolean;
}

const ACTIVE = new Set(['queued', 'running', 'awaiting_approval']);

function SourceIcon(props: { source: string }) {
  switch (props.source) {
    case 'telematics':
      return (
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M10 11v6M6.5 7.5a5 5 0 0 1 7 0M4 5a8.5 8.5 0 0 1 12 0" />
          <circle cx="10" cy="10" r="1.3" />
        </svg>
      );
    case 'schedule':
      return (
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <circle cx="10" cy="10" r="7" />
          <path d="M10 6v4l2.5 2" />
        </svg>
      );
    case 'partner':
      return (
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M3 10h5M12 10h5M8 7l4 3-4 3" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <circle cx="10" cy="7" r="3" />
          <path d="M4 17a6 6 0 0 1 12 0" />
        </svg>
      );
  }
}

/**
 * Agent runs working in the background: planning started by a dispatcher, exception handling
 * started by telematics, the morning schedule, and partner agents' requests. Polls the server
 * (faster while something is running) and links each run to its live view.
 */
export default function RunsPanel(props: Props) {
  const [runs, setRuns] = signal<RunCard[]>(props.runs);
  const [now, setNow] = signal(props.now);
  const [busy, setBusy] = signal<string | undefined>(undefined);
  const [message, setMessage] = signal<string | undefined>(undefined);
  let lastVersion = -1;

  const load = async (): Promise<void> => {
    try {
      const res = await fetch('/api/runs', { headers: { accept: 'application/json' } });
      if (!res.ok) return;
      const body = (await res.json()) as { runs: RunCard[]; version: number };
      setRuns(body.runs);
      setNow(Date.now());
      if (lastVersion !== -1 && body.version !== lastVersion) requestRefresh();
      lastVersion = body.version;
    } catch {
      /* offline for a moment: keep the last list */
    }
  };

  onMount(() => {
    setNow(Date.now());
    let timer: ReturnType<typeof setTimeout>;
    const tick = async (): Promise<void> => {
      if (!document.hidden) await load();
      timer = setTimeout(tick, runs().some((r) => ACTIVE.has(r.status)) ? 1200 : 4000);
    };
    timer = setTimeout(tick, 600);
    const onRefresh = (): void => void load();
    window.addEventListener(REFRESH_EVENT, onRefresh);
    return () => {
      clearTimeout(timer);
      window.removeEventListener(REFRESH_EVENT, onRefresh);
    };
  });

  const trigger = async (key: string, url: string, body?: unknown): Promise<void> => {
    setBusy(key);
    setMessage(undefined);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      const out = (await res.json()) as { url?: string; started?: unknown[]; error?: string };
      if (!res.ok) setMessage(out.error ?? 'That did not work');
      else if (out.started) setMessage(out.started.length ? `Started ${out.started.length} planning runs` : 'Planning runs are already in progress');
      else setMessage('Telematics event received: the exception desk is on it');
      await load();
    } catch {
      setMessage('The server did not answer');
    } finally {
      setBusy(undefined);
    }
  };

  const active = (): number => runs().filter((r) => ACTIVE.has(r.status)).length;

  return (
    <section class="panel runs" aria-labelledby="runs-title">
      <header class="panel-head">
        <h2 id="runs-title">Background runs</h2>
        <span class="count" aria-live="polite">
          {() => (active() > 0 ? `${active()} working` : 'All quiet')}
        </span>
      </header>
      {props.triggers ? (
        <div class="triggers">
          <button type="button" class="btn btn-small btn-alarm" disabled={() => busy() !== undefined} onClick={() => void trigger('incident', '/api/demo/telematics', { vehicleId: 'TRK-214', type: 'breakdown' })}>
            Simulate TRK-214 breakdown
          </button>
          <button type="button" class="btn btn-small btn-ghost" disabled={() => busy() !== undefined} onClick={() => void trigger('schedule', '/api/schedule/morning-planning')}>
            Run morning planning
          </button>
          {() => (message() ? <p class="trigger-note" role="status">{message()}</p> : null)}
        </div>
      ) : null}
      {() =>
        runs().length === 0 ? (
          <p class="empty">No runs yet. Ask the planner for tomorrow's routes, or simulate a breakdown to see an event-driven run start on its own.</p>
        ) : null
      }
      <ol class="run-list">
        <For each={runs} key={(r) => `${r.id}:${r.status}:${r.currentStep}:${r.pendingApprovals}`}>
          {(r: RunCard) => (
            <li class={`run run-${r.status}`}>
              <div class="run-top">
                <span class={`agent-tag agent-${r.agent}`}>{r.agentLabel}</span>
                <span class={`origin origin-${r.startedBy}`} title={SOURCE_LABELS[r.startedBy]}>
                  <SourceIcon source={r.startedBy} />
                  {r.startedByName}
                </span>
                <time datetime={r.createdAt}>{() => ago(r.createdAt, now())}</time>
              </div>
              <a class="run-title" href={`/runs/${r.id}`}>
                {r.title}
              </a>
              <p class="run-step">
                <span class="run-dot" aria-hidden="true" />
                {r.currentStep}
              </p>
              <div class="run-foot">
                <span class={`pill pill-${r.status}`}>{STATUS_LABELS[r.status] ?? r.status}</span>
                <span class="run-count">{r.steps === 1 ? '1 step' : `${r.steps} steps`}</span>
                {r.pendingApprovals > 0 ? (
                  <button type="button" class="btn btn-small btn-approve" onClick={() => navigate(`/runs/${r.id}`)}>
                    Review approval
                  </button>
                ) : null}
              </div>
            </li>
          )}
        </For>
      </ol>
    </section>
  );
}
