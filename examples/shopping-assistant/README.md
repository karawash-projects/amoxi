# Demo Outdoor Store: an AI shopping assistant on Amoxi

A Canadian outdoor gear store (fictional) that sells through a conversation. Shoppers describe the trip; the assistant answers with **product cards, comparison tables, a live cart and order cards** instead of walls of text, remembers sizes and preferences between visits, checks out only after the shopper approves the total, tracks orders and opens returns under the 30-day policy. The same catalog is open to **other people's shopping agents** over MCP, A2A, `llms.txt` and markdown/JSON pages.

Everything runs offline with no API key (a built-in keyword model drives the demo and the tests). Put a key in `.env` and the same app uses a real model.

Demo: fictional brand, products and orders. Nothing is charged or shipped. Prices are in CAD, stored as integer cents.

<!-- screenshots -->
## Screenshots

Taken from this app running with the offline demo model. All data is fictional.

**Products as a carousel**

<img src="../../website/public/shots/retail-assistant-desktop.jpg" alt="Products as a carousel, desktop" width="100%">

**Comparing two products**

<img src="../../website/public/shots/retail-compare-desktop.jpg" alt="Comparing two products, desktop" width="100%">

**Confirming an order**

<img src="../../website/public/shots/retail-order-desktop.jpg" alt="Confirming an order, desktop" width="100%">

On a phone:

| Products as a carousel | Comparing two products | Confirming an order |
|---|---|---|
| <img src="../../website/public/shots/retail-assistant-mobile.jpg" alt="Products as a carousel, phone" width="240"> | <img src="../../website/public/shots/retail-compare-mobile.jpg" alt="Comparing two products, phone" width="240"> | <img src="../../website/public/shots/retail-order-mobile.jpg" alt="Confirming an order, phone" width="240"> |

## What to try

Open `/assistant` and use the suggestion chips (each works with the offline model):

| Prompt | What happens |
|---|---|
| Show me waterproof jackets under $400 | `search_products` → **ProductCarousel** (a React island) with live stock and an option picker |
| Compare the Ridgemarrow 2 and the Talvane 3 | `compare_products` → **ComparisonTable**, best value per row marked |
| Remember "I wear size 10 boots and prefer synthetic insulation" | built-in `remember` tool; appears under "What I remember" (with a Forget button) |
| Show me hiking boots in my size | carousel with size 10 preselected from memory |
| Search the guides: down or synthetic insulation for wet trips? | `search_knowledge` over the buying guides (RAG), titles cited |
| Add the Harrowind hoody in Spruce, size M, to my cart | `add_to_cart` (stock checked) → **CartSummary**; the cart rail updates |
| Place my order | `place_order` pauses for **approval**: the card shows lines and the total; approve → **OrderConfirmation**, stock taken, product pages revalidated |
| Track my order DS-24502 | `track_order` → order card with progress |
| Start a return for order DS-24017 | refused by the `beforeToolCall` guardrail (delivered more than 30 days ago) before the shopper is asked anything. Try DS-24388: approval card with the refund amount, then **ReturnReceipt** |

The generative components are clickable: **Add to cart** on a product card sends the request through the conversation (so the transcript stays the record of what happened), or calls the cart API directly when no chat is on the page or the agent is busy. **Check out**, **Track** and **Return** buttons in the side rail also go through the chat. Reloading `/assistant` restores the conversation server-side, including a checkout still waiting for confirmation.

## Amoxi feature → why it matters in retail

| Amoxi feature | Why it matters for a store |
|---|---|
| Generative UI (`ctx.ui('ProductCarousel', …)`, `@generative` islands, props validated against their TypeScript type) | Shoppers buy from cards, not paragraphs. Tools show the component themselves, so prices and stock come from the catalog, never from the model's prose |
| React islands as generative UI (`ProductCarousel.react.tsx`) | Reuse existing React product components and libraries; React is only downloaded on pages that use it |
| Human approval (`approval: true`) | The shopper confirms the total before an order is placed or a return opened; nothing runs before that. The cart is recorded (`ctx.step` in `beforeToolCall`) when the approval is requested, and the order is refused if the cart changed before it runs |
| Durable runs + `ctx.step()` + `@Tool({ idempotent: true })` | A deploy or crash mid-checkout never places a second order: the resumed run re-runs `place_order` and the recorded step replays instead of ordering again |
| `agentChat({ resume })` | Reloading the page mid-checkout brings back the approval card, and confirming it continues the same run |
| Memory (`memory: true`, `MemoryService`) | Sizes and preferences carry over between visits; shown and forgettable in the UI |
| Knowledge / RAG (`knowledge: ['guides']`) | Answers about temperature ratings, waterproofing and the returns policy come from the store's own guides, with citations |
| `principal()` / `owner()` hooks | Tools run in the background but still act for the right shopper; conversations, carts and orders are per shopper |
| `beforeToolCall` guardrail (runs before approval is requested) | External agents can browse and compare but not buy; returns outside the policy window are refused without a pointless confirmation prompt |
| MCP (`ai.mcp`) with `expose` / `readOnly` | Agentic commerce: Claude, ChatGPT or Cursor can search, compare and check stock; checkout tools are never exposed |
| A2A (`ai.a2a`) | Other agents send the shopping assistant tasks ("compare these two tents") |
| `.md` / JSON page representations, `withData()`, `llms.txt` | Every product page is readable by agents with structured data (price, variants, live stock) |
| `@Cached` + `revalidatePath()` | Product and category pages are cached for everyone and refreshed the moment an order changes stock |
| Body validation from types (`AddItemRequest`) | The cart API rejects bad variant ids and quantities with no hand-written validation |
| Offline model + `ScriptedChatModel` | The demo and the tests run anywhere, deterministically, without an API key |

