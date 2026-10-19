import { Eager, PostConstruct, Singleton } from 'amoxi';
import { KnowledgeBases } from 'amoxi/ai';

export interface Guide {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly summary: string;
  readonly text: string;
}

/** Gear-buying guides and store policies: the assistant's knowledge base ("guides"). */
export const GUIDES: readonly Guide[] = [
  {
    id: 'returns-policy',
    title: 'Returns and exchanges policy',
    url: '/guides/returns-policy',
    summary: '30 days from delivery, unused or lightly tried indoors, free return labels in Canada.',
    text: `Demo Outdoor Store returns policy.

You can return or exchange anything within 30 days of delivery. The 30-day return window starts on the delivery date shown in your order, not the order date. After 30 days we can't accept a return, but manufacturing defects are still covered by our 2-year warranty.

Items must be unused: clothing unwashed with tags attached, footwear tried on indoors only (clean soles), tents and sleeping bags not used outdoors. Sleeping bags must be returned in their original stuff sack.

Return labels are free anywhere in Canada. Start a return with the assistant or from your order; you get a return code to show at any parcel counter within 14 days. Refunds go to the original payment method within 5 business days of the parcel being scanned. Shipping charges are refunded only if the item was faulty or we sent the wrong item.

Exchanges for a different size are free and ship as soon as the return is scanned.`,
  },
  {
    id: 'shipping',
    title: 'Shipping and delivery',
    url: '/guides/shipping',
    summary: 'Free shipping over $150 CAD, otherwise $15; 3 to 6 business days across Canada.',
    text: `Shipping and delivery.

Shipping is free on orders of $150 CAD or more; smaller orders ship for a flat $15. Orders placed before 2 p.m. Eastern ship the same business day. Ground delivery takes 3 to 6 business days to most of Canada and up to 10 days to the territories. Prices are in Canadian dollars and include no duties. The demo checkout charges 13% HST (Ontario); the real rate depends on the delivery province.`,
  },
  {
    id: 'sleeping-bag-ratings',
    title: 'How to read sleeping bag temperature ratings',
    url: '/guides/sleeping-bag-ratings',
    summary: 'Comfort vs limit temperature (ISO 23537), and how to pick a rating for your trip.',
    text: `How to read sleeping bag temperature ratings.

Our bags are tested to ISO 23537. The comfort temperature is the lowest temperature at which a typical cold sleeper stays comfortable in a relaxed position. The limit temperature is the lowest temperature at which a typical warm sleeper sleeps curled up for eight hours without waking cold. Product names use the limit rating, for example the Larchmere -7°C.

Rule of thumb: choose a bag whose comfort rating is at or below the coldest night you expect. If you sleep cold, use the comfort number; if you sleep warm, you can lean towards the limit number. Add about 3°C of warmth with a liner, and always pair the bag with an insulated sleeping pad: a cold ground steals more heat than the air.

For Canadian shoulder seasons (May and September in the mountains) a -7°C limit bag is the most versatile choice. For summer car camping a 10°C bag is plenty. Winter camping needs -18°C or colder.`,
  },
  {
    id: 'down-vs-synthetic',
    title: 'Down or synthetic insulation?',
    url: '/guides/down-vs-synthetic',
    summary: 'Down is lighter and packs smaller; synthetic keeps insulating when wet and costs less.',
    text: `Down or synthetic insulation?

Down (measured in fill power, such as 800-fill) gives the most warmth for its weight, compresses smallest and lasts for decades with care. Its weakness is moisture: wet down clumps and stops insulating, even with a water-resistant treatment. Choose down for cold, dry trips where weight matters: alpine backpacking, winter camping in dry cold.

Synthetic insulation is heavier and bulkier for the same warmth, but it keeps most of its warmth when damp, dries quickly and costs less. Choose synthetic for wet climates and water trips: West Coast hiking, canoe trips, multi-day rain, and for anyone who prefers an animal-free option. Synthetic jackets are also good as active insulation because they breathe while you move.

All our down is certified to the Responsible Down Standard (RDS).`,
  },
  {
    id: 'waterproofing',
    title: 'Waterproof ratings explained',
    url: '/guides/waterproofing',
    summary: 'Hydrostatic head in mm: what 3,000 mm vs 20,000 mm means for tents and jackets.',
    text: `Waterproof ratings explained.

Waterproofing is measured as hydrostatic head in millimetres: the height of a water column the fabric holds back before it leaks. For tent flies, 1,500 mm is shower-proof, 3,000 mm handles steady rain and 4,000 mm or more is storm-ready. Tent floors need more (5,000 mm and up) because you kneel and lie on them.

For jackets, 10,000 mm is waterproof for most hiking and city use; 20,000 mm suits all-day rain and West Coast trips. Breathability (g/m²/24h) matters as much: 15,000 g or more keeps you drier inside on climbs. Water-resistant (DWR) jackets, like most down hoodies, shed light rain but are not waterproof.

Re-apply a DWR finish when water stops beading on the surface.`,
  },
  {
    id: 'boot-fit',
    title: 'Fitting hiking boots',
    url: '/guides/boot-fit',
    summary: 'Fit at the end of the day, with hiking socks, and leave a thumb-width at the toe.',
    text: `Fitting hiking boots and trail shoes.

Try boots on at the end of the day when your feet are largest, wearing the socks you hike in. You want a thumb-width of space in front of your longest toe and a heel that doesn't lift as you walk uphill. All Demo Outdoor Store footwear is in US men's sizes. The Trailvane Mid fits true to size; the Screevane Runner runs half a size small, so size up; the Muskvane winter boot is roomy for thick socks.

New leather boots need 20 to 30 km of easy walking before a long trip. Footwear can be returned within 30 days if it was only tried on indoors.`,
  },
  {
    id: 'choosing-a-tent',
    title: 'Choosing a backpacking tent',
    url: '/guides/choosing-a-tent',
    summary: 'Capacity, weight, freestanding design and seasons for Canadian trips.',
    text: `Choosing a backpacking tent.

Tent capacity is snug: a 2-person tent fits two sleeping pads with little room for gear, so couples who want space often choose a 3-person tent and split the weight. For backpacking, aim for under 1 kg per person. Freestanding tents pitch on rock slabs and tent platforms, common in Canadian parks. Two doors and two vestibules make a big difference on rainy trips.

Three-season tents cover spring to fall; a 3-season+ tent with steep walls and more guy-outs handles exposed, windy campsites. Car campers should prioritise headroom and a screened porch over weight.`,
  },
];

/**
 * Loads the guides into the "guides" knowledge base at startup (an @Eager bean, so it runs
 * when the app starts). Ingesting chunks, embeds and indexes them; re-ingesting replaces them.
 */
@Singleton()
@Eager()
export class GuideLibrary {
  /** Resolves when the guides are searchable (tests await it). */
  ready: Promise<void> = Promise.resolve();

  constructor(private readonly knowledge: KnowledgeBases) {}

  @PostConstruct()
  load(): void {
    this.ready = this.knowledge
      .get('guides')
      .ingest(GUIDES.map((g) => ({ id: g.id, title: g.title, url: g.url, text: g.text })))
      .then(() => undefined);
  }

  all(): readonly Guide[] {
    return GUIDES;
  }

  get(id: string): Guide | undefined {
    return GUIDES.find((g) => g.id === id);
  }
}
