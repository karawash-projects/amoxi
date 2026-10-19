import { bearing, roadKm, type DepotInfo, type LatLon } from '../domain/geography';
import type { HeldStop, PlannedRoute, PlannedStop, Shipment, Vehicle } from '../domain/model';

/**
 * A small, deterministic vehicle-routing heuristic (sweep clustering, nearest neighbour,
 * 2-opt, hours-of-service and time-window checks). Each phase is a pure function returning
 * JSON, so the planning tool can checkpoint every phase with ctx.step() and a resumed run
 * skips the phases it already finished.
 */

export const AVG_SPEED_KMH = 62;
export const LOAD_MIN = 30;
export const DEPART_MIN = 7 * 60;
/** Canadian hours of service (south of 60°N): 13 h of driving per day. */
export const DAILY_DRIVING_MIN = 13 * 60;

export interface Zone {
  vehicleId: string;
  shipmentIds: string[];
}

export interface Clustering {
  zones: Zone[];
  held: HeldStop[];
}

const held = (s: Shipment, reason: string): HeldStop => ({ shipmentId: s.id, place: s.place, lat: s.lat, lon: s.lon, reason });

/** Vehicles that can run routes on a future date (not in the shop or broken down). */
export function usableVehicles(vehicles: readonly Vehicle[], depot: DepotInfo): Vehicle[] {
  return vehicles.filter((v) => v.depot === depot.code && v.status !== 'maintenance' && v.status !== 'breakdown');
}

/** Sorts stops by bearing from the depot, starting after the widest empty sector. */
function sweepOrder(depot: LatLon, stops: readonly Shipment[]): Shipment[] {
  const withAngle = stops.map((s) => ({ s, a: bearing(depot, s) })).sort((x, y) => x.a - y.a || x.s.id.localeCompare(y.s.id));
  if (withAngle.length < 2) return withAngle.map((x) => x.s);
  let gapAt = 0;
  let widest = -1;
  for (let i = 0; i < withAngle.length; i++) {
    const next = withAngle[(i + 1) % withAngle.length].a + (i + 1 === withAngle.length ? 360 : 0);
    const gap = next - withAngle[i].a;
    if (gap > widest) {
      widest = gap;
      gapAt = (i + 1) % withAngle.length;
    }
  }
  return [...withAngle.slice(gapAt), ...withAngle.slice(0, gapAt)].map((x) => x.s);
}

/** Splits sweep-ordered stops into contiguous zones, one per vehicle, within capacity. */
function splitIntoZones(order: Shipment[], fleet: Vehicle[], out: Clustering, noRoomReason: string): void {
  const total = order.reduce((n, s) => n + s.pallets, 0);
  if (order.length === 0 || fleet.length === 0) {
    for (const s of order) out.held.push(held(s, noRoomReason));
    return;
  }
  // Use the fewest (largest) vehicles that hold the load with 10% slack, else all of them.
  const sorted = [...fleet].sort((a, b) => b.capacityPallets - a.capacityPallets || a.id.localeCompare(b.id));
  const chosen: Vehicle[] = [];
  let cap = 0;
  for (const v of sorted) {
    if (cap >= total * 1.1) break;
    chosen.push(v);
    cap += v.capacityPallets;
  }
  let i = 0;
  for (let z = 0; z < chosen.length; z++) {
    const v = chosen[z];
    const remainingCap = chosen.slice(z).reduce((n, x) => n + x.capacityPallets, 0);
    const remainingLoad = order.slice(i).reduce((n, s) => n + s.pallets, 0);
    const target = z === chosen.length - 1 ? v.capacityPallets : Math.min(v.capacityPallets, Math.round((remainingLoad * v.capacityPallets) / remainingCap));
    const zone: Zone = { vehicleId: v.id, shipmentIds: [] };
    let pallets = 0;
    let kg = 0;
    while (i < order.length) {
      const s = order[i];
      if (pallets + s.pallets > v.capacityPallets || kg + s.weightKg > v.capacityKg) break;
      if (pallets >= target) break;
      zone.shipmentIds.push(s.id);
      pallets += s.pallets;
      kg += s.weightKg;
      i++;
    }
    if (zone.shipmentIds.length > 0) out.zones.push(zone);
  }
  for (const s of order.slice(i)) out.held.push(held(s, noRoomReason));
}

