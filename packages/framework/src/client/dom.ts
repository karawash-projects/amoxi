/*! amoxi | Copyright 2026 Ahmad Karawash | Apache-2.0 */
/**
 * Browser JSX runtime: JSX evaluates directly to real DOM nodes (no virtual DOM, no diffing).
 * Any function passed as a child or attribute is treated as reactive and re-evaluated by an
 * effect when the signals it reads change.
 */
import { createRoot, effect, getOwner, onCleanup, runWithOwner, untrack } from './signals';
import { isUnsafeUrl, URL_ATTRIBUTES } from './url-safety';

type Props = Record<string, unknown> & { children?: unknown };
export type Component<P = any> = (props: P) => unknown;

const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_TAGS = new Set([
  'svg', 'path', 'circle', 'g', 'line', 'rect', 'text', 'tspan', 'defs', 'polyline', 'polygon',
  'ellipse', 'use', 'symbol', 'clipPath', 'mask', 'linearGradient', 'radialGradient', 'stop',
  // Islands never render the document <title>, so title/desc are SVG accessibility elements here.
  'title', 'desc', 'marker', 'pattern', 'image', 'textPath', 'foreignObject',
]);
const PROPERTIES = new Set(['value', 'checked', 'selected', 'indeterminate']);

let mountQueue: Array<() => void> = [];
const mounted = new Set<() => void>();

/**
 * Runs after the island is attached to the document (never on the server). If `fn` returns a
 * function, it runs when the island is torn down (e.g. on client-side navigation).
 */
export function onMount(fn: () => void | (() => void)): void {
  const scope = getOwner();
  mountQueue.push(() =>
    runWithOwner(scope, () => {
      const cleanup = fn();
      if (typeof cleanup === 'function') onCleanup(cleanup);
    }),
  );
}

/**
 * Renders with a fresh onMount queue. The returned `attached` runs the callbacks once the nodes
 * are in the document; while the surrounding island is still being built, they are handed to its
 * queue instead, so they run when the island mounts.
 */
function collectMounts<T>(render: () => T): { value: T; attached: (connected: boolean) => void } {
  const previous = mountQueue;
  mountQueue = [];
  let queue: Array<() => void>;
  let value: T;
  try {
    value = render();
  } finally {
    queue = mountQueue;
    mountQueue = previous;
  }
  return {
    value,
    attached: (connected) => {
      if (queue.length === 0) return;
      if (connected) for (const fn of queue) fn();
      else mountQueue.push(...queue);
    },
  };
}

export { onCleanup };

export function Fragment(props: { children?: unknown }): unknown {
  return props.children;
}

/** Inside the browser an island is just its component (islands don't nest across bundles). */
export function Island<P>(props: { of: Component<P>; load?: 'load' | 'visible' | 'idle' } & P): unknown {
  const { of, load: _load, ...rest } = props as { of: Component<P>; load?: string } & Record<string, unknown>;
  return of(rest as P);
}

const ATTRIBUTE_NAME = /^[A-Za-z_:][A-Za-z0-9_:.-]*$/;

function setAttr(el: Element, name: string, value: unknown): void {
  // Skip names that aren't valid attributes (from spread, untrusted props) and string event handlers.
  if (!ATTRIBUTE_NAME.test(name) || /^on/i.test(name)) return;
  if (name === 'className') name = 'class';
  else if (name === 'htmlFor') name = 'for';
  // A script URL in href or src runs code when clicked or loaded: never set it.
  if (URL_ATTRIBUTES.has(name.toLowerCase()) && typeof value === 'string' && isUnsafeUrl(value, name.toLowerCase() !== 'href')) {
    el.removeAttribute(name);
    return;
  }
  if (PROPERTIES.has(name)) {
    (el as unknown as Record<string, unknown>)[name] = value ?? '';
    return;
  }
  if (name === 'style' && value && typeof value === 'object') {
    Object.assign((el as HTMLElement).style, value);
    return;
  }
  if (value == null || value === false) el.removeAttribute(name);
  else el.setAttribute(name, value === true ? '' : String(value));
}

