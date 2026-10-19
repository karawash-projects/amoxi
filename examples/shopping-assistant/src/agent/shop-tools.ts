import { Singleton } from 'amoxi';
import { Tool, type ToolContext, ToolError } from 'amoxi/ai';
import { artUrl } from '../catalog/art';
import { Catalog } from '../catalog/catalog';
import type { Product, Variant } from '../catalog/model';
import { CartError, CartService, checkoutSnapshot, sameCheckout } from '../shop/cart';
import { OrderService } from '../shop/orders';
import { shopperOf } from '../shop/shopper';
import { money, weight } from '../ui/format';
import { profile, sizesFrom, type PreferredSizes } from './preferences';

type CategoryName = 'tents' | 'sleeping-bags' | 'jackets' | 'footwear';

const CATEGORY_LABEL: Record<CategoryName, string> = { tents: 'tents', 'sleeping-bags': 'sleeping bags', jackets: 'jackets', footwear: 'footwear' };

/** A compact product line for the model (the card shows the rest). */
interface ProductBrief {
  id: string;
  name: string;
  priceCents: number;
  available: string;
}

/**
 * The shopping assistant's tools. Read-only catalog tools are also offered to other AI agents
 * over MCP (expose: true); cart, order and return tools act for the shopper of the run
 * (ctx.principal) and are never exposed. Each tool shows its own generative component with
 * show(ctx, ), so the shopper sees cards and tables rather than paragraphs.
 */
@Singleton()
export class ShopTools {
  constructor(
    private readonly catalog: Catalog,
    private readonly carts: CartService,
    private readonly orders: OrderService,
  ) {}

  /**
   * Find and show products from the Demo Outdoor Store catalog (tents, sleeping bags, waterproof and insulated jackets,
   * hiking boots and shoes), filtered by keyword, category and maximum price, as product cards.
   */
  @Tool({ readOnly: true, expose: true })
  async searchProducts(
    input: {
      /** What the shopper is looking for, in their words, e.g. "waterproof jacket for West Coast hiking". */
      query: string;
      /** Only this category. */
      category?: CategoryName;
      /**
       * Highest price in cents (CAD), e.g. 30000 for $300.
       * @integer
       * @minimum 1000
       * @maximum 500000
       */
      maxPriceCents?: number;
    },
    ctx: ToolContext,
  ): Promise<{ message: string; products: ProductBrief[] }> {
    const found = this.catalog.search({ query: input.query, category: input.category, maxPriceCents: input.maxPriceCents, limit: 6 });
    const sizes = await this.sizes(ctx);
    const scope = [input.category ? CATEGORY_LABEL[input.category] : 'products', input.maxPriceCents ? `under ${money(input.maxPriceCents)}` : ''].filter(Boolean).join(' ');
    if (found.length === 0) {
      return { message: `Nothing in the catalog matches that${input.maxPriceCents ? ` under ${money(input.maxPriceCents)}` : ''}. Try fewer words, another category or a higher budget.`, products: [] };
    }
    show(ctx, 'ProductCarousel', {
      title: `${found.length} ${found.length === 1 ? 'match' : 'matches'}${input.maxPriceCents ? ` under ${money(input.maxPriceCents)}` : ''}`,
      products: found.map((p) => this.catalog.card(p)),
      ...(sizes.footwear || sizes.jackets ? { preferredSizes: sizes, note: sizeNote(sizes) } : {}),
    });
    return {
      message: `Showing ${found.length} ${scope} as cards, best match first.`,
      products: found.map((p) => this.brief(p)),
    };
  }

  /** Compare two to four products side by side: price, weight, warmth, waterproofing and fit. */
  @Tool({ readOnly: true, expose: true })
  compareProducts(
    input: {
      /**
       * Product ids, e.g. ["OG-1101", "OG-1102"].
       * @maxItems 4
       */
      productIds?: string[];
      /** Or the products' names in words, e.g. "Ridgemarrow 2 vs Talvane 3". */
      query?: string;
    },
    ctx: ToolContext,
  ): { message: string; products: ProductBrief[] } {
    const picked: Product[] = [];
    for (const id of input.productIds ?? []) {
      const p = this.catalog.get(id) ?? this.catalog.variant(id)?.product;
      if (p && !picked.includes(p)) picked.push(p);
    }
    for (const p of this.catalog.resolveMentions(input.query ?? '')) if (!picked.includes(p)) picked.push(p);
    if (picked.length < 2) {
      throw new ToolError('Name at least two products to compare, by name (Ridgemarrow, Talvane, Harrowind...) or id (OG-1101).');
    }
    const products = picked.slice(0, 4);
    show(ctx, 'ComparisonTable', this.comparison(products));
    return { message: `Compared ${products.map((p) => p.name).join(' and ')} in a table.`, products: products.map((p) => this.brief(p)) };
  }

