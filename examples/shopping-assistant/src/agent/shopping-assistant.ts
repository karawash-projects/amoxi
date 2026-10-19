import type { RequestContext } from 'amoxi';
import { Agent, MemoryService, type AgentRunContext, type ToolContext } from 'amoxi/ai';
import { CartService, checkoutSnapshot } from '../shop/cart';
import { OrderService, RETURN_WINDOW_DAYS } from '../shop/orders';
import { shopperId, shopperOf } from '../shop/shopper';
import { money } from '../ui/format';
import { profile } from './preferences';
import { ShopTools } from './shop-tools';

/** Tools that act on a shopper's own cart and orders: never for anonymous external agents. */
const SHOPPER_ONLY = new Set(['add_to_cart', 'place_order', 'track_order', 'start_return']);

/**
 * Demo Outdoor Store' shopping assistant: finds and compares gear as product cards and
 * tables, remembers sizes and preferences, keeps the cart, checks out with the shopper's
 * approval, tracks orders and starts returns under the returns policy.
 */
@Agent({
  tools: [ShopTools],
  ui: ['ProductCarousel', 'ComparisonTable', 'CartSummary', 'OrderConfirmation', 'ReturnReceipt'],
  knowledge: ['guides'],
  memory: true,
  examples: [
    'Show me waterproof jackets under $400',
    'Compare the Ridgemarrow 2 and the Talvane 3',
    'Search the guides: down or synthetic insulation for wet trips?',
  ],
})
export class ShoppingAssistant {
  constructor(
    private readonly carts: CartService,
    private readonly orders: OrderService,
    private readonly memory: MemoryService,
  ) {}

  async instructions(ctx: AgentRunContext): Promise<string> {
    const signedIn = typeof ctx.principal === 'string';
    const shopper = shopperOf(ctx.principal);
    const known = signedIn ? await profile(this.memory.for(`principal:${shopper}`)) : [];
    const cart = this.carts.view(shopper);
    const orders = signedIn ? this.orders.list(shopper) : [];
    return [
      `You are the shopping assistant of Demo Outdoor Store, a Canadian outdoor gear store (tents, sleeping bags, jackets, footwear). Today is ${ctx.now.toISOString().slice(0, 10)}. Prices are in Canadian dollars.`,
      'Sell by showing, not telling: use search_products, compare_products and product_details, which show product cards and comparison tables to the shopper, then add one or two sentences of advice. Never invent products, prices, specs or stock: only use what the tools return.',
      'When the shopper mentions a lasting fact (their shoe or jacket size, preferring synthetic insulation, a budget, the trips they do), save it with remember. Use what you remember: preselect their size and respect their preferences.',
      'For buying advice (temperature ratings, down vs synthetic, waterproof ratings, boot fit) and store policies (returns, shipping), search the guides with search_knowledge and cite the guide title.',
      `Checkout: add_to_cart needs a size or colour variant; ask if it's unclear. place_order asks the shopper to approve the total. Returns: whole orders, within ${RETURN_WINDOW_DAYS} days of delivery; start_return refuses anything outside the window.`,
      signedIn
        ? `Shopper ${shopper}. Cart: ${cart.lines.length === 0 ? 'empty' : `${cart.lines.map((l) => `${l.quantity} × ${l.name} (${l.option}, ${l.variantId})`).join('; ')}; total ${money(cart.totalCents)} incl. shipping and tax`}.`
        : 'This request comes from an external agent without a shopper session: you can search, compare and explain, but carts, orders and returns need the shopper to visit the store.',
      orders.length > 0 ? `Their orders: ${orders.map((o) => `${o.id} (${o.status.replace('_', ' ')}${o.deliveredAt ? `, delivered ${o.deliveredAt.slice(0, 10)}` : ''})`).join(', ')}.` : '',
      known.length > 0 ? `Shopper profile (saved preferences):\n${known.map((m) => `- ${m.text}`).join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  /** Tools run in the background: capture the shopper id while the request is here. */
  principal(req: RequestContext): string | undefined {
    return shopperId(req);
  }

  /** Conversations belong to the shopper (one id per browser session). */
  owner(req: RequestContext): string | undefined {
    return shopperId(req);
  }

  /**
   * Guardrails, checked before anything runs (and before the shopper is asked to approve):
   * external agents (MCP/A2A runs, principal { channel }) may browse but not buy, and a return
   * outside the policy window is refused without a pointless confirmation prompt.
   */
  async beforeToolCall(call: { tool: string; input: unknown; ctx: ToolContext }): Promise<string | undefined> {
    const shopper = typeof call.ctx.principal === 'string' ? call.ctx.principal : undefined;
    if (SHOPPER_ONLY.has(call.tool) && !shopper) {
      return 'Carts, orders and returns need a shopper session. Share the product link (for example /products/OG-1101) so the shopper can buy it on demo-store.example.';
    }
    if (call.tool === 'place_order' && shopper) {
      if (this.carts.view(shopper).lines.length === 0) return 'The cart is empty: add something before checking out.';
      // Runs just before the shopper is asked to approve: record the cart they are approving. The step is
      // durable and belongs to this tool call, so place_order compares against it when it runs.
      await call.ctx.step('cart-at-approval', () => checkoutSnapshot(this.carts.view(shopper)));
    }
    if (call.tool === 'start_return' && shopper) {
      const check = this.orders.eligibility(shopper, String((call.input as { orderId?: unknown }).orderId ?? ''));
      if (!check.eligible) return `Return refused: ${check.reason}`;
    }
    return undefined;
  }
}
