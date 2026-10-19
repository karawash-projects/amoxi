import { randomBytes } from 'node:crypto';
import type { RequestContext } from 'amoxi';

const KEY = 'shopperId';

/**
 * Shoppers don't log in: each browser gets a random shopper id in the encrypted session cookie.
 * The agent captures it as the run's principal (tools run in the background, outside the
 * request) and as the conversation owner, so carts, orders, memory and chats are per shopper.
 */
export function shopperId(req: RequestContext, create = true): string | undefined {
  const existing = req.session.get<string>(KEY);
  if (typeof existing === 'string' && /^SH-[0-9A-F]{10}$/.test(existing)) return existing;
  if (!create) return undefined;
  const id = `SH-${randomBytes(5).toString('hex').toUpperCase()}`;
  req.session.set(KEY, id);
  return id;
}

/** Shopper of a tool call. External agents (MCP/A2A) have no session and shop as a guest. */
export function shopperOf(principal: unknown): string {
  return typeof principal === 'string' && principal ? principal : 'guest-agent';
}
