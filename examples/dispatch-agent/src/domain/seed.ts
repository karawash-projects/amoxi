import type { DepotCode } from './geography';
import type { Shipment, Vehicle, VehicleKind } from './model';

/** yyyy-mm-dd in local time (the offline model reads "tomorrow" the same way). */
export function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return localDate(new Date(y, m - 1, d + days, 12));
}

type Row = [id: number, customer: string, place: string, lat: number, lon: number, pallets: number, kg: number, reefer: boolean, window: string];

const W_AM = '08:00-12:00';
const W_DAY = '08:00-17:00';
const W_PM = '12:00-17:00';
const W_EARLY = '07:00-10:00';

/** Tomorrow's unassigned work per depot (fictional customers). */
const TOMORROW: Record<DepotCode, Row[]> = {
  TOR: [
    [40201, 'Larkspire Grocers', 'Brampton', 43.731, -79.762, 6, 4100, false, W_AM],
    [40202, 'Harbourvane Hardware', 'Vaughan', 43.837, -79.508, 8, 5600, false, W_DAY],
    [40203, 'Northwhistle Pharmacy', 'Markham', 43.857, -79.337, 2, 640, false, W_EARLY],
    [40204, 'Cedarvane Building Supply', 'Richmond Hill', 43.882, -79.44, 10, 7900, false, W_DAY],
    [40205, 'Fennimarrow Paper Co.', 'Newmarket', 44.059, -79.461, 5, 3300, false, W_PM],
    [40206, 'Heronvale Beverages', 'Barrie', 44.389, -79.69, 9, 7200, false, W_DAY],
    [40207, 'Saltmarrow Seafoods', 'Scarborough', 43.773, -79.231, 4, 2600, true, W_EARLY],
    [40208, 'Quillvane Office Supply', 'Etobicoke', 43.654, -79.567, 3, 900, false, W_AM],
    [40209, 'Morrowmead Dairy', 'Oshawa', 43.897, -78.865, 7, 5400, true, W_AM],
    [40210, 'Graniteholm Furniture', 'Pickering', 43.838, -79.086, 6, 2900, false, W_PM],
    [40211, 'Kestrelvane Auto Parts', 'Oakville', 43.447, -79.666, 5, 3800, false, W_DAY],
    [40212, 'Brightwhistle Pet Supplies', 'Burlington', 43.325, -79.799, 4, 2200, false, W_AM],
    [40213, 'Tamarvane Outfitters', 'Hamilton', 43.256, -79.869, 6, 3100, false, W_DAY],
    [40214, 'Oxmarrow Electronics', 'St. Catharines', 43.159, -79.246, 3, 1400, false, W_PM],
    [40215, 'Lumenvale Lighting', 'Guelph', 43.545, -80.248, 5, 2700, false, W_DAY],
    [40216, 'Palisvane Textiles', 'Kitchener', 43.451, -80.493, 7, 3900, false, W_PM],
    [40217, 'Willowvane Bakery', 'Milton', 43.518, -79.882, 3, 1500, true, W_EARLY],
    [40218, 'Copperholm Plumbing', 'Cambridge', 43.36, -80.312, 8, 6100, false, W_DAY],
  ],
  MTL: [
    [40301, 'Bellemarre Épicerie', 'Laval', 45.57, -73.692, 6, 4200, false, W_AM],
    [40302, 'Fleuvane Matériaux', 'Longueuil', 45.531, -73.518, 9, 7100, false, W_DAY],
    [40303, 'Maison Corvelle Meubles', 'Brossard', 45.458, -73.466, 5, 2400, false, W_PM],
    [40304, 'Laiterie des Prévanes', 'Terrebonne', 45.7, -73.647, 6, 4800, true, W_EARLY],
    [40305, 'Outils Lavarelle', 'Saint-Jérôme', 45.78, -74.004, 4, 2600, false, W_DAY],
    [40306, 'Papeterie Vaurelle', 'Vaudreuil-Dorion', 45.4, -74.033, 3, 1100, false, W_AM],
    [40307, 'Pièces Auto Richevane', 'Saint-Jean-sur-Richelieu', 45.307, -73.262, 7, 4400, false, W_DAY],
    [40308, 'Boulangerie Granvelle', 'Granby', 45.4, -72.733, 4, 1900, true, W_AM],
    [40309, 'Électrique Bouchevane', 'Boucherville', 45.591, -73.436, 5, 2300, false, W_PM],
  ],
  OTT: [
    [40401, 'Ridgevane Labs', 'Kanata', 45.309, -75.909, 3, 900, false, W_AM],
    [40402, 'Rivane Home Centre', 'Orléans', 45.469, -75.515, 8, 6200, false, W_DAY],
    [40403, 'Outavane Fresh', 'Gatineau', 45.477, -75.701, 5, 3400, true, W_EARLY],
    [40404, 'Barrowmere Books', 'Barrhaven', 45.273, -75.737, 2, 600, false, W_PM],
    [40405, 'Madavane Mill Supply', 'Arnprior', 45.434, -76.353, 6, 4700, false, W_DAY],
    [40406, 'Kemptvane Feed & Seed', 'Kemptville', 45.016, -75.646, 7, 5600, false, W_AM],
    [40407, 'Rockvane Hardware', 'Rockland', 45.546, -75.291, 4, 2500, false, W_PM],
  ],
};

