// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import { ModelError, type ChatModel, type ChatRequest, type ModelEvent, type Usage } from '../types';
import { sleep } from './http';

/** One model turn played by ScriptedChatModel. */
export interface ScriptedTurn {
  /** Streamed in a few chunks. */
  readonly text?: string;
  /** Emitted after the text; ids default to `call_<turn>_<n>`. */
  readonly toolCalls?: ReadonlyArray<{ readonly name: string; readonly input: unknown; readonly id?: string }>;
  /** Default { inputTokens: 0, outputTokens: 0 }. */
  readonly usage?: Usage;
  /** Throws ModelError(error) instead of answering. */
  readonly error?: string;
  /** Waits before answering (abortable through the request signal). */
  readonly delayMs?: number;
}

export type ScriptStep = ScriptedTurn | ((request: ChatRequest) => ScriptedTurn);

/** Splits text into roughly `count` chunks on word boundaries. */
function chunks(text: string, count = 3): string[] {
  const words = text.match(/\s*\S+\s*/g) ?? [text];
  if (words.length <= count) return words;
  const size = Math.ceil(words.length / count);
  const out: string[] = [];
  for (let i = 0; i < words.length; i += size) out.push(words.slice(i, i + size).join(''));
  return out;
}

/**
 * A deterministic model for tests: plays a script of turns in order and records every request,
 * so tests can assert what the agent loop sent (messages, tools, system prompt).
 */
export class ScriptedChatModel implements ChatModel {
  readonly provider = 'scripted';
  readonly model = 'scripted';
  /** Every request received, in order. */
  readonly requests: ChatRequest[] = [];
  private next = 0;

  constructor(private readonly script: readonly ScriptStep[]) {}

  /** Turns not yet played. */
  get remaining(): number {
    return this.script.length - this.next;
  }

  async *stream(request: ChatRequest): AsyncGenerator<ModelEvent> {
    this.requests.push(request);
    const turnNo = this.next;
    if (turnNo >= this.script.length) {
      throw new Error(
        `ScriptedChatModel: the script has ${this.script.length} turn(s) but the model was called ${this.requests.length} times; add another ScriptedTurn to the script.`,
      );
    }
    this.next++;
    const step = this.script[turnNo];
    const turn = typeof step === 'function' ? step(request) : step;
    if (turn.delayMs && turn.delayMs > 0) await sleep(turn.delayMs, request.signal);
    if (request.signal?.aborted) throw request.signal.reason;
    if (turn.error !== undefined) throw new ModelError(turn.error);
    if (turn.text) for (const delta of chunks(turn.text)) yield { type: 'text', delta };
    const calls = turn.toolCalls ?? [];
    for (let i = 0; i < calls.length; i++) {
      yield { type: 'tool_call', id: calls[i].id ?? `call_${turnNo + 1}_${i + 1}`, name: calls[i].name, input: calls[i].input };
    }
    yield { type: 'usage', inputTokens: turn.usage?.inputTokens ?? 0, outputTokens: turn.usage?.outputTokens ?? 0 };
    yield { type: 'finish', reason: calls.length > 0 ? 'tool_calls' : 'stop' };
  }
}