function insert(parent: Node, child: unknown, before: Node | null = null): void {
  if (child == null || child === true || child === false) return;
  if (Array.isArray(child)) {
    for (const c of child) insert(parent, c, before);
  } else if (child instanceof Node) {
    parent.insertBefore(child, before);
  } else if (typeof child === 'function') {
    // Reactive region delimited by two empty text nodes.
    const start = document.createTextNode('');
    const end = document.createTextNode('');
    parent.insertBefore(start, before);
    parent.insertBefore(end, before);
    effect(() => {
      const value = (child as () => unknown)();
      const region = end.parentNode!;
      // Fast path: a single text node whose content just changed.
      const only = start.nextSibling;
      if ((typeof value === 'string' || typeof value === 'number') && only !== end && only?.nextSibling === end && only.nodeType === 3) {
        only.textContent = String(value);
        return;
      }
      while (start.nextSibling && start.nextSibling !== end) region.removeChild(start.nextSibling);
      const { attached } = collectMounts(() => insert(region, value, end));
      attached(end.isConnected);
    });
  } else {
    parent.insertBefore(document.createTextNode(String(child)), before);
  }
}

export function jsx(type: string | Component, props: Props, key?: unknown): unknown {
  // The automatic JSX runtime passes `key` separately; components like <For key={...}> need it.
  if (typeof type === 'function') return untrack(() => type(key === undefined ? props : { ...props, key }));
  const el = SVG_TAGS.has(type) ? document.createElementNS(SVG_NS, type) : document.createElement(type);
  for (const key in props) {
    const value = props[key];
    if (key === 'children' || key === 'key') continue;
    if (key === 'ref') {
      if (typeof value === 'function') (value as (e: Element) => void)(el);
    } else if (key.length > 2 && key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (typeof value === 'function') {
      effect(() => setAttr(el, key, (value as () => unknown)()));
    } else {
      setAttr(el, key, value);
    }
  }
  insert(el, props.children);
  return el;
}

/**
 * Keyed list: renders `children(item)` once per key and keeps the DOM node while the item
 * stays the same object, so updating one entry (e.g. a streaming chat message) doesn't
 * rebuild, and lose the state of, the others. Changed items are re-rendered individually.
 *
 *   <For each={items} key={(i) => i.id}>{(item) => <li>{item.text}</li>}</For>
 */
export function For<T>(props: { each: () => readonly T[]; key: (item: T, index: number) => string | number; children: ((item: T) => unknown) | Array<(item: T) => unknown> }): unknown {
  const render = (Array.isArray(props.children) ? props.children[0] : props.children) as (item: T) => unknown;
  const start = document.createTextNode('');
  const end = document.createTextNode('');
  const fragment = document.createDocumentFragment();
  fragment.append(start, end);
  let current = new Map<string | number, { item: T; nodes: Node[]; dispose: () => void }>();
  const pendingMounts: Array<(connected: boolean) => void> = [];
  effect(() => {
    const list = props.each();
    const next = new Map<string | number, { item: T; nodes: Node[]; dispose: () => void }>();
    list.forEach((item, i) => {
      const k = props.key(item, i);
      const prev = current.get(k);
      if (prev && prev.item === item && !next.has(k)) {
        next.set(k, prev);
        current.delete(k);
        return;
      }
      const holder = document.createDocumentFragment();
      const rendered = collectMounts(() =>
        createRoot((d) => {
          insert(holder, untrack(() => render(item)));
          return d;
        }),
      );
      pendingMounts.push(rendered.attached);
      next.set(next.has(k) ? `${k}#${i}` : k, { item, nodes: [...holder.childNodes], dispose: rendered.value });
    });
    for (const old of current.values()) {
      old.dispose();
      for (const n of old.nodes) n.parentNode?.removeChild(n);
    }
    const parent = end.parentNode ?? fragment;
    for (const entry of next.values()) for (const n of entry.nodes) parent.insertBefore(n, end);
    current = next;
    for (const attached of pendingMounts.splice(0)) attached(end.isConnected);
  });
  return [...fragment.childNodes];
}

/**
 * Renders a component into a container, replacing its server-rendered markup.
 * Returns a function that disposes every effect and cleanup the island registered.
 */
export function mount(container: Element, component: Component, props: object): () => void {
  const previous = mountQueue;
  mountQueue = [];
  const disposeRoot = createRoot((dispose) => {
    const node = untrack(() => component(props));
    container.replaceChildren();
    insert(container, node);
    const queue = mountQueue;
    mountQueue = previous;
    for (const fn of queue) fn();
    return dispose;
  });
  const teardown = (): void => {
    mounted.delete(teardown);
    disposeRoot();
  };
  mounted.add(teardown);
  return teardown;
}

/** Registers teardown for an island mounted by another renderer (React islands). */
export function trackTeardown(fn: () => void): void {
  const teardown = (): void => {
    mounted.delete(teardown);
    fn();
  };
  mounted.add(teardown);
}

/** Tears down every mounted island (called before a client-side navigation swaps the page). */
export function disposeAll(): void {
  for (const teardown of [...mounted]) teardown();
}