/** Today's loads on vehicles already on the road. */
const TODAY: Array<{ vehicle: string; rows: Row[] }> = [
  {
    vehicle: 'TRK-214',
    rows: [
      [40101, 'Lakevane Hospital Supply', 'Cobourg', 43.959, -78.168, 4, 1800, false, '10:00-13:00'],
      [40102, 'Quintvane Office Interiors', 'Belleville', 44.163, -77.383, 6, 3900, false, '11:00-15:00'],
      [40103, 'Napvane Feed Co-op', 'Napanee', 44.249, -76.951, 5, 4300, false, '12:00-16:00'],
      [40104, 'Limevane Medical', 'Kingston', 44.231, -76.486, 3, 1100, false, '13:00-16:00'],
      [40105, 'Isleward Marine', 'Brockville', 44.59, -75.684, 4, 2700, false, '14:00-18:00'],
    ],
  },
  {
    vehicle: 'TRK-142',
    rows: [
      [40111, 'Shorevane Appliances', 'Mississauga', 43.589, -79.644, 5, 3200, false, '08:00-11:00'],
      [40112, 'Rivervane Cafés', 'Port Credit', 43.551, -79.585, 2, 700, false, '09:00-12:00'],
      [40113, 'Bronvale Marine Supply', 'Oakville', 43.395, -79.716, 4, 2100, false, '11:00-15:00'],
      [40114, 'Aldervane Garden Centre', 'Burlington', 43.31, -79.855, 6, 4200, false, '13:00-17:00'],
    ],
  },
  {
    vehicle: 'TRK-124',
    rows: [
      [40121, 'Danvane Fresh Market', 'Toronto', 43.678, -79.35, 6, 4400, true, '06:00-09:00'],
      [40122, 'Lesvane Creamery', 'Toronto', 43.664, -79.33, 3, 1700, true, '07:00-10:00'],
    ],
  },
  {
    vehicle: 'TRK-415',
    rows: [
      [40131, 'Marché Rosevane', 'Montreal', 45.546, -73.581, 7, 4900, true, '07:00-11:00'],
      [40132, 'Pharmacie Verdelle', 'Verdun', 45.457, -73.57, 2, 500, false, '09:00-13:00'],
      [40133, 'Quincaillerie Anvelle', 'Anjou', 45.606, -73.554, 6, 4100, false, '12:00-16:00'],
    ],
  },
];

function shipment(depot: DepotCode, date: string, r: Row, status: Shipment['status'], vehicleId?: string): Shipment {
  const [start, end] = r[8].split('-');
  return {
    id: `DF-${r[0]}`,
    customer: r[1],
    depot,
    place: r[2],
    lat: r[3],
    lon: r[4],
    pallets: r[5],
    weightKg: r[6],
    reefer: r[7],
    date,
    windowStart: start,
    windowEnd: end,
    status,
    ...(vehicleId ? { vehicleId } : {}),
  };
}

type VRow = [id: string, kind: VehicleKind, depot: DepotCode, pallets: number, kg: number, status: Vehicle['status'], driverId: string, driver: string, shiftMin: number, cycleMin: number, loc: string, lat: number, lon: number];

