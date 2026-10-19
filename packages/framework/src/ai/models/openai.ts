// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto';
import { ModelError, type ChatMessage, type ChatModel, type ChatRequest, type FinishReason, type ModelEvent } from '../types';
import { fetchWithRetry, parseToolArguments, readWithIdleTimeout, trimBaseUrl, type FetchFn } from './http';
import { parseSse } from './sse';

export interface OpenAiChatModelOptions {
  /** Sent as `authorization: Bearer <apiKey>`. Optional for local servers (Ollama, vLLM). */
  readonly apiKey?: string;
  readonly model: string;
  /** Default https://api.openai.com/v1 (`/chat/completions` is appended). */
  readonly baseUrl?: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
  /** Extra headers, e.g. `{ 'api-key': ... }` for Azure OpenAI. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Time allowed to receive response headers, per attempt. Default 120 000 ms. */
  readonly timeoutMs?: number;
  /** Fails the stream when no data arrives for this long. Default: timeoutMs. */
  readonly idleTimeoutMs?: number;
  /** Default 2. */
  readonly maxRetries?: number;
  readonly fetch?: FetchFn;
}

type OpenAiMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> }
  | { role: 'tool'; tool_call_id: string; content: string };

const MAX_TOOL_JSON = 4 * 1024 * 1024;
const MAX_TOOL_CALLS = 128;

function stringifyOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output === undefined) return '';
  try {
    return JSON.stringify(output) ?? '';
  } catch {
    return String(output);
  }
}

/** Maps provider-neutral messages to Chat Completions messages (role 'system' for compatibility). */
export function toOpenAiMessages(system: string | undefined, messages: readonly ChatMessage[]): OpenAiMessage[] {
  const out: OpenAiMessage[] = [];
  if (system && system.trim() !== '') out.push({ role: 'system', content: system });
  for (const msg of messages) {
    const text = msg.content
      .filter((p) => p.type === 'text')
      .map((p) => (p as { text: string }).text)
      .filter((t) => t.trim() !== '')
      .join('\n\n');
    if (msg.role === 'assistant') {
      const calls = msg.content.flatMap((p) =>
        p.type === 'tool_call' ? [{ id: p.id, type: 'function' as const, function: { name: p.name, arguments: JSON.stringify(p.input ?? {}) } }] : [],
      );
      if (!text && calls.length === 0) continue;
      out.push({ role: 'assistant', content: text || null, ...(calls.length > 0 ? { tool_calls: calls } : {}) });
      continue;
    }
    for (const p of msg.content) {
      if (p.type === 'tool_result') out.push({ role: 'tool', tool_call_id: p.callId, content: stringifyOutput(p.output) });
    }
    if (msg.role === 'user' && text) out.push({ role: 'user', content: text });
  }
  return out;
}

function mapFinish(reason: string | undefined): FinishReason {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'content_filter':
      return 'refusal';
    default:
      return 'other';
  }
}

interface PendingCall {
  id: string;
  name: string;
  args: string;
}

/**
 * OpenAI Chat Completions adapter (Adapter pattern): works with OpenAI, Azure OpenAI, Ollama,
 * vLLM, Groq, Mistral and any OpenAI-compatible server. Raw fetch + SSE, no SDK.
 * Tool-call fragments are assembled by index and emitted once the choice finishes.
 */
export class OpenAiChatModel implements ChatModel {
  readonly provider = 'openai';
  readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchFn;
  private readonly officialApi: boolean;

  constructor(private readonly options: OpenAiChatModelOptions) {
    this.model = options.model;
    this.baseUrl = trimBaseUrl(options.baseUrl ?? 'https://api.openai.com/v1');
    this.fetchFn = options.fetch ?? ((url, init) => fetch(url, init));
    let host = '';
    try {
      host = new URL(this.baseUrl).hostname;
    } catch {
      throw new Error(`OpenAiChatModel: invalid baseUrl '${this.baseUrl}' (expected e.g. https://api.openai.com/v1)`);
    }
    this.officialApi = host === 'api.openai.com';
  }

  /** The JSON body sent for a request (exposed for diagnostics and tests). */
  buildBody(request: ChatRequest): Record<string, unknown> {
    const tools = request.tools ?? [];
    const maxTokens = request.maxTokens ?? this.options.maxTokens;
    const temperature = request.temperature ?? this.options.temperature;
    const body: Record<string, unknown> = {
      model: request.model ?? this.model,
      messages: toOpenAiMessages(request.system, request.messages),
    };
    if (tools.length > 0) {
      body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
      if (request.toolChoice) body.tool_choice = request.toolChoice;
    }
    body.stream = true;
    body.stream_options = { include_usage: true };
    if (maxTokens !== undefined) body[this.officialApi ? 'max_completion_tokens' : 'max_tokens'] = maxTokens;
    if (temperature !== undefined) body.temperature = temperature;
    return body;
  }

