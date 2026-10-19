// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto';
import type { ApplicationContext } from '../../runtime/container';
import { HttpError } from '../../runtime/http';
import { INVALID_JSON_KEY } from '../models/http';
import type { Logger } from '../../runtime/logger';
import { ToolError, type AgentDefinition, type JsonSchema, type ToolContext, type ToolDefinition, type ToolSpec, type UiComponentDefinition, type UiPart } from '../types';
import type { KnowledgeBases } from './services';

/**
 * What a failed tool reports to the model and the person. Messages of ToolError, HttpError and
 * invalid-input errors are shown; in production any other error is reported as an internal error
 * with a reference id, and logged with its details under that id.
 */
export function toolFailure(err: unknown, tool: string, production: boolean, logger: Logger, context: Record<string, unknown> = {}): Record<string, unknown> {
  if (err instanceof HttpError) return { error: err.message, status: err.status };
  if (err instanceof ToolError || !production) {
    if (!(err instanceof ToolError)) logger.warn('Tool failed', { tool, ...context, err });
    return { error: err instanceof Error ? err.message : String(err) };
  }
  const reference = randomUUID().slice(0, 8);
  logger.error('Tool failed', { tool, reference, ...context, err });
  return { error: `The ${tool.replace(/_/g, ' ')} tool failed with an internal error (reference ${reference}).` };
}

/** A tool argument object that failed validation; reported to the model so it can correct itself. */
export class ToolInputError extends Error {
  override name = 'ToolInputError';
  constructor(
    message: string,
    readonly details: ReadonlyArray<{ path: string; message: string }> = [],
  ) {
    super(message);
  }
}

/**
 * Something an agent can call (Strategy). Bean tools come from @Tool methods; the runtime adds
 * generative-UI, memory and knowledge tools.
 */
export interface ExecutableTool {
  readonly spec: ToolSpec;
  readonly approval: boolean;
  readonly readOnly: boolean;
  /** Safe to re-run after an interruption (see @Tool({ idempotent })). */
  readonly idempotent?: boolean;
  /** Validates and cleans the arguments; throws ToolInputError. */
  validate(input: unknown): unknown;
  run(input: unknown, ctx: ToolRuntimeContext): Promise<unknown>;
}

/** ToolContext plus the hook for UI parts (the agent loop collects them). */
export interface ToolRuntimeContext extends ToolContext {
  readonly emitUi: (part: UiPart) => void;
}

function generated(validate: (x: unknown) => unknown, input: unknown): unknown {
  if (input && typeof input === 'object' && INVALID_JSON_KEY in input) {
    throw new ToolInputError('The arguments were not valid JSON', [{ path: '', message: 'send the arguments as a JSON object' }]);
  }
  try {
    return validate(input);
  } catch (err) {
    if (err instanceof HttpError && err.status === 400) {
      const body = err.body as { details?: Array<{ path: string; message: string }> } | undefined;
      throw new ToolInputError('Invalid tool arguments', body?.details ?? []);
    }
    throw err;
  }
}

/** A @Tool method of a bean. */
export class BeanTool implements ExecutableTool {
  readonly spec: ToolSpec;
  constructor(
    readonly definition: ToolDefinition,
    private readonly context: ApplicationContext,
  ) {
    this.spec = { name: definition.name, description: definition.description, inputSchema: definition.inputSchema };
  }
  get approval(): boolean {
    return this.definition.approval;
  }
  get readOnly(): boolean {
    return this.definition.readOnly;
  }
  get idempotent(): boolean {
    return !!this.definition.idempotent;
  }
  validate(input: unknown): unknown {
    return generated(this.definition.validate, input);
  }
  async run(input: unknown, ctx: ToolRuntimeContext): Promise<unknown> {
    return this.definition.invoke(this.context.get(this.definition.beanId), input, ctx);
  }
}

/** `show_<component>`: lets the model show a @generative island with validated props. */
export class ShowComponentTool implements ExecutableTool {
  readonly spec: ToolSpec;
  readonly approval = false;
  readonly readOnly = true;
  constructor(private readonly component: UiComponentDefinition) {
    this.spec = { name: ShowComponentTool.toolName(component.name), description: `Show the person: ${component.description}`, inputSchema: component.propsSchema };
  }
  static toolName(component: string): string {
    return `show_${component.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()}`.slice(0, 64);
  }
  validate(input: unknown): unknown {
    return generated(this.component.validate, input);
  }
  async run(input: unknown, ctx: ToolRuntimeContext): Promise<unknown> {
    ctx.emitUi({ type: 'ui', id: randomUUID(), component: this.component.name, props: input as Record<string, unknown> });
    return { shown: this.component.name };
  }
}

const object = (properties: Record<string, JsonSchema>, required: string[]): JsonSchema => ({ type: 'object', properties, required, additionalProperties: false });