const VEHICLES: VRow[] = [
  ['TRK-118', 'dry_van', 'TOR', 26, 20000, 'available', 'D-118', 'Dev Ravelund', 780, 2880, 'Meadowvale yard', 43.655, -79.665],
  ['TRK-124', 'reefer', 'TOR', 22, 17000, 'on_route', 'D-124', 'Hélène Gagnerelle', 610, 2400, 'Corvane Ave, Toronto', 43.679, -79.347],
  ['TRK-131', 'straight_truck', 'TOR', 12, 8000, 'available', 'D-131', 'Marcus Belvane', 780, 370, 'Meadowvale yard', 43.655, -79.665],
  ['TRK-142', 'dry_van', 'TOR', 26, 20000, 'on_route', 'D-142', 'Priya Sandravel', 520, 400, 'QEW near Oakville', 43.4, -79.72],
  ['TRK-157', 'straight_truck', 'TOR', 12, 8000, 'available', 'D-157', 'Tomás Orvellano', 780, 3100, 'Meadowvale yard', 43.655, -79.665],
  ['TRK-214', 'dry_van', 'TOR', 26, 20000, 'on_route', 'D-214', 'Aisha Kamarelle', 450, 1900, 'Hwy 401 EB near Port Hope', 43.968, -78.322],
  ['TRK-305', 'reefer', 'TOR', 22, 17000, 'available', 'D-305', 'Owen MacLorran', 780, 2600, 'Meadowvale yard', 43.655, -79.665],
  ['TRK-402', 'dry_van', 'MTL', 26, 20000, 'available', 'D-402', 'Luc Bérivel', 780, 2900, 'Lachine yard', 45.445, -73.69],
  ['TRK-415', 'reefer', 'MTL', 22, 17000, 'on_route', 'D-415', 'Sofia Petravelou', 560, 2300, 'Rue Belvane E, Montreal', 45.553, -73.574],
  ['TRK-421', 'straight_truck', 'MTL', 12, 8000, 'maintenance', 'D-421', 'Nadia Haddarine', 780, 3000, 'Lachine yard (bay 3)', 45.445, -73.69],
  ['TRK-433', 'straight_truck', 'MTL', 12, 8000, 'available', 'D-433', 'Kenji Wardale', 780, 2700, 'Lachine yard', 45.445, -73.69],
  ['TRK-503', 'dry_van', 'OTT', 26, 20000, 'available', 'D-503', 'Grace Oseiwa', 780, 2950, 'Merivale yard', 45.335, -75.72],
  ['TRK-517', 'reefer', 'OTT', 22, 17000, 'available', 'D-517', 'Rory Kavanloe', 780, 2500, 'Merivale yard', 45.335, -75.72],
];

/** Builds the deterministic demo data for the given "today". */
export function seed(today: Date): { shipments: Shipment[]; vehicles: Vehicle[] } {
  const day = localDate(today);
  const tomorrow = addDays(day, 1);
  const stamp = new Date(today.getTime() - 4 * 60_000).toISOString();
  const vehicles: Vehicle[] = VEHICLES.map((v) => ({
    id: v[0],
    kind: v[1],
    depot: v[2],
    capacityPallets: v[3],
    capacityKg: v[4],
    status: v[5],
    driver: { id: v[6], name: v[7], shiftMinutesLeft: v[8], cycleMinutesLeft: v[9] },
    location: { label: v[10], lat: v[11], lon: v[12], updatedAt: stamp },
  }));
  const shipments: Shipment[] = [];
  for (const depot of Object.keys(TOMORROW) as DepotCode[]) {
    for (const r of TOMORROW[depot]) shipments.push(shipment(depot, tomorrow, r, 'unassigned'));
  }
  for (const load of TODAY) {
    const v = vehicles.find((x) => x.id === load.vehicle)!;
    load.rows.forEach((r, i) => {
      // The first stop of TRK-142 is already delivered; the rest are on the truck.
      const delivered = load.vehicle === 'TRK-142' && i < 2;
      const s = shipment(v.depot, day, r, delivered ? 'delivered' : 'in_transit', v.id);
      s.eta = r[8].split('-')[0];
      shipments.push(s);
    });
  }
  return { shipments, vehicles };
}
