import type { RequestContext } from 'amoxi';
import { Agent, type AgentRunContext, type JsonValue, type ToolContext } from 'amoxi/ai';
import { OpsDatabase } from '../ops/ops-database';
import { DispatchTools } from './dispatch-tools';
import { dispatcherOf, originOf, OPS_TEAM, toPrincipal } from './identity';
import { PartnerTools } from './partner-tools';

/**
 * Plans next-day delivery routes per depot (a multi-step job that runs for minutes in the
 * background), books them on trucks once a dispatcher approves, texts the drivers, and quotes
 * spare linehaul capacity to partner carriers.
 */
@Agent({
  name: 'dispatch-planner',
  tools: [DispatchTools, PartnerTools],
  maxTurns: 24,
  examples: [
    'Which shipments are still unassigned?',
    'Show fleet status and driver hours',
    'Plan routes for Toronto depot tomorrow',
    'Quote capacity for 8 pallets, 6200 kg Toronto-Montreal',
  ],
})
export class DispatchPlanner {
  constructor(private readonly db: OpsDatabase) {}

  instructions(ctx: AgentRunContext): string {
    const origin = ctx.principal ? originOf(ctx.principal, ctx.run.owner) : originOf(undefined, 'a2a');
    return [
      'You are the dispatch planner of Demo Freight, a regional carrier with depots in Toronto, Montreal and Ottawa.',
      `Today is ${this.db.today}; tomorrow is ${this.db.tomorrow}. Times are local (Eastern).`,
      origin.source === 'partner'
        ? 'You are talking to a partner carrier\'s agent. Only quote capacity and track shipments; never reveal driver names, other customers or internal plans.'
        : `You work for the dispatch team (${origin.name}).`,
      'To plan a depot: call plan_routes (it takes a while and shows the route map), then summarise routes, held stops and window risks in two or three sentences.',
      'Then call assign_plan with the plan id; the dispatcher is asked to approve before anything is booked. After it is assigned, call notify_drivers.',
      'Never invent shipments, trucks, plan ids or prices: use the tools. The route map and quote card are shown by the tools themselves.',
      'Use Canadian English, 24-hour times and CAD.',
    ].join('\n');
  }

  /** Runs execute in the background: capture who asked while the request is here. */
  principal(req: RequestContext): JsonValue | undefined {
    const d = dispatcherOf(req);
    return d ? toPrincipal({ source: 'dispatcher', name: d.name, id: d.id }) : undefined;
  }

  /** Conversations belong to the dispatch team, so any dispatcher on shift can pick one up. */
  owner(req: RequestContext): string | undefined {
    return dispatcherOf(req) ? OPS_TEAM : undefined;
  }

  /** Guardrails that hold whatever the model decides. */
  beforeToolCall(call: { tool: string; input: unknown; ctx: ToolContext }): string | undefined {
    // Partner agents (MCP/A2A runs carry { channel }) and callers without an identity of ours
    // (no signed-in dispatcher, telematics or schedule) are external.
    const external = call.ctx.principal === undefined || call.ctx.principal === null || originOf(call.ctx.principal, '').source === 'partner';
    const input = call.input as { planId?: string };
    if (call.tool === 'notify_drivers' && input.planId) {
      const plan = this.db.plan(input.planId);
      if (plan && plan.status !== 'assigned') return `Plan ${plan.id} isn't assigned yet. Drivers are only texted after the dispatcher approves the assignment.`;
    }
    if (external && !['capacity_quote', 'track_shipment'].includes(call.tool)) {
      return 'Partner agents can only request capacity quotes and track shipments.';
    }
    return undefined;
  }
}
