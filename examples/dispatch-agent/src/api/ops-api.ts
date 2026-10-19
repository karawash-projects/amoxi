import { Body, Controller, Get, HttpError, PathParam, Post, eventStream, lastEventId, type RequestContext } from 'amoxi';
import type { AgentPlatform } from 'amoxi/ai';
import { dispatcherOf, originOf, toPrincipal } from '../agents/identity';
import type { IncidentType } from '../domain/model';
import { OpsDatabase } from '../ops/ops-database';
import { OpsViews } from '../ops/ops-views';
import { RunBoard } from '../runs/run-board';
import { MorningPlanning } from '../schedule/morning-planning';
import { IncidentService } from '../telematics/incident-service';

export interface Decision {
  approved: boolean;
  /** @maxLength 500 */
  note?: string;
}

export interface FollowUp {
  /**
   * @minLength 1
   * @maxLength 2000
   */
  input: string;
}

export interface DemoIncident {
  /** @pattern ^TRK-\d{3}$ */
  vehicleId: string;
  type: IncidentType;
}

const DEMO_LOCATIONS: Record<string, string> = {
  'TRK-214': 'Hwy 401 EB near Port Hope (km 464)',
  'TRK-142': 'QEW Niagara-bound at Corrowind Rd, Oakville',
  'TRK-124': 'Corvane Ave at Fenmarrow Rd, Toronto',
  'TRK-415': 'A-40 W near Anjou, Montreal',
};

function requireDispatcher(ctx: RequestContext): void {
  if (!dispatcherOf(ctx)) throw new HttpError(401, 'Open the console first: the demo signs you in as the dispatcher on shift');
}

/**
 * JSON and SSE endpoints behind the operations console. Agent runs are reached through the
 * AgentPlatform facade, the same one the /agents endpoints, MCP and A2A use.
 */
@Controller('/api')
export class OpsApi {
  constructor(
    private readonly views: OpsViews,
    private readonly db: OpsDatabase,
    private readonly board: RunBoard,
    private readonly platform: AgentPlatform,
    private readonly incidents: IncidentService,
    private readonly schedule: MorningPlanning,
  ) {}

  @Get('/ops/snapshot')
  snapshot(ctx: RequestContext) {
    requireDispatcher(ctx);
    return this.views.snapshot();
  }

  @Get('/runs')
  async runs(ctx: RequestContext) {
    requireDispatcher(ctx);
    return { runs: await this.board.list(), version: this.db.version };
  }

  private async visibleRun(ctx: RequestContext, id: string) {
    requireDispatcher(ctx);
    const run = await this.platform.getRun(id);
    if (!this.board.visible(run)) throw new HttpError(404, 'Run not found');
    return run;
  }

  /** The run's events as Server-Sent Events; resumes after Last-Event-ID. */
  @Get('/runs/:id/events')
  async events(@PathParam() id: string, ctx: RequestContext) {
    const run = await this.visibleRun(ctx, id);
    const after = Number(lastEventId(ctx.headers, ctx.query) ?? ctx.query.get('after') ?? '0');
    const platform = this.platform;
    return eventStream(
      async function* (signal) {
        for await (const e of platform.subscribe(run.id, Number.isFinite(after) && after > 0 ? after : 0, signal)) {
          yield { id: e.seq, event: e.type, data: { ...e.data, seq: e.seq, at: e.at } };
        }
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  }

  @Post('/runs/:id/approvals/:callId')
  async decide(@PathParam() id: string, @PathParam() callId: string, @Body() body: Decision, ctx: RequestContext) {
    const run = await this.visibleRun(ctx, id);
    const who = dispatcherOf(ctx)!;
    const next = await this.platform.decide(run.id, callId, { approved: body.approved, note: body.note ?? `${body.approved ? 'Approved' : 'Declined'} by ${who.name}` });
    return { id: next.id, status: next.status };
  }

  @Post('/runs/:id/cancel')
  async cancel(@PathParam() id: string, ctx: RequestContext) {
    const run = await this.visibleRun(ctx, id);
    const next = await this.platform.cancel(run.id);
    return { id: next.id, status: next.status };
  }

  /** Continues the run's conversation with a new message from the dispatcher. */
  @Post('/runs/:id/follow-up')
  async followUp(@PathParam() id: string, @Body() body: FollowUp, ctx: RequestContext) {
    const run = await this.visibleRun(ctx, id);
    const who = dispatcherOf(ctx)!;
    const next = await this.platform.startRun({
      agent: run.agent,
      input: body.input,
      owner: run.owner,
      threadId: run.threadId,
      // The dispatcher typed this one; keep the incident context of the run it follows.
      principal: toPrincipal({ ...originOf(run.principal, run.owner), source: 'dispatcher', name: who.name, id: who.id }),
    });
    return { runId: next.id, url: `/runs/${next.id}` };
  }

  @Get('/plans/:id')
  plan(@PathParam() id: string, ctx: RequestContext) {
    requireDispatcher(ctx);
    const plan = this.db.plan(id);
    if (!plan) throw new HttpError(404, 'Plan not found');
    return {
      id: plan.id,
      status: plan.status,
      depot: plan.depot,
      date: plan.date,
      totalKm: plan.totalKm,
      routes: plan.routes.map((r) => ({ vehicleId: r.vehicleId, driver: r.driver, stops: r.stops.length, pallets: r.pallets, km: r.km })),
      held: plan.held.length,
    };
  }

  /** Simulates a telematics event from the console (the real units call the webhook). */
  @Post('/demo/telematics')
  async demoIncident(@Body() body: DemoIncident, ctx: RequestContext) {
    requireDispatcher(ctx);
    const { incident, run } = await this.incidents.report({
      vehicleId: body.vehicleId,
      type: body.type,
      location: DEMO_LOCATIONS[body.vehicleId] ?? this.db.vehicle(body.vehicleId)?.location.label ?? 'Unknown location',
      note: body.type === 'breakdown' ? 'Coolant leak, engine derated, tow requested' : body.type === 'delay' ? 'Collision ahead, traffic stopped' : 'Return air 7.8 °C, set point 2 °C',
      occurredAt: new Date().toISOString(),
    });
    return { eventId: incident.id, runId: run.id, url: `/runs/${run.id}` };
  }

  /** Runs the morning planning schedule now (it otherwise fires on its interval when enabled). */
  @Post('/schedule/morning-planning')
  async runSchedule(ctx: RequestContext) {
    requireDispatcher(ctx);
    const runs = await this.schedule.runNow();
    return { started: runs.map((r) => ({ runId: r.id, input: r.input })), enabled: this.schedule.enabled, intervalMs: this.schedule.intervalMs };
  }
}
