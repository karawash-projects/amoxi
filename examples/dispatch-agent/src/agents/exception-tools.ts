import { Singleton, Value } from 'amoxi';
import { Tool, type ToolContext, ToolError } from 'amoxi/ai';
import { DEPOTS, roadKm } from '../domain/geography';
import type { AlertSeverity, IncidentType, Shipment, Vehicle } from '../domain/model';
import { OpsDatabase } from '../ops/ops-database';
import { AVG_SPEED_KMH, fmtMin, hhmm } from '../ops/route-optimizer';
import { pause } from '../ops/timing';

export interface AffectedShipment {
  shipmentId: string;
  customer: string;
  place: string;
  window: string;
  pallets: number;
  refrigerated: boolean;
  projectedArrival: string;
  risk: 'late' | 'tight' | 'ok';
}

export interface RecoveryOption {
  vehicleId: string;
  driver: string;
  kind: string;
  location: string;
  distanceKm: number;
  reachMinutes: number;
  sparePallets: number;
  drivingLeft: string;
}

export interface IncidentAssessment {
  vehicleId: string;
  type: IncidentType;
  location: string;
  depot: string;
  affected: AffectedShipment[];
  palletsAtRisk: number;
  recommendation: RecoveryOption | null;
  alternatives: RecoveryOption[];
  nextStep: string;
}

/** Time lost before freight moves again, by incident type (minutes). */
const RECOVERY_DELAY: Record<IncidentType, number> = { breakdown: 90, delay: 45, temperature_alarm: 30 };

const nowMinutes = (): number => {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
};
const toMin = (hhmmText: string): number => {
  const [h, m] = hhmmText.split(':').map(Number);
  return h * 60 + m;
};

/**
 * Tools of the exception handler. Analysis is read-only and runs straight away (no person is
 * watching when telematics triggers it); moving freight between trucks needs approval.
 */
@Singleton()
export class ExceptionTools {
  constructor(
    private readonly db: OpsDatabase,
    @Value('${dispatch.planner.step-ms:650}') private readonly stepMs: number,
  ) {}

  private affectedBy(v: Vehicle, type: IncidentType): Shipment[] {
    const load = this.db.loadOf(v.id);
    return type === 'temperature_alarm' ? load.filter((s) => s.reefer) : load;
  }

  private options(v: Vehicle, freight: readonly Shipment[]): RecoveryOption[] {
    const pallets = freight.reduce((n, s) => n + s.pallets, 0);
    const needsReefer = freight.some((s) => s.reefer);
    return this.db.vehicles
      .filter((c) => c.id !== v.id && c.depot === v.depot && c.status === 'available')
      .filter((c) => !needsReefer || c.kind === 'reefer')
      .map((c) => {
        const km = Math.round(roadKm(c.location, v.location));
        const spare = c.capacityPallets - this.db.loadOf(c.id).reduce((n, s) => n + s.pallets, 0);
        return {
          vehicleId: c.id,
          driver: c.driver.name,
          kind: c.kind.replace('_', ' '),
          location: c.location.label,
          distanceKm: km,
          reachMinutes: Math.round((km / AVG_SPEED_KMH) * 60),
          sparePallets: spare,
          drivingLeft: fmtMin(c.driver.shiftMinutesLeft),
          fits: spare >= pallets && c.driver.shiftMinutesLeft >= (km / AVG_SPEED_KMH) * 60 * 2 + 120,
        };
      })
      .filter((o) => o.fits)
      .sort((a, b) => a.distanceKm - b.distanceKm || a.vehicleId.localeCompare(b.vehicleId))
      .map(({ fits: _fits, ...o }) => o);
  }

