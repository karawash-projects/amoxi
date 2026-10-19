import { Config, AmoxiApplication, type RunningApplication } from 'amoxi';
import { AiServices, ScriptedChatModel, type AgentPlatform, type ScriptedTurn } from 'amoxi/ai';
import { PolicyLibrary } from '../src/agent/policy-library';
import { applicationModule } from '../src/generated/amoxi.generated';

export const MCP_TOKEN = 'test-mcp-token-0123456789';

export interface TestApp {
  app: RunningApplication;
  base: string;
  platform: AgentPlatform;
  model?: ScriptedChatModel;
  get<T>(type: abstract new (...args: never[]) => T): T;
  close(): Promise<void>;
}

/** Starts the app on a free port. With a script, the model is scripted; otherwise the offline model runs. */
export async function start(script?: ScriptedTurn[]): Promise<TestApp> {
  const model = script ? new ScriptedChatModel(script) : undefined;
  const app = await AmoxiApplication.run(applicationModule, {
    config: Config.of(
      {
        server: { port: 0, host: '127.0.0.1' },
        bank: { today: '2026-10-18', limits: { 'single-transfer-cents': 300000, 'daily-transfer-cents': 500000 } },
        ai: { mcp: { enabled: true, token: MCP_TOKEN, 'expose-agents': false }, runs: { 'poll-ms': 50 } },
      },
      'test',
    ),
    silent: true,
    shutdownHook: false,
    overrides: model ? [['ChatModel', model]] : [],
  });
  const get = <T,>(type: abstract new (...args: never[]) => T): T => app.context.getBean(type as never) as T;
  await get(PolicyLibrary).ready;
  return {
    app,
    base: `http://127.0.0.1:${app.port}`,
    platform: AiServices.of(app.context).platform(),
    model,
    get,
    close: () => app.close(),
  };
}

/** A browser-like client with its own cookie jar (one per customer). */
export class Client {
  cookie = '';
  constructor(private readonly base: string) {}

  async fetch(path: string, init: RequestInit & { headers?: Record<string, string> } = {}): Promise<Response> {
    const res = await fetch(this.base + path, {
      redirect: 'manual',
      ...init,
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...(this.cookie ? { cookie: this.cookie } : {}), ...(init.headers ?? {}) },
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    return res;
  }

  async signIn(customerId: string): Promise<this> {
    const res = await this.fetch('/api/session', { method: 'POST', body: JSON.stringify({ customerId }) });
    if (res.status !== 200) throw new Error(`sign-in failed: ${res.status}`);
    return this;
  }

  /** Sends a message and reads the event stream until the run finishes or waits for approval. */
  async ask(input: string, threadId?: string): Promise<SseEvent[]> {
    const res = await this.fetch('/agents/banking-assistant/runs', { method: 'POST', headers: { accept: 'text/event-stream' }, body: JSON.stringify({ input, ...(threadId ? { threadId } : {}) }) });
    if (res.status !== 200) throw new Error(`run failed to start: ${res.status} ${await res.text()}`);
    return sse(res);
  }

  /** Approves or declines, then follows the run to its end. */
  async decide(runId: string, callId: string, approved: boolean): Promise<{ status: number; events: SseEvent[] }> {
    const res = await this.fetch(`/agents/banking-assistant/runs/${runId}/approvals/${callId}`, { method: 'POST', headers: { accept: 'text/event-stream' }, body: JSON.stringify({ approved }) });
    if (res.status !== 200) return { status: res.status, events: [] };
    return { status: res.status, events: await sse(res) };
  }
}

export interface SseEvent {
  event: string;
  data: Record<string, any>;
}

export async function sse(res: Response): Promise<SseEvent[]> {
  const text = await res.text();
  return text
    .split('\n\n')
    .filter((b) => b.includes('data:'))
    .map((block) => {
      const out: SseEvent = { event: 'message', data: {} };
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) out.event = line.slice(7);
        else if (line.startsWith('data: ')) out.data = JSON.parse(line.slice(6)) as Record<string, any>;
      }
      return out;
    });
}

export const find = (events: SseEvent[], type: string): SseEvent[] => events.filter((e) => e.event === type);
