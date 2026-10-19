import type { Category, Product, Spec, Variant } from './model';

/**
 * The Demo Outdoor Store demo catalog: 16 fictional products in four categories, with
 * variants and a deterministic opening stock. Prices are integer cents (CAD).
 */

const SWATCH: Record<string, string> = {
  Sage: '#7E9A7A',
  Ember: '#C8532B',
  Slate: '#56677A',
  Sand: '#C9B48A',
  Spruce: '#2F5D50',
  Glacier: '#7FA7C2',
  Lichen: '#A9B54A',
  Basalt: '#3B3F45',
  Loon: '#1F2A36',
  Moss: '#5E6B3A',
  Driftwood: '#8C7A63',
};

const colours = (productId: string, names: string[]): Variant[] =>
  names.map((c) => ({ id: `${productId}-${c.toUpperCase()}`, label: c, colour: c, swatch: SWATCH[c] }));

const sizes = (productId: string, colour: string, list: string[], prefix = ''): Variant[] =>
  list.map((s) => ({ id: `${productId}-${prefix}${s}`, label: `Size ${s}`, size: s, colour, swatch: SWATCH[colour] }));

const colourSizes = (productId: string, colourNames: string[], list: string[]): Variant[] =>
  colourNames.flatMap((c) =>
    list.map((s) => ({ id: `${productId}-${c.toUpperCase()}-${s}`, label: `${c} / ${s}`, colour: c, size: s, swatch: SWATCH[c] })),
  );

const lengths = (productId: string, colour: string): Variant[] => [
  { id: `${productId}-REG`, label: 'Regular (fits to 183 cm)', size: 'Regular', colour, swatch: SWATCH[colour] },
  { id: `${productId}-LONG`, label: 'Long (fits to 198 cm)', size: 'Long', colour, swatch: SWATCH[colour] },
];

const s = (label: string, value: string): Spec => ({ label, value });

interface Seed extends Omit<Product, 'category'> {
  readonly stock: Record<string, number>;
}

function product(category: Category, p: Seed): Product & { stock: Record<string, number> } {
  return { ...p, category };
}

const JACKET_SIZES = ['S', 'M', 'L', 'XL'];
const SHOE_SIZES = ['8', '9', '10', '11', '12'];

