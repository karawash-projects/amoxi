// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

/** The repository's apps, and what the checks need to know to exercise each one. */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';

/**
 * session: the demo sign-in request (none: no sign-in needed).
 * agent/prompt: an agent and a request that completes with the offline model.
 * mcpToken/a2aToken: the tokens the checks send. Production refuses the published demo values (they
 *   are in application-development.json only), so the checks pass their own through `env`.
 * env: environment for production runs (the secrets an example needs there).
 * workers: production worker count. The examples keep demo data in memory, so they run one.
 */
const VERIFY_SECRET = (name) => `verify-${name}-0123456789abcdef`;
export const APPS = [
  { id: 'user-service', dir: 'examples/user-service', websocket: '/ws/activity', workers: 2 },
  {
    id: 'banking-assistant',
    dir: 'examples/banking-assistant',
    workers: 1,
    session: { path: '/api/session', body: { customerId: 'C-1001' } },
    agent: 'banking-assistant',
    prompt: 'Show my accounts and balances',
    approvalPrompt: 'Transfer $250 from CHQ-4417 to SAV-4418',
    mcpToken: VERIFY_SECRET('bank-mcp'),
    env: { AI_MCP_TOKEN: VERIFY_SECRET('bank-mcp') },
    protectedAgents: true,
  },
  {
    id: 'clinic-assistant',
    dir: 'examples/clinic-assistant',
    workers: 1,
    session: { path: '/session/demo-patient', body: { patientId: 'P-1001' } },
    agent: 'clinic-assistant',
    prompt: 'Find a clinician who speaks French',
    a2aToken: VERIFY_SECRET('clinic-a2a'),
    env: { AI_A2A_TOKEN: VERIFY_SECRET('clinic-a2a'), CLINIC_PSEUDONYMKEY: VERIFY_SECRET('clinic-pseudonym') },
    protectedAgents: true,
  },
  {
    id: 'shopping-assistant',
    dir: 'examples/shopping-assistant',
    workers: 1,
    agent: 'shopping-assistant',
    prompt: 'Show me waterproof jackets under $400',
    mcpToken: VERIFY_SECRET('store-mcp'),
    a2aToken: VERIFY_SECRET('store-a2a'),
    env: { AI_MCP_TOKEN: VERIFY_SECRET('store-mcp'), AI_A2A_TOKEN: VERIFY_SECRET('store-a2a') },
  },
  {
    id: 'dispatch-agent',
    dir: 'examples/dispatch-agent',
    workers: 1,
    agent: 'dispatch-planner',
    prompt: 'Which shipments are still unassigned?',
    mcpToken: VERIFY_SECRET('freight-mcp'),
    a2aToken: VERIFY_SECRET('freight-a2a'),
    env: { AI_MCP_CALLERS_PARTNER: VERIFY_SECRET('freight-mcp'), AI_A2A_CALLERS_PARTNER: VERIFY_SECRET('freight-a2a'), DISPATCH_TELEMATICS_SECRET: VERIFY_SECRET('freight-telematics') },
  },
  { id: 'website', dir: 'website', workers: 2 },
];

/** Signs a client in as the app's demo user (no-op for apps without sign-in). */
export async function signIn(client, app) {
  if (!app.session) return;
  const res = await client.request(app.session.path, { method: 'POST', json: app.session.body });
  await res.arrayBuffer();
  if (!res.ok) throw new Error(`${app.id}: demo sign-in failed with ${res.status}`);
}

/** The compiled application module of an app (built by `npm run build`). */
export function loadModule(root, app) {
  const file = path.join(root, app.dir, 'dist', 'src', 'generated', 'amoxi.generated.js');
  if (!existsSync(file)) throw new Error(`${app.id} isn't built (${path.relative(root, file)} is missing): run npm run build`);
  const req = createRequire(file);
  return req(file).applicationModule;
}

/** Static page paths of an app (pages without :params). */
export function pagePaths(module) {
  return module.routes.filter((r) => r.page && r.method === 'GET' && r.pattern === null).map((r) => r.path);
}

/** Starts an app in production mode with `amoxi start` (cluster) or a single process. */
export function startArgs(root, app, { cluster = true, workers = 2 } = {}) {
  const bin = path.join(root, 'packages', 'framework', 'bin', 'amoxi.js');
  return cluster ? [bin, 'start', 'dist/src/main.js', '--workers', String(workers)] : ['dist/src/main.js'];
}
