/**
 * Catalog types shared by the server, the agent tools and the islands (types only, no Node code).
 * Money is always in integer cents (CAD); dates are ISO-8601 strings.
 */

export type Category = 'tents' | 'sleeping-bags' | 'jackets' | 'footwear';

export const CATEGORIES: ReadonlyArray<{ id: Category; name: string; blurb: string }> = [
  { id: 'tents', name: 'Tents', blurb: 'Backpacking and family shelters with real rain numbers.' },
  { id: 'sleeping-bags', name: 'Sleeping bags', blurb: 'Rated with ISO 23537 comfort and limit temperatures.' },
  { id: 'jackets', name: 'Jackets', blurb: 'Shells, down and synthetic insulation, layered for Canadian weather.' },
  { id: 'footwear', name: 'Footwear', blurb: 'Hiking boots, trail shoes and winter boots in US sizes.' },
];

export interface Spec {
  readonly label: string;
  readonly value: string;
}

export interface Variant {
  /** e.g. OG-3101-SPRUCE-M */
  readonly id: string;
  /** What the shopper picks, e.g. "Spruce / M" or "Size 10". */
  readonly label: string;
  readonly colour?: string;
  readonly size?: string;
  /** Hex colour used by the illustration. */
  readonly swatch: string;
}

export interface Product {
  /** e.g. OG-1101 */
  readonly id: string;
  readonly name: string;
  /** The distinctive word shoppers use ("Ridgemarrow", "Harrowind"). */
  readonly model: string;
  readonly category: Category;
  readonly priceCents: number;
  readonly summary: string;
  readonly description: string;
  readonly tags: readonly string[];
  /** Grams (per pair for footwear). */
  readonly weightGrams: number;
  /** Lower-is-warmer limit temperature in °C, where it applies. */
  readonly temperatureC?: number;
  /** Hydrostatic head in mm, where it applies. */
  readonly waterproofMm?: number;
  readonly insulation?: 'down' | 'synthetic' | 'none';
  readonly capacity?: number;
  readonly specs: readonly Spec[];
  readonly variants: readonly Variant[];
}

/** A product as shown in cards and returned by tools: with live stock per variant. */
export interface ProductCard {
  readonly id: string;
  readonly name: string;
  readonly category: Category;
  readonly priceCents: number;
  readonly summary: string;
  readonly url: string;
  readonly art: string;
  readonly highlights: readonly Spec[];
  readonly variants: ReadonlyArray<{ id: string; label: string; size?: string; stock: number }>;
}

export interface CartLine {
  readonly variantId: string;
  readonly productId: string;
  readonly name: string;
  readonly option: string;
  readonly quantity: number;
  readonly unitCents: number;
  readonly lineCents: number;
  readonly art: string;
}

export interface CartView {
  readonly lines: readonly CartLine[];
  readonly itemCount: number;
  readonly subtotalCents: number;
  readonly shippingCents: number;
  readonly taxCents: number;
  readonly totalCents: number;
}

export type OrderStatus = 'processing' | 'shipped' | 'delivered' | 'return_started';

export interface Order {
  readonly id: string;
  readonly placedAt: string;
  readonly status: OrderStatus;
  readonly lines: readonly CartLine[];
  readonly subtotalCents: number;
  readonly shippingCents: number;
  readonly taxCents: number;
  readonly totalCents: number;
  readonly carrier: string;
  readonly trackingNumber?: string;
  readonly estimatedDelivery: string;
  readonly deliveredAt?: string;
  readonly returnId?: string;
}