  /** Full details and live stock per size and colour for one product (details, specs, availability). */
  @Tool({ readOnly: true, expose: true })
  async productDetails(
    input: {
      /** Product id, e.g. OG-3101. */
      productId?: string;
      /** Or the product's name in words, e.g. "Harrowind down hoody". */
      query?: string;
    },
    ctx: ToolContext,
  ): Promise<{ id: string; name: string; priceCents: number; description: string; specs: Array<{ label: string; value: string }>; variants: Array<{ id: string; label: string; stock: number }> }> {
    const p = (input.productId ? (this.catalog.get(input.productId) ?? this.catalog.variant(input.productId)?.product) : undefined) ?? this.catalog.resolveMentions(input.query ?? '')[0];
    if (!p) throw new ToolError('Which product? Give its name (for example "Harrowind") or id (OG-3101).');
    const sizes = await this.sizes(ctx);
    show(ctx, 'ProductCarousel', { title: 'Details and stock', products: [this.catalog.card(p)], expanded: true, ...(sizes.footwear || sizes.jackets ? { preferredSizes: sizes, note: sizeNote(sizes) } : {}) });
    return {
      id: p.id,
      name: p.name,
      priceCents: p.priceCents,
      description: p.description,
      specs: [...p.specs],
      variants: p.variants.map((v) => ({ id: v.id, label: v.label, stock: this.catalog.stockOf(v.id) })),
    };
  }

  /** Add a product to the shopper's cart (checks stock). Pick the size or colour variant, e.g. variant OG-3101-SPRUCE-M. */
  @Tool({ expose: false })
  async addToCart(
    input: {
      /** Variant id from the product card, e.g. OG-4101-10 or OG-3101-SPRUCE-M. */
      variantId?: string;
      /** Or the product, size and colour in words, e.g. "Harrowind hoody, Spruce, size M". */
      query?: string;
      /**
       * How many (default 1).
       * @integer
       * @minimum 1
       * @maximum 5
       */
      quantity?: number;
    },
    ctx: ToolContext,
  ): Promise<{ message: string; itemCount: number; totalCents: number }> {
    const shopper = shopperOf(ctx.principal);
    const variant = await this.pickVariant(input, ctx);
    const quantity = input.quantity ?? 1;
    let cart;
    try {
      cart = this.carts.add(shopper, variant.id, quantity);
    } catch (err) {
      if (err instanceof CartError) throw new ToolError(err.message);
      throw err;
    }
    const line = cart.lines.find((l) => l.variantId === variant.id)!;
    show(ctx, 'CartSummary', { ...cart, lines: [...cart.lines], highlight: variant.id });
    return { message: `Added ${quantity} × ${line.name} (${line.option}). The cart has ${cart.itemCount} item(s).`, itemCount: cart.itemCount, totalCents: cart.totalCents };
  }

  /** Check out: buy everything in the shopper's cart. The shopper approves the total before anything is charged. */
  @Tool({ approval: true, idempotent: true, expose: false })
  async placeOrder(
    input: {
      /**
       * The total the shopper saw, in cents; refused if the cart changed since.
       * @integer
       * @minimum 0
       */
      confirmTotalCents?: number;
    },
    ctx: ToolContext,
  ): Promise<{ message: string; orderId: string; totalCents: number; estimatedDelivery: string }> {
    const shopper = shopperOf(ctx.principal);
    // The cart the shopper approved (recorded by the assistant's beforeToolCall when it asked).
    const approved = await ctx.step('cart-at-approval', () => checkoutSnapshot(this.carts.view(shopper)));
    // Durable step: if the server restarts after the order was placed, the run resumes with
    // this result instead of placing (and charging) a second order.
    const order = await ctx.step('place-order', () => {
      const cart = this.carts.view(shopper);
      if (!sameCheckout(checkoutSnapshot(cart), approved)) {
        throw new ToolError(`The cart changed after the shopper approved ${money(approved.totalCents)}; it is now ${money(cart.totalCents)}. Nothing was ordered. Show the cart again and ask the shopper to approve the new total.`);
      }
      if (input.confirmTotalCents !== undefined && input.confirmTotalCents !== cart.totalCents) {
        throw new ToolError(`The cart total is now ${money(cart.totalCents)}, not ${money(input.confirmTotalCents)}. Show the cart again and ask the shopper to confirm the new total.`);
      }
      ctx.progress('Reserving stock and placing the order…');
      return JSON.parse(JSON.stringify(this.orders.place(shopper)));
    });
    show(ctx, 'OrderConfirmation', {
      kind: 'placed',
      orderId: order.id,
      placedAt: order.placedAt,
      status: order.status,
      lines: order.lines,
      subtotalCents: order.subtotalCents,
      shippingCents: order.shippingCents,
      taxCents: order.taxCents,
      totalCents: order.totalCents,
      estimatedDelivery: order.estimatedDelivery,
    });
    return { message: `Order ${order.id} placed for ${money(order.totalCents)}. Estimated delivery ${order.estimatedDelivery}.`, orderId: order.id, totalCents: order.totalCents, estimatedDelivery: order.estimatedDelivery };
  }

