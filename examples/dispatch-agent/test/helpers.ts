import { Config, AmoxiApplication } from 'amoxi';
import { AiServices, TERMINAL_STATUSES, type AgentPlatform, type ConversationStore, type RunEvent, type RunRecord, type RunStore, type ScriptedChatModel } from 'amoxi/ai';
import { applicationModule } from '../src/generated/amoxi.generated';
import { OpsDatabase } from '../src/ops/ops-database';

export const SECRET = 'test-telematics-secret-0123456789';
export const MCP_TOKEN = 'test-mcp-token-0123456789';
export const A2A_TOKEN = 'test-a2a-token-0123456789';

type Tree = { [key: string]: unknown };

function merge(a: Tree, b: Tree): Tree {
  const out: Tree = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' ? merge(a[k] as Tree, v as Tree) : v;
  }
  return out;
}

export interface StartOptions {
  model?: ScriptedChatModel;
  db?: OpsDatabase;
  stores?: { runs: RunStore; conversations: ConversationStore };
  config?: Tree;
}

/** Starts the app in the 'test' profile (offline model unless scripted, in-memory stores). */
export async function start(options: StartOptions = {}) {
  const db = options.db ?? new OpsDatabase();
  const overrides: Array<[string, unknown]> = [['OpsDatabase', db]];
  if (options.model) overrides.push(['ChatModel', options.model]);
  if (options.stores) overrides.push(['RunStore', options.stores.runs], ['ConversationStore', options.stores.conversations]);
  const config = merge(
    {
      server: { port: 0, host: '127.0.0.1' },
      amoxi: { log: { level: 'error' } },
      ai: { runs: { 'poll-ms': 50, 'lease-ms': 5000 }, mcp: { enabled: true, callers: { partner: MCP_TOKEN } }, a2a: { enabled: true, callers: { partner: A2A_TOKEN } } },
      dispatch: { planner: { 'step-ms': 2 }, notify: { 'step-ms': 2 }, telematics: { secret: SECRET } },
    },
    options.config ?? {},
  );
  const app = await AmoxiApplication.run(applicationModule, { config: Config.of(config, 'test'), silent: true, shutdownHook: false, overrides });
  const base = `http://127.0.0.1:${app.port}`;
  const jar = { cookie: '' };
  /** Same-origin request carrying the session cookie (the console's dispatcher). */
  const request = async (path: string, init: RequestInit & { headers?: Record<string, string> } = {}): Promise<Response> => {
    const res = await fetch(base + path, {
      ...init,
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...(jar.cookie ? { cookie: jar.cookie } : {}), ...(init.headers ?? {}) },
    });
    const set = res.headers.getSetCookie?.() ?? [];
    for (const c of set) if (c.startsWith('amoxi_session=')) jar.cookie = c.split(';')[0];
    return res;
  };
  /** Opens the console once, which signs the demo dispatcher in (session cookie). */
  const signIn = async (): Promise<void> => {
    const res = await request('/', { headers: { accept: 'text/html' } });
    await res.text();
  };
  const platform: AgentPlatform = AiServices.of(app.context).platform();
  return { app, base, db, request, signIn, platform, jar };
}

export async function waitFor<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 15));
  }
}

/** Waits until the run finishes or pauses for approval. */
export function settled(platform: AgentPlatform, id: string, ms = 10000): Promise<RunRecord> {
  return waitFor(async () => {
    const r = await platform.getRun(id);
    return r && (TERMINAL_STATUSES.has(r.status) || r.status === 'awaiting_approval') ? r : undefined;
  }, ms);
}

/** All stored events of a run (follows it to its end or pause). */
export async function eventsOf(platform: AgentPlatform, id: string): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const e of platform.subscribe(id, 0)) out.push(e);
  return out;
}

/** Parses a text/event-stream body into events. */
export async function sse(res: Response): Promise<Array<{ id?: string; event?: string; data: any }>> {
  const text = await res.text();
  return text
    .split('\n\n')
    .filter((b) => b.includes('data:'))
    .map((block) => {
      const out: { id?: string; event?: string; data: any } = { data: undefined };
      for (const line of block.split('\n')) {
        const i = line.indexOf(':');
        const k = line.slice(0, i);
        const v = line.slice(i + 2);
        if (k === 'data') out.data = JSON.parse(v);
        else if (k === 'id') out.id = v;
        else if (k === 'event') out.event = v;
      }
      return out;
    });
}

export const DISPATCHER = { source: 'dispatcher', name: 'Test Dispatcher', id: 'DSP-T' };
