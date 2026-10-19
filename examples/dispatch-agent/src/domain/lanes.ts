import type { DepotCode } from './geography';

/** Corridors Demo Freight sells capacity on (both directions price the same). */
export type Lane = 'Toronto-Montreal' | 'Toronto-Ottawa' | 'Ottawa-Montreal' | 'Toronto-Kingston' | 'Montreal-Quebec City' | 'Ottawa-Kingston';

export const LANES: Readonly<Record<Lane, { readonly origin: DepotCode; readonly km: number }>> = {
  'Toronto-Montreal': { origin: 'TOR', km: 541 },
  'Toronto-Ottawa': { origin: 'TOR', km: 450 },
  'Ottawa-Montreal': { origin: 'OTT', km: 200 },
  'Toronto-Kingston': { origin: 'TOR', km: 263 },
  'Montreal-Quebec City': { origin: 'MTL', km: 253 },
  'Ottawa-Kingston': { origin: 'OTT', km: 196 },
};

export const BASE_CENTS = 15_000;
export const CENTS_PER_PALLET_KM = 12;
export const REEFER_SURCHARGE = 0.25;
export const FUEL_SURCHARGE = 0.18;
export const MAX_KG_PER_PALLET = 1_100;

/** Linehaul price in cents: base + pallet-km, reefer surcharge, then fuel surcharge. */
export function linehaulCents(lane: Lane, pallets: number, refrigerated: boolean): number {
  const core = BASE_CENTS + pallets * LANES[lane].km * CENTS_PER_PALLET_KM;
  const withReefer = refrigerated ? core * (1 + REEFER_SURCHARGE) : core;
  return Math.round(withReefer * (1 + FUEL_SURCHARGE));
}
