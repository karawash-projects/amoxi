import { Singleton } from 'amoxi';
import { artUrl } from '../catalog/art';
import { Catalog } from '../catalog/catalog';
import type { CartLine, Order } from '../catalog/model';
import { CartService, totals } from './cart';

export const RETURN_WINDOW_DAYS = 30;
const DAY = 86_400_000;

/** The time source; tests replace it to move the calendar. */
@Singleton()
export class Clock {
  now(): Date {
    return new Date();
  }
}

export interface ReturnEligibility {
  readonly orderId: string;
  readonly eligible: boolean;
  readonly reason: string;
  readonly deliveredAt?: string;
  readonly windowEndsAt?: string;
  readonly refundCents?: number;
}

export interface ReturnReceipt {
  readonly returnId: string;
  readonly orderId: string;
  readonly refundCents: number;
  readonly lines: ReadonlyArray<{ name: string; option: string; quantity: number }>;
  readonly dropOffBy: string;
  readonly instructions: string;
}

/**
 * Orders and returns, per shopper. Every new shopper starts with three demo orders (one in
 * transit, one recently delivered, one delivered outside the return window) so tracking and
 * returns can be tried straight away.
 */
@Singleton()
export class OrderService {
  private readonly orders = new Map<string, Map<string, Order>>();
  private next = 30411;
  private nextReturn = 7101;

  constructor(
    private readonly catalog: Catalog,
    private readonly carts: CartService,
    private readonly clock: Clock,
  ) {}

  list(shopper: string): Order[] {
    return [...this.book(shopper).values()].sort((a, b) => b.placedAt.localeCompare(a.placedAt));
  }

  get(shopper: string, orderId: string): Order | undefined {
    return this.book(shopper).get(orderId.trim().toUpperCase());
  }

  /** Turns the cart into an order: takes stock (all or nothing), then empties the cart. */
  place(shopper: string): Order {
    const cart = this.carts.view(shopper);
    if (cart.lines.length === 0) throw new Error('The cart is empty: add something before checking out.');
    this.catalog.take(cart.lines);
    const now = this.clock.now();
    const order: Order = {
      id: `DS-${this.next++}`,
      placedAt: now.toISOString(),
      status: 'processing',
      lines: cart.lines,
      subtotalCents: cart.subtotalCents,
      shippingCents: cart.shippingCents,
      taxCents: cart.taxCents,
      totalCents: cart.totalCents,
      carrier: 'Canada-wide ground (demo)',
      estimatedDelivery: new Date(now.getTime() + 5 * DAY).toISOString().slice(0, 10),
    };
    this.book(shopper).set(order.id, order);
    this.carts.clear(shopper);
    return order;
  }

  eligibility(shopper: string, orderId: string): ReturnEligibility {
    const order = this.get(shopper, orderId);
    const id = orderId.trim().toUpperCase();
    if (!order) return { orderId: id, eligible: false, reason: `No order ${id} was found for this shopper.` };
    if (order.returnId) return { orderId: id, eligible: false, reason: `A return (${order.returnId}) is already open for ${id}.` };
    if (order.status !== 'delivered' || !order.deliveredAt) {
      return { orderId: id, eligible: false, reason: `${id} hasn't been delivered yet (status: ${order.status}). Returns open once it arrives.` };
    }
    const ends = new Date(new Date(order.deliveredAt).getTime() + RETURN_WINDOW_DAYS * DAY);
    const refundCents = order.subtotalCents + order.taxCents - Math.round(order.shippingCents * 1.13);
    if (this.clock.now() > ends) {
      return {
        orderId: id,
        eligible: false,
        reason: `${id} was delivered on ${order.deliveredAt.slice(0, 10)}; the ${RETURN_WINDOW_DAYS}-day return window closed on ${ends.toISOString().slice(0, 10)}. Warranty claims are still possible.`,
        deliveredAt: order.deliveredAt,
        windowEndsAt: ends.toISOString(),
      };
    }
    return { orderId: id, eligible: true, reason: `Within the ${RETURN_WINDOW_DAYS}-day window (until ${ends.toISOString().slice(0, 10)}).`, deliveredAt: order.deliveredAt, windowEndsAt: ends.toISOString(), refundCents };
  }

  /** Opens a return for a whole order, enforcing the returns policy. */
  startReturn(shopper: string, orderId: string): ReturnReceipt {
    const check = this.eligibility(shopper, orderId);
    if (!check.eligible) throw new Error(`Return refused: ${check.reason}`);
    const order = this.get(shopper, orderId)!;
    const returnId = `RMA-${this.nextReturn++}`;
    this.book(shopper).set(order.id, { ...order, status: 'return_started', returnId });
    return {
      returnId,
      orderId: order.id,
      refundCents: check.refundCents!,
      lines: order.lines.map((l) => ({ name: l.name, option: l.option, quantity: l.quantity })),
      dropOffBy: new Date(this.clock.now().getTime() + 14 * DAY).toISOString().slice(0, 10),
      instructions: 'Show the return code at any Canada-wide parcel counter. The refund goes back to the original payment within 5 business days of the parcel being scanned.',
    };
  }

  private book(shopper: string): Map<string, Order> {
    let book = this.orders.get(shopper);
    if (!book) {
      book = new Map(this.history().map((o) => [o.id, o]));
      this.orders.set(shopper, book);
    }
    return book;
  }

  private history(): Order[] {
    const now = this.clock.now().getTime();
    const at = (days: number): string => new Date(now - days * DAY).toISOString();
    const line = (variantId: string, quantity: number): CartLine => {
      const { product, variant } = this.catalog.variant(variantId)!;
      return { variantId, productId: product.id, name: product.name, option: variant.label, quantity, unitCents: product.priceCents, lineCents: product.priceCents * quantity, art: artUrl(product.id, variantId) };
    };
    const order = (id: string, placed: number, lines: CartLine[], extra: Partial<Order>): Order => {
      const t = totals(lines);
      return { id, placedAt: at(placed), status: 'delivered', lines, subtotalCents: t.subtotalCents, shippingCents: t.shippingCents, taxCents: t.taxCents, totalCents: t.totalCents, carrier: 'Canada-wide ground (demo)', estimatedDelivery: at(placed - 4).slice(0, 10), ...extra };
    };
    return [
      order('DS-24502', 3, [line('OG-3102-M', 1)], { status: 'shipped', trackingNumber: '7741 2290 5531', estimatedDelivery: at(-2).slice(0, 10) }),
      order('DS-24388', 13, [line('OG-2102-REG', 1)], { trackingNumber: '7741 1093 2210', deliveredAt: at(8) }),
      order('DS-24017', 56, [line('OG-3104-M', 1), line('OG-4104-10', 1)], { trackingNumber: '7740 8812 0042', deliveredAt: at(50) }),
    ];
  }
}