  /**
   * Assess a vehicle incident (breakdown, delay or temperature alarm): finds the shipments on the
   * truck, projects which delivery windows will be missed, and recommends a recovery vehicle.
   * Read-only; shows the incident brief.
   */
  @Tool({ readOnly: true, expose: false })
  async assessVehicleIncident(
    input: {
      /**
       * The truck reporting the incident, e.g. TRK-214
       * @pattern ^TRK-\d{3}$
       * @patternMessage must look like TRK-214
       */
      vehicleId: string;
      /** What telematics reported. */
      type: IncidentType;
    },
    ctx: ToolContext,
  ): Promise<IncidentAssessment> {
    const v = this.db.vehicle(input.vehicleId);
    if (!v) throw new ToolError(`No vehicle ${input.vehicleId} in the fleet.`);
    const wait = (): Promise<void> => pause(Math.round(this.stepMs * 0.6), ctx.signal);

    ctx.progress(`Pulling ${v.id}'s manifest…`);
    await wait();
    const freight = this.affectedBy(v, input.type);
    const start = nowMinutes() + RECOVERY_DELAY[input.type];
    let clock = start;
    let at = v.location as { lat: number; lon: number };
    const affected: AffectedShipment[] = freight.map((s) => {
      clock += (roadKm(at, s) / AVG_SPEED_KMH) * 60;
      at = s;
      const arrival = Math.round(clock);
      clock += 20;
      const end = toMin(s.windowEnd);
      return {
        shipmentId: s.id,
        customer: s.customer,
        place: s.place,
        window: `${s.windowStart}-${s.windowEnd}`,
        pallets: s.pallets,
        refrigerated: s.reefer,
        projectedArrival: hhmm(arrival),
        risk: arrival > end ? 'late' : arrival > end - 30 ? 'tight' : 'ok',
      };
    });
    const pallets = affected.reduce((n, s) => n + s.pallets, 0);
    ctx.progress(`${affected.length} shipments on board (${pallets} pallets), ${affected.filter((a) => a.risk !== 'ok').length} windows at risk`);

    ctx.progress(`Searching ${DEPOTS[v.depot].city} for a recovery truck with ${pallets} pallets free…`);
    await wait();
    const options = affected.length > 0 ? this.options(v, freight) : [];
    const best = options[0] ?? null;
    if (best) ctx.progress(`${best.vehicleId} (${best.driver}) can reach ${v.id} in ${fmtMin(best.reachMinutes)}`);

    const assessment: IncidentAssessment = {
      vehicleId: v.id,
      type: input.type,
      location: v.location.label,
      depot: DEPOTS[v.depot].city,
      affected,
      palletsAtRisk: pallets,
      recommendation: best,
      alternatives: options.slice(1, 3),
      nextStep: best
        ? `Reassign shipments from ${v.id} to ${best.vehicleId} (needs the dispatcher's approval).`
        : affected.length === 0
          ? 'No freight affected; no action needed.'
          : 'No truck can take the whole load; call the partner network or split the load.',
    };
    ctx.ui('IncidentBrief', {
      vehicleId: v.id,
      driver: v.driver.name,
      type: input.type,
      location: v.location.label,
      reportedAt: v.location.updatedAt,
      affected: affected.map((a) => ({ ...a })),
      recommendation: best ? { ...best } : null,
      alternatives: assessment.alternatives.map((a) => ({ ...a })),
      nextStep: assessment.nextStep,
    });
    return assessment;
  }

  /** Reassign the open shipments of a broken-down or delayed truck to a recovery truck. Needs the dispatcher's approval. */
  @Tool({ approval: true, idempotent: true })
  async reassignShipments(
    input: {
      /**
       * The truck the freight is on now, e.g. TRK-214
       * @pattern ^TRK-\d{3}$
       */
      fromVehicleId: string;
      /**
       * The recovery truck, e.g. TRK-305
       * @pattern ^TRK-\d{3}$
       */
      toVehicleId: string;
    },
    ctx: ToolContext,
  ): Promise<{ moved: string[]; fromVehicleId: string; toVehicleId: string; driverNotified: boolean; message: string }> {
    const from = this.db.vehicle(input.fromVehicleId);
    const to = this.db.vehicle(input.toVehicleId);
    if (!from || !to) throw new ToolError(`Unknown vehicle ${!from ? input.fromVehicleId : input.toVehicleId}.`);
    const result = await ctx.step('move', () => {
      const load = this.db.loadOf(from.id);
      if (load.length === 0) return { moved: [] as string[], already: true };
      if (to.status !== 'available') throw new ToolError(`${to.id} is ${to.status.replace('_', ' ')}, not available for recovery.`);
      const pallets = load.reduce((n, s) => n + s.pallets, 0);
      if (to.capacityPallets < pallets) throw new ToolError(`${to.id} holds ${to.capacityPallets} pallets; ${from.id} carries ${pallets}.`);
      if (load.some((s) => s.reefer) && to.kind !== 'reefer') throw new ToolError(`${from.id} carries refrigerated freight; ${to.id} isn't a reefer.`);
      return { moved: this.db.reassign(from.id, to.id).map((s) => s.id), already: false };
    });
    const sms = this.db.sendMessage({
      idempotencyKey: `recovery:${from.id}:${to.id}:${this.db.today}`,
      vehicleId: to.id,
      driver: to.driver.name,
      text: `Demo Freight recovery: meet ${from.id} at ${from.location.label} and transfer ${result.moved.length} shipments.`,
    });
    return {
      moved: result.moved,
      fromVehicleId: from.id,
      toVehicleId: to.id,
      driverNotified: !sms.duplicate,
      message: result.already ? `${from.id} has no open freight; nothing to move.` : `${result.moved.length} shipments moved to ${to.id}; ${to.driver.name} has been texted.`,
    };
  }

  /** Post an alert on the operations board for the dispatch team (one per run). */
  @Tool({ expose: false, idempotent: true })
  postOpsAlert(
    input: {
      severity: AlertSeverity;
      /**
       * The truck concerned, e.g. TRK-214
       * @pattern ^TRK-\d{3}$
       */
      vehicleId?: string;
      /**
       * One-line headline.
       * @minLength 3
       * @maxLength 120
       */
      title: string;
      /**
       * What happened and what was decided.
       * @minLength 3
       * @maxLength 1200
       */
      body: string;
    },
    ctx: ToolContext,
  ): { alertId: string } {
    const alert = this.db.raiseAlert({ severity: input.severity, vehicleId: input.vehicleId, title: input.title, body: input.body, runId: ctx.runId });
    return { alertId: alert.id };
  }
}