  /** Track an order by its order id like DS-24502: status, carrier, tracking number and delivery date. */
  @Tool({ readOnly: true, expose: false })
  trackOrder(
    input: {
      /** The order id, e.g. DS-24502. */
      orderId: string;
    },
    ctx: ToolContext,
  ): { orderId: string; status: string; estimatedDelivery: string; deliveredAt: string | null; trackingNumber: string | null } {
    const order = this.orders.get(shopperOf(ctx.principal), input.orderId);
    if (!order) throw new ToolError(`No order ${input.orderId.toUpperCase()} for this shopper. Their orders: ${this.orders.list(shopperOf(ctx.principal)).map((o) => o.id).join(', ')}.`);
    show(ctx, 'OrderConfirmation', {
      kind: 'tracking',
      orderId: order.id,
      placedAt: order.placedAt,
      status: order.status,
      lines: [...order.lines],
      subtotalCents: order.subtotalCents,
      shippingCents: order.shippingCents,
      taxCents: order.taxCents,
      totalCents: order.totalCents,
      estimatedDelivery: order.estimatedDelivery,
      ...(order.deliveredAt ? { deliveredAt: order.deliveredAt } : {}),
      ...(order.trackingNumber ? { trackingNumber: order.trackingNumber } : {}),
      ...(order.returnId ? { returnId: order.returnId } : {}),
    });
    return { orderId: order.id, status: order.status.replace('_', ' '), estimatedDelivery: order.estimatedDelivery, deliveredAt: order.deliveredAt?.slice(0, 10) ?? null, trackingNumber: order.trackingNumber ?? null };
  }

  /** Start a refund for a delivered order (whole order). Enforces the 30-day window; the shopper approves first. */
  @Tool({ approval: true, idempotent: true, expose: false })
  async startReturn(
    input: {
      /** The order id, e.g. DS-24388. */
      orderId: string;
      /**
       * Why it's going back (optional), e.g. "too small".
       * @maxLength 200
       */
      reason?: string;
    },
    ctx: ToolContext,
  ): Promise<{ message: string; returnId: string; refundCents: number; dropOffBy: string }> {
    const shopper = shopperOf(ctx.principal);
    const receipt = await ctx.step('start-return', () => JSON.parse(JSON.stringify(this.orders.startReturn(shopper, input.orderId))));
    show(ctx, 'ReturnReceipt', { ...receipt, ...(input.reason ? { reason: input.reason } : {}) });
    return { message: `Return ${receipt.returnId} opened for ${receipt.orderId}; refund ${money(receipt.refundCents)} once the parcel is scanned.`, returnId: receipt.returnId, refundCents: receipt.refundCents, dropOffBy: receipt.dropOffBy };
  }

  /* -------------------------------------------------------------- */

  private brief(p: Product): ProductBrief {
    const inStock = p.variants.filter((v) => this.catalog.stockOf(v.id) > 0);
    const available = inStock.length === 0 ? 'out of stock' : inStock.length === p.variants.length ? 'all options in stock' : `in stock: ${inStock.map((v) => v.size ?? v.colour ?? v.label).join(', ')}`;
    return { id: p.id, name: p.name, priceCents: p.priceCents, available };
  }

  private async sizes(ctx: ToolContext): Promise<PreferredSizes> {
    if (typeof ctx.principal !== 'string') return {};
    return sizesFrom(await profile(ctx.memory));
  }

