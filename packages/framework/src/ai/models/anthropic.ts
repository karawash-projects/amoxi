// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import { ModelError, type ChatMessage, type ChatModel, type ChatRequest, type FinishReason, type ModelEvent } from '../types';
import { fetchWithRetry, parseToolArguments, readWithIdleTimeout, trimBaseUrl, type FetchFn } from './http';
import { parseSse } from './sse';

export interface AnthropicChatModelOptions {
  readonly apiKey: string;
  /** Default model id, e.g. 'claude-sonnet-5-5'. */
  readonly model: string;
  /** Default https://api.anthropic.com (`/v1/messages` is appended). */
  readonly baseUrl?: string;
  /** Default 4096. */
  readonly maxTokens?: number;
  readonly temperature?: number;
  /** Time allowed to receive response headers, per attempt. Default 120 000 ms. */
  readonly timeoutMs?: number;
  /** Fails the stream when no data arrives for this long. Default: timeoutMs. */
  readonly idleTimeoutMs?: number;
  /** Retries of 408/409/429/5xx/529 and network errors. Default 2. */
  readonly maxRetries?: number;
  /** Injected fetch (tests, proxies). Default: global fetch. */
  readonly fetch?: FetchFn;
}

type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicBlock[];
}

/** Placeholder sent when a conversation does not start with a user message (the API requires one). */
const LEADING_USER_TEXT = '(continued)';
/** Upper bound on streamed tool arguments per call. */
const MAX_TOOL_JSON = 4 * 1024 * 1024;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function stringifyOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output === undefined) return '';
  try {
    return JSON.stringify(output) ?? '';
  } catch {
    return String(output);
  }
}

/**
 * Maps provider-neutral messages to the Messages API: tool results become user messages,
 * 'ui' parts are dropped, consecutive same-role messages are merged (tool results first, as
 * the API requires), empty text blocks are never sent, and the first message is a user message.
 */
export function toAnthropicMessages(messages: readonly ChatMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  for (const msg of messages) {
    const role: 'user' | 'assistant' = msg.role === 'assistant' ? 'assistant' : 'user';
    const blocks: AnthropicBlock[] = [];
    for (const part of msg.content) {
      if (part.type === 'text') {
        if (part.text.trim() !== '') blocks.push({ type: 'text', text: part.text });
      } else if (part.type === 'tool_call') {
        if (role === 'assistant') blocks.push({ type: 'tool_use', id: part.id, name: part.name, input: isPlainObject(part.input) ? part.input : {} });
      } else if (part.type === 'tool_result') {
        if (role === 'user') {
          blocks.push({
            type: 'tool_result',
            tool_use_id: part.callId,
            content: stringifyOutput(part.output),
            ...(part.isError ? { is_error: true } : {}),
          });
        }
      }
      // 'ui' parts are for people, never for the model.
    }
    if (blocks.length === 0) continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === role) prev.content.push(...blocks);
    else out.push({ role, content: blocks });
  }
  for (const m of out) {
    if (m.role === 'user') {
      // Tool results must come before any other content of the user turn.
      m.content = [...m.content.filter((b) => b.type === 'tool_result'), ...m.content.filter((b) => b.type !== 'tool_result')];
    }
  }
  if (out.length === 0 || out[0].role !== 'user') out.unshift({ role: 'user', content: [{ type: 'text', text: LEADING_USER_TEXT }] });
  return out;
}

function mapStopReason(reason: string | undefined): FinishReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'tool_use':
      return 'tool_calls';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    default:
      return 'other';
  }
}

interface OpenBlock {
  readonly kind: 'text' | 'tool' | 'other';
  readonly id?: string;
  readonly name?: string;
  json: string;
  readonly initialInput?: unknown;
}

/**
 * Anthropic Messages API adapter (Adapter pattern): raw fetch + SSE, no SDK.
 * Text deltas are emitted as they arrive; each tool call is emitted once its block closes.
 * Thinking, server-tool and unknown blocks and events are ignored.
 */
export class AnthropicChatModel implements ChatModel {
  readonly provider = 'anthropic';
  readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchFn;

  constructor(private readonly options: AnthropicChatModelOptions) {
    if (!options.apiKey) throw new Error('AnthropicChatModel needs an apiKey: set ANTHROPIC_API_KEY (or ai.anthropic.api-key).');
    this.model = options.model;
    this.baseUrl = trimBaseUrl(options.baseUrl ?? 'https://api.anthropic.com');
    this.fetchFn = options.fetch ?? ((url, init) => fetch(url, init));
  }

