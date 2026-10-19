import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ToolContext } from 'amoxi/ai';
import { ShopTools } from '../src/agent/shop-tools';
import { Catalog } from '../src/catalog/catalog';
import { CartService } from '../src/shop/cart';
import { OrderService } from '../src/shop/orders';
import { resultsOf, startShop, toolsOf, uiOf } from './helpers';

// Offline model (no API key): each suggested prompt must reach the intended tool.

test('offline: "waterproof jackets under $400" shows a ProductCarousel of matching jackets', async () => {
  const shop = await startShop();
  try {
    const events = await shop.client().say('Show me waterproof jackets under $400');
    assert.deepEqual(toolsOf(events), ['search_products']);
    const started = events.find((e) => e.event === 'tool.started')!;
    assert.equal(started.data.input.category, 'jackets');
    assert.equal(started.data.input.maxPriceCents, 40000);
    const [carousel] = uiOf(events, 'ProductCarousel');
    const ids = carousel.products.map((p: { id: string }) => p.id);
    assert.deepEqual(ids.sort(), ['OG-3102', 'OG-3103']);
    for (const p of carousel.products) {
      assert.equal(p.category, 'jackets');
      assert.ok(p.priceCents <= 40000);
      assert.ok(p.variants.every((v: { stock: number }) => typeof v.stock === 'number'), 'live stock per variant');
    }
    assert.equal(events.at(-1)!.event, 'run.completed');
  } finally {
    await shop.close();
  }
});

test('offline: "compare X and Y" shows a ComparisonTable with the best value marked', async () => {
  const shop = await startShop();
  try {
    const events = await shop.client().say('Compare the Ridgemarrow 2 and the Talvane 3');
    assert.deepEqual(toolsOf(events), ['compare_products']);
    const [table] = uiOf(events, 'ComparisonTable');
    assert.deepEqual(table.products.map((p: { id: string }) => p.id), ['OG-1101', 'OG-1102']);
    const price = table.rows.find((r: { label: string }) => r.label === 'Price');
    assert.deepEqual(price.values, ['$449.00', '$579.00']);
    assert.equal(price.best, 0);
    assert.equal(table.rows.find((r: { label: string }) => r.label === 'Sleeps').best, 1);
    assert.match(table.verdict, /Ridgemarrow/);
  } finally {
    await shop.close();
  }
});

test('offline: guide questions are answered from the knowledge base (RAG) with titles', async () => {
  const shop = await startShop();
  try {
    const events = await shop.client().say('Search the guides: down or synthetic insulation for wet trips?');
    assert.deepEqual(toolsOf(events), ['search_knowledge']);
    const [result] = resultsOf(events, 'search_knowledge');
    assert.equal(result.output.results[0].title, 'Down or synthetic insulation?');
    assert.match(events.at(-1)!.data.output, /synthetic/i);
  } finally {
    await shop.close();
  }
});

test('memory: "remember I wear size 10" is saved, recalled into the instructions, and preselects the size', async () => {
  const shop = await startShop([
    { toolCalls: [{ name: 'remember', input: { fact: 'Wears size 10 hiking boots; prefers synthetic insulation' } }] },
    { text: 'Noted: size 10, synthetic.' },
    { toolCalls: [{ name: 'search_products', input: { query: 'hiking boots', category: 'footwear' } }] },
    { text: 'Here are boots in your size.' },
  ]);
  try {
    const shopper = shop.client();
    const first = await shopper.say('Remember that I wear size 10 and prefer synthetic insulation');
    assert.deepEqual(toolsOf(first), ['remember']);
    const later = await shopper.say('Which hiking boots would fit me?');
    const system = shop.model!.requests[2].system ?? '';
    assert.match(system, /Wears size 10 hiking boots/, 'the memory is in the next run\'s instructions');
    const [carousel] = uiOf(later, 'ProductCarousel');
    assert.equal(carousel.preferredSizes.footwear, '10');
    const profile = (await (await shopper.request('/api/profile')).json()) as { memories: Array<{ text: string }> };
    assert.equal(profile.memories.length, 1);
    // Another shopper doesn't see it.
    const other = (await (await shop.client().request('/api/profile')).json()) as { memories: unknown[] };
    assert.deepEqual(other.memories, []);
  } finally {
    await shop.close();
  }
});

test('cart: adding validates the variant and the stock left (API and agent tool)', async () => {
  const shop = await startShop();
  try {
    const shopper = shop.client();
    const add = (variantId: string, quantity: number) => shopper.request('/api/cart/items', { method: 'POST', body: JSON.stringify({ variantId, quantity }) });
    assert.equal((await add('OG-4101-10', 2)).status, 200, 'two size-10 Trailvanes are left');
    const over = await add('OG-4101-10', 1);
    assert.equal(over.status, 409);
    assert.match(((await over.json()) as { error: string }).error, /Only 2 .* left .* 2 already in the cart/);
    assert.equal((await add('nonsense', 1)).status, 400, 'body validated from the TypeScript type');
    // Through the agent: a sold-out option is refused with a reason the model can relay.
    const events = await shopper.say('Add the Harrowind hoody in Ember, size XL, to my cart');
    const [result] = resultsOf(events, 'add_to_cart');
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.output), /out of stock/);
    const cart = (await (await shopper.request('/api/cart')).json()) as { itemCount: number };
    assert.equal(cart.itemCount, 2);
  } finally {
    await shop.close();
  }
});