  /** Resolves the variant from an id, or from product + size/colour words, or the remembered size. */
  private async pickVariant(input: { variantId?: string; query?: string }, ctx: ToolContext): Promise<Variant> {
    const text = `${input.variantId ?? ''} ${input.query ?? ''}`;
    const idMatch = text.toUpperCase().match(/\bFH-\d{4}(?:-[A-Z0-9]+)+/);
    if (idMatch) {
      const found = this.catalog.variant(idMatch[0]);
      if (found) return found.variant;
    }
    const product = (input.variantId ? this.catalog.get(input.variantId) : undefined) ?? this.catalog.resolveMentions(text)[0];
    if (!product) throw new ToolError('Which product? Give the variant id from the card (e.g. OG-4101-10) or the product name and size.');
    let options = [...product.variants];
    if (options.length === 1) return options[0];
    const lower = ` ${text.toLowerCase().replace(/[^a-z0-9.]+/g, ' ')} `;
    const colour = options.find((v) => v.colour && lower.includes(` ${v.colour.toLowerCase()} `))?.colour;
    if (colour) options = options.filter((v) => v.colour === colour);
    const word = lower.match(/\b(?:size|us)\s+([0-9]{1,2}|xs|s|m|l|xl)\b/)?.[1] ?? (/ medium /.test(lower) ? 'm' : / large /.test(lower) ? 'l' : / small /.test(lower) ? 's' : / long /.test(lower) ? 'long' : / regular /.test(lower) ? 'regular' : undefined);
    let size = word?.toUpperCase();
    if (!size && options.some((v) => v.size)) {
      const remembered = await this.sizes(ctx);
      size = product.category === 'footwear' ? remembered.footwear : product.category === 'jackets' ? remembered.jackets : undefined;
    }
    if (size) options = options.filter((v) => v.size?.toUpperCase() === size);
    if (options.length === 1) return options[0];
    const choices = (options.length > 0 ? options : product.variants).map((v) => `${v.label} (${v.id}, ${this.catalog.stockOf(v.id)} left)`).join('; ');
    throw new ToolError(`${product.name} comes in several options; ask the shopper which one: ${choices}.`);
  }

  private comparison(products: Product[]) {
    type Row = { label: string; values: string[]; best?: number };
    const rows: Row[] = [];
    const bestOf = (nums: Array<number | undefined>, lowest: boolean): number | undefined => {
      const valid = nums.map((n, i) => ({ n, i })).filter((x) => x.n !== undefined) as Array<{ n: number; i: number }>;
      if (valid.length < 2) return undefined;
      const target = lowest ? Math.min(...valid.map((x) => x.n)) : Math.max(...valid.map((x) => x.n));
      const winners = valid.filter((x) => x.n === target);
      return winners.length === 1 ? winners[0].i : undefined;
    };
    const add = (label: string, values: string[], best?: number): void => {
      if (values.every((v) => v === '—')) return;
      rows.push({ label, values, ...(best !== undefined ? { best } : {}) });
    };
    add('Price', products.map((p) => money(p.priceCents)), bestOf(products.map((p) => p.priceCents), true));
    add('Weight', products.map((p) => weight(p.weightGrams)), bestOf(products.map((p) => p.weightGrams), true));
    add('Sleeps', products.map((p) => (p.capacity ? String(p.capacity) : '—')), bestOf(products.map((p) => p.capacity), false));
    add('Temperature', products.map((p) => (p.temperatureC !== undefined ? `${p.temperatureC}°C` : '—')), bestOf(products.map((p) => p.temperatureC), true));
    add('Insulation', products.map((p) => (p.insulation === 'down' ? 'Down' : p.insulation === 'synthetic' ? 'Synthetic' : '—')));
    add('Waterproofing', products.map((p) => (p.waterproofMm ? `${p.waterproofMm.toLocaleString('en-CA')} mm` : '—')), bestOf(products.map((p) => p.waterproofMm), false));
    const labels: string[] = [];
    for (const p of products) for (const s of p.specs) if (!labels.includes(s.label) && !/weight/i.test(s.label) && !rows.some((r) => r.label === s.label)) labels.push(s.label);
    for (const label of labels.slice(0, 6)) add(label, products.map((p) => p.specs.find((s) => s.label === label)?.value ?? '—'));
    add('In stock', products.map((p) => `${p.variants.filter((v) => this.catalog.stockOf(v.id) > 0).length} of ${p.variants.length} options`));

    const lightest = bestOf(products.map((p) => p.weightGrams), true);
    const cheapest = bestOf(products.map((p) => p.priceCents), true);
    const verdict =
      lightest !== undefined && lightest === cheapest
        ? [`${products[lightest].model} is both the lightest and the least expensive`]
        : [lightest !== undefined ? `${products[lightest].model} is the lightest` : '', cheapest !== undefined ? `${products[cheapest].model} costs least` : ''].filter(Boolean);
    return {
      products: products.map((p) => ({ id: p.id, name: p.name, priceCents: p.priceCents, url: `/products/${p.id}`, art: artUrl(p.id) })),
      rows,
      ...(verdict.length ? { verdict: `${verdict.join('; ')}.` } : {}),
    };
  }
}

/**
 * Shows a generative component to a shopper. Runs from other agents (A2A, MCP: principal
 * { channel }) have no screen, so they get the data as text and structured output instead.
 */
function show(ctx: ToolContext, component: string, props: Record<string, unknown>): void {
  if (typeof ctx.principal === 'string') ctx.ui(component, props);
}

function sizeNote(sizes: PreferredSizes): string {
  const parts = [sizes.footwear ? `size ${sizes.footwear} in footwear` : '', sizes.jackets ? `${sizes.jackets} in jackets` : ''].filter(Boolean);
  return `Preselected your ${parts.join(' and ')}, from what you told me earlier.`;
}
