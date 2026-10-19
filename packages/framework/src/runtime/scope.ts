// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import { AsyncLocalStorage } from 'node:async_hooks';
import type { RequestContext } from './types';

/** Per-request state for @RequestScope beans, carried through async calls by AsyncLocalStorage. */
export interface RequestScopeState {
  readonly ctx: RequestContext;
  readonly beans: Map<number, unknown>;
  readonly destroy: Array<() => unknown>;
}

export const requestScope = new AsyncLocalStorage<RequestScopeState>();

/** Runs `fn` inside a request scope and disposes request beans (@PreDestroy) afterwards. */
export async function withRequestScope<T>(ctx: RequestContext, fn: () => Promise<T>, onError: (err: unknown) => void): Promise<T> {
  const state: RequestScopeState = { ctx, beans: new Map(), destroy: [] };
  try {
    return await requestScope.run(state, fn);
  } finally {
    for (let i = state.destroy.length - 1; i >= 0; i--) {
      try {
        await state.destroy[i]();
      } catch (err) {
        onError(err);
      }
    }
  }
}
