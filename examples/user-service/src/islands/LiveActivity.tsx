import { onMount, signal } from 'amoxi';
import type { ActivityEvent } from '../activity/activity-hub';

const VERB: Record<ActivityEvent['kind'], string> = { added: 'was added', removed: 'was removed', photo: 'has a new photo' };
const time = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** Live feed over WebSocket. Server-rendered with recent events; updates as people change anywhere. */
export default function LiveActivity(props: { title: string; events: ActivityEvent[] }) {
  const [events, setEvents] = signal<ActivityEvent[]>(props.events);
  const [connected, setConnected] = signal(false);

  onMount(() => {
    let socket: WebSocket | undefined;
    let retry = 500;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = (): void => {
      socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/activity`);
      socket.onopen = () => {
        setConnected(true);
        retry = 500;
      };
      socket.onmessage = (e) => {
        const msg = JSON.parse(e.data as string) as { type: string; events?: ActivityEvent[]; event?: ActivityEvent };
        if (msg.type === 'history' && msg.events) setEvents(msg.events);
        if (msg.type === 'event' && msg.event) setEvents((list) => [msg.event!, ...list].slice(0, 10));
      };
      socket.onclose = () => {
        setConnected(false);
        if (!stopped) timer = setTimeout(connect, (retry = Math.min(retry * 2, 10_000)));
      };
    };
    connect();
    return () => {
      stopped = true; // runs on client-side navigation away from the page
      clearTimeout(timer);
      socket?.close();
    };
  });

  return (
    <section class="activity" aria-live="polite">
      <h2>
        <span class={() => (connected() ? 'live on' : 'live')} aria-hidden="true" />
        {props.title}
      </h2>
      {() =>
        events().length === 0 ? (
          <p class="muted">Changes made by anyone appear here instantly.</p>
        ) : (
          <ul>
            {events().map((e) => (
              <li>
                <strong>{e.name}</strong> {VERB[e.kind]} <time datetime={e.at}>{time(e.at)}</time>
              </li>
            ))}
          </ul>
        )
      }
    </section>
  );
}
