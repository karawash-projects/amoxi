// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import type { ChatMessage, MessagePart, ToolCallPart, ToolResultPart, UiPart } from '../types';

/** Text of a message's text parts. */
export function textOf(message: ChatMessage): string {
  return message.content
    .filter((p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

export const toolCallsOf = (m: ChatMessage): ToolCallPart[] => m.content.filter((p): p is ToolCallPart => p.type === 'tool_call');
export const toolResultsOf = (m: ChatMessage): ToolResultPart[] => m.content.filter((p): p is ToolResultPart => p.type === 'tool_result');

/** Tool calls in `messages` that have no result yet, in order. */
export function unansweredCalls(messages: readonly ChatMessage[]): ToolCallPart[] {
  const answered = new Set(messages.flatMap((m) => toolResultsOf(m).map((r) => r.callId)));
  return messages.flatMap(toolCallsOf).filter((c) => !answered.has(c.id));
}

/**
 * Gives every unanswered tool call an error result, so the transcript is valid for every
 * provider (Anthropic and OpenAI both reject a tool call without a result). Used when a run is
 * cancelled or fails part-way.
 */
export function sealMessages(messages: readonly ChatMessage[], reason: string): ChatMessage[] {
  const open = unansweredCalls(messages);
  if (open.length === 0) return [...messages];
  return [
    ...messages,
    { role: 'tool', content: open.map((c): ToolResultPart => ({ type: 'tool_result', callId: c.id, name: c.name, output: { error: reason }, isError: true })) },
  ];
}

/**
 * The most recent history that fits `limit` messages without splitting a tool call from its
 * result: the window starts at a user message. Generative UI parts are kept (adapters skip them).
 */
export function recentHistory(messages: readonly ChatMessage[], limit: number): ChatMessage[] {
  if (messages.length <= limit) return [...messages];
  let start = messages.length - limit;
  while (start < messages.length && messages[start].role !== 'user') start++;
  return messages.slice(start);
}

/** What a chat UI shows for one transcript entry. Shared by server pages and the browser client. */
export type ChatItem =
  | { readonly kind: 'user'; readonly id: string; readonly text: string }
  | { readonly kind: 'assistant'; readonly id: string; readonly text: string }
  | { readonly kind: 'tool'; readonly id: string; readonly tool: string; readonly input: unknown; readonly status: 'running' | 'done' | 'error'; readonly output?: unknown }
  | { readonly kind: 'ui'; readonly id: string; readonly component: string; readonly props: Record<string, unknown> }
  | { readonly kind: 'approval'; readonly id: string; readonly callId: string; readonly tool: string; readonly input: unknown; readonly reason?: string; readonly status: 'pending' | 'approved' | 'denied' }
  | { readonly kind: 'progress'; readonly id: string; readonly text: string }
  | { readonly kind: 'error'; readonly id: string; readonly text: string };

const isUiTool = (name: string): boolean => name.startsWith('show_');

/**
 * Converts a stored transcript into chat items, so a page can render a conversation (and hand
 * it to a chat island as props) after a reload. Generative components come back as `ui` items.
 */
export function toChatItems(messages: readonly ChatMessage[]): ChatItem[] {
  const items: ChatItem[] = [];
  const toolItems = new Map<string, number>();
  messages.forEach((m, mi) => {
    m.content.forEach((part, pi) => {
      const id = `${m.id ?? mi}:${pi}`;
      if (part.type === 'text' && part.text.trim()) {
        items.push(m.role === 'user' ? { kind: 'user', id, text: part.text } : { kind: 'assistant', id, text: part.text });
      } else if (part.type === 'tool_call' && !isUiTool(part.name)) {
        toolItems.set(part.id, items.length);
        items.push({ kind: 'tool', id: part.id, tool: part.name, input: part.input, status: 'running' });
      } else if (part.type === 'tool_result') {
        const at = toolItems.get(part.callId);
        if (at !== undefined) {
          const prev = items[at] as Extract<ChatItem, { kind: 'tool' }>;
          items[at] = { ...prev, status: part.isError ? 'error' : 'done', output: part.output };
        }
      } else if (part.type === 'ui') {
        const ui = part as UiPart;
        items.push({ kind: 'ui', id: ui.id, component: ui.component, props: ui.props });
      }
    });
  });
  return items;
}
