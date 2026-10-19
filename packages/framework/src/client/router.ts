/*! amoxi | Copyright 2026 Ahmad Karawash | Apache-2.0 */
/**
 * Client-side navigation for server-rendered pages: same-origin link clicks fetch the next
 * page's HTML and swap <body> without a full reload (scripts, styles and islands' shared
 * runtime stay loaded). Links are prefetched on hover, focus or touch, or when visible
 * (data-prefetch="visible"). Back/forward and scroll positions behave like normal navigation.
 *
 * Opt out per link with `data-reload`, `target`, `download` or `rel="external"`.
 */
import { disposeAll } from './dom';

interface Fetched {
  html: string;
  url: string;
}

export interface NavigateOptions {
  /** Replace the current history entry instead of pushing a new one. */
  replace?: boolean;
  /** Keep the current scroll position (used for live reload). */
  keepScroll?: boolean;
}

const PREFETCH_TTL = 10_000;
const prefetched = new Map<string, { at: number; page: Promise<Fetched> }>();
let afterSwap: () => void = () => undefined;
let navToken = 0;
let currentKey = '';
let visibleObserver: IntersectionObserver | undefined;

const keyOf = (url: URL): string => url.pathname + url.search;

function eligible(a: Element | null, e?: MouseEvent): URL | null {
  if (!(a instanceof HTMLAnchorElement) || !a.href) return null;
  if (e && (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)) return null;
  if ((a.target && a.target !== '_self') || a.hasAttribute('download') || a.hasAttribute('data-reload')) return null;
  if (a.relList.contains('external') || a.closest('[data-reload]')) return null;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin || (url.protocol !== 'http:' && url.protocol !== 'https:')) return null;
  if (url.pathname.startsWith('/_amoxi/') || url.pathname.startsWith('/amoxi/')) return null;
  if (/\.[a-z0-9]{1,8}$/i.test(url.pathname) && !url.pathname.endsWith('.html')) return null; // files
  if (keyOf(url) === currentKey && url.hash) return null; // in-page anchor: let the browser scroll
  return url;
}

async function fetchPage(url: URL): Promise<Fetched> {
  const res = await fetch(url.href, {
    headers: { accept: 'text/html', 'x-amoxi-navigation': '1' },
    credentials: 'same-origin',
  });
  if (!(res.headers.get('content-type') ?? '').includes('text/html')) throw new Error('Not an HTML page');
  return { html: await res.text(), url: res.url || url.href };
}

export function prefetch(href: string): void {
  const url = new URL(href, location.href);
  const key = keyOf(url);
  const hit = prefetched.get(key);
  if (hit && Date.now() - hit.at < PREFETCH_TTL) return;
  const page = fetchPage(url);
  page.catch(() => prefetched.delete(key));
  prefetched.set(key, { at: Date.now(), page });
}

function take(url: URL): Promise<Fetched> {
  const key = keyOf(url);
  const hit = prefetched.get(key);
  prefetched.delete(key);
  return hit && Date.now() - hit.at < PREFETCH_TTL ? hit.page : fetchPage(url);
}

/** Moves streamed <Await> results into place in a fetched document (inline scripts don't run there). */
function applyStreamed(doc: Document): void {
  for (const t of doc.querySelectorAll<HTMLTemplateElement>('template[data-amoxi-for]')) {
    doc.getElementById(t.dataset.amoxiFor!)?.replaceWith(t.content);
    t.remove();
  }
}

async function mergeStyles(doc: Document): Promise<() => void> {
  const have = new Set([...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].map((l) => l.href));
  const want = [...doc.querySelectorAll<HTMLLinkElement>('head link[rel="stylesheet"]')].map((l) => new URL(l.getAttribute('href')!, location.href).href);
  const loads = want
    .filter((href) => !have.has(href))
    .map(
      (href) =>
        new Promise<void>((resolve) => {
          const link = document.createElement('link');
          link.rel = 'stylesheet';
          link.href = href;
          link.onload = link.onerror = () => resolve();
          document.head.appendChild(link);
          setTimeout(resolve, 3000);
        }),
    );
  await Promise.all(loads);
  const keep = new Set(want);
  // Remove stylesheets the new page doesn't use, after the swap.
  return () => {
    for (const l of document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) if (!keep.has(l.href)) l.remove();
  };
}

