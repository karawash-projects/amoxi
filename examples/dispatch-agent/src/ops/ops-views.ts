import { Singleton } from 'amoxi';
import { DEPOTS } from '../domain/geography';
import type { AlertSeverity, VehicleKind, VehicleStatus } from '../domain/model';
import { OpsDatabase } from './ops-database';

export interface ShipmentView {
  id: string;
  customer: string;
  place: string;
  depot: string;
  date: string;
  pallets: number;
  weightKg: number;
  reefer: boolean;
  window: string;
}

export interface VehicleView {
  id: string;
  kind: VehicleKind;
  depot: string;
  status: VehicleStatus;
  location: string;
  driver: string;
  drivingLeftMin: number;
  cycleLeftMin: number;
  capacityPallets: number;
  palletsOnBoard: number;
  stopsToday: number;
  tomorrowPlan: string | null;
}

export interface AlertView {
  id: string;
  severity: AlertSeverity;
  title: string;
  body: string;
  vehicleId: string | null;
  runId: string | null;
  createdAt: string;
}

export interface Kpis {
  tomorrowShipments: number;
  tomorrowUnassigned: number;
  tomorrowPallets: number;
  fleetTotal: number;
  onRoute: number;
  available: number;
  outOfService: number;
  onTimePct: number;
  atRisk: number;
  openAlerts: number;
  driversTexted: number;
}

export interface OpsSnapshot {
  version: number;
  today: string;
  tomorrow: string;
  kpis: Kpis;
  unassigned: ShipmentView[];
  fleet: VehicleView[];
  alerts: AlertView[];
}

/** Read models for the console (server-rendered first, then polled by the islands). */
@Singleton()
export class OpsViews {
  constructor(private readonly db: OpsDatabase) {}

  snapshot(): OpsSnapshot {
    const db = this.db;
    const tomorrow = db.shipments.filter((s) => s.date === db.tomorrow);
    const today = db.shipments.filter((s) => s.date === db.today);
    const broken = new Set(db.vehicles.filter((v) => v.status === 'breakdown').map((v) => v.id));
    const atRisk = today.filter((s) => s.status === 'in_transit' && s.vehicleId && broken.has(s.vehicleId)).length;
    const unassigned = db.unassigned(undefined, db.tomorrow).sort((a, b) => a.depot.localeCompare(b.depot) || a.windowStart.localeCompare(b.windowStart) || a.id.localeCompare(b.id));
    return {
      version: db.version,
      today: db.today,
      tomorrow: db.tomorrow,
      kpis: {
        tomorrowShipments: tomorrow.length,
        tomorrowUnassigned: unassigned.length,
        tomorrowPallets: tomorrow.reduce((n, s) => n + s.pallets, 0),
        fleetTotal: db.vehicles.length,
        onRoute: db.vehicles.filter((v) => v.status === 'on_route').length,
        available: db.vehicles.filter((v) => v.status === 'available').length,
        outOfService: db.vehicles.filter((v) => v.status === 'maintenance' || v.status === 'breakdown').length,
        onTimePct: today.length ? Math.round(((today.length - atRisk) / today.length) * 100) : 100,
        atRisk,
        openAlerts: db.alerts.filter((a) => a.status === 'open').length,
        driversTexted: db.messages.length,
      },
      unassigned: unassigned.map((s) => ({
        id: s.id,
        customer: s.customer,
        place: s.place,
        depot: DEPOTS[s.depot].city,
        date: s.date,
        pallets: s.pallets,
        weightKg: s.weightKg,
        reefer: s.reefer,
        window: `${s.windowStart}–${s.windowEnd}`,
      })),
      fleet: db.vehicles.map((v) => {
        const load = db.loadOf(v.id);
        const planned = db.shipments.find((s) => s.vehicleId === v.id && s.date === db.tomorrow && s.planId);
        return {
          id: v.id,
          kind: v.kind,
          depot: DEPOTS[v.depot].city,
          status: v.status,
          location: v.location.label,
          driver: v.driver.name,
          drivingLeftMin: v.driver.shiftMinutesLeft,
          cycleLeftMin: v.driver.cycleMinutesLeft,
          capacityPallets: v.capacityPallets,
          palletsOnBoard: load.reduce((n, s) => n + s.pallets, 0),
          stopsToday: load.length,
          tomorrowPlan: planned?.planId ?? null,
        };
      }),
      alerts: db.alerts.slice(0, 8).map((a) => ({ id: a.id, severity: a.severity, title: a.title, body: a.body, vehicleId: a.vehicleId ?? null, runId: a.runId ?? null, createdAt: a.createdAt })),
    };
  }
}
