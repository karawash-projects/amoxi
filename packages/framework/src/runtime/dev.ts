// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DevHooks } from './http';

/**
 * Child-process side of `amoxi dev`: an SSE endpoint that tells browsers which build is
 * running (so they refresh after a restart) and relays build errors for the overlay.
 */
export function createDevHooks(buildId: string): DevHooks {
  const clients = new Set<ServerResponse>();
  let errors: unknown[] = [];

  const broadcast = (event: string, data: unknown): void => {
    for (const c of clients) c.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  process.on('message', (m: { type?: string; errors?: unknown[] }) => {
    if (m?.type === 'amoxi:errors') {
      errors = m.errors ?? [];
      broadcast('errors', errors);
    }
  });
  const ping = setInterval(() => {
    for (const c of clients) c.write(': ping\n\n');
  }, 15_000);
  ping.unref();

  return {
    handle(req: IncomingMessage, res: ServerResponse, path: string): boolean {
      if (path !== '/_amoxi/dev/events') return false;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`retry: 300\nevent: hello\ndata: ${JSON.stringify({ build: buildId, errors })}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return true;
    },
    close(): void {
      clearInterval(ping);
      for (const c of clients) c.end();
      clients.clear();
    },
  };
}