function focusAndAnnounce(title: string): void {
  const main = document.querySelector<HTMLElement>('main, [role="main"]');
  if (main) {
    if (!main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1');
    main.focus({ preventScroll: true });
  }
  let live = document.getElementById('amoxi-announcer');
  if (!live) {
    live = document.createElement('div');
    live.id = 'amoxi-announcer';
    live.setAttribute('aria-live', 'assertive');
    live.setAttribute('aria-atomic', 'true');
    live.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap';
    document.body.appendChild(live);
  }
  live.textContent = title;
}

async function go(url: URL, mode: 'push' | 'replace' | 'pop', scrollTo: number | 'keep' | undefined): Promise<void> {
  const token = ++navToken;
  const busy = setTimeout(() => document.documentElement.classList.add('amoxi-loading'), 120);
  let page: Fetched;
  try {
    page = await take(url);
  } catch {
    location.assign(url.href); // fall back to a normal navigation
    return;
  } finally {
    clearTimeout(busy);
    document.documentElement.classList.remove('amoxi-loading');
  }
  if (token !== navToken) return;

  const doc = new DOMParser().parseFromString(page.html, 'text/html');
  applyStreamed(doc);
  const cleanupStyles = await mergeStyles(doc);
  if (token !== navToken) return;

  const finalUrl = new URL(page.url);
  finalUrl.hash = url.hash;
  const y = scrollTo === 'keep' ? window.scrollY : (scrollTo ?? 0);
  if (mode !== 'pop') history.replaceState({ ...(history.state ?? {}), amoxiScroll: window.scrollY }, '');
  if (mode === 'push') history.pushState({ amoxiScroll: 0 }, '', finalUrl.href);
  else if (mode === 'replace') history.replaceState({ amoxiScroll: y }, '', finalUrl.href);
  currentKey = keyOf(finalUrl);

  const swap = (): void => {
    disposeAll();
    document.title = doc.title;
    // Keep <html lang/dir> in sync (pages can change language); other attributes such as the theme stay.
    for (const attr of ['lang', 'dir']) {
      const value = doc.documentElement.getAttribute(attr);
      if (value) document.documentElement.setAttribute(attr, value);
      else document.documentElement.removeAttribute(attr);
    }
    document.body.replaceWith(document.adoptNode(doc.body));
    cleanupStyles();
    afterSwap();
    const target = finalUrl.hash && scrollTo !== 'keep' ? document.getElementById(decodeURIComponent(finalUrl.hash.slice(1))) : null;
    if (target) target.scrollIntoView();
    else window.scrollTo(0, y);
    if (scrollTo !== 'keep') focusAndAnnounce(doc.title);
  };
  const vt = (document as Document & { startViewTransition?: (cb: () => void) => { updateCallbackDone: Promise<void> } }).startViewTransition;
  if (vt && scrollTo !== 'keep' && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    await vt.call(document, swap).updateCallbackDone.catch(() => undefined);
  } else {
    swap();
  }
}

/**
 * On a site exported with `amoxi export --base-path /docs`, turns "/x" into "/docs/x", matching
 * the exported links. Elsewhere it returns the path unchanged.
 */
export function withBasePath(path: string): string {
  const base = document.querySelector<HTMLMetaElement>('meta[name="amoxi-base-path"]')?.content ?? '';
  if (!base || !path.startsWith('/') || path.startsWith('//') || path === base || path.startsWith(`${base}/`)) return path;
  return base + path;
}

/** Navigate to a URL without a full page load (falls back to one for other origins or errors). */
export function navigate(href: string, options: NavigateOptions = {}): Promise<void> {
  const url = new URL(withBasePath(href), location.href);
  if (url.origin !== location.origin) {
    location.assign(url.href);
    return Promise.resolve();
  }
  prefetched.clear(); // programmatic navigation usually follows a change: never show stale data
  return go(url, options.replace ? 'replace' : 'push', options.keepScroll ? 'keep' : undefined);
}

function observeVisibleLinks(): void {
  if (!('IntersectionObserver' in window)) return;
  visibleObserver?.disconnect();
  visibleObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const url = eligible(e.target);
      if (url) prefetch(url.href);
      visibleObserver!.unobserve(e.target);
    }
  });
  for (const a of document.querySelectorAll('a[data-prefetch="visible"]')) visibleObserver.observe(a);
}

let installed = false;

export function installRouter(onSwap: () => void): void {
  if (installed) return;
  installed = true;
  afterSwap = () => {
    onSwap();
    observeVisibleLinks();
  };
  currentKey = keyOf(new URL(location.href));
  history.scrollRestoration = 'manual';
  history.replaceState({ ...(history.state ?? {}), amoxiScroll: window.scrollY }, '');

  document.addEventListener('click', (e) => {
    const a = (e.target as Element | null)?.closest?.('a') ?? null;
    const url = eligible(a, e);
    if (!url) return;
    e.preventDefault();
    void go(url, 'push', undefined);
  });

  window.addEventListener('popstate', (e) => {
    const url = new URL(location.href);
    if (keyOf(url) === currentKey) return; // hash-only change
    void go(url, 'pop', (e.state as { amoxiScroll?: number } | null)?.amoxiScroll ?? 0);
  });

  let hoverTimer: ReturnType<typeof setTimeout> | undefined;
  document.addEventListener(
    'pointerover',
    (e) => {
      const url = eligible((e.target as Element | null)?.closest?.('a') ?? null);
      if (!url) return;
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => prefetch(url.href), 65);
    },
    { passive: true },
  );
  document.addEventListener('pointerout', () => clearTimeout(hoverTimer), { passive: true });
  const immediate = (e: Event): void => {
    const url = eligible((e.target as Element | null)?.closest?.('a') ?? null);
    if (url) prefetch(url.href);
  };
  document.addEventListener('touchstart', immediate, { passive: true });
  document.addEventListener('focusin', immediate);
  observeVisibleLinks();

  (window as unknown as { __amoxi: unknown }).__amoxi = { navigate, prefetch };
}
