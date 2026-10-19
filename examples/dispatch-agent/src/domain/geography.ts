/**
 * Schematic geography of the Ontario/Quebec corridor: depots, water and highways as lat/lon
 * polylines. Pure data and math, shared by the server (distances) and the RoutePlanMap island.
 */

export type DepotCode = 'TOR' | 'MTL' | 'OTT';

export interface LatLon {
  readonly lat: number;
  readonly lon: number;
}

export interface DepotInfo extends LatLon {
  readonly code: DepotCode;
  /** The name the dispatcher uses ("Toronto"). */
  readonly city: 'Toronto' | 'Montreal' | 'Ottawa';
  /** Yard address shown in the UI. */
  readonly yard: string;
}

export const DEPOTS: Readonly<Record<DepotCode, DepotInfo>> = {
  TOR: { code: 'TOR', city: 'Toronto', yard: 'Meadowvale yard, Mississauga', lat: 43.655, lon: -79.665 },
  MTL: { code: 'MTL', city: 'Montreal', yard: 'Lachine yard', lat: 45.445, lon: -73.69 },
  OTT: { code: 'OTT', city: 'Ottawa', yard: 'Merivale yard, Nepean', lat: 45.335, lon: -75.72 },
};

export function depotByCity(city: string): DepotInfo | undefined {
  const c = city.trim().toLowerCase();
  return Object.values(DEPOTS).find((d) => d.city.toLowerCase() === c || d.code.toLowerCase() === c);
}

type Line = ReadonlyArray<readonly [number, number]>;

/** Water bodies as closed polygons [lat, lon]. Schematic, not survey-grade. */
export const WATER: ReadonlyArray<{ name: string; points: Line }> = [
  {
    name: 'Lake Ontario',
    points: [
      [43.28, -79.79], [43.32, -79.79], [43.43, -79.66], [43.55, -79.57], [43.63, -79.4], [43.7, -79.22], [43.8, -79.07],
      [43.86, -78.85], [43.89, -78.65], [43.94, -78.29], [43.95, -78.16], [43.99, -77.73], [43.86, -77.32], [43.95, -76.85],
      [44.2, -76.5], [44.12, -76.33], [43.75, -76.2], [43.46, -76.51], [43.27, -76.98], [43.26, -77.61], [43.37, -77.95],
      [43.34, -78.72], [43.26, -79.07], [43.2, -79.56], [43.23, -79.72],
    ],
  },
  {
    name: 'Lake Simcoe',
    points: [[44.38, -79.62], [44.43, -79.55], [44.57, -79.42], [44.5, -79.21], [44.33, -79.2], [44.24, -79.35], [44.26, -79.47], [44.37, -79.5]],
  },
  {
    name: 'Lake Erie',
    points: [[42.88, -78.9], [42.88, -79.25], [42.82, -79.6], [42.78, -79.95], [42.6, -80.4], [42.3, -80.4], [42.3, -78.9]],
  },
];

/** Rivers as open polylines [lat, lon], drawn with a wide stroke. */
export const RIVERS: ReadonlyArray<{ name: string; points: Line }> = [
  {
    name: 'St. Lawrence River',
    points: [[44.22, -76.48], [44.59, -75.68], [45.01, -74.73], [45.25, -74.13], [45.4, -73.85], [45.47, -73.6], [45.52, -73.53], [45.75, -73.4], [46.05, -73.12], [46.34, -72.54], [46.81, -71.21]],
  },
  {
    name: 'Ottawa River',
    points: [[45.83, -77.11], [45.6, -76.6], [45.43, -76.35], [45.42, -75.7], [45.55, -75.3], [45.61, -74.6], [45.47, -74.09], [45.42, -73.95]],
  },
];

/** Major highways as polylines [lat, lon]. */
export const HIGHWAYS: ReadonlyArray<{ name: string; points: Line }> = [
  {
    name: '401',
    points: [[43.42, -80.45], [43.5, -79.9], [43.63, -79.62], [43.73, -79.45], [43.78, -79.23], [43.89, -78.87], [43.96, -78.3], [44.19, -77.38], [44.26, -76.53], [44.61, -75.7], [45.03, -74.74], [45.47, -73.75]],
  },
  { name: '400', points: [[43.74, -79.54], [44.0, -79.6], [44.38, -79.69]] },
  { name: 'QEW', points: [[43.62, -79.5], [43.45, -79.68], [43.33, -79.8], [43.22, -79.7], [43.17, -79.24], [43.1, -79.07]] },
  { name: '417', points: [[45.35, -76.2], [45.4, -75.7], [45.31, -75.09], [45.55, -74.6], [45.5, -73.8]] },
  { name: '416', points: [[45.3, -75.75], [44.72, -75.52]] },
  { name: 'A-40', points: [[45.5, -73.6], [46.34, -72.6], [46.81, -71.3]] },
];

const R = 6371;
const rad = (d: number): number => (d * Math.PI) / 180;

/** Great-circle distance in km. */
export function haversineKm(a: LatLon, b: LatLon): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Road distance estimate: great-circle distance times a detour factor. */
export function roadKm(a: LatLon, b: LatLon): number {
  return haversineKm(a, b) * 1.25;
}

/** Compass bearing from a to b in degrees [0, 360). */
export function bearing(a: LatLon, b: LatLon): number {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