/** Phase 1: sweep clustering. Refrigerated freight only rides on reefers (food-safety rule). */
export function clusterStops(depot: DepotInfo, shipments: readonly Shipment[], vehicles: readonly Vehicle[]): Clustering {
  const fleet = usableVehicles(vehicles, depot);
  const out: Clustering = { zones: [], held: [] };
  splitIntoZones(
    sweepOrder(depot, shipments.filter((s) => s.reefer)),
    fleet.filter((v) => v.kind === 'reefer'),
    out,
    'No refrigerated capacity left at this depot',
  );
  splitIntoZones(
    sweepOrder(depot, shipments.filter((s) => !s.reefer)),
    fleet.filter((v) => v.kind !== 'reefer'),
    out,
    'No dry-van capacity left at this depot',
  );
  topUp(depot, shipments, fleet, out);
  return out;
}

/**
 * Puts stops that found no room onto a truck with space left (dry freight may ride on a reefer,
 * never the reverse), choosing the zone whose stops are closest.
 */
function topUp(depot: DepotInfo, shipments: readonly Shipment[], fleet: readonly Vehicle[], out: Clustering): void {
  const byId = new Map(shipments.map((s) => [s.id, s]));
  const used = (z: Zone): { pallets: number; kg: number } =>
    z.shipmentIds.reduce((a, id) => ({ pallets: a.pallets + byId.get(id)!.pallets, kg: a.kg + byId.get(id)!.weightKg }), { pallets: 0, kg: 0 });
  for (const h of [...out.held]) {
    const s = byId.get(h.shipmentId)!;
    let best: { zone: Zone; km: number } | undefined;
    const zones = [...out.zones, ...fleet.filter((v) => !out.zones.some((z) => z.vehicleId === v.id)).map((v) => ({ vehicleId: v.id, shipmentIds: [] as string[] }))];
    for (const zone of zones) {
      const v = fleet.find((x) => x.id === zone.vehicleId)!;
      if (s.reefer && v.kind !== 'reefer') continue;
      const u = used(zone);
      if (u.pallets + s.pallets > v.capacityPallets || u.kg + s.weightKg > v.capacityKg) continue;
      const km = zone.shipmentIds.length ? Math.min(...zone.shipmentIds.map((id) => roadKm(byId.get(id)!, s))) : roadKm(depot, s) * 2;
      if (!best || km < best.km) best = { zone, km };
    }
    if (!best) continue;
    if (!out.zones.includes(best.zone)) out.zones.push(best.zone);
    best.zone.shipmentIds.push(s.id);
    out.held.splice(out.held.indexOf(h), 1);
  }
}

/** Length of the closed tour depot -> stops -> depot, in km. */
export function tourKm(depot: LatLon, stops: readonly LatLon[]): number {
  let km = 0;
  let at: LatLon = depot;
  for (const s of stops) {
    km += roadKm(at, s);
    at = s;
  }
  return km + (stops.length ? roadKm(at, depot) : 0);
}

/** Phase 2a: nearest-neighbour order. */
export function nearestNeighbour<T extends LatLon & { id: string }>(depot: LatLon, stops: readonly T[]): T[] {
  const left = [...stops];
  const out: T[] = [];
  let at: LatLon = depot;
  while (left.length) {
    let best = 0;
    for (let i = 1; i < left.length; i++) if (roadKm(at, left[i]) < roadKm(at, left[best])) best = i;
    at = left[best];
    out.push(left.splice(best, 1)[0]);
  }
  return out;
}

/** Phase 2b: 2-opt improvement of a closed tour (deterministic, first-improvement). */
export function twoOpt<T extends LatLon>(depot: LatLon, order: readonly T[], cost: (order: readonly T[]) => number = (o) => tourKm(depot, o)): T[] {
  let best = [...order];
  let bestKm = cost(best);
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < best.length - 1; i++) {
      for (let k = i + 1; k < best.length; k++) {
        const next = [...best.slice(0, i), ...best.slice(i, k + 1).reverse(), ...best.slice(k + 1)];
        const km = cost(next);
        if (km + 0.01 < bestKm) {
          best = next;
          bestKm = km;
          improved = true;
        }
      }
    }
  }
  return best;
}

