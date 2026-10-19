import { Singleton } from 'amoxi';
import { artUrl } from '../catalog/art';
import { Catalog } from '../catalog/catalog';
import type { CartLine, CartView } from '../catalog/model';
import { ToolError } from 'amoxi/ai';

export const FREE_SHIPPING_CENTS = 15000;
export const SHIPPING_CENTS = 1500;
/** Demo assumption: shipping to Ontario (13% HST). */
export const TAX_RATE = 0.13;
export const MAX_PER_LINE = 5;

export class CartError extends ToolError {}

/** Shopping carts, per shopper id. In memory for the demo. */
@Singleton()
export class CartService {
  private readonly carts = new Map<string, Map<string, number>>();

  constructor(private readonly catalog: Catalog) {}

  view(shopper: string): CartView {
    const lines: CartLine[] = [];
    for (const [variantId, quantity] of this.carts.get(shopper) ?? []) {
      const found = this.catalog.variant(variantId);
      if (!found) continue;
      lines.push({
        variantId,
        productId: found.product.id,
        name: found.product.name,
        option: found.variant.label,
        quantity,
        unitCents: found.product.priceCents,
        lineCents: found.product.priceCents * quantity,
        art: artUrl(found.product.id, variantId),
      });
    }
    return totals(lines);
  }

  /** Adds to the cart after checking the variant exists and enough stock is left. */
  add(shopper: string, variantId: string, quantity: number): CartView {
    const found = this.catalog.variant(variantId);
    if (!found) throw new CartError(`There is no product variant '${variantId}'. Use a variant id from the product card, e.g. OG-3101-SPRUCE-M.`);
    if (!Number.isInteger(quantity) || quantity < 1) throw new CartError('Quantity must be a whole number of at least 1.');
    const cart = this.carts.get(shopper) ?? new Map<string, number>();
    const next = (cart.get(found.variant.id) ?? 0) + quantity;
    const stock = this.catalog.stockOf(found.variant.id);
    const what = `${found.product.name} (${found.variant.label})`;
    if (stock <= 0) throw new CartError(`${what} is out of stock. Suggest another size or colour.`);
    if (next > stock) throw new CartError(`Only ${stock} of ${what} left in stock${next - quantity > 0 ? ` and ${next - quantity} already in the cart` : ''}.`);
    if (next > MAX_PER_LINE) throw new CartError(`The limit is ${MAX_PER_LINE} of one item per order.`);
    cart.set(found.variant.id, next);
    this.carts.set(shopper, cart);
    return this.view(shopper);
  }

  remove(shopper: string, variantId: string): CartView {
    this.carts.get(shopper)?.delete(variantId.toUpperCase());
    return this.view(shopper);
  }

  clear(shopper: string): void {
    this.carts.delete(shopper);
  }
}

export function totals(lines: CartLine[]): CartView {
  const subtotalCents = lines.reduce((n, l) => n + l.lineCents, 0);
  const shippingCents = subtotalCents === 0 || subtotalCents >= FREE_SHIPPING_CENTS ? 0 : SHIPPING_CENTS;
  const taxCents = Math.round((subtotalCents + shippingCents) * TAX_RATE);
  return {
    lines,
    itemCount: lines.reduce((n, l) => n + l.quantity, 0),
    subtotalCents,
    shippingCents,
    taxCents,
    totalCents: subtotalCents + shippingCents + taxCents,
  };
}

/**
 * What a checkout approval is for: every line (variant, quantity, price) and the total. The order is
 * placed only if the cart still matches the one the shopper was asked to approve.
 */
export type CheckoutSnapshot = { lines: string[]; totalCents: number };

export function checkoutSnapshot(cart: CartView): CheckoutSnapshot {
  return { lines: cart.lines.map((l) => `${l.variantId} x${l.quantity} @${l.unitCents}`).sort(), totalCents: cart.totalCents };
}

export function sameCheckout(a: CheckoutSnapshot, b: CheckoutSnapshot): boolean {
  return a.totalCents === b.totalCents && a.lines.length === b.lines.length && a.lines.every((l, i) => l === b.lines[i]);
}