/** `remember`: the model saves a fact to the subject's long-term memory. */
export class RememberTool implements ExecutableTool {
  readonly spec: ToolSpec = {
    name: 'remember',
    description: 'Save a lasting fact or preference about the person for future conversations (not one-off details).',
    inputSchema: object({ fact: { type: 'string', minLength: 3, maxLength: 1000, description: 'The fact, as a short sentence' } }, ['fact']),
  };
  readonly approval = false;
  readonly readOnly = false;
  validate(input: unknown): unknown {
    const fact = (input as { fact?: unknown } | null)?.fact;
    if (typeof fact !== 'string' || fact.trim().length < 3 || fact.length > 1000) throw new ToolInputError('Invalid tool arguments', [{ path: 'fact', message: 'must be a string of 3 to 1000 characters' }]);
    return { fact: fact.trim() };
  }
  async run(input: unknown, ctx: ToolRuntimeContext): Promise<unknown> {
    const item = await ctx.memory.remember((input as { fact: string }).fact, { agent: ctx.agent });
    return { saved: true, id: item.id };
  }
}

/** `search_knowledge`: semantic search over the agent's knowledge bases (RAG). */
export class SearchKnowledgeTool implements ExecutableTool {
  readonly spec: ToolSpec;
  readonly approval = false;
  readonly readOnly = true;
  constructor(
    private readonly names: readonly string[],
    private readonly knowledge: KnowledgeBases,
  ) {
    this.spec = {
      name: 'search_knowledge',
      description: `Search the ${names.join(', ')} knowledge base${names.length > 1 ? 's' : ''} for passages relevant to a question. Cite the titles you use.`,
      inputSchema: object(
        {
          query: { type: 'string', minLength: 2, maxLength: 500, description: 'What to look for, in natural language' },
          limit: { type: 'integer', minimum: 1, maximum: 10, description: 'Number of passages (default 5)' },
        },
        ['query'],
      ),
    };
  }
  validate(input: unknown): unknown {
    const i = (input ?? {}) as { query?: unknown; limit?: unknown };
    if (typeof i.query !== 'string' || i.query.trim().length < 2) throw new ToolInputError('Invalid tool arguments', [{ path: 'query', message: 'must be a non-empty string' }]);
    const limit = i.limit === undefined ? 5 : Number(i.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new ToolInputError('Invalid tool arguments', [{ path: 'limit', message: 'must be an integer from 1 to 10' }]);
    return { query: i.query.trim().slice(0, 500), limit };
  }
  async run(input: unknown): Promise<unknown> {
    const { query, limit } = input as { query: string; limit: number };
    const hits = (await Promise.all(this.names.map((n) => this.knowledge.get(n).search(query, { limit })))).flat();
    hits.sort((a, b) => b.score - a.score);
    return {
      results: hits.slice(0, limit).map((h) => ({ title: h.title, url: h.url, text: h.text, score: Math.round(h.score * 1000) / 1000 })),
    };
  }
}

/** Builds the tool set an agent may use (its tools, UI components, memory and knowledge). */
export class ToolCatalog {
  private readonly byName: ReadonlyMap<string, ToolDefinition>;
  private readonly components: ReadonlyMap<string, UiComponentDefinition>;

  constructor(
    tools: readonly ToolDefinition[],
    components: readonly UiComponentDefinition[],
    private readonly context: ApplicationContext,
    private readonly knowledge: () => KnowledgeBases,
  ) {
    this.byName = new Map(tools.map((t) => [t.name, t]));
    this.components = new Map(components.map((c) => [c.name, c]));
  }

  definition(name: string): ToolDefinition | undefined {
    return this.byName.get(name);
  }

  all(): ToolDefinition[] {
    return [...this.byName.values()];
  }

  forAgent(agent: AgentDefinition): Map<string, ExecutableTool> {
    const set = new Map<string, ExecutableTool>();
    for (const name of agent.tools) {
      const def = this.byName.get(name);
      if (def && this.context.isEnabled(def.beanId)) set.set(name, new BeanTool(def, this.context));
    }
    for (const name of agent.ui) {
      const c = this.components.get(name);
      if (c) {
        const tool = new ShowComponentTool(c);
        set.set(tool.spec.name, tool);
      }
    }
    if (agent.rememberTool) set.set('remember', new RememberTool());
    if (agent.knowledge.length > 0) set.set('search_knowledge', new SearchKnowledgeTool(agent.knowledge, this.knowledge()));
    return set;
  }

  /** A bean tool on its own (MCP's tools/call), when enabled. */
  beanTool(name: string): BeanTool | undefined {
    const def = this.byName.get(name);
    return def && this.context.isEnabled(def.beanId) ? new BeanTool(def, this.context) : undefined;
  }
}

/** Keeps tool output within what a model context can reasonably take. */
export function boundOutput(value: unknown, maxChars = 20_000): unknown {
  if (value === undefined) return { ok: true };
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return { error: 'The tool returned a value that cannot be converted to JSON' };
  }
  if (json === undefined) return { ok: true };
  if (json.length <= maxChars) return JSON.parse(json) as unknown;
  return { truncated: true, note: `Output shortened from ${json.length} characters`, partial: json.slice(0, maxChars) };
}
