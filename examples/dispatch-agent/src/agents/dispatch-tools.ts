import { Singleton, Value } from 'amoxi';
import { Tool, type JsonValue, type ToolContext, ToolError } from 'amoxi/ai';
import { DEPOTS, depotByCity } from '../domain/geography';
import type { HeldStop, PlannedRoute, RoutePlan, Shipment, VehicleKind, VehicleStatus } from '../domain/model';
import { addDays } from '../domain/seed';
import { OpsDatabase } from '../ops/ops-database';
import { buildRoute, clusterStops, fitHours, fmtMin, sequence, tourKm, type Clustering } from '../ops/route-optimizer';
import { pause } from '../ops/timing';

export type DepotCity = 'Toronto' | 'Montreal' | 'Ottawa';

export interface ShipmentRow {
  id: string;
  customer: string;
  depot: string;
  place: string;
  date: string;
  pallets: number;
  weightKg: number;
  refrigerated: boolean;
  window: string;
}

export interface VehicleRow {
  id: string;
  kind: VehicleKind;
  depot: string;
  status: VehicleStatus;
  location: string;
  driver: string;
  drivingLeft: string;
  cycleLeft: string;
  capacityPallets: number;
  palletsOnBoard: number;
}

export interface PlanSummary {
  planId: string | null;
  depot: string;
  date: string;
  routes: Array<{ vehicleId: string; driver: string; stops: number; pallets: number; km: number; duration: string; lateStops: number }>;
  heldStops: Array<{ shipmentId: string; reason: string }>;
  totalKm: number;
  message: string;
}

export interface AssignResult {
  planId: string;
  status: 'assigned';
  shipmentsAssigned: number;
  vehicles: string[];
  message: string;
}

export interface NotifyResult {
  planId: string;
  sent: Array<{ vehicleId: string; driver: string; messageId: string }>;
  alreadyNotified: string[];
  message: string;
}

const row = (s: Shipment): ShipmentRow => ({
  id: s.id,
  customer: s.customer,
  depot: DEPOTS[s.depot].city,
  place: s.place,
  date: s.date,
  pallets: s.pallets,
  weightKg: s.weightKg,
  refrigerated: s.reefer,
  window: `${s.windowStart}-${s.windowEnd}`,
});

/**
 * The planner's tools. Planning is deliberately slow (a simulated optimiser working through
 * phases): it reports progress, stops when the run is cancelled, and checkpoints each phase with
 * ctx.step() so a run resumed after a restart picks up where it was.
 */
@Singleton()
export class DispatchTools {
  constructor(
    private readonly db: OpsDatabase,
    @Value('${dispatch.planner.step-ms:650}') private readonly stepMs: number,
    @Value('${dispatch.notify.step-ms:450}') private readonly notifyMs: number,
  ) {}

  /** Unassigned shipments waiting for a truck, with pallets, weight and delivery window. Optionally for one depot or date. */
  @Tool({ readOnly: true, expose: false })
  listUnassignedShipments(input: {
    /** Depot city; all depots when omitted. */
    depot?: DepotCity;
    /**
     * Delivery date (yyyy-mm-dd); all dates when omitted.
     * @format date
     */
    date?: string;
  }): { count: number; pallets: number; shipments: ShipmentRow[] } {
    const depot = input.depot ? depotByCity(input.depot)?.code : undefined;
    const list = this.db.unassigned(depot, input.date).sort((a, b) => a.depot.localeCompare(b.depot) || a.id.localeCompare(b.id));
    return { count: list.length, pallets: list.reduce((n, s) => n + s.pallets, 0), shipments: list.map(row) };
  }

