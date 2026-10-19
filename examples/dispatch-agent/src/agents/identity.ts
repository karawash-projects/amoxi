import type { RequestContext } from 'amoxi';
import { userOwner, type JsonValue } from 'amoxi/ai';

/** What the agents' owner(req) hook returns for the dispatch team. */
export const OPS_TEAM = 'ops';
/**
 * How the framework stores that owner on threads and runs. Programmatic runs (webhooks,
 * schedules) use it so the dispatchers can open them in the console.
 */
export const OPS_OWNER = userOwner(OPS_TEAM);
/**
 * Partner agents call over A2A or MCP with a token of their own (ai.a2a.callers.<name>,
 * ai.mcp.callers.<name>); the protocol servers then own their runs as 'a2a:<name>' or 'mcp:<name>'.
 */
export function isPartnerOwner(owner: string): boolean {
  return owner.startsWith('a2a:') || owner.startsWith('mcp:');
}

export interface Dispatcher {
  readonly id: string;
  readonly name: string;
}

/** The demo signs every console visitor in as the on-shift dispatcher (a real app uses its IdP). */
export const DEMO_DISPATCHER: Dispatcher = { id: 'DSP-07', name: 'Mireille Obrelle' };

const SESSION_KEY = 'demo-freight.dispatcher';

export function signInDemoDispatcher(req: RequestContext): Dispatcher {
  const current = dispatcherOf(req);
  if (current) return current;
  req.session.set(SESSION_KEY, DEMO_DISPATCHER);
  return DEMO_DISPATCHER;
}

export function dispatcherOf(req: RequestContext): Dispatcher | undefined {
  const d = req.session.get<Dispatcher>(SESSION_KEY);
  return d && typeof d.id === 'string' && typeof d.name === 'string' ? d : undefined;
}

/** Who or what started a run, captured as the run's principal. */
export type RunSource = 'dispatcher' | 'telematics' | 'schedule' | 'partner';

export interface RunOrigin {
  readonly source: RunSource;
  readonly name: string;
  readonly id?: string;
  readonly vehicleId?: string;
  readonly eventId?: string;
  readonly incidentType?: string;
}

export function originOf(principal: JsonValue | undefined, owner: string): RunOrigin {
  if (principal && typeof principal === 'object' && !Array.isArray(principal) && typeof principal.source === 'string') {
    return principal as unknown as RunOrigin;
  }
  // Runs started over MCP or A2A carry { channel: 'mcp' | 'a2a' }.
  if (principal && typeof principal === 'object' && !Array.isArray(principal) && (principal.channel === 'a2a' || principal.channel === 'mcp')) {
    return { source: 'partner', name: principal.channel === 'a2a' ? 'Partner agent (A2A)' : 'MCP client' };
  }
  if (owner === 'a2a' || owner.startsWith('a2a:')) return { source: 'partner', name: 'Partner agent (A2A)' };
  if (owner === 'mcp' || owner.startsWith('mcp:')) return { source: 'partner', name: 'MCP client' };
  return { source: 'dispatcher', name: 'Dispatcher' };
}

export function toPrincipal(origin: RunOrigin): JsonValue {
  return { ...origin } as unknown as JsonValue;
}
