/*! amoxi | Copyright 2026 Ahmad Karawash | Apache-2.0 */
import { mount, trackTeardown, type Component } from './dom';

type ReactMount = { __amoxiMount: (el: Element, props: object) => () => void };
import { installRouter } from './router';

interface PageData {
  islands?: Record<string, string>;
  navigation?: boolean;
}

function readData(): PageData {
  try {
    return JSON.parse(document.getElementById('amoxi-data')?.textContent || '{}') as PageData;
  } catch {
    return {};
  }
}

/** Loads each island's bundle and activates it, eagerly, when idle, or when scrolled into view. */
export function hydrate(manifest: Record<string, string>): void {
  for (const el of document.querySelectorAll<HTMLElement>('amoxi-island')) {
    const url = manifest[el.dataset.c ?? ''];
    if (!url || el.dataset.hydrated) continue;
    el.dataset.hydrated = 'pending';
    const start = (): void => {
      import(/* @vite-ignore */ url).then(
        (mod: { default: Component | ReactMount }) => {
          if (!el.isConnected) return; // navigated away before it loaded
          const props = JSON.parse(el.dataset.p || '{}') as object;
          const island = mod.default;
          // React islands hydrate the server HTML with React; Amoxi islands mount with signals.
          if (typeof island === 'object' && island && '__amoxiMount' in island) trackTeardown(island.__amoxiMount(el, props));
          else mount(el, island as Component, props);
          el.dataset.hydrated = 'true';
        },
        (err) => console.error(`[amoxi] failed to load island ${el.dataset.c}`, err),
      );
    };
    const when = el.dataset.load;
    // <amoxi-island> is display:contents (no box), so observe its first rendered child.
    const target = el.firstElementChild;
    if (when === 'visible' && target && 'IntersectionObserver' in window) {
      const io = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          start();
        }
      });
      io.observe(target);
    } else if (when === 'idle' && 'requestIdleCallback' in window) {
      requestIdleCallback(start);
    } else {
      start();
    }
  }
}

/** Activates islands added to the page after it loaded (e.g. generative UI shown by an agent). */
export function activateIslands(): void {
  hydrate(readData().islands ?? {});
}

/** Whether the page can load this island (it's in the page's island manifest). */
export function hasIsland(name: string): boolean {
  return !!readData().islands?.[name];
}

/** Entry point injected into every page: activates islands and enables client-side navigation. */
export function start(): void {
  const data = readData();
  hydrate(data.islands ?? {});
  document.addEventListener('amoxi:swap', () => hydrate(readData().islands ?? {}));
  if (data.navigation !== false) installRouter(() => hydrate(readData().islands ?? {}));
}