  async *stream(request: ChatRequest): AsyncGenerator<ModelEvent> {
    const timeoutMs = this.options.timeoutMs ?? 120_000;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
      ...(this.options.headers ?? {}),
    };
    const res = await fetchWithRetry(
      this.fetchFn,
      `${this.baseUrl}/chat/completions`,
      { method: 'POST', headers, body: JSON.stringify(this.buildBody(request)) },
      {
        maxRetries: this.options.maxRetries ?? 2,
        timeoutMs,
        signal: request.signal,
        label: 'OpenAI-compatible API',
        secrets: [this.options.apiKey, ...Object.values(this.options.headers ?? {})],
      },
    );
    if (!res.body) throw new ModelError('OpenAI-compatible API returned an empty response body', res.status, true);

    const calls = new Map<number, PendingCall>();
    let lastIndex = -1;
    let finishReason: string | undefined;
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    let done = false;
    let refusal = false;
    let emittedCalls = 0;

    const flushCalls = function* (): Generator<ModelEvent> {
      for (const index of [...calls.keys()].sort((a, b) => a - b)) {
        const c = calls.get(index)!;
        emittedCalls++;
        // Some OpenAI-compatible servers omit tool-call ids. A fallback like "call_0" would repeat every
        // turn, and a repeated id looks already answered, so later calls would never run: make it unique.
        yield { type: 'tool_call', id: c.id || `call_${randomUUID().replace(/-/g, '').slice(0, 20)}_${index}`, name: c.name, input: parseToolArguments(c.args) };
      }
      calls.clear();
    };

    for await (const sse of parseSse(readWithIdleTimeout(res.body, this.options.idleTimeoutMs ?? timeoutMs, 'OpenAI-compatible API'))) {
      const data = sse.data.trim();
      if (data === '[DONE]') {
        done = true;
        break;
      }
      let chunk: Record<string, any>;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      if (chunk === null || typeof chunk !== 'object') continue;
      if (chunk.error) {
        const e = chunk.error;
        const msg = typeof e === 'string' ? e : String(e.message ?? 'unknown error');
        throw new ModelError(`OpenAI-compatible API stream error: ${msg}`);
      }
      const u = chunk.usage;
      if (u && typeof u === 'object') {
        usage = {
          inputTokens: Number(u.prompt_tokens ?? u.input_tokens ?? 0) || 0,
          outputTokens: Number(u.completion_tokens ?? u.output_tokens ?? 0) || 0,
        };
      }
      const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
      if (!choice) continue;
      const delta = choice.delta ?? {};
      if (typeof delta.content === 'string' && delta.content) yield { type: 'text', delta: delta.content };
      if (typeof delta.refusal === 'string' && delta.refusal) {
        refusal = true;
        yield { type: 'text', delta: delta.refusal };
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          if (!tc || typeof tc !== 'object') continue;
          let index: number;
          if (typeof tc.index === 'number') index = tc.index;
          else if (tc.id) index = [...calls.entries()].find(([, c]) => c.id === tc.id)?.[0] ?? lastIndex + 1;
          else index = Math.max(lastIndex, 0);
          lastIndex = Math.max(lastIndex, index);
          let call = calls.get(index);
          if (!call) {
            if (calls.size >= MAX_TOOL_CALLS) throw new ModelError(`OpenAI-compatible API: more than ${MAX_TOOL_CALLS} tool calls in one turn`);
            call = { id: '', name: '', args: '' };
            calls.set(index, call);
          }
          if (typeof tc.id === 'string' && tc.id) call.id = tc.id;
          const fn = tc.function ?? {};
          // The name arrives in the first fragment; some servers repeat it in later ones.
          if (typeof fn.name === 'string' && fn.name && !call.name) call.name = fn.name;
          if (typeof fn.arguments === 'string') call.args += fn.arguments;
          else if (fn.arguments && typeof fn.arguments === 'object') call.args = JSON.stringify(fn.arguments);
          if (call.args.length > MAX_TOOL_JSON) throw new ModelError(`OpenAI-compatible API: tool arguments exceed ${MAX_TOOL_JSON} characters`);
        }
      }
      if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
        finishReason = choice.finish_reason;
        yield* flushCalls();
      }
    }
    if (!done && finishReason === undefined) {
      throw new ModelError('OpenAI-compatible API stream ended before the response was complete', undefined, true);
    }
    yield* flushCalls();
    if (usage) yield { type: 'usage', ...usage };
    let reason = refusal ? 'refusal' : mapFinish(finishReason);
    // Some compatible servers report 'stop' even though they called tools.
    if (emittedCalls > 0 && (reason === 'stop' || reason === 'other')) reason = 'tool_calls';
    yield { type: 'finish', reason: reason as FinishReason };
  }
}
