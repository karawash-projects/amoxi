import { onMount, signal, type Getter } from 'amoxi';
import type { OpsSnapshot } from '../ops/ops-views';

/** Fired by the chat when the agents change something, so every panel refreshes at once. */
export const REFRESH_EVENT = 'demo-freight:refresh';

export function requestRefresh(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(REFRESH_EVENT));
}

interface Hub {
  listeners: Set<(s: OpsSnapshot) => void>;
  timer?: ReturnType<typeof setInterval>;
  refresh: () => void;
}

declare global {
  interface Window {
    __demoFreightSnapshot?: Hub;
  }
}

/**
 * The console's live operations snapshot. Several islands read it; one poller per page
 * (shared through `window`) fetches /api/ops/snapshot every few seconds and on demand.
 */
export function liveSnapshot(initial: OpsSnapshot): Getter<OpsSnapshot> {
  const [snapshot, setSnapshot] = signal(initial);
  onMount(() => {
    const hub = (window.__demoFreightSnapshot ??= createHub());
    hub.listeners.add(setSnapshot);
    if (!hub.timer) {
      hub.timer = setInterval(hub.refresh, 5000);
      window.addEventListener(REFRESH_EVENT, hub.refresh);
    }
    return () => {
      hub.listeners.delete(setSnapshot);
      if (hub.listeners.size === 0 && hub.timer) {
        clearInterval(hub.timer);
        hub.timer = undefined;
        window.removeEventListener(REFRESH_EVENT, hub.refresh);
      }
    };
  });
  return snapshot;
}

function createHub(): Hub {
  let inFlight = false;
  const hub: Hub = {
    listeners: new Set(),
    refresh: () => {
      if (inFlight || document.hidden) return;
      inFlight = true;
      fetch('/api/ops/snapshot', { headers: { accept: 'application/json' } })
        .then((r) => (r.ok ? (r.json() as Promise<OpsSnapshot>) : undefined))
        .then((s) => {
          if (s) for (const l of hub.listeners) l(s);
        })
        .catch(() => undefined)
        .finally(() => {
          inFlight = false;
        });
    },
  };
  return hub;
}
