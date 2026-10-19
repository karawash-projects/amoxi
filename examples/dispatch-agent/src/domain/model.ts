import type { DepotCode, LatLon } from './geography';

export type ShipmentStatus = 'unassigned' | 'assigned' | 'in_transit' | 'delivered';

export interface Shipment {
  /** e.g. DF-40213 */
  readonly id: string;
  readonly customer: string;
  readonly depot: DepotCode;
  /** Delivery place name, e.g. "Brampton". */
  readonly place: string;
  readonly lat: number;
  readonly lon: number;
  readonly pallets: number;
  readonly weightKg: number;
  /** Needs a refrigerated trailer. */
  readonly reefer: boolean;
  /** Delivery date, ISO yyyy-mm-dd. */
  readonly date: string;
  /** Delivery window, local time "08:00". */
  readonly windowStart: string;
  readonly windowEnd: string;
  status: ShipmentStatus;
  vehicleId?: string;
  planId?: string;
  /** Planned arrival time "10:35" once sequenced. */
  eta?: string;
}

export type VehicleKind = 'dry_van' | 'reefer' | 'straight_truck';
export type VehicleStatus = 'available' | 'on_route' | 'maintenance' | 'breakdown';

export interface Driver {
  readonly id: string;
  readonly name: string;
  /** Minutes of driving left in today's shift (Canadian HOS: 13 h per day). */
  shiftMinutesLeft: number;
  /** Minutes left in the 70 h / 7 day cycle. */
  cycleMinutesLeft: number;
}

export interface Vehicle {
  /** e.g. TRK-214 */
  readonly id: string;
  readonly kind: VehicleKind;
  readonly depot: DepotCode;
  readonly capacityPallets: number;
  readonly capacityKg: number;
  status: VehicleStatus;
  location: LatLon & { label: string; updatedAt: string };
  readonly driver: Driver;
}

export interface PlannedStop {
  readonly shipmentId: string;
  readonly customer: string;
  readonly place: string;
  readonly lat: number;
  readonly lon: number;
  readonly pallets: number;
  readonly eta: string;
  readonly windowEnd: string;
  readonly late: boolean;
}

export interface PlannedRoute {
  readonly vehicleId: string;
  readonly driver: string;
  readonly kind: VehicleKind;
  readonly stops: PlannedStop[];
  readonly km: number;
  readonly durationMin: number;
  readonly limitMin: number;
  readonly pallets: number;
  readonly capacityPallets: number;
  readonly weightKg: number;
}

export interface HeldStop {
  readonly shipmentId: string;
  readonly place: string;
  readonly lat: number;
  readonly lon: number;
  readonly reason: string;
}

export type PlanStatus = 'draft' | 'assigned';

export interface RoutePlan {
  readonly id: string;
  readonly depot: DepotCode;
  readonly date: string;
  readonly createdAt: string;
  readonly routes: PlannedRoute[];
  readonly held: HeldStop[];
  readonly totalKm: number;
  /** Kilometres saved by the 2-opt pass. */
  readonly savedKm: number;
  status: PlanStatus;
  assignedAt?: string;
}

/** A text message to a driver, as recorded by the (simulated) SMS gateway. */
export interface DriverMessage {
  readonly id: string;
  /** Deduplication key: the gateway never sends two messages with the same key. */
  readonly idempotencyKey: string;
  readonly vehicleId: string;
  readonly driver: string;
  readonly text: string;
  readonly sentAt: string;
}

export type AlertSeverity = 'critical' | 'warning' | 'info';

export interface OpsAlert {
  readonly id: string;
  readonly severity: AlertSeverity;
  readonly vehicleId?: string;
  readonly title: string;
  readonly body: string;
  /** The agent run that raised it. */
  readonly runId?: string;
  readonly createdAt: string;
  status: 'open' | 'resolved';
}

export type IncidentType = 'breakdown' | 'delay' | 'temperature_alarm';

/** A telematics event as recorded by the ops database. */
export interface IncidentRecord {
  readonly id: string;
  readonly vehicleId: string;
  readonly type: IncidentType;
  readonly location: string;
  readonly note?: string;
  readonly occurredAt: string;
  readonly receivedAt: string;
  runId?: string;
}
