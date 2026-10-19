import assert from 'node:assert/strict';
import { test } from 'node:test';
import { A2A_TOKEN, MCP_TOKEN, startShop } from './helpers';

const mcp = (base: string, body: unknown, token: string | null = MCP_TOKEN) =>
  fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

test('MCP: only the public catalog tools are offered, and tools/call search works', async () => {
  const shop = await startShop();
  try {
    assert.equal((await mcp(shop.base, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, null)).status, 401, 'the token is required');
    const list = (await (await mcp(shop.base, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })).json()) as { result: { tools: Array<{ name: string; annotations: { readOnlyHint: boolean } }> } };
    const names = list.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['ask_shopping_assistant', 'compare_products', 'product_details', 'search_products']);
    for (const t of list.result.tools.filter((x) => x.name !== 'ask_shopping_assistant')) assert.equal(t.annotations.readOnlyHint, true);

    const call = (await (
      await mcp(shop.base, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_products', arguments: { query: 'synthetic sleeping bag for a canoe trip', maxPriceCents: 20000 } } })
    ).json()) as { result: { isError: boolean; structuredContent: { products: Array<{ id: string; priceCents: number }> } } };
    assert.equal(call.result.isError, false);
    assert.equal(call.result.structuredContent.products[0].id, 'OG-2102');
    assert.ok(call.result.structuredContent.products.every((p) => p.priceCents <= 20000));

    const hidden = (await (await mcp(shop.base, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'place_order', arguments: {} } })).json()) as { error?: { message: string } };
    assert.match(hidden.error!.message, /Unknown tool/);
  } finally {
    await shop.close();
  }
});

test('A2A: the agent card lists the shopping assistant and a task compares products', async () => {
  const shop = await startShop();
  try {
    const card = (await (await fetch(`${shop.base}/.well-known/agent-card.json`)).json()) as { name: string; skills: Array<{ id: string }> };
    assert.equal(card.name, 'Demo Outdoor Store');
    assert.ok(card.skills.some((s) => s.id === 'shopping-assistant'));
    const res = await fetch(`${shop.base}/a2a`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${A2A_TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { role: 'user', messageId: 'm1', parts: [{ kind: 'text', text: 'Compare the Ridgemarrow 2 and the Talvane 3' }] } } }),
    });
    const body = (await res.json()) as { result: { status: { state: string }; artifacts: Array<{ parts: Array<{ text?: string }> }> } };
    assert.equal(body.result.status.state, 'completed');
    assert.match(JSON.stringify(body.result.artifacts), /Talvane 3 Trekking Tent/);
  } finally {
    await shop.close();
  }
});

test('pages for agents: product .md and JSON carry the data; llms.txt lists every product', async () => {
  const shop = await startShop();
  try {
    const md = await fetch(`${shop.base}/products/OG-4101.md`);
    assert.equal(md.status, 200);
    assert.match(md.headers.get('content-type')!, /text\/markdown/);
    const text = await md.text();
    assert.match(text, /^# Trailvane Mid Waterproof Hiking Boot/m);
    assert.match(text, /\$239\.00/);
    assert.match(text, /Size 10 \| Only 2 left \(2\)/);

    const json = (await (await fetch(`${shop.base}/products/OG-4101`, { headers: { accept: 'application/json' } })).json()) as { title: string; data: { product: any } };
    assert.match(json.title, /Trailvane/);
    assert.equal(json.data.product.priceCents, 23900);
    assert.equal(json.data.product.currency, 'CAD');
    assert.equal(json.data.product.variants.length, 5);

    const category = await (await fetch(`${shop.base}/shop/tents.md`)).text();
    assert.match(category, /Ridgemarrow 2 Backpacking Tent/);
    assert.equal((await fetch(`${shop.base}/products/OG-9999`, { headers: { accept: 'text/html' } })).status, 404);

    const llms = await (await fetch(`${shop.base}/llms.txt`)).text();
    for (const id of ['OG-1101', 'OG-2104', 'OG-3102', 'OG-4104']) assert.ok(llms.includes(`/products/${id}.md`), id);
    assert.match(llms, /\/mcp/);
    assert.match(llms, /agent-card\.json/);
  } finally {
    await shop.close();
  }
});

test('React generative island: server-rendered on the home page, and the assistant page restores a carousel from the transcript', async () => {
  const shop = await startShop();
  try {
    const home = await (await fetch(`${shop.base}/`, { headers: { accept: 'text/html' } })).text();
    const island = home.match(/<amoxi-island data-c="ProductCarousel"[\s\S]*?<\/amoxi-island>/)?.[0] ?? '';
    assert.ok(island, 'the island is on the page');
    assert.match(island, /<section class="carousel"/, 'React rendered it on the server (className -> class)');
    assert.match(island, /Ridgemarrow 2 Backpacking Tent/);
    assert.match(island, /<button type="button" class="btn btn-blaze"[^>]*>Add to cart<\/button>/);
    assert.match(home, /ProductCarousel\.react-[A-Z0-9]+\.js/, 'the browser bundle is referenced for hydration');

    const shopper = shop.client();
    await shopper.say('Show me waterproof jackets under $400');
    const page = await (await shopper.request('/assistant', { headers: { accept: 'text/html' } })).text();
    const data = page.match(/<amoxi-island data-c="ShopAssistant"[^>]*data-p="([^"]*)"/)?.[1] ?? '';
    const props = JSON.parse(data.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'"));
    const ui = props.initial.find((i: { kind: string }) => i.kind === 'ui');
    assert.equal(ui.component, 'ProductCarousel');
    assert.ok(props.threadId);
    assert.match(page, /Squallmere 3L Rain Shell/, 'the restored conversation is rendered on the server');
    // A fresh conversation on request.
    const fresh = await (await shopper.request('/assistant?new=1', { headers: { accept: 'text/html' } })).text();
    assert.doesNotMatch(fresh, /Squallmere 3L Rain Shell/);
  } finally {
    await shop.close();
  }
});
