import type { RequestContext } from 'amoxi';
import { Agent, type AgentRunContext, type RunRecord } from 'amoxi/ai';
import { OpsDatabase } from '../ops/ops-database';
import { ExceptionTools } from './exception-tools';
import { dispatcherOf, originOf, OPS_TEAM } from './identity';

/**
 * Handles road exceptions reported by truck telematics (breakdowns, delays, reefer temperature
 * alarms) with no one typing: assesses the impact straight away, proposes a recovery truck for
 * the dispatcher to approve, and keeps the operations board up to date.
 */
@Agent({
  name: 'exception-handler',
  tools: [ExceptionTools],
  maxTurns: 16,
  examples: ['Assess vehicle incident: breakdown of TRK-214', 'Reassign shipments from TRK-214 to TRK-305'],
})
export class ExceptionHandler {
  constructor(private readonly db: OpsDatabase) {}

  instructions(ctx: AgentRunContext): string {
    const origin = originOf(ctx.principal, ctx.run.owner);
    return [
      'You are the exception desk of Demo Freight. Telematics events arrive as messages; nobody is typing, so act without asking questions.',
      `Today is ${this.db.today}. ${origin.source === 'telematics' ? `This run was started by telematics event ${origin.eventId ?? ''} for ${origin.vehicleId ?? 'a truck'}.` : `A dispatcher (${origin.name}) is following up.`}`,
      '1. Call assess_vehicle_incident for the truck and incident type (read-only, runs immediately).',
      '2. If freight is at risk and a recovery truck is recommended, call reassign_shipments; the dispatcher approves it in the console before anything moves.',
      '3. Call post_ops_alert with a one-line title and a short body: what happened, shipments at risk, the recommendation and its status.',
      'Finish with a three-sentence summary for the dispatcher. Never invent trucks or shipments.',
    ].join('\n');
  }

  owner(req: RequestContext): string | undefined {
    return dispatcherOf(req) ? OPS_TEAM : undefined;
  }

  /**
   * Every exception run leaves a trace on the ops board, whatever the model did: if it didn't
   * post an alert itself, its final summary becomes one.
   */
  onRunFinished(run: RunRecord): void {
    const origin = originOf(run.principal, run.owner);
    if (run.status === 'cancelled') return;
    const vehicle = origin.vehicleId ? this.db.vehicle(origin.vehicleId) : undefined;
    const type = origin.incidentType ?? 'incident';
    this.db.raiseAlert({
      severity: run.status === 'failed' || type === 'breakdown' || type === 'temperature_alarm' ? 'critical' : 'warning',
      vehicleId: vehicle?.id,
      title: vehicle ? `${vehicle.id} ${type.replace('_', ' ')}: ${vehicle.location.label}` : 'Exception run finished',
      body: (run.status === 'failed' ? `The exception run failed: ${run.error?.message ?? 'unknown error'}` : (run.output ?? '')).slice(0, 1200),
      runId: run.id,
    });
  }
}
