import { Singleton } from 'amoxi';
import { Tool, type ToolContext, ToolError } from 'amoxi/ai';
import { DEPOTS } from '../domain/geography';
import { LANES, MAX_KG_PER_PALLET, linehaulCents, type Lane } from '../domain/lanes';
import { addDays } from '../domain/seed';
import { OpsDatabase } from '../ops/ops-database';
import { originOf } from './identity';
import { usableVehicles } from '../ops/route-optimizer';

export interface CapacityQuote {
  quoteId: string;
  lane: Lane;
  pickupDate: string;
  deliverBy: string;
  pallets: number;
  weightKg: number;
  refrigerated: boolean;
  capacityAvailable: boolean;
  sparePallets: number;
  earliestPickupDate: string;
  priceCents: number;
  currency: 'CAD';
  validUntil: string;
}

export interface ShipmentTracking {
  shipmentId: string;
  status: string;
  destination: string;
  deliveryDate: string;
  window: string;
  vehicleId: string | null;
  eta: string | null;
  lastPosition: string | null;
  lastPositionAt: string | null;
}

/**
 * Tools partner carriers' agents may use too (exposed over MCP and reachable through A2A):
 * read-only, with nothing private in the output (no driver names or phone numbers).
 */
@Singleton()
export class PartnerTools {
  constructor(private readonly db: OpsDatabase) {}

  /** Spare pallets at the origin depot on a date, after its own deliveries. */
  private spare(lane: Lane, date: string, refrigerated: boolean): number {
    const depot = DEPOTS[LANES[lane].origin];
    const fleet = usableVehicles(this.db.vehicles, depot).filter((v) => (refrigerated ? v.kind === 'reefer' : v.kind !== 'reefer'));
    const capacity = fleet.reduce((n, v) => n + v.capacityPallets, 0);
    const demand = this.db.shipments
      .filter((s) => s.depot === depot.code && s.date === date && s.reefer === refrigerated && s.status !== 'delivered')
      .reduce((n, s) => n + s.pallets, 0);
    return Math.max(0, capacity - demand);
  }

  /**
   * Capacity quote for a lane: price in CAD and whether Demo Freight has room for the pallets on
   * the pickup date (default tomorrow). For partner carriers and brokers.
   */
  @Tool({ readOnly: true, expose: true })
  capacityQuote(
    input: {
      /** Corridor, e.g. Toronto-Montreal (either direction). */
      lane: Lane;
      /**
       * Number of standard 48x40 pallets.
       * @integer
       * @minimum 1
       * @maximum 26
       */
      pallets: number;
      /**
       * Total weight in kilograms.
       * @integer
       * @minimum 1
       * @maximum 20000
       */
      weightKg: number;
      /**
       * Pickup date (yyyy-mm-dd); tomorrow when omitted.
       * @format date
       */
      pickupDate?: string;
      /** Needs a refrigerated trailer. */
      refrigerated?: boolean;
    },
    ctx: ToolContext,
  ): CapacityQuote {
    const refrigerated = input.refrigerated ?? false;
    if (input.weightKg > input.pallets * MAX_KG_PER_PALLET) {
      throw new ToolError(`${input.weightKg} kg on ${input.pallets} pallets is over the ${MAX_KG_PER_PALLET} kg per pallet limit; add pallets or split the load.`);
    }
    const pickupDate = input.pickupDate ?? this.db.tomorrow;
    if (pickupDate < this.db.today) throw new ToolError(`${pickupDate} is in the past.`);
    let earliest = pickupDate;
    for (let i = 0; i < 7 && this.spare(input.lane, earliest, refrigerated) < input.pallets; i++) earliest = addDays(earliest, 1);
    const spare = this.spare(input.lane, pickupDate, refrigerated);
    const quote: CapacityQuote = {
      quoteId: `Q-${LANES[input.lane].origin}-${pickupDate.replace(/-/g, '').slice(2)}-${input.pallets}${refrigerated ? 'R' : ''}`,
      lane: input.lane,
      pickupDate,
      deliverBy: addDays(pickupDate, LANES[input.lane].km > 480 ? 2 : 1),
      pallets: input.pallets,
      weightKg: input.weightKg,
      refrigerated,
      capacityAvailable: spare >= input.pallets,
      sparePallets: spare,
      earliestPickupDate: earliest,
      priceCents: linehaulCents(input.lane, input.pallets, refrigerated),
      currency: 'CAD',
      validUntil: addDays(this.db.today, 2),
    };
    // People in the console get the quote card; partner agents (A2A/MCP) read the data itself.
    if (originOf(ctx.principal, '').source !== 'partner' && ctx.principal != null) ctx.ui('QuoteCard', { ...quote });
    return quote;
  }

  /** Track a shipment by id (e.g. DF-40213): status, truck, ETA and last known position. */
  @Tool({ readOnly: true, expose: true })
  trackShipment(input: {
    /**
     * Shipment id, e.g. DF-40213
     * @pattern ^DF-\d{5}$
     * @patternMessage must look like DF-40213
     */
    shipmentId: string;
  }): ShipmentTracking {
    const s = this.db.shipment(input.shipmentId);
    if (!s) throw new ToolError(`No shipment ${input.shipmentId}. Check the id on the bill of lading.`);
    const v = s.vehicleId ? this.db.vehicle(s.vehicleId) : undefined;
    const moving = s.status === 'in_transit' && v;
    return {
      shipmentId: s.id,
      status: s.status === 'in_transit' && v?.status === 'breakdown' ? 'delayed' : s.status,
      destination: `${s.customer}, ${s.place}`,
      deliveryDate: s.date,
      window: `${s.windowStart}-${s.windowEnd}`,
      vehicleId: s.vehicleId ?? null,
      eta: s.eta ?? null,
      lastPosition: moving ? v.location.label : null,
      lastPositionAt: moving ? v.location.updatedAt : null,
    };
  }
}
