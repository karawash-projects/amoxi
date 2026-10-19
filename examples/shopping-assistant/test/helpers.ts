import { Config, AmoxiApplication, responseCache } from 'amoxi';
import { AiServices, ScriptedChatModel, type AgentPlatform, type ScriptedTurn } from 'amoxi/ai';
import { applicationModule } from '../src/generated/amoxi.generated';
import { GuideLibrary } from '../src/guides/guides';

export const MCP_TOKEN = 'test-mcp-token-0123456789';
export const A2A_TOKEN = 'test-a2a-token-0123456789';

export interface SseEvent {
  id?: string;
  event?: string;
  data: any;
}

export interface Shop {
  base: string;
  platform: AgentPlatform;
  model?: ScriptedChatModel;
  app: Awaited<ReturnType<typeof AmoxiApplication.run>>;
  /** A browser-like client with its own session cookie (one shopper). */
  client(): Client;
  close(): Promise<void>;
}

export interface Client {
  cookie: string;
  request(path: string, init?: RequestInit): Promise<Response>;
  /** Sends a chat message and returns the run's events. */
  say(input: string, threadId?: string): Promise<SseEvent[]>;
  /** Approves or declines the pending call of a run, returning the rest of the events. */
  decide(events: SseEvent[], approved: boolean): Promise<SseEvent[]>;
}

/** Starts the app on a random port: offline model by default, or a scripted one. */
export async function startShop(script?: ScriptedTurn[]): Promise<Shop> {
  responseCache.clear();
  const model = script ? new ScriptedChatModel(script) : undefined;
  const app = await AmoxiApplication.run(applicationModule, {
    config: Config.of(
      {
        app: { name: 'Demo Outdoor Store', description: 'Outdoor gear store' },
        server: { port: 0, host: '127.0.0.1' },
        ai: { runs: { 'poll-ms': 20 }, mcp: { enabled: true, token: MCP_TOKEN }, a2a: { enabled: true, token: A2A_TOKEN } },
      },
      'test',
    ),
    silent: true,
    shutdownHook: false,
    overrides: model ? [['ChatModel', model]] : [],
  });
  await app.context.getBean(GuideLibrary).ready;
  const base = `http://127.0.0.1:${app.port}`;
  const client = (): Client => {
    const c: Client = {
      cookie: '',
      async request(path, init = {}) {
        const res = await fetch(base + path, {
          ...init,
          headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...(c.cookie ? { cookie: c.cookie } : {}), ...((init.headers as Record<string, string>) ?? {}) },
        });
        const set = res.headers.get('set-cookie');
        if (set) c.cookie = set.split(';')[0];
        return res;
      },
      async say(input, threadId) {
        const res = await c.request('/agents/shopping-assistant/runs', { method: 'POST', headers: { accept: 'text/event-stream' }, body: JSON.stringify({ input, ...(threadId ? { threadId } : {}) }) });
        if (res.status !== 200) throw new Error(`run failed to start: ${res.status} ${await res.text()}`);
        return sse(await res.text());
      },
      async decide(events, approved) {
        const approval = events.find((e) => e.event === 'approval.required');
        if (!approval) throw new Error('no approval requested');
        const runId = events[0].data.runId;
        const res = await c.request(`/agents/shopping-assistant/runs/${runId}/approvals/${approval.data.callId}?after=${events.at(-1)!.id}`, {
          method: 'POST',
          headers: { accept: 'text/event-stream' },
          body: JSON.stringify({ approved }),
        });
        return sse(await res.text());
      },
    };
    return c;
  };
  return { base, app, model, platform: AiServices.of(app.context).platform(), client, close: () => app.close() };
}

export function sse(text: string): SseEvent[] {
  return text
    .split('\n\n')
    .filter((b) => b.includes('data:'))
    .map((block) => {
      const out: SseEvent = { data: undefined };
      for (const line of block.split('\n')) {
        const i = line.indexOf(':');
        const k = line.slice(0, i);
        const v = line.slice(i + 2);
        if (k === 'data') out.data = JSON.parse(v);
        else if (k === 'id' || k === 'event') out[k] = v;
      }
      return out;
    });
}

export const uiOf = (events: SseEvent[], component: string) => events.filter((e) => e.event === 'ui' && e.data.component === component).map((e) => e.data.props);
export const toolsOf = (events: SseEvent[]) => events.filter((e) => e.event === 'tool.started').map((e) => e.data.tool as string);
export const resultsOf = (events: SseEvent[], tool: string) => events.filter((e) => e.event === 'tool.completed' && e.data.tool === tool).map((e) => e.data);