const toMin = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
export const hhmm = (min: number): string => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(Math.round(min % 60)).padStart(2, '0')}`;

export interface Timeline {
  stops: PlannedStop[];
  km: number;
  /** Minutes from leaving the dock to returning, including waits and unloading. */
  durationMin: number;
  /** Minutes behind the wheel. */
  drivingMin: number;
}

/** Phase 4: arrival times, waits for windows, and late flags. */
export function timeline(depot: LatLon, order: readonly Shipment[]): Timeline {
  let t = DEPART_MIN;
  let at: LatLon = depot;
  let km = 0;
  let driving = 0;
  const stops: PlannedStop[] = [];
  for (const s of order) {
    const leg = roadKm(at, s);
    km += leg;
    driving += (leg / AVG_SPEED_KMH) * 60;
    t += (leg / AVG_SPEED_KMH) * 60;
    const arrive = Math.max(t, toMin(s.windowStart));
    stops.push({ shipmentId: s.id, customer: s.customer, place: s.place, lat: s.lat, lon: s.lon, pallets: s.pallets, eta: hhmm(arrive), windowEnd: s.windowEnd, late: arrive > toMin(s.windowEnd) });
    t = arrive + 15 + 2 * s.pallets;
    at = s;
  }
  const back = order.length ? roadKm(at, depot) : 0;
  km += back;
  driving += (back / AVG_SPEED_KMH) * 60;
  t += (back / AVG_SPEED_KMH) * 60;
  return { stops, km: Math.round(km), durationMin: Math.round(t - DEPART_MIN + LOAD_MIN), drivingMin: Math.round(driving) };
}

/** Route cost for sequencing: kilometres, plus a heavy penalty per missed delivery window. */
export function routeCost(depot: LatLon, order: readonly Shipment[]): number {
  const t = timeline(depot, order);
  return t.km + 500 * t.stops.filter((s) => s.late).length;
}

/**
 * Phase 2: sequence one route. Tries a distance-first order (nearest neighbour) and a
 * window-first order (earliest closing window first), improves both with 2-opt on
 * distance plus late-window penalty, and keeps the better one.
 */
export function sequence(depot: LatLon, stops: readonly Shipment[]): { order: Shipment[]; naiveKm: number } {
  const nn = nearestNeighbour(depot, stops);
  const byWindow = [...stops].sort((a, b) => a.windowEnd.localeCompare(b.windowEnd) || roadKm(depot, a) - roadKm(depot, b));
  const cost = (o: readonly Shipment[]): number => routeCost(depot, o);
  const a = twoOpt(depot, nn, cost);
  const b = twoOpt(depot, byWindow, cost);
  return { order: cost(a) <= cost(b) ? a : b, naiveKm: tourKm(depot, nn) };
}

/** The driving limit for a driver on the plan date: 13 h per day, capped by their 7-day cycle. */
export function drivingLimit(v: Vehicle): number {
  return Math.min(DAILY_DRIVING_MIN, v.driver.cycleMinutesLeft);
}

/**
 * Phase 3: hours of service. Drops the stop farthest from the depot until the route's driving
 * time fits the driver's limit; dropped stops are held for the dispatcher.
 */
export function fitHours(depot: LatLon, v: Vehicle, order: readonly Shipment[]): { keep: Shipment[]; held: HeldStop[] } {
  const limit = drivingLimit(v);
  let keep = [...order];
  const out: HeldStop[] = [];
  while (keep.length > 0 && timeline(depot, keep).durationMin > limit) {
    let far = 0;
    for (let i = 1; i < keep.length; i++) if (roadKm(depot, keep[i]) > roadKm(depot, keep[far])) far = i;
    const drop = keep[far];
    const before = timeline(depot, keep).durationMin;
    out.push(held(drop, `Hours of service: ${v.driver.name} has ${fmtMin(limit)} left; route needed ${fmtMin(before)}`));
    keep = sequence(depot, keep.filter((_, i) => i !== far)).order;
  }
  return { keep, held: out };
}

export function fmtMin(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
}

export function buildRoute(depot: LatLon, v: Vehicle, order: readonly Shipment[]): PlannedRoute {
  const t = timeline(depot, order);
  return {
    vehicleId: v.id,
    driver: v.driver.name,
    kind: v.kind,
    stops: t.stops,
    km: t.km,
    durationMin: t.durationMin,
    limitMin: drivingLimit(v),
    pallets: order.reduce((n, s) => n + s.pallets, 0),
    capacityPallets: v.capacityPallets,
    weightKg: order.reduce((n, s) => n + s.weightKg, 0),
  };
}