## Run it

From this folder:

`npm start` runs in production, which refuses the demo secrets (they are in `application-development.json`, used by `npm run dev` only). Before the first start, create a file named `.env.production.local` in this folder (git ignores it) with your own values, each at least 16 characters:

```
AI_MCP_TOKEN=replace-with-a-long-random-value
AI_A2A_TOKEN=replace-with-a-long-random-value
```

```
npm run build
npm start
```

`npm start` runs one worker because this demo keeps its data in memory, which each worker process would hold separately. A production version with a database (and `ai.store.type` set to `postgres`) can run one worker per CPU core with `amoxi start dist/src/main.js --workers auto`.

Then open http://localhost:8083. For development with live reload:

```
npm run dev
```

Tests (14, offline):

```
npm test
```

### Use a real model

Create `.env` in this folder (never commit it) with one of:

```
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
```

and restart. The tools, components, approvals and guardrails stay the same; the conversation becomes natural ("I'm doing the West Coast Trail in May, what shell and boots?").

## Selling to AI agents

MCP and A2A are enabled in `application.json`. In development they use **clearly fake demo tokens** from `application-development.json` (`demo-store-mcp-token`, `demo-store-a2a-token`). Production refuses them: set real secrets through environment variables (`AI_MCP_TOKEN`, `AI_A2A_TOKEN`), or one token per partner with `ai.mcp.callers.<name>` and `ai.a2a.callers.<name>`.

List the tools over MCP (only `search_products`, `compare_products`, `product_details` and `ask_shopping_assistant` are offered; tools that need approval never are):

```
curl -s http://localhost:8083/mcp -H "authorization: Bearer demo-store-mcp-token" -H "content-type: application/json" -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\",\"params\":{}}"
```

Search the catalog (the result has `structuredContent.products` with prices in cents and live stock):

```
curl -s http://localhost:8083/mcp -H "authorization: Bearer demo-store-mcp-token" -H "content-type: application/json" -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"search_products\",\"arguments\":{\"query\":\"synthetic sleeping bag for a canoe trip\",\"maxPriceCents\":20000}}}"
```

Send the assistant a task over A2A (the agent card is at `/.well-known/agent-card.json`):

```
curl -s http://localhost:8083/a2a -H "authorization: Bearer demo-store-a2a-token" -H "content-type: application/json" -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"message/send\",\"params\":{\"message\":{\"role\":\"user\",\"messageId\":\"m1\",\"parts\":[{\"kind\":\"text\",\"text\":\"Compare the Ridgemarrow 2 and the Talvane 3\"}]}}}"
```

Read pages as an agent would:

```
curl -s http://localhost:8083/llms.txt
curl -s http://localhost:8083/products/OG-1101.md
curl -s http://localhost:8083/products/OG-1101 -H "accept: application/json"
curl -s "http://localhost:8083/api/products?category=jackets&maxPriceCents=30000"
```

The same information is on the `/for-agents` page.

## File map

```
src/
  agent/shopping-assistant.ts   @Agent: instructions (cart, orders, profile), principal/owner hooks, guardrail
  agent/shop-tools.ts           @Tool methods: search, compare, details (exposed), cart, order, track, return
  agent/preferences.ts          reads sizes out of remembered facts
  catalog/                      products (seed), Catalog service (search, stock, revalidation), SVG art + route
  shop/                         cart, orders and returns, shopper id, JSON API (/api/...)
  guides/guides.ts              buying guides + returns policy, ingested into the "guides" knowledge base
  pages/shop-pages.tsx          home, category, product (@Cached + withData), assistant, guides, for-agents
  pages/llms-controller.ts      /llms.txt listing every product and category
  islands/                      ShopAssistant (chat), ShopperPanel (cart/orders/memory rail), CartBadge, AddToCart,
                                generative: ProductCarousel.react, ComparisonTable, CartSummary, OrderConfirmation, ReturnReceipt
  styles/app.css                the "trail map" identity
test/                           offline prompts, scripted memory, cart, checkout approval + idempotency,
                                returns, guardrail/ownership, MCP, A2A, .md/JSON, React SSR
```

## Framework notes

- The built-in `/llms.txt` lists only pages without path parameters (by design), so a store's product and category pages would be missing. This app defines its own `/llms.txt` with `buildLlmsTxt()`; defining the route replaces the built-in one.
- Runs from other agents (A2A, MCP's `ask_shopping_assistant`) have no screen, so the tools only call `ctx.ui()` for a shopper (`show()` in `shop-tools.ts`); other agents get the products as text and structured output instead of "I've put the details above".
- Issues reported while building this and since fixed in the framework: array tool inputs breaking generated validators, `.md` URLs of parameterised pages, `revalidatePath()` not clearing markdown/JSON copies, React generative islands hydrating into empty elements, `<For key>` in islands, chat item ids repeating across runs, guardrails running after approval, MCP/A2A principals, and resuming a paused run after a reload (`agentChat({ resume })`).

## What production would add

- Real shopper accounts (an IdP) instead of an anonymous session id, so memory and orders follow the person across devices; consent and retention rules for remembered preferences.
- The commerce platform behind `Catalog`, `CartService` and `OrderService` (inventory, payments with a PSP, tax by province, shipping rates), with idempotency keys passed through to the payment call inside `ctx.step()`.
- PostgreSQL + pgvector for runs, conversations, memory and knowledge (`ai.store.type=postgres`), a shared cache or CDN purge for `revalidatePath()` across instances.
- Real MCP/A2A credentials per partner agent, rate limits, and an audit trail via `onRunFinished`.
- Product photography alongside the generated illustrations, and an evaluation suite for the real model's recommendations.