  /** Fleet status: every truck with its status, location, capacity, load and the driver's hours left. */
  @Tool({ readOnly: true, expose: false })
  fleetStatus(input: {
    /** Depot city; the whole fleet when omitted. */
    depot?: DepotCity;
  }): { vehicles: VehicleRow[]; available: number; onRoute: number; outOfService: number } {
    const depot = input.depot ? depotByCity(input.depot)?.code : undefined;
    const vehicles = this.db.vehicles
      .filter((v) => !depot || v.depot === depot)
      .map((v) => ({
        id: v.id,
        kind: v.kind,
        depot: DEPOTS[v.depot].city,
        status: v.status,
        location: v.location.label,
        driver: v.driver.name,
        drivingLeft: fmtMin(v.driver.shiftMinutesLeft),
        cycleLeft: fmtMin(v.driver.cycleMinutesLeft),
        capacityPallets: v.capacityPallets,
        palletsOnBoard: this.db.loadOf(v.id).reduce((n, s) => n + s.pallets, 0),
      }));
    return {
      vehicles,
      available: vehicles.filter((v) => v.status === 'available').length,
      onRoute: vehicles.filter((v) => v.status === 'on_route').length,
      outOfService: vehicles.filter((v) => v.status === 'maintenance' || v.status === 'breakdown').length,
    };
  }

