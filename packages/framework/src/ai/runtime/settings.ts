// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import type { Config } from '../../runtime/config';

/** Agent runtime configuration (application.json `ai` section). Every key has a working default. */
export interface AiSettings {
  /** URL prefix of the agent endpoints. */
  readonly path: string;
  /** This instance executes runs (set false on web-only instances when workers share a PostgreSQL queue). */
  readonly worker: boolean;
  /** Runs executed at the same time by this process. */
  readonly concurrency: number;
  /** A run whose worker hasn't sent a heartbeat for this long is taken over by another worker. */
  readonly leaseMs: number;
  /** How often idle workers look for queued runs (other processes may have queued them). */
  readonly pollMs: number;
  readonly maxTurns: number;
  /** Messages of thread history sent to the model. */
  readonly historyLimit: number;
  readonly maxInputLength: number;
  readonly maxToolOutputChars: number;
  readonly mcp: { readonly enabled: boolean; readonly path: string; readonly token?: string; readonly callers: Readonly<Record<string, string>>; readonly exposeAgents: boolean; readonly approvals: 'decline' | 'wait' };
  readonly a2a: { readonly enabled: boolean; readonly path: string; readonly token?: string; readonly callers: Readonly<Record<string, string>>; readonly approvals: 'decline' | 'wait' | 'caller' };
  readonly app: { readonly name: string; readonly description: string; readonly version: string };
  readonly production: boolean;
}

export function readAiSettings(config: Config): AiSettings {
  const optional = (key: string): string | undefined => (config.has(key) ? config.string(key) || undefined : undefined);
  // ai.mcp.callers.<name> = <token>: one token per caller, so each one is told apart from the others.
  const callers = (prefix: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const name of config.keys(prefix)) {
      const token = optional(`${prefix}.${name}`);
      if (token) out[name] = token;
    }
    return out;
  };
  const path = `/${config.string('ai.path', '/agents').replace(/^\/+|\/+$/g, '')}`;
  return {
    path,
    worker: config.boolean('ai.runs.worker', 'true'),
    concurrency: Math.max(1, config.number('ai.runs.concurrency', '8')),
    leaseMs: Math.max(5000, config.number('ai.runs.lease-ms', '30000')),
    pollMs: Math.max(100, config.number('ai.runs.poll-ms', config.profile === 'test' ? '200' : '2000')),
    maxTurns: Math.max(1, config.number('ai.runs.max-turns', '12')),
    historyLimit: Math.max(2, config.number('ai.history.limit', '40')),
    maxInputLength: config.number('ai.input.max-length', '20000'),
    maxToolOutputChars: config.number('ai.tool-output.max-chars', '20000'),
    mcp: {
      enabled: config.boolean('ai.mcp.enabled', 'false'),
      path: config.string('ai.mcp.path', '/mcp'),
      token: optional('ai.mcp.token'),
      callers: callers('ai.mcp.callers'),
      exposeAgents: config.boolean('ai.mcp.expose-agents', 'true'),
      approvals: oneOf(config.string('ai.mcp.approvals', 'decline'), ['decline', 'wait'] as const, 'ai.mcp.approvals'),
    },
    a2a: {
      enabled: config.boolean('ai.a2a.enabled', 'false'),
      path: config.string('ai.a2a.path', '/a2a'),
      token: optional('ai.a2a.token'),
      callers: callers('ai.a2a.callers'),
      approvals: oneOf(config.string('ai.a2a.approvals', 'decline'), ['decline', 'wait', 'caller'] as const, 'ai.a2a.approvals'),
    },
    app: {
      name: config.string('app.name', 'Amoxi app'),
      description: config.string('app.description', ''),
      version: config.string('app.version', '1.0.0'),
    },
    production: config.isProduction,
  };
}

function oneOf<T extends string>(value: string, allowed: readonly T[], key: string): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`${key} must be one of ${allowed.join(', ')} (got "${value}")`);
}
