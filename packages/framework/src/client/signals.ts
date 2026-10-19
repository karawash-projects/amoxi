/*! amoxi | Copyright 2026 Ahmad Karawash | Apache-2.0 */
/**
 * Fine-grained reactivity shared by the server and browser runtimes.
 * On the server, components run once and effects are effectively no-ops;
 * in the browser, signals update exactly the DOM nodes that read them.
 *
 * Two pointers are tracked separately: the *listener* (who subscribes to signals read now)
 * and the *owner* (who disposes effects created now). `untrack` clears only the listener,
 * so effects created inside components are still cleaned up with their island.
 */

interface Computation {
  run(): void;
  readonly deps: Set<Set<Computation>>;
  readonly children: Computation[];
  readonly cleanups: Array<() => void>;
  disposed: boolean;
}

let listener: Computation | null = null;
let owner: Computation | null = null;

export type Getter<T> = () => T;
export type Setter<T> = (next: T | ((prev: T) => T)) => void;

export function signal<T>(initial: T): [Getter<T>, Setter<T>] {
  let value = initial;
  const subscribers = new Set<Computation>();
  const get: Getter<T> = () => {
    if (listener && !listener.disposed) {
      subscribers.add(listener);
      listener.deps.add(subscribers);
    }
    return value;
  };
  const set: Setter<T> = (next) => {
    const v = typeof next === 'function' ? (next as (prev: T) => T)(value) : next;
    if (Object.is(v, value)) return;
    value = v;
    for (const c of [...subscribers]) if (!c.disposed) c.run();
  };
  return [get, set];
}

function dispose(c: Computation, self: boolean): void {
  for (const d of c.deps) d.delete(c);
  c.deps.clear();
  for (const child of c.children.splice(0)) dispose(child, true);
  for (const fn of c.cleanups.splice(0)) fn();
  if (self) c.disposed = true;
}

function computation(run: () => void): Computation {
  return { run, deps: new Set(), children: [], cleanups: [], disposed: false };
}

/** Runs `fn` now and again whenever a signal it read changes. Nested effects are disposed on re-run. */
export function effect(fn: () => void): () => void {
  const parent = owner;
  const c = computation(() => {
    dispose(c, false);
    const prevListener = listener;
    const prevOwner = owner;
    listener = owner = c;
    try {
      fn();
    } finally {
      listener = prevListener;
      owner = prevOwner;
    }
  });
  parent?.children.push(c);
  c.run();
  return () => dispose(c, true);
}

export function computed<T>(fn: () => T): Getter<T> {
  const [get, set] = signal<T>(undefined as T);
  effect(() => set(fn()));
  return get;
}

/** Reads signals without subscribing. */
export function untrack<T>(fn: () => T): T {
  const prev = listener;
  listener = null;
  try {
    return fn();
  } finally {
    listener = prev;
  }
}

/** Runs `fn` in a new ownership scope; calling `dispose` stops every effect created inside it. */
export function createRoot<T>(fn: (dispose: () => void) => T): T {
  const root = computation(() => undefined);
  const prevListener = listener;
  const prevOwner = owner;
  listener = null;
  owner = root;
  try {
    return fn(() => dispose(root, true));
  } finally {
    listener = prevListener;
    owner = prevOwner;
  }
}

/** @internal The current ownership scope, to run code in it later (onMount). */
export function getOwner(): unknown {
  return owner;
}

/** @internal Runs `fn` with `scope` as the owner, so its onCleanup and effects belong there. */
export function runWithOwner<T>(scope: unknown, fn: () => T): T {
  const prevOwner = owner;
  const prevListener = listener;
  owner = scope as Computation | null;
  listener = null;
  try {
    return fn();
  } finally {
    owner = prevOwner;
    listener = prevListener;
  }
}

/** Registers cleanup for the current scope (effect re-run or island teardown). */
export function onCleanup(fn: () => void): void {
  owner?.cleanups.push(fn);
}