test('checkout: approval first, then the order is placed, stock taken and product pages revalidated', async () => {
  const shop = await startShop();
  try {
    const shopper = shop.client();
    const page = async (path: string, accept = 'text/html') => {
      const res = await fetch(shop.base + path, { headers: { accept } });
      return { cache: res.headers.get('x-amoxi-cache'), body: await res.text() };
    };
    assert.match((await page('/products/OG-3101')).body, /Spruce \/ M<\/th><td>In stock \(8\)/);
    assert.equal((await page('/products/OG-3101')).cache, 'HIT', 'the product page is cached');
    assert.match((await page('/products/OG-3101.md')).body, /Spruce \/ M \| In stock \(8\)/);

    await shopper.say('Add the Harrowind hoody in Spruce, size M, to my cart');
    const asked = await shopper.say('Place my order');
    const approval = asked.find((e) => e.event === 'approval.required')!;
    assert.equal(approval.data.tool, 'place_order');
    assert.equal(asked.at(-1)!.data.status, 'awaiting_approval');
    assert.equal(shop.app.context.getBean(Catalog).stockOf('OG-3101-SPRUCE-M'), 8, 'nothing happens before approval');

    const done = await shopper.decide(asked, true);
    const [confirmation] = uiOf(done, 'OrderConfirmation');
    assert.equal(confirmation.kind, 'placed');
    assert.match(confirmation.orderId, /^DS-\d+$/);
    assert.equal(confirmation.totalCents, 37177);
    assert.equal(shop.app.context.getBean(Catalog).stockOf('OG-3101-SPRUCE-M'), 7);
    const fresh = await page('/products/OG-3101');
    assert.equal(fresh.cache, 'MISS', 'revalidatePath cleared the cached page');
    assert.match(fresh.body, /Spruce \/ M<\/th><td>In stock \(7\)/);
    assert.match((await page('/products/OG-3101.md')).body, /In stock \(7\)/, 'and its markdown twin');
    const json = JSON.parse((await page('/products/OG-3101', 'application/json')).body);
    assert.equal(json.data.product.variants.find((v: { id: string }) => v.id === 'OG-3101-SPRUCE-M').stock, 7, 'and its JSON representation');
    const cart = (await (await shopper.request('/api/cart')).json()) as { itemCount: number };
    assert.equal(cart.itemCount, 0);
    const orders = (await (await shopper.request('/api/orders')).json()) as { orders: Array<{ id: string }> };
    assert.equal(orders.orders[0].id, confirmation.orderId);
  } finally {
    await shop.close();
  }
});

test('checkout: a cart changed after the approval was requested is not ordered', async () => {
  const shop = await startShop();
  try {
    const shopper = shop.client();
    await shopper.say('Add the Harrowind hoody in Spruce, size M, to my cart');
    const asked = await shopper.say('Place my order');
    assert.equal(asked.find((e) => e.event === 'approval.required')!.data.tool, 'place_order');
    // Another tab adds a second item while the approval card is open.
    const added = await shopper.request('/api/cart/items', { method: 'POST', body: JSON.stringify({ variantId: 'OG-4104-9', quantity: 1 }) });
    assert.ok(added.ok, `adding to the cart failed: ${added.status}`);
    const ordersOf = async () => ((await (await shopper.request('/api/orders')).json()) as { orders: unknown[] }).orders.length;
    const before = await ordersOf();
    const done = await shopper.decide(asked, true);
    const result = done.find((e) => e.event === 'tool.completed' && e.data.tool === 'place_order')!;
    assert.equal(result.data.isError, true);
    assert.match(JSON.stringify(result.data.output), /cart changed after the shopper approved/);
    assert.equal(uiOf(done, 'OrderConfirmation').length, 0);
    assert.equal(await ordersOf(), before, 'no new order');
    assert.equal(shop.app.context.getBean(Catalog).stockOf('OG-3101-SPRUCE-M'), 8, 'no stock taken');
  } finally {
    await shop.close();
  }
});

