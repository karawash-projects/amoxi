// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

/**
 * Server-side counterparts of the browser agent client (src/client/agent.ts). Islands also
 * render on the server, so these return the initial state without any network activity; the
 * browser versions take over when the island activates.
 */
import { signal } from '../client/signals';
import type { AgentChat, AgentChatOptions, AgentEvent, ChatItem, ChatStatus } from '../client/agent';

export type { AgentChat, AgentChatOptions, AgentEvent, ChatItem, ChatStatus };

export function agentChat(_agent: string, options: AgentChatOptions = {}): AgentChat {
  const [items] = signal<ChatItem[]>(options.initial ?? []);
  const [status] = signal<ChatStatus>('idle');
  const [error] = signal<string | undefined>(undefined);
  const [threadId] = signal<string | undefined>(options.threadId);
  const [runId] = signal<string | undefined>(undefined);
  const browserOnly = (): Promise<void> => Promise.reject(new Error('agentChat() actions run in the browser (inside an island event handler)'));
  return { items, status, error, threadId, runId, send: browserOnly, decide: browserOnly, cancel: browserOnly };
}

export function followRun(_eventsUrl: string, _options: { after?: number; signal?: AbortSignal; onEvent: (e: AgentEvent) => void; retries?: number }): Promise<number> {
  return Promise.reject(new Error('followRun() runs in the browser'));
}

/** On the server, generative components are mounted by the browser after the island activates. */
export function mountComponent(_host: unknown, _component: string, _props: Record<string, unknown>): boolean {
  return false;
}
