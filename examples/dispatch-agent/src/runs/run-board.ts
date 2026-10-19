import { ApplicationContext, Singleton } from 'amoxi';
import { TERMINAL_STATUSES, toChatItems, type AgentPlatform, type ChatItem, type RunEvent, type RunRecord, type RunStatus, type RunStore } from 'amoxi/ai';
import { isPartnerOwner, OPS_OWNER, originOf, type RunSource } from '../agents/identity';
import { toolLabel } from '../ui/labels';

export interface RunCard {
  id: string;
  agent: string;
  agentLabel: string;
  status: RunStatus;
  title: string;
  startedBy: RunSource;
  startedByName: string;
  currentStep: string;
  steps: number;
  createdAt: string;
  finishedAt: string | null;
  pendingApprovals: number;
  summary: string | null;
}

export const AGENT_LABELS: Record<string, string> = { 'dispatch-planner': 'Planner', 'exception-handler': 'Exceptions' };

const INCIDENT_LABEL: Record<string, string> = { breakdown: 'breakdown', delay: 'delay', temperature_alarm: 'reefer temperature alarm' };

/** A readable title: telematics runs get the event, others the request. */
export function runTitle(input: string, origin: { source: string; vehicleId?: string; incidentType?: string; eventId?: string }): string {
  if (origin.source === 'telematics' && origin.vehicleId) {
    return `${origin.vehicleId} ${INCIDENT_LABEL[origin.incidentType ?? ''] ?? 'incident'} reported by telematics${origin.eventId ? ` (${origin.eventId})` : ''}`;
  }
  const text = input.replace(/\s+/g, ' ');
  return text.length > 110 ? `${text.slice(0, 109)}…` : text;
}

/** The most recent thing a run did, for the "current step" column. */
export function currentStep(run: RunRecord, events: readonly RunEvent[]): string {
  if (run.status === 'awaiting_approval') {
    const p = (run.pending ?? []).find((x) => !x.decision);
    return p ? `Waiting for approval: ${p.tool.replace(/_/g, ' ')}` : 'Waiting for approval';
  }
  if (run.status === 'queued') return run.startedAt ? 'Queued to resume' : 'Queued';
  if (run.status === 'cancelled') return 'Cancelled';
  if (run.status === 'failed') return run.error?.message ?? 'Failed';
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'progress' && !/^(Approved|Declined): /.test(String(e.data.message))) return String(e.data.message ?? '');
    if (e.type === 'tool.started') return run.status === 'completed' ? `Finished: ${toolLabel(String(e.data.tool ?? ''))}` : `Running: ${toolLabel(String(e.data.tool ?? ''))}`;
  }
  return run.status === 'completed' ? 'Answered' : 'Thinking…';
}

/**
 * Background runs for the operations console: every run owned by the ops team (started by a
 * dispatcher, telematics or the schedule) and by partner agents, newest first, with the step it
 * is on. Reads the same RunStore the agent workers write to, so it shows runs executed by any
 * worker process.
 */
@Singleton()
export class RunBoard {
  private readonly finished = new Map<string, RunCard>();

  /** The ops team and every configured partner (see isPartnerOwner). */
  private readonly owners: readonly string[];

  constructor(
    private readonly platform: AgentPlatform,
    private readonly runs: RunStore,
    context: ApplicationContext,
  ) {
    const partners = (channel: 'a2a' | 'mcp') => context.config.keys(`ai.${channel}.callers`).map((name) => `${channel}:${name}`);
    this.owners = [OPS_OWNER, ...partners('a2a'), ...partners('mcp')];
  }

  /** Runs the console may open: the ops team's and partner agents'. */
  visible(run: RunRecord | undefined): run is RunRecord {
    return !!run && (run.owner === OPS_OWNER || isPartnerOwner(run.owner));
  }

  async list(limit = 24): Promise<RunCard[]> {
    const owners = this.owners;
    const threads = (await Promise.all(owners.map((o) => this.platform.threads(o)))).flat();
    const all = (await Promise.all(threads.map((t) => this.runs.listByThread(t.id)))).flat();
    all.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    const out: RunCard[] = [];
    for (const run of all.slice(0, limit)) {
      const cached = this.finished.get(run.id);
      if (cached && cached.status === run.status) {
        out.push(cached);
        continue;
      }
      const card = await this.card(run);
      if (TERMINAL_STATUSES.has(run.status)) this.finished.set(run.id, card);
      out.push(card);
    }
    return out;
  }

  async card(run: RunRecord): Promise<RunCard> {
    const events = await this.runs.events(run.id, 0);
    const origin = originOf(run.principal, run.owner);
    return {
      id: run.id,
      agent: run.agent,
      agentLabel: AGENT_LABELS[run.agent] ?? run.agent,
      status: run.status,
      title: runTitle(run.input, origin),
      startedBy: origin.source,
      startedByName: origin.name,
      currentStep: currentStep(run, events).slice(0, 160),
      steps: events.filter((e) => e.type === 'progress' || e.type === 'tool.started').length,
      createdAt: run.createdAt,
      finishedAt: run.finishedAt ?? null,
      pendingApprovals: (run.pending ?? []).filter((p) => !p.decision).length,
      summary: run.output ? run.output.replace(/\s+/g, ' ').slice(0, 220) : null,
    };
  }

  async events(runId: string): Promise<RunEvent[]> {
    return this.runs.events(runId, 0);
  }

  runsOfThread(threadId: string): Promise<RunRecord[]> {
    return this.runs.listByThread(threadId);
  }

  /**
   * The dispatchers' latest planner conversation (not the schedule's), to reopen in the console
   * after a reload, with the run still working in it if any.
   */
  async latestPlannerConversation(): Promise<{ threadId: string; items: ChatItem[]; activeRun?: { id: string; status: string; lastSeq: number } } | undefined> {
    const threads = await this.platform.threads(OPS_OWNER, 'dispatch-planner');
    for (const t of threads.slice(0, 10)) {
      const runs = await this.runs.listByThread(t.id);
      if (originOf(runs[0]?.principal, OPS_OWNER).source !== 'dispatcher') continue;
      const found = await this.platform.thread(t.id);
      if (!found) continue;
      // A run still in progress contributes its finished steps and the approval it waits for,
      // and the chat continues it (agentChat({ resume })).
      const active = runs.find((r) => !TERMINAL_STATUSES.has(r.status));
      const items = toChatItems([...found.messages, ...(active?.checkpoint ?? [])]);
      for (const p of active?.pending ?? []) {
        if (!p.decision) items.push({ kind: 'approval', id: `ap-${p.callId}`, callId: p.callId, tool: p.tool, input: p.input, reason: p.reason, status: 'pending' });
      }
      if (!active) return { threadId: t.id, items };
      const events = await this.runs.events(active.id, 0);
      return { threadId: t.id, items, activeRun: { id: active.id, status: active.status, lastSeq: events.at(-1)?.seq ?? 0 } };
    }
    return undefined;
  }

  /** Messages of the run's conversation that came before it. */
  async priorItems(run: RunRecord): Promise<ChatItem[]> {
    const found = await this.platform.thread(run.threadId);
    if (!found) return [];
    const earlier = new Set((await this.runs.listByThread(run.threadId)).filter((r) => r.createdAt < run.createdAt).map((r) => r.id));
    return toChatItems(found.messages.filter((m) => m.runId !== undefined && earlier.has(m.runId)));
  }
}