test('checkout is idempotent: a resumed run replays ctx.step instead of ordering twice', async () => {
  const shop = await startShop();
  try {
    const { context } = shop.app;
    const tools = context.getBean(ShopTools);
    const catalog = context.getBean(Catalog);
    context.getBean(CartService).add('SH-RESUMED01', 'OG-2102-REG', 2);
    const steps = new Map<string, unknown>();
    const ui: string[] = [];
    const ctx = {
      principal: 'SH-RESUMED01',
      ui: (component: string) => ui.push(component),
      progress: () => undefined,
      step: async (key: string, fn: () => unknown) => {
        if (!steps.has(key)) steps.set(key, await fn());
        return steps.get(key);
      },
    } as unknown as ToolContext;
    const first = await tools.placeOrder({}, ctx);
    const again = await tools.placeOrder({}, ctx); // e.g. the server restarted after the side effect
    assert.equal(again.orderId, first.orderId);
    assert.equal(catalog.stockOf('OG-2102-REG'), 16, 'stock taken once (18 - 2)');
    assert.equal(context.getBean(OrderService).list('SH-RESUMED01').filter((o) => o.id === first.orderId).length, 1);
    assert.deepEqual(ui, ['OrderConfirmation', 'OrderConfirmation']);
    // A changed cart total is refused rather than charged.
    context.getBean(CartService).add('SH-RESUMED01', 'OG-4104-9', 1);
    await assert.rejects(tools.placeOrder({ confirmTotalCents: 100 }, { ...ctx, step: async (_k: string, fn: () => unknown) => fn() } as unknown as ToolContext), /cart total is now/);
  } finally {
    await shop.close();
  }
});

test('returns: outside the 30-day window is refused by the guardrail before any approval; inside it opens a return', async () => {
  const shop = await startShop();
  try {
    const shopper = shop.client();
    const late = await shopper.say('Start a return for order DS-24017');
    const eligibility = (await (await shopper.request('/api/orders/DS-24017/return-eligibility')).json()) as { eligible: boolean };
    assert.equal(eligibility.eligible, false);
    assert.equal(late.filter((e) => e.event === 'approval.required').length, 0, 'the shopper is not asked to approve a return that would be refused');
    const [result] = resultsOf(late, 'start_return');
    assert.equal(result.isError, true);
    assert.match(result.output.error, /Return refused: .*30-day return window closed/);
    assert.equal(uiOf(late, 'ReturnReceipt').length, 0);
    assert.equal(late.at(-1)!.event, 'run.completed');

    const asked = await shopper.say('Start a return for order DS-24388');
    assert.equal(asked.find((e) => e.event === 'approval.required')!.data.tool, 'start_return');
    const ok = await shopper.decide(asked, true);
    const [receipt] = uiOf(ok, 'ReturnReceipt');
    assert.match(receipt.returnId, /^RMA-\d+$/);
    assert.equal(receipt.refundCents, 21357);
  } finally {
    await shop.close();
  }
});

test('guardrail and ownership: external agents can browse but not buy; conversations stay with their shopper', async () => {
  const shop = await startShop([{ toolCalls: [{ name: 'add_to_cart', input: { variantId: 'OG-1101-SAGE' } }] }, { text: 'I can’t do that from here.' }, { text: 'Hello.' }]);
  try {
    // A run without a shopper (as A2A/MCP create them) hits the beforeToolCall guardrail.
    const run = await shop.platform.startRun({ agent: 'shopping-assistant', input: 'add the Ridgemarrow to a cart', owner: 'a2a', principal: { channel: 'a2a' } });
    for (let i = 0; i < 100 && (await shop.platform.getRun(run.id))!.status !== 'completed'; i++) await new Promise((r) => setTimeout(r, 20));
    const refusal = shop.model!.requests[1].messages.at(-1)!.content[0] as { output: { error: string }; isError: boolean };
    assert.equal(refusal.isError, true);
    assert.match(refusal.output.error, /need a shopper session/);

    const alice = shop.client();
    const events = await alice.say('hi');
    const threadId = events[0].data.threadId;
    assert.equal((await alice.request(`/agents/shopping-assistant/threads/${threadId}`)).status, 200);
    assert.equal((await shop.client().request(`/agents/shopping-assistant/threads/${threadId}`)).status, 404, 'another shopper gets 404');
  } finally {
    await shop.close();
  }
});

test('offline: the message a product card sends ("Add to cart") and order tracking reach the right tools', async () => {
  const shop = await startShop();
  try {
    const shopper = shop.client();
    // Exactly what ProductCarousel sends through the chat when its button is clicked.
    const added = await shopper.say('Add 1 × Trailvane Mid Waterproof Hiking Boot (Size 10) to my cart, variant OG-4101-10');
    assert.deepEqual(toolsOf(added), ['add_to_cart']);
    const [summary] = uiOf(added, 'CartSummary');
    assert.equal(summary.highlight, 'OG-4101-10');
    assert.equal(summary.lines[0].quantity, 1);
    const tracked = await shopper.say('Track my order DS-24502');
    assert.deepEqual(toolsOf(tracked), ['track_order']);
    const [order] = uiOf(tracked, 'OrderConfirmation');
    assert.equal(order.kind, 'tracking');
    assert.equal(order.status, 'shipped');
  } finally {
    await shop.close();
  }
});
