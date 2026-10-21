// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

/**
 * AI decorators. Like every Amoxi decorator they are markers only: `amoxi build` reads them
 * from the TypeScript AST and generates the tool schemas, validators and wiring. Nothing is
 * registered or reflected at runtime.
 */

import type { ClassMarker, MethodMarker } from '../runtime/decorators';

const marker = ((): void => undefined) as unknown as ClassMarker & MethodMarker;

export interface AgentOptions {
  /** URL-safe name used in /agents/<name>; defaults to the class name in kebab-case. */
  name?: string;
  /** What the agent does. Read by people, other agents (A2A) and MCP clients. Defaults to the class JSDoc. */
  description?: string;
  /** Classes whose @Tool methods the agent may call. Its own @Tool methods are always included. */
  tools?: readonly (abstract new (...args: never[]) => unknown)[];
  /** Generative UI: @generative islands the agent may show, or true for all of them. */
  ui?: readonly string[] | true;
  /** Knowledge bases it can search (adds a `search_knowledge` tool). */
  knowledge?: readonly string[];
  /**
   * Long-term memory: `true` recalls 5 relevant memories into every run and lets the model save
   * new ones; or `{ recall: 3, remember: false }`.
   */
  memory?: boolean | { recall?: number; remember?: boolean };
  /** Example requests, shown in UIs and agent cards. */
  examples?: readonly string[];
  /** Stop after this many model turns (default: ai.runs.max-turns, 12). */
  maxTurns?: number;
  /** Model id for this agent, overriding the configured one. */
  model?: string;
}

/**
 * Declares an AI agent: a singleton whose `instructions()` form the system prompt and whose
 * tools come from its own @Tool methods and the `tools` classes. Amoxi exposes it at
 * /agents/<name> with streaming, durable runs and human approvals.
 */
export function Agent(_options?: AgentOptions): ClassMarker {
  return marker;
}

export interface ToolOptions {
  /** How the model decides when to call it. Defaults to the method's JSDoc. */
  description?: string;
  /** Tool name the model sees; defaults to the method name in snake_case. */
  name?: string;
  /** A person must approve every call before it runs (human in the loop). */
  approval?: boolean;
  /** No side effects: safe to retry after a crash, marked read-only for MCP clients. */
  readOnly?: boolean;
  /**
   * Safe to run again with the same input: its side effects are guarded by ctx.step() or an
   * idempotency key. A run resumed after a crash re-runs it (completed steps return their recorded
   * results) instead of asking the model what to do.
   */
  idempotent?: boolean;
  /** Offer it to external agents over MCP (default true; tools that need approval never are). */
  expose?: boolean;
}

/**
 * Makes a bean method callable by agents. Its parameter types become the JSON Schema the model
 * sees and the validator its arguments must pass, both generated at build time:
 *
 *   @Tool('Looks up the balance of one of the customer\'s accounts')
 *   balance(input: { accountId: string }, ctx: ToolContext): Promise<Balance> { ... }
 */
export function Tool(_descriptionOrOptions?: string | ToolOptions): MethodMarker {
  return marker;
}