export const SEED_PRODUCTS: ReadonlyArray<Product & { stock: Record<string, number> }> = [
  // Tents -------------------------------------------------------------------------------------
  product('tents', {
    id: 'OG-1101',
    name: 'Ridgemarrow 2 Backpacking Tent',
    model: 'Ridgemarrow',
    priceCents: 44900,
    summary: 'Freestanding 2-person, 3-season tent with two doors and a 3,000 mm fly.',
    description:
      'The Ridgemarrow 2 pitches fly-first in the rain, has two doors and two vestibules so nobody climbs over anybody, and packs to the size of a 1-litre bottle. Colour-coded clips and a single hubbed pole set.',
    tags: ['backpacking', 'hiking', '2-person', 'two person', 'lightweight', '3-season', 'waterproof', 'freestanding'],
    weightGrams: 1620,
    waterproofMm: 3000,
    capacity: 2,
    specs: [s('Sleeps', '2'), s('Season', '3-season'), s('Packed weight', '1.62 kg'), s('Fly', '20D ripstop nylon, 3,000 mm'), s('Floor', '30D nylon, 5,000 mm'), s('Doors / vestibules', '2 / 2'), s('Peak height', '104 cm')],
    variants: colours('OG-1101', ['Sage', 'Ember']),
    stock: { 'OG-1101-SAGE': 14, 'OG-1101-EMBER': 3 },
  }),
  product('tents', {
    id: 'OG-1102',
    name: 'Talvane 3 Trekking Tent',
    model: 'Talvane',
    priceCents: 57900,
    summary: 'Roomy 3-person tent with a steep-walled hubbed frame and 4,000 mm fly.',
    description:
      'Built for windy alpine lakes: steep walls, eight guy-out points and a 4,000 mm silicone-coated fly. Room for three, or two and a dog and all the gear.',
    tags: ['backpacking', 'trekking', '3-person', 'three person', 'family', '3-season', 'waterproof', 'wind', 'alpine'],
    weightGrams: 2350,
    waterproofMm: 4000,
    capacity: 3,
    specs: [s('Sleeps', '3'), s('Season', '3-season+'), s('Packed weight', '2.35 kg'), s('Fly', '30D silnylon, 4,000 mm'), s('Floor', '40D nylon, 8,000 mm'), s('Doors / vestibules', '2 / 2'), s('Peak height', '112 cm')],
    variants: colours('OG-1102', ['Sage', 'Slate']),
    stock: { 'OG-1102-SAGE': 6, 'OG-1102-SLATE': 9 },
  }),
  product('tents', {
    id: 'OG-1103',
    name: 'Quellan 1 Ultralight Tent',
    model: 'Quellan',
    priceCents: 52900,
    summary: 'Semi-freestanding solo shelter under a kilogram, pitched with one pole.',
    description:
      'For long trails where every gram counts. A single-wall-feel double-wall tent with a full mesh inner, one pole and a 2,000 mm ultralight laminate fly.',
    tags: ['ultralight', 'solo', '1-person', 'one person', 'thru-hike', 'backpacking', 'lightweight', 'hiking'],
    weightGrams: 980,
    waterproofMm: 2000,
    capacity: 1,
    specs: [s('Sleeps', '1'), s('Season', '3-season'), s('Packed weight', '0.98 kg'), s('Fly', 'Ultralight laminate, 2,000 mm'), s('Floor', '20D nylon, 3,000 mm'), s('Doors / vestibules', '1 / 1'), s('Peak height', '98 cm')],
    variants: colours('OG-1103', ['Slate']),
    stock: { 'OG-1103-SLATE': 5 },
  }),
  product('tents', {
    id: 'OG-1104',
    name: 'Lochvane 4 Family Dome',
    model: 'Lochvane',
    priceCents: 38900,
    summary: 'Stand-up 4-person car-camping dome with a big screened porch.',
    description:
      'A campground basecamp: you can stand up in the middle, the porch keeps boots and bugs out, and it survives a lakeshore thunderstorm with its 3,000 mm polyester fly.',
    tags: ['car camping', 'family', 'tent', '4-person', 'four person', 'campground', 'basecamp', 'waterproof'],
    weightGrams: 4900,
    waterproofMm: 3000,
    capacity: 4,
    specs: [s('Sleeps', '4'), s('Season', '3-season'), s('Packed weight', '4.90 kg'), s('Fly', '68D polyester, 3,000 mm'), s('Floor', '150D polyester, 5,000 mm'), s('Doors / vestibules', '2 / 1 screened porch'), s('Peak height', '185 cm')],
    variants: colours('OG-1104', ['Sand', 'Sage']),
    stock: { 'OG-1104-SAND': 8, 'OG-1104-SAGE': 4 },
  }),

  // Sleeping bags -------------------------------------------------------------------------------
  product('sleeping-bags', {
    id: 'OG-2101',
    name: 'Larchmere -7°C Down Sleeping Bag',
    model: 'Larchmere',
    priceCents: 41900,
    summary: '800-fill responsibly sourced down for shoulder-season nights, 1.05 kg.',
    description:
      'Our best warmth-to-weight bag for spring and fall trips: 800-fill-power down with a water-resistant treatment, a draft collar and a full-length two-way zip.',
    tags: ['down', 'backpacking', 'lightweight', 'shoulder season', '3-season', 'mummy', 'warm'],
    weightGrams: 1050,
    temperatureC: -7,
    insulation: 'down',
    specs: [s('Insulation', '800-fill down (RDS)'), s('Comfort / limit', '-1°C / -7°C'), s('Weight', '1.05 kg (Regular)'), s('Shape', 'Mummy'), s('Shell', '15D nylon, DWR'), s('Packed size', '18 × 30 cm')],
    variants: lengths('OG-2101', 'Glacier'),
    stock: { 'OG-2101-REG': 7, 'OG-2101-LONG': 2 },
  }),
  product('sleeping-bags', {
    id: 'OG-2102',
    name: 'Driftmere 0°C Synthetic Sleeping Bag',
    model: 'Driftmere',
    priceCents: 18900,
    summary: 'Synthetic fill that keeps insulating when damp. Canoe-trip proof.',
    description:
      'Continuous-filament synthetic insulation stays warm when wet, dries fast and forgives being stuffed into a damp canoe pack day after day.',
    tags: ['synthetic', 'canoe', 'paddling', 'wet', 'budget', '3-season', 'mummy', 'damp'],
    weightGrams: 1400,
    temperatureC: 0,
    insulation: 'synthetic',
    specs: [s('Insulation', 'Continuous-filament synthetic'), s('Comfort / limit', '5°C / 0°C'), s('Weight', '1.40 kg (Regular)'), s('Shape', 'Mummy'), s('Shell', '30D polyester, DWR'), s('Packed size', '23 × 38 cm')],
    variants: lengths('OG-2102', 'Lichen'),
    stock: { 'OG-2102-REG': 18, 'OG-2102-LONG': 9 },
  }),
  product('sleeping-bags', {
    id: 'OG-2103',
    name: 'Frostvane -18°C Expedition Bag',
    model: 'Frostvane',
    priceCents: 64900,
    summary: 'Winter camping bag with 750-fill down, baffled zip and a cinch hood.',
    description:
      'For winter camping and northern trips: 750-fill down, a baffled zip and collar, and a roomier cut so you can sleep with your water bottle and boot liners inside.',
    tags: ['down', 'winter', 'expedition', 'cold', 'warm', '4-season', 'snow'],
    weightGrams: 1850,
    temperatureC: -18,
    insulation: 'down',
    specs: [s('Insulation', '750-fill down (RDS)'), s('Comfort / limit', '-11°C / -18°C'), s('Weight', '1.85 kg (Regular)'), s('Shape', 'Relaxed mummy'), s('Shell', '20D nylon, DWR'), s('Packed size', '24 × 40 cm')],
    variants: lengths('OG-2103', 'Ember'),
    stock: { 'OG-2103-REG': 4, 'OG-2103-LONG': 1 },
  }),
  product('sleeping-bags', {
    id: 'OG-2104',
    name: 'Summerwisp 10°C Sleeping Bag',
    model: 'Summerwisp',
    priceCents: 10900,
    summary: 'Light synthetic summer bag that unzips into a quilt.',
    description: 'For July nights and cabin bunks: a rectangular synthetic bag that unzips flat into a quilt and machine-washes at home.',
    tags: ['synthetic', 'summer', 'budget', 'cabin', 'car camping', 'quilt'],
    weightGrams: 850,
    temperatureC: 10,
    insulation: 'synthetic',
    specs: [s('Insulation', 'Synthetic'), s('Comfort / limit', '14°C / 10°C'), s('Weight', '0.85 kg (Regular)'), s('Shape', 'Rectangular, opens to quilt'), s('Shell', '40D polyester'), s('Packed size', '20 × 35 cm')],
    variants: lengths('OG-2104', 'Moss'),
    stock: { 'OG-2104-REG': 22, 'OG-2104-LONG': 11 },
  }),

  // Jackets -------------------------------------------------------------------------------------
  product('jackets', {
    id: 'OG-3101',
    name: 'Harrowind Down Hoody',
    model: 'Harrowind',
    priceCents: 32900,
    summary: '850-fill down hoody, 360 g, packs into its own pocket.',
    description:
      'A warm layer for cold camps and summit breaks: 850-fill down in a 10D shell with a water-resistant finish. Down is the lightest warmth there is, but keep it dry under a shell in steady rain.',
    tags: ['down', 'insulated', 'warm', 'lightweight', 'packable', 'puffy', 'hoody', 'water-resistant'],
    weightGrams: 360,
    insulation: 'down',
    specs: [s('Insulation', '850-fill down (RDS), 110 g'), s('Shell', '10D nylon, DWR (water-resistant)'), s('Weight', '360 g (M)'), s('Fit', 'Trim, layers over a base layer'), s('Packs into', 'Chest pocket')],
    variants: colourSizes('OG-3101', ['Spruce', 'Ember'], JACKET_SIZES),
    stock: {
      'OG-3101-SPRUCE-S': 3, 'OG-3101-SPRUCE-M': 8, 'OG-3101-SPRUCE-L': 6, 'OG-3101-SPRUCE-XL': 2,
      'OG-3101-EMBER-S': 2, 'OG-3101-EMBER-M': 5, 'OG-3101-EMBER-L': 1, 'OG-3101-EMBER-XL': 0,
    },
  }),
  product('jackets', {
    id: 'OG-3102',
    name: 'Squallmere 3L Rain Shell',
    model: 'Squallmere',
    priceCents: 28900,
    summary: 'Fully waterproof 3-layer shell, 20,000 mm, pit zips, helmet-compatible hood.',
    description:
      'Our waterproof workhorse for West Coast trails: a 3-layer membrane rated 20,000 mm with 15,000 g breathability, fully taped seams, pit zips and a hood that adjusts with one hand.',
    tags: ['waterproof', 'rain', 'shell', 'hiking', 'breathable', 'west coast', 'storm', 'hardshell'],
    weightGrams: 410,
    waterproofMm: 20000,
    insulation: 'none',
    specs: [s('Waterproofing', '20,000 mm, 3-layer membrane'), s('Breathability', '15,000 g/m²/24h'), s('Weight', '410 g (M)'), s('Seams', 'Fully taped'), s('Venting', 'Pit zips')],
    variants: sizes('OG-3102', 'Glacier', JACKET_SIZES),
    stock: { 'OG-3102-S': 7, 'OG-3102-M': 11, 'OG-3102-L': 9, 'OG-3102-XL': 4 },
  }),
  product('jackets', {
    id: 'OG-3103',
    name: 'Ptarvane Synthetic Parka',
    model: 'Ptarvane',
    priceCents: 37900,
    summary: 'Waterproof insulated parka with synthetic fill that stays warm when wet.',
    description:
      'A city-to-trailhead winter parka: 200 g synthetic insulation that keeps working in sleet, a 10,000 mm waterproof shell and a hip-length cut with a two-way zip.',
    tags: ['synthetic', 'insulated', 'winter', 'waterproof', 'parka', 'warm', 'wet', 'city'],
    weightGrams: 980,
    waterproofMm: 10000,
    insulation: 'synthetic',
    specs: [s('Insulation', '200 g synthetic'), s('Waterproofing', '10,000 mm, 2.5-layer'), s('Weight', '980 g (M)'), s('Comfort range', 'Down to about -20°C when active'), s('Length', 'Hip')],
    variants: sizes('OG-3103', 'Basalt', JACKET_SIZES),
    stock: { 'OG-3103-S': 4, 'OG-3103-M': 6, 'OG-3103-L': 5, 'OG-3103-XL': 3 },
  }),
  product('jackets', {
    id: 'OG-3104',
    name: 'Switchmarrow Grid Fleece',
    model: 'Switchmarrow',
    priceCents: 11900,
    summary: 'Breathable grid-fleece midlayer for cool starts and layering.',
    description: 'The midlayer you never take off: grid fleece that breathes on climbs and adds warmth under a shell. Thumb loops, a zip chest pocket and no feathers to worry about.',
    tags: ['fleece', 'midlayer', 'breathable', 'layering', 'budget', 'hiking'],
    weightGrams: 340,
    insulation: 'synthetic',
    specs: [s('Fabric', '100% recycled polyester grid fleece'), s('Weight', '340 g (M)'), s('Fit', 'Regular'), s('Pockets', '2 hand, 1 chest')],
    variants: sizes('OG-3104', 'Lichen', JACKET_SIZES),
    stock: { 'OG-3104-S': 12, 'OG-3104-M': 15, 'OG-3104-L': 13, 'OG-3104-XL': 8 },
  }),

  // Footwear ------------------------------------------------------------------------------------
  product('footwear', {
    id: 'OG-4101',
    name: 'Trailvane Mid Waterproof Hiking Boot',
    model: 'Trailvane',
    priceCents: 23900,
    summary: 'Waterproof membrane mid boot with a grippy lugged sole. US sizes 8–12.',
    description:
      'A supportive mid-height hiking boot for rocky, wet trails: waterproof breathable membrane, nubuck upper, 5 mm lugs and a stiff-enough shank for loaded packs. Order your usual size; it fits true to size.',
    tags: ['hiking', 'boots', 'boot', 'waterproof', 'backpacking', 'trail', 'mid'],
    weightGrams: 1100,
    waterproofMm: 10000,
    specs: [s('Waterproofing', 'Breathable membrane'), s('Weight', '1.10 kg per pair (US 9)'), s('Upper', 'Nubuck leather and mesh'), s('Sole', '5 mm lugs, rubber'), s('Fit', 'True to size, medium width')],
    variants: sizes('OG-4101', 'Driftwood', SHOE_SIZES),
    stock: { 'OG-4101-8': 4, 'OG-4101-9': 6, 'OG-4101-10': 2, 'OG-4101-11': 5, 'OG-4101-12': 3 },
  }),
  product('footwear', {
    id: 'OG-4102',
    name: 'Screevane Runner Trail Shoe',
    model: 'Screevane',
    priceCents: 17900,
    summary: 'Light, quick-drying trail runner with a rock plate. US sizes 8–12.',
    description: 'For fast hikes and trail runs: a breathable mesh upper that drains, a rock plate for sharp scree and sticky rubber. Not waterproof, by design: it dries in an hour.',
    tags: ['trail', 'running', 'shoes', 'shoe', 'lightweight', 'hiking', 'quick-drying', 'breathable'],
    weightGrams: 590,
    specs: [s('Waterproofing', 'None (drains and dries fast)'), s('Weight', '590 g per pair (US 9)'), s('Drop', '6 mm'), s('Protection', 'Rock plate'), s('Fit', 'Runs half a size small')],
    variants: sizes('OG-4102', 'Ember', SHOE_SIZES),
    stock: { 'OG-4102-8': 5, 'OG-4102-9': 7, 'OG-4102-10': 6, 'OG-4102-11': 4, 'OG-4102-12': 2 },
  }),
  product('footwear', {
    id: 'OG-4103',
    name: 'Muskvane Winter Boot',
    model: 'Muskvane',
    priceCents: 25900,
    summary: 'Insulated waterproof winter boot rated to -32°C. US sizes 8–12.',
    description: 'For snowshoeing, winter camping and February bus stops: a waterproof rubber shell, felt-lined removable liner and a sole that stays soft in the cold.',
    tags: ['winter', 'boots', 'boot', 'snow', 'insulated', 'waterproof', 'cold', 'warm'],
    weightGrams: 1800,
    temperatureC: -32,
    waterproofMm: 20000,
    insulation: 'synthetic',
    specs: [s('Rated to', '-32°C'), s('Waterproofing', 'Rubber shell, seam-sealed'), s('Weight', '1.80 kg per pair (US 9)'), s('Liner', 'Removable felt'), s('Fit', 'Roomy; true to size with thick socks')],
    variants: sizes('OG-4103', 'Loon', SHOE_SIZES),
    stock: { 'OG-4103-8': 3, 'OG-4103-9': 5, 'OG-4103-10': 4, 'OG-4103-11': 3, 'OG-4103-12': 1 },
  }),
  product('footwear', {
    id: 'OG-4104',
    name: 'Portwhistle Camp Sandal',
    model: 'Portwhistle',
    priceCents: 7900,
    summary: 'Strappy water sandal for river crossings and the end of the day.',
    description: 'Wade the creek, walk the portage, wear it round the fire: quick-dry webbing, a toe bumper and a sole that grips wet rock.',
    tags: ['sandal', 'sandals', 'water', 'camp', 'canoe', 'paddling', 'summer', 'budget'],
    weightGrams: 520,
    specs: [s('Weight', '520 g per pair (US 9)'), s('Straps', 'Quick-dry webbing'), s('Sole', 'Wet-grip rubber'), s('Fit', 'Adjustable, true to size')],
    variants: sizes('OG-4104', 'Moss', SHOE_SIZES),
    stock: { 'OG-4104-8': 9, 'OG-4104-9': 12, 'OG-4104-10': 10, 'OG-4104-11': 8, 'OG-4104-12': 5 },
  }),
];
