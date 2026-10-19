import { Config, AmoxiApplication, type RunningApplication } from 'amoxi';
import { AiServices, userOwner, type AgentPlatform, type ChatModel, type RunRecord } from 'amoxi/ai';
import { applicationModule } from '../src/generated/amoxi.generated';
import type { Clock } from '../src/services/clock';

export const AGENT = 'clinic-assistant';
export const A2A_TOKEN = 'test-partner-token-0123456789';

/** Monday 2026-10-19 09:00 in Toronto: makes schedules and the 24-hour policy deterministic. */
export const MONDAY_9AM = new Date('2026-10-19T13:00:00Z');

export interface TestApp {
  app: RunningApplication;
  base: string;
  platform: AgentPlatform;
  get<T>(token: string): T;
  close(): Promise<void>;
}

export async function start(options: { model?: ChatModel; now?: Date } = {}): Promise<TestApp> {
  const overrides: Array<[string, unknown]> = [];
  if (options.model) overrides.push(['ChatModel', options.model]);
  if (options.now) {
    const fixed: Clock = { now: () => new Date(options.now!) };
    overrides.push(['Clock', fixed]);
  }
  const app = await AmoxiApplication.run(applicationModule, {
    config: Config.of(
      {
        server: { port: 0, host: '127.0.0.1' },
        amoxi: { log: { level: 'silent' } },
        ai: { runs: { 'poll-ms': 50 }, a2a: { enabled: true, token: A2A_TOKEN }, mcp: { enabled: false } },
        clinic: { 'pseudonym-key': 'test-pseudonym-key-0123456789' },
      },
      'test',
    ),
    silent: true,
    shutdownHook: false,
    overrides,
  });
  return {
    app,
    base: `http://127.0.0.1:${app.port}`,
    platform: AiServices.of(app.context).platform(),
    get: <T>(token: string) => app.context.getBean<T>(token),
    close: () => app.close(),
  };
}

/** A browser-like client with its own cookie jar (one per demo patient). */
export class Client {
  cookie = '';
  constructor(private readonly base: string) {}

  async request(path: string, init: RequestInit & { headers?: Record<string, string> } = {}): Promise<Response> {
    const res = await fetch(this.base + path, {
      ...init,
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...(this.cookie ? { cookie: this.cookie } : {}), ...(init.headers ?? {}) },
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    return res;
  }

  async signIn(patientId: string): Promise<void> {
    const res = await this.request('/session/demo-patient', { method: 'POST', body: JSON.stringify({ patientId }) });
    if (res.status !== 200) throw new Error(`sign-in failed: ${res.status}`);
  }

  /** Sends a chat message and returns the SSE events until the run completes or pauses. */
  async ask(input: string, threadId?: string): Promise<SseEvent[]> {
    const res = await this.request(`/agents/${AGENT}/runs`, { method: 'POST', headers: { accept: 'text/event-stream' }, body: JSON.stringify({ input, ...(threadId ? { threadId } : {}) }) });
    if (res.status !== 200) throw new Error(`run failed to start: ${res.status} ${await res.text()}`);
    return parseSse(await res.text());
  }
}

export interface SseEvent {
  id?: string;
  event?: string;
  data: Record<string, any>;
}

export function parseSse(text: string): SseEvent[] {
  return text
    .split('\n\n')
    .filter((b) => b.includes('data:'))
    .map((block) => {
      const out: SseEvent = { data: {} };
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

export async function waitFor<T>(fn: () => Promise<T | undefined | false>, ms = 4000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Waits until a run pauses for approval or finishes. */
export function settle(platform: AgentPlatform, runId: string, status?: RunRecord['status']): Promise<RunRecord> {
  return waitFor(async () => {
    const r = await platform.getRun(runId);
    if (!r) return undefined;
    if (status) return r.status === status ? r : undefined;
    return ['awaiting_approval', 'completed', 'failed', 'cancelled'].includes(r.status) ? r : undefined;
  });
}

/** Starts a run as a patient, the way the HTTP endpoint does (owner and principal = patient id). */
export function runAs(platform: AgentPlatform, patientId: string, input: string, threadId?: string): Promise<RunRecord> {
  return platform.startRun({ agent: AGENT, input, owner: userOwner(patientId), principal: patientId, ...(threadId ? { threadId } : {}) });
}

/** Approves every pending call until the run completes; returns the final run. */
export async function approveAll(platform: AgentPlatform, runId: string, approved = true): Promise<RunRecord> {
  for (;;) {
    const r = await settle(platform, runId);
    if (r.status !== 'awaiting_approval') return r;
    for (const p of r.pending ?? []) if (!p.decision) await platform.decide(runId, p.callId, { approved });
    await waitFor(async () => ((await platform.getRun(runId))?.status !== 'awaiting_approval' ? true : undefined));
  }
}

/** Tool results the run produced, from its thread. */
export async function toolResults(platform: AgentPlatform, threadId: string): Promise<Array<{ name: string; output: any; isError?: boolean }>> {
  const t = await platform.thread(threadId);
  return (t?.messages ?? []).flatMap((m) => m.content.filter((p) => p.type === 'tool_result')) as Array<{ name: string; output: any; isError?: boolean }>;
}
