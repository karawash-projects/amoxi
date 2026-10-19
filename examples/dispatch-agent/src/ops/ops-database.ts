import { Singleton } from 'amoxi';
import { DEPOTS, type DepotCode } from '../domain/geography';
import type { DriverMessage, IncidentRecord, OpsAlert, RoutePlan, Shipment, Vehicle } from '../domain/model';
import { addDays, localDate, seed } from '../domain/seed';
import { ToolError } from 'amoxi/ai';

/**
 * The operations database: shipments, fleet, route plans, driver messages and alerts.
 *
 * In memory and seeded deterministically for the demo. It stands in for the TMS database a
 * real carrier runs (PostgreSQL, Oracle...): tests share one instance between two application
 * instances to simulate a restart against the same database.
 */
@Singleton()
export class OpsDatabase {
  readonly today: string;
  readonly shipments: Shipment[];
  readonly vehicles: Vehicle[];
  readonly plans = new Map<string, RoutePlan>();
  readonly messages: DriverMessage[] = [];
  readonly alerts: OpsAlert[] = [];
  readonly incidents: IncidentRecord[] = [];
  private planSeq = 2040;
  private alertSeq = 700;
  private incidentSeq = 9100;
  private messageSeq = 0;
  /** Bumped on every change, so the console knows when to refresh. */
  version = 1;

  constructor() {
    const now = new Date();
    const data = seed(now);
    this.today = localDate(now);
    this.shipments = data.shipments;
    this.vehicles = data.vehicles;
    this.alerts.push({
      id: `AL-${++this.alertSeq}`,
      severity: 'info',
      vehicleId: 'TRK-421',
      title: 'TRK-421 in the shop until Thursday',
      body: 'Brake service at Lachine bay 3. Excluded from Montreal planning.',
      createdAt: new Date(now.getTime() - 3 * 3600_000).toISOString(),
      status: 'open',
    });
  }

  get tomorrow(): string {
    return addDays(this.today, 1);
  }

  touch(): void {
    this.version++;
  }

  vehicle(id: string): Vehicle | undefined {
    return this.vehicles.find((v) => v.id === id.toUpperCase());
  }

  shipment(id: string): Shipment | undefined {
    return this.shipments.find((s) => s.id === id.toUpperCase());
  }

  unassigned(depot?: DepotCode, date?: string): Shipment[] {
    return this.shipments.filter((s) => s.status === 'unassigned' && (!depot || s.depot === depot) && (!date || s.date === date));
  }

  /** Open freight on a vehicle today (not yet delivered). */
  loadOf(vehicleId: string): Shipment[] {
    return this.shipments.filter((s) => s.vehicleId === vehicleId && s.date === this.today && (s.status === 'in_transit' || s.status === 'assigned'));
  }

  nextPlanId(): string {
    let id: string;
    do id = `PLN-${++this.planSeq}`;
    while (this.plans.has(id));
    return id;
  }

  /** Inserts or replaces a draft plan (idempotent: a resumed planning run re-saves the same plan). */
  savePlan(plan: RoutePlan): RoutePlan {
    const existing = this.plans.get(plan.id);
    if (existing && existing.status === 'assigned') return existing;
    this.plans.set(plan.id, plan);
    const n = Number(plan.id.slice(4));
    if (Number.isFinite(n) && n > this.planSeq) this.planSeq = n;
    this.touch();
    return plan;
  }

  plan(id: string): RoutePlan | undefined {
    return this.plans.get(id.toUpperCase());
  }

  /**
   * Assigns every routed shipment of a draft plan to its vehicle. Applying an already assigned
   * plan changes nothing, so a retried approval can never double-book a truck.
   */
  assignPlan(id: string): { plan: RoutePlan; changed: number; alreadyAssigned: boolean } {
    const plan = this.plan(id);
    if (!plan) throw new ToolError(`Plan ${id} doesn't exist. Plan the routes first.`);
    if (plan.status === 'assigned') return { plan, changed: 0, alreadyAssigned: true };
    const stale = plan.routes.flatMap((r) => r.stops).filter((s) => this.shipment(s.shipmentId)?.status !== 'unassigned');
    if (stale.length > 0) {
      throw new ToolError(`Plan ${plan.id} is out of date: ${stale.map((s) => s.shipmentId).join(', ')} were assigned elsewhere. Plan the routes again.`);
    }
    let changed = 0;
    for (const route of plan.routes) {
      for (const stop of route.stops) {
        const s = this.shipment(stop.shipmentId)!;
        s.status = 'assigned';
        s.vehicleId = route.vehicleId;
        s.planId = plan.id;
        s.eta = stop.eta;
        changed++;
      }
    }
    plan.status = 'assigned';
    plan.assignedAt = new Date().toISOString();
    this.touch();
    return { plan, changed, alreadyAssigned: false };
  }

  /** The SMS gateway's record: one message per idempotency key, ever. */
  sendMessage(input: { idempotencyKey: string; vehicleId: string; driver: string; text: string }): { message: DriverMessage; duplicate: boolean } {
    const prior = this.messages.find((m) => m.idempotencyKey === input.idempotencyKey);
    if (prior) return { message: prior, duplicate: true };
    const message: DriverMessage = { id: `SMS-${String(++this.messageSeq).padStart(4, '0')}`, ...input, sentAt: new Date().toISOString() };
    this.messages.push(message);
    this.touch();
    return { message, duplicate: false };
  }

  raiseAlert(input: Omit<OpsAlert, 'id' | 'createdAt' | 'status'>): OpsAlert {
    if (input.runId) {
      const prior = this.alerts.find((a) => a.runId === input.runId);
      if (prior) return prior;
    }
    const alert: OpsAlert = { id: `AL-${++this.alertSeq}`, ...input, createdAt: new Date().toISOString(), status: 'open' };
    this.alerts.unshift(alert);
    this.touch();
    return alert;
  }

  recordIncident(input: Omit<IncidentRecord, 'id' | 'receivedAt'>): IncidentRecord {
    const incident: IncidentRecord = { id: `EV-${++this.incidentSeq}`, ...input, receivedAt: new Date().toISOString() };
    this.incidents.unshift(incident);
    const v = this.vehicle(input.vehicleId);
    if (v && input.type === 'breakdown') v.status = 'breakdown';
    if (v) v.location = { ...v.location, label: input.location, updatedAt: input.occurredAt };
    this.touch();
    return incident;
  }

  /** Moves today's open freight from one vehicle to another. */
  reassign(fromId: string, toId: string, shipmentIds?: readonly string[]): Shipment[] {
    const moving = this.loadOf(fromId).filter((s) => !shipmentIds || shipmentIds.includes(s.id));
    for (const s of moving) {
      s.vehicleId = toId;
      s.status = 'in_transit';
    }
    const to = this.vehicle(toId);
    if (to && to.status === 'available' && moving.length > 0) to.status = 'on_route';
    this.touch();
    return moving;
  }

  depotName(code: DepotCode): string {
    return DEPOTS[code].city;
  }
}
