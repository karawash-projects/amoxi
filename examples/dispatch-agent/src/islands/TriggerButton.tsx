import { navigate, signal } from 'amoxi';

/** A button that POSTs to a console endpoint (simulate an event, run a schedule) and opens the run it started. */
export default function TriggerButton(props: { label: string; endpoint: string; body?: Record<string, string>; variant?: 'alarm' | 'ghost' }) {
  const [busy, setBusy] = signal(false);
  const [note, setNote] = signal<string | undefined>(undefined);
  const run = async (): Promise<void> => {
    setBusy(true);
    setNote(undefined);
    try {
      const res = await fetch(props.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(props.body ?? {}) });
      const out = (await res.json()) as { url?: string; started?: Array<{ runId: string }>; error?: string };
      if (!res.ok) setNote(out.error ?? 'That did not work');
      else if (out.url) navigate(out.url);
      else if (out.started?.length) navigate(`/runs/${out.started[0].runId}`);
      else setNote('Already running');
    } catch {
      setNote('The server did not answer');
    } finally {
      setBusy(false);
    }
  };
  return (
    <span class="trigger">
      <button type="button" class={`btn btn-small btn-${props.variant ?? 'ghost'}`} disabled={busy} onClick={() => void run()}>
        {props.label}
      </button>
      {() => (note() ? <span class="trigger-note" role="status">{note()}</span> : null)}
    </span>
  );
}