  /**
   * Plan routes for one depot and date: clusters the stops, matches zones to trucks by pallets,
   * weight and reefer needs, checks driver hours, sequences each route and checks delivery
   * windows. Takes several seconds. Returns a draft plan id (PLN-0000) and shows the route map.
   */
  @Tool({ readOnly: true, expose: false })
  async planRoutes(
    input: {
      /** Depot city to plan from. */
      depot: DepotCity;
      /**
       * Delivery date to plan (yyyy-mm-dd), usually tomorrow.
       * @format date
       */
      date: string;
    },
    ctx: ToolContext,
  ): Promise<PlanSummary> {
    const depot = depotByCity(input.depot);
    if (!depot) throw new ToolError(`Unknown depot '${input.depot}'. Demo Freight plans from Toronto, Montreal and Ottawa.`);
    if (input.date < this.db.today) throw new ToolError(`${input.date} is in the past; plan today or a later date.`);
    if (input.date > addDays(this.db.today, 7)) throw new ToolError('Plans can be made at most 7 days ahead.');

    // A resumed run replays the phases it checkpointed before the restart: skip their pauses and
    // progress lines until the first phase that really runs.
    let fresh = false;
    await ctx.step('begin', () => {
      fresh = true;
      return new Date().toISOString();
    });
    let fastForward = !fresh;
    if (fastForward) ctx.progress('Resuming after a restart: replaying finished phases from the checkpoint');
    const say = (message: string): void => {
      if (!fastForward) ctx.progress(message);
    };
    const wait = (factor = 1): Promise<void> => (fastForward ? Promise.resolve() : pause(this.stepMs * factor, ctx.signal));
    /** A checkpointed phase: replayed from the run record when the run resumes after a restart. */
    const phase = async <T>(key: string, label: string, fn: () => T): Promise<T> => {
      let ran = false;
      const value = await ctx.step(key, () => {
        ran = true;
        fastForward = false;
        return fn() as unknown as JsonValue;
      });
      if (!ran) ctx.progress(`Resumed from checkpoint: ${label} already done`);
      return value as unknown as T;
    };

    say(`Loading unassigned shipments for ${depot.city} on ${input.date}…`);
    await wait(0.6);
    const stops = this.db.unassigned(depot.code, input.date);
    if (stops.length === 0) {
      return { planId: null, depot: depot.city, date: input.date, routes: [], heldStops: [], totalKm: 0, message: `Nothing to plan: ${depot.city} has no unassigned shipments on ${input.date}.` };
    }
    const byId = new Map(stops.map((s) => [s.id, s]));
    const pallets = stops.reduce((n, s) => n + s.pallets, 0);

    say(`Clustering ${stops.length} stops (${pallets} pallets) into delivery zones…`);
    await wait();
    // A truck runs one route a day: trucks already booked on an assigned plan for this date are out.
    const booked = new Set(this.db.shipments.filter((s) => s.date === input.date && s.status === 'assigned' && s.vehicleId).map((s) => s.vehicleId!));
    const clustering = await phase<Clustering>('cluster', 'clustering', () => clusterStops(depot, stops, this.db.vehicles.filter((v) => !booked.has(v.id))));
    say(`Matched ${clustering.zones.length} zones to trucks: ${clustering.zones.map((z) => `${z.vehicleId} (${z.shipmentIds.length})`).join(', ')}`);
    await wait(0.6);

    say('Checking driver hours (13 h driving per day, 70 h cycle)…');
    await wait();
    const sequenced = await phase<{ zones: Array<{ vehicleId: string; order: string[] }>; held: HeldStop[]; savedKm: number }>('sequence', 'sequencing', () => {
      const held: HeldStop[] = [...clustering.held];
      let saved = 0;
      const zones = clustering.zones.map((z) => {
        const v = this.db.vehicle(z.vehicleId)!;
        const zoneStops = z.shipmentIds.map((id) => byId.get(id)!);
        const seq = sequence(depot, zoneStops);
        saved += Math.max(0, seq.naiveKm - tourKm(depot, seq.order));
        const fitted = fitHours(depot, v, seq.order);
        held.push(...fitted.held);
        return { vehicleId: v.id, order: fitted.keep.map((s) => s.id) };
      });
      return { zones, held, savedKm: Math.round(saved) };
    });
    for (const h of sequenced.held.filter((x) => x.reason.startsWith('Hours'))) {
      say(`Holding ${h.shipmentId} (${h.place}): ${h.reason}`);
    }
    for (const z of sequenced.zones) {
      say(`Sequencing ${z.vehicleId}: ${z.order.length === 1 ? '1 stop' : `${z.order.length} stops`}, distance and window orders, then 2-opt…`);
      await wait(0.7);
    }
    say(`2-opt saved ${sequenced.savedKm} km against nearest-neighbour across ${sequenced.zones.length} routes`);
    await wait(0.6);

    say('Checking delivery windows…');
    await wait();
    const plan = await phase<RoutePlan>('plan', 'route plan', () => {
      const routes: PlannedRoute[] = sequenced.zones
        .filter((z) => z.order.length > 0)
        .map((z) => buildRoute(depot, this.db.vehicle(z.vehicleId)!, z.order.map((id) => byId.get(id)!)));
      return {
        id: this.db.nextPlanId(),
        depot: depot.code,
        date: input.date,
        createdAt: new Date().toISOString(),
        routes,
        held: sequenced.held,
        totalKm: routes.reduce((n, r) => n + r.km, 0),
        savedKm: sequenced.savedKm,
        status: 'draft',
      };
    });
    // Idempotent upsert: a resumed run (or a fresh process) saves the same plan again.
    this.db.savePlan(plan);
    const late = plan.routes.flatMap((r) => r.stops).filter((s) => s.late);
    if (late.length > 0) say(`Window risk: ${late.map((s) => `${s.shipmentId} ETA ${s.eta} (closes ${s.windowEnd})`).join(', ')}`);

    ctx.ui('RoutePlanMap', {
      planId: plan.id,
      depot: { name: depot.city, yard: depot.yard, lat: depot.lat, lon: depot.lon },
      date: plan.date,
      totalKm: plan.totalKm,
      savedKm: plan.savedKm,
      routes: plan.routes.map((r) => ({
        vehicleId: r.vehicleId,
        driver: r.driver,
        kind: r.kind,
        km: r.km,
        durationMin: r.durationMin,
        limitMin: r.limitMin,
        pallets: r.pallets,
        capacityPallets: r.capacityPallets,
        stops: r.stops.map((s) => ({ shipmentId: s.shipmentId, place: s.place, customer: s.customer, lat: s.lat, lon: s.lon, eta: s.eta, late: s.late })),
      })),
      held: plan.held.map((h) => ({ shipmentId: h.shipmentId, place: h.place, lat: h.lat, lon: h.lon, reason: h.reason })),
    });
    ctx.progress(`Plan ${plan.id} ready: ${plan.routes.length === 1 ? '1 route' : `${plan.routes.length} routes`}, ${plan.totalKm} km, ${plan.held.length} held`);

    return {
      planId: plan.id,
      depot: depot.city,
      date: plan.date,
      routes: plan.routes.map((r) => ({
        vehicleId: r.vehicleId,
        driver: r.driver,
        stops: r.stops.length,
        pallets: r.pallets,
        km: r.km,
        duration: fmtMin(r.durationMin),
        lateStops: r.stops.filter((s) => s.late).length,
      })),
      heldStops: plan.held.map((h) => ({ shipmentId: h.shipmentId, reason: h.reason })),
      totalKm: plan.totalKm,
      message: `Draft ${plan.id} is ready. Ask to assign plan ${plan.id} to its vehicles; the dispatcher approves before anything is booked.`,
    };
  }

