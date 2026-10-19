// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import cluster from 'node:cluster';
import { configurePages } from '../../runtime/jsx';
import { storeKind } from '../stores/factory';
import type { ExtensionRoute, AmoxiExtension } from '../../runtime/types';
import { a2aRoutes } from '../protocols/a2a';
import { mcpRoutes, type McpResourceProvider } from '../protocols/mcp';
import { agentRoutes } from './endpoints';
import { AiServices } from './services';

/**
 * Serves the app's static pages to MCP clients as markdown resources. Resource URIs use the
 * public origin (`app.url`, else the local address); content is fetched from this server over
 * the loopback address without cookies, so only public content is exposed.
 */
class PageResources implements McpResourceProvider {
  constructor(
    private readonly paths: readonly string[],
    private readonly publicOrigin: () => string | undefined,
    private readonly loopback: () => string | undefined,
  ) {}

  async list(): Promise<Array<{ uri: string; name: string; title?: string; mimeType?: string }>> {
    const origin = this.publicOrigin() ?? 'http://localhost';
    return this.paths.map((p) => ({ uri: `${origin}${p}`, name: p === '/' ? 'home' : p.slice(1).replace(/\//g, '-'), title: `Page ${p}`, mimeType: 'text/markdown' }));
  }

  async read(uri: string): Promise<{ text: string; mimeType: string } | undefined> {
    let path: string;
    try {
      path = new URL(uri).pathname;
    } catch {
      return undefined;
    }
    const origin = this.loopback();
    if (!this.paths.includes(path) || !origin) return undefined;
    const res = await fetch(`${origin}${path}`, { headers: { accept: 'text/markdown' } }).catch(() => undefined);
    if (!res?.ok) return undefined;
    return { text: await res.text(), mimeType: 'text/markdown' };
  }
}

/**
 * The AI module as an Amoxi extension: agent endpoints, MCP and A2A servers, generative UI on
 * pages, and the background run worker. Added to the generated module when the app uses
 * @Agent, @Tool or @generative islands.
 */
export const aiExtension: AmoxiExtension = {
  name: 'amoxi/ai',
  install({ context, config, logger }) {
    const services = AiServices.of(context);
    services.useLogger(logger);
    const { settings } = services;
    // In-memory runs and conversations belong to one process: with several workers, a request for
    // a run can reach a worker that never saw it.
    const workers = Number(process.env.AMOXI_WORKERS ?? (cluster.isWorker ? 2 : 1));
    if (cluster.isWorker && workers > 1 && storeKind(config) === 'memory' && (context.module.ai?.agents.length ?? 0) > 0) {
      logger.warn(
        'ai.store.type is "memory" but this app runs several workers (amoxi start): runs and conversations are per worker, so requests can get 404. Use the file or postgres store, or start one worker (amoxi start --workers 1).',
      );
    }
    const ai = context.module.ai;
    if (ai && ai.components.length > 0) configurePages({ generativeIslands: ai.components.map((c) => c.name) });

    const hasAgents = (ai?.agents.length ?? 0) > 0;
    const hasTools = (ai?.tools.length ?? 0) > 0;
    let port: number | undefined;
    const loopback = (): string | undefined => (port === undefined ? undefined : `http://127.0.0.1:${port}`);
    const publicOrigin = (): string | undefined => (config.has('app.url') ? config.string('app.url').replace(/\/+$/, '') : loopback());

    const routes: ExtensionRoute[] = [];
    // The engine is created lazily: apps whose agents are never called pay nothing at startup.
    const platform = () => services.runtime().platform;
    if (hasAgents) routes.push(...agentRoutes(lazyPlatform(platform), context, settings));
    if (settings.mcp.enabled && (hasAgents || hasTools)) {
      const pages = context.module.routes.filter((r) => r.page && r.method === 'GET' && r.pattern === null).map((r) => r.path);
      const reader = new PageResources(pages, publicOrigin, loopback);
      routes.push(
        ...mcpRoutes(lazyPlatform(platform), {
          path: settings.mcp.path,
          name: settings.app.name,
          version: settings.app.version,
          instructions: settings.app.description || undefined,
          token: settings.mcp.token,
          callers: settings.mcp.callers,
          // Tools and guardrails can tell external callers apart: ctx.principal.channel === 'mcp'.
          principal: () => ({ channel: 'mcp' }),
          exposeAgents: settings.mcp.exposeAgents,
          approvals: settings.mcp.approvals,
          resources: pages.length > 0 ? reader : undefined,
        }),
      );
      if (!settings.mcp.token && Object.keys(settings.mcp.callers).length === 0 && settings.production) {
        logger.warn(`MCP endpoint ${settings.mcp.path} is enabled without ai.mcp.token: protect it with a token or authentication middleware`);
      }
    }
    if (settings.a2a.enabled && hasAgents) {
      routes.push(
        ...a2aRoutes(lazyPlatform(platform), {
          path: settings.a2a.path,
          name: settings.app.name,
          description: settings.app.description || ai!.agents.map((a) => a.description).join(' '),
          version: settings.app.version,
          token: settings.a2a.token,
          callers: settings.a2a.callers,
          principal: () => ({ channel: 'a2a' }),
          approvals: settings.a2a.approvals,
        }),
      );
    }

    return {
      routes,
      describe: () => ({
        agents: (ai?.agents ?? []).filter((a) => context.isEnabled(a.beanId)).map((a) => ({ name: a.name, description: a.description, url: `${settings.path}/${a.name}` })),
        links: {
          mcp: settings.mcp.enabled ? settings.mcp.path : undefined,
          agentCard: settings.a2a.enabled ? '/.well-known/agent-card.json' : undefined,
        },
      }),
      start: (info) => {
        port = info.port;
        // Resume runs interrupted by the last shutdown, and pick up queued work.
        if (hasAgents && settings.worker) services.runtime().runner.start();
      },
      stop: () => services.close(),
    };
  },
};

/** Defers creating the engine until a route is actually used (Proxy pattern). */
function lazyPlatform<T extends object>(get: () => T): T {
  return new Proxy({} as T, {
    get: (_target, prop) => {
      const target = get() as Record<PropertyKey, unknown>;
      const value = target[prop];
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}