  /** The JSON body sent for a request (exposed for diagnostics and tests). */
  buildBody(request: ChatRequest): Record<string, unknown> {
    const tools = request.tools ?? [];
    const temperature = request.temperature ?? this.options.temperature;
    const body: Record<string, unknown> = {
      model: request.model ?? this.model,
      max_tokens: request.maxTokens ?? this.options.maxTokens ?? 4096,
    };
    if (request.system && request.system.trim() !== '') body.system = request.system;
    body.messages = toAnthropicMessages(request.messages);
    if (tools.length > 0) {
      body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
      if (request.toolChoice) body.tool_choice = { type: request.toolChoice === 'required' ? 'any' : request.toolChoice };
    }
    body.stream = true;
    if (temperature !== undefined) body.temperature = temperature;
    return body;
  }

  async *stream(request: ChatRequest): AsyncGenerator<ModelEvent> {
    const timeoutMs = this.options.timeoutMs ?? 120_000;
    const res = await fetchWithRetry(
      this.fetchFn,
      `${this.baseUrl}/v1/messages`,
      {
        method: 'POST',
        headers: {
          'x-api-key': this.options.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
          accept: 'text/event-stream',
        },
        body: JSON.stringify(this.buildBody(request)),
      },
      { maxRetries: this.options.maxRetries ?? 2, timeoutMs, signal: request.signal, label: 'Anthropic API', secrets: [this.options.apiKey] },
    );
    if (!res.body) throw new ModelError('Anthropic API returned an empty response body', res.status, true);

    const blocks = new Map<number, OpenBlock>();
    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason: string | undefined;
    let stopped = false;

    for await (const sse of parseSse(readWithIdleTimeout(res.body, this.options.idleTimeoutMs ?? timeoutMs, 'Anthropic API'))) {
      let ev: Record<string, any>;
      try {
        ev = JSON.parse(sse.data);
      } catch {
        continue; // not JSON: ignore, like any unknown event
      }
      if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) continue;
      const type = typeof ev.type === 'string' ? ev.type : sse.event;
      switch (type) {
        case 'message_start': {
          const u = ev.message?.usage;
          if (u) inputTokens = countInput(u);
          if (typeof u?.output_tokens === 'number') outputTokens = u.output_tokens;
          break;
        }
        case 'content_block_start': {
          const cb = ev.content_block ?? {};
          const index = Number(ev.index);
          if (cb.type === 'text') {
            blocks.set(index, { kind: 'text', json: '' });
            if (typeof cb.text === 'string' && cb.text) yield { type: 'text', delta: cb.text };
          } else if (cb.type === 'tool_use') {
            blocks.set(index, { kind: 'tool', id: String(cb.id), name: String(cb.name), json: '', initialInput: cb.input });
          } else {
            blocks.set(index, { kind: 'other', json: '' });
          }
          break;
        }
        case 'content_block_delta': {
          const block = blocks.get(Number(ev.index));
          const delta = ev.delta ?? {};
          if (!block) break;
          if (block.kind === 'text' && delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
            yield { type: 'text', delta: delta.text };
          } else if (block.kind === 'tool' && delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
            block.json += delta.partial_json;
            if (block.json.length > MAX_TOOL_JSON) throw new ModelError(`Anthropic API: arguments of tool '${block.name}' exceed ${MAX_TOOL_JSON} characters`);
          }
          break;
        }
        case 'content_block_stop': {
          const index = Number(ev.index);
          const block = blocks.get(index);
          blocks.delete(index);
          if (block?.kind === 'tool') {
            const input =
              block.json === '' && isPlainObject(block.initialInput) && Object.keys(block.initialInput).length > 0
                ? block.initialInput
                : parseToolArguments(block.json);
            yield { type: 'tool_call', id: block.id!, name: block.name!, input };
          }
          break;
        }
        case 'message_delta': {
          if (typeof ev.delta?.stop_reason === 'string') stopReason = ev.delta.stop_reason;
          const u = ev.usage;
          if (u) {
            if (typeof u.output_tokens === 'number') outputTokens = u.output_tokens;
            if (typeof u.input_tokens === 'number') inputTokens = countInput(u);
          }
          break;
        }
        case 'message_stop':
          stopped = true;
          break;
        case 'error': {
          const errType = String(ev.error?.type ?? 'error');
          const message = String(ev.error?.message ?? 'unknown error');
          throw new ModelError(`Anthropic API stream error (${errType}): ${message}`, undefined, errType === 'overloaded_error' || errType === 'api_error');
        }
        default:
          break; // ping and unknown events
      }
      if (stopped) break;
    }
    if (!stopped && stopReason === undefined) {
      throw new ModelError('Anthropic API stream ended before the message was complete', undefined, true);
    }
    yield { type: 'usage', inputTokens, outputTokens };
    yield { type: 'finish', reason: mapStopReason(stopReason) };
  }
}

function countInput(u: Record<string, unknown>): number {
  const n = (k: string) => (typeof u[k] === 'number' ? (u[k] as number) : 0);
  return n('input_tokens') + n('cache_creation_input_tokens') + n('cache_read_input_tokens');
}