  /** Assign a draft route plan to its vehicles, booking every routed shipment on its truck. Needs the dispatcher's approval. */
  @Tool({ approval: true, idempotent: true })
  async assignPlan(
    input: {
      /**
       * The draft plan id from route planning, e.g. PLN-2041
       * @pattern ^PLN-\d{4}$
       * @patternMessage must look like PLN-2041
       */
      planId: string;
    },
    ctx: ToolContext,
  ): Promise<AssignResult> {
    const outcome = await ctx.step('assign', () => {
      const r = this.db.assignPlan(input.planId);
      return { changed: r.changed, alreadyAssigned: r.alreadyAssigned, vehicles: r.plan.routes.map((x) => x.vehicleId) };
    });
    return {
      planId: input.planId,
      status: 'assigned',
      shipmentsAssigned: outcome.changed,
      vehicles: outcome.vehicles,
      message: outcome.alreadyAssigned
        ? `${input.planId} was already assigned; nothing changed.`
        : `${outcome.changed} shipments booked on ${outcome.vehicles.length} trucks. Next: notify drivers for plan ${input.planId}.`,
    };
  }

  /** Notify drivers of an assigned plan: texts each driver their route, first stop and dock time. Each driver is texted once. */
  @Tool({ expose: false, idempotent: true })
  async notifyDrivers(
    input: {
      /**
       * The assigned plan id, e.g. PLN-2041
       * @pattern ^PLN-\d{4}$
       * @patternMessage must look like PLN-2041
       */
      planId: string;
    },
    ctx: ToolContext,
  ): Promise<NotifyResult> {
    const plan = this.db.plan(input.planId);
    if (!plan) throw new ToolError(`Plan ${input.planId} doesn't exist.`);
    if (plan.status !== 'assigned') throw new ToolError(`Plan ${plan.id} isn't assigned yet; assign it before notifying drivers.`);
    const sent: NotifyResult['sent'] = [];
    const already: string[] = [];
    for (const route of plan.routes) {
      ctx.progress(`Texting ${route.driver} (${route.vehicleId})…`);
      // idempotent: true + ctx.step: if a restart interrupts this loop, the run re-runs the call
      // and every text already sent returns its recorded result instead of being sent again.
      // The gateway's idempotency key is defence in depth (e.g. the model asking twice).
      const r = await ctx.step(`sms:${route.vehicleId}`, async () => {
        await pause(this.notifyMs, ctx.signal);
        const first = route.stops[0];
        const res = this.db.sendMessage({
          idempotencyKey: `${plan.id}:${route.vehicleId}`,
          vehicleId: route.vehicleId,
          driver: route.driver,
          text: `Demo Freight ${plan.date}: ${route.vehicleId}, ${route.stops.length} stops, ${route.km} km. Dock 06:30, first stop ${first?.place ?? '-'} ETA ${first?.eta ?? '-'}.`,
        });
        return { id: res.message.id, duplicate: res.duplicate };
      });
      if (r.duplicate) already.push(route.vehicleId);
      else sent.push({ vehicleId: route.vehicleId, driver: route.driver, messageId: r.id });
    }
    return {
      planId: plan.id,
      sent,
      alreadyNotified: already,
      message: `${sent.length} drivers texted${already.length ? `, ${already.length} already had their route` : ''}.`,
    };
  }
}
