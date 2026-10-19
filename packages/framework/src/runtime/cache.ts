// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

export interface CachedResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | Buffer | undefined;
  /** CSP nonce baked into a cached page; replaced with a fresh one on every hit. */
  readonly nonce?: string;
  readonly storedAt: number;
  readonly ttlMs: number;
  readonly swrMs: number;
}

/** In-memory LRU response cache used by @Cached routes. Each process (cluster worker) has its own. */
export class ResponseCache {
  private readonly entries = new Map<string, CachedResponse>();
  private readonly refreshing = new Set<string>();

  constructor(private readonly maxEntries = 1000) {}

  get(key: string): CachedResponse | undefined {
    const e = this.entries.get(key);
    if (e) {
      this.entries.delete(key);
      this.entries.set(key, e);
    }
    return e;
  }

  set(key: string, entry: CachedResponse): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
    if (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
  }

  /** Drop every cached variant (any query string) of a path. */
  revalidate(path: string): number {
    let n = 0;
    for (const key of [...this.entries.keys()]) {
      // Markdown and JSON copies of a page are cached as "markdown|<origin>|/path" and "json|<origin>|/path".
      const keyPath = key.startsWith('/') ? key : key.slice(key.indexOf('|/') + 1);
      if (keyPath === path || keyPath.startsWith(`${path}?`)) {
        this.entries.delete(key);
        n++;
      }
    }
    return n;
  }

  clear(): void {
    this.entries.clear();
  }

  /** @internal Ensures only one background refresh per key. */
  beginRefresh(key: string): boolean {
    if (this.refreshing.has(key)) return false;
    this.refreshing.add(key);
    return true;
  }

  /** @internal */
  endRefresh(key: string): void {
    this.refreshing.delete(key);
  }
}

export const responseCache = new ResponseCache();

/**
 * On-demand revalidation (like Next.js `revalidatePath`): the next request for `path`
 * renders fresh content. Affects the current process only.
 */
export function revalidatePath(path: string): void {
  responseCache.revalidate(path);
}
