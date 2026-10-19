import { Body, Cached, Controller, Delete, Get, HttpError, HttpResponse, PathParam, Post, QueryParam, type RequestContext } from 'amoxi';
import { MemoryService } from 'amoxi/ai';
import { profile } from '../agent/preferences';
import { Catalog } from '../catalog/catalog';
import type { Category } from '../catalog/model';
import { CartError, CartService, totals } from './cart';
import { OrderService } from './orders';
import { shopperId } from './shopper';

export interface AddItemRequest {
  /**
   * Variant id, e.g. OG-3101-SPRUCE-M
   * @pattern ^OG-\d{4}(-[A-Za-z0-9]+)+$
   * @patternMessage must be a variant id like OG-3101-SPRUCE-M
   */
  readonly variantId: string;
  /**
   * @integer
   * @minimum 1
   * @maximum 5
   */
  readonly quantity: number;
}

const CATEGORIES = new Set<Category>(['tents', 'sleeping-bags', 'jackets', 'footwear']);

/**
 * JSON API used by the islands (cart, orders, profile) and by any client that prefers plain
 * HTTP to MCP (the public catalog). Per-shopper endpoints read the shopper id from the session.
 */
@Controller('/api')
export class ShopApi {
  constructor(
    private readonly catalog: Catalog,
    private readonly carts: CartService,
    private readonly orders: OrderService,
    private readonly memory: MemoryService,
  ) {}

  /** The public catalog with live stock; filter with q, category and maxPriceCents. */
  @Get('/products')
  @Cached(10, { staleWhileRevalidate: 30 })
  products(@QueryParam() q?: string, @QueryParam() category?: string, @QueryParam() maxPriceCents?: number) {
    const cat = category && CATEGORIES.has(category as Category) ? (category as Category) : undefined;
    const list = q || cat || maxPriceCents ? this.catalog.search({ query: q, category: cat, maxPriceCents, limit: 50 }) : this.catalog.all();
    return { currency: 'CAD', products: list.map((p) => this.catalog.card(p)) };
  }

  /** The shopper's cart with shipping, tax and total. */
  @Get('/cart')
  cart(ctx: RequestContext) {
    const shopper = shopperId(ctx, false);
    return shopper ? this.carts.view(shopper) : totals([]);
  }

  /** Adds a variant to the cart (409 when there isn't enough stock). */
  @Post('/cart/items')
  add(@Body() body: AddItemRequest, ctx: RequestContext) {
    try {
      return this.carts.add(shopperId(ctx)!, body.variantId, body.quantity);
    } catch (err) {
      if (err instanceof CartError) throw new HttpError(409, err.message);
      throw err;
    }
  }

  @Delete('/cart/items/:variantId')
  remove(@PathParam() variantId: string, ctx: RequestContext) {
    const shopper = shopperId(ctx, false);
    return shopper ? this.carts.remove(shopper, variantId) : totals([]);
  }

  /** The shopper's orders, newest first. */
  @Get('/orders')
  list(ctx: RequestContext) {
    const shopper = shopperId(ctx, false);
    const orders = shopper ? this.orders.list(shopper) : [];
    return { orders: orders.map((o) => ({ id: o.id, placedAt: o.placedAt, status: o.status, totalCents: o.totalCents, itemCount: o.lines.reduce((n, l) => n + l.quantity, 0) })) };
  }

  /** Whether an order can still be returned under the 30-day policy. */
  @Get('/orders/:orderId/return-eligibility')
  eligibility(@PathParam() orderId: string, ctx: RequestContext) {
    const shopper = shopperId(ctx, false);
    if (!shopper) throw new HttpError(404, 'Order not found');
    return this.orders.eligibility(shopper, orderId);
  }

  /** What the assistant remembers about this shopper. */
  @Get('/profile')
  async profile(ctx: RequestContext) {
    const shopper = shopperId(ctx, false);
    if (!shopper) return { memories: [] };
    const items = await profile(this.memory.for(`principal:${shopper}`));
    return { memories: items.map((m) => ({ id: m.id, text: m.text, createdAt: m.createdAt })) };
  }

  /** Forgets one remembered fact (the shopper stays in control of their profile). */
  @Delete('/profile/memories/:id')
  async forget(@PathParam() id: string, ctx: RequestContext) {
    const shopper = shopperId(ctx, false);
    if (shopper) await this.memory.for(`principal:${shopper}`).forget(id);
    return HttpResponse.noContent();
  }
}
