import { HttpError, Singleton } from 'amoxi';
import type { AgentPlatform, RunRecord } from 'amoxi/ai';
import type { IncidentRecord, IncidentType } from '../domain/model';
import { OPS_OWNER, toPrincipal } from '../agents/identity';
import { OpsDatabase } from '../ops/ops-database';

export interface TelematicsEvent {
  /**
   * The truck's fleet id.
   * @pattern ^TRK-\d{3}$
   * @patternMessage must look like TRK-214
   */
  vehicleId: string;
  type: IncidentType;
  /**
   * Where it happened, as reported by the unit (road, direction, landmark).
   * @minLength 2
   * @maxLength 160
   */
  location: string;
  /**
   * Free text from the driver or the unit.
   * @maxLength 500
   */
  note?: string;
  /** @format date-time */
  occurredAt: string;
}

const LABEL: Record<IncidentType, string> = { breakdown: 'a breakdown', delay: 'a delay', temperature_alarm: 'a reefer temperature alarm' };

/**
 * Turns telematics events into exception-handler runs. No person is involved: the run is started
 * programmatically through AgentPlatform, owned by the ops team so dispatchers see it in the
 * console, with the event captured as the run's principal.
 */
@Singleton()
export class IncidentService {
  constructor(
    private readonly db: OpsDatabase,
    private readonly platform: AgentPlatform,
  ) {}

  async report(event: TelematicsEvent): Promise<{ incident: IncidentRecord; run: RunRecord }> {
    const vehicle = this.db.vehicle(event.vehicleId);
    if (!vehicle) throw new HttpError(404, `Unknown vehicle ${event.vehicleId}`);
    const incident = this.db.recordIncident({ vehicleId: vehicle.id, type: event.type, location: event.location, note: event.note, occurredAt: event.occurredAt });
    // The vehicle id comes first: the offline model reads the first id-like token as the truck.
    const input =
      `${vehicle.id} reported ${LABEL[event.type]} (${event.type}) at ${event.location}, ${event.occurredAt}. ` +
      (event.note ? `Unit note: ${event.note.replace(/["“”]/g, "'")}. ` : '') +
      `Telematics event ${incident.id}. Assess the vehicle incident and protect the freight on board.`;
    const run = await this.platform.startRun({
      agent: 'exception-handler',
      input,
      owner: OPS_OWNER,
      principal: toPrincipal({ source: 'telematics', name: `Telematics ${vehicle.id}`, vehicleId: vehicle.id, eventId: incident.id, incidentType: event.type }),
    });
    incident.runId = run.id;
    return { incident, run };
  }
}
