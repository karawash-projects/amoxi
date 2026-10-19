import { Cached, Controller, ErrorPage, Island, Page, PathParam, QueryParam, withData, withStatus, type RequestContext } from 'amoxi';
import { toChatItems, userOwner, type AgentPlatform, type ChatItem, type RunStore } from 'amoxi/ai';
import { MemoryService } from 'amoxi/ai';
import { profile } from '../agent/preferences';
import { artUrl } from '../catalog/art';
import { Catalog } from '../catalog/catalog';
import { CATEGORIES, type Product } from '../catalog/model';
import { GuideLibrary } from '../guides/guides';
import AddToCart from '../islands/AddToCart';
import ProductCarousel from '../islands/ProductCarousel.react';
import ShopAssistant from '../islands/ShopAssistant';
import ShopperPanel from '../islands/ShopperPanel';
import { CartService } from '../shop/cart';
import { OrderService } from '../shop/orders';
import { shopperId } from '../shop/shopper';
import { money, stockText } from '../ui/format';
import { Layout } from '../ui/layout';

/** Prompts that work with the offline demo model as well as with a real one. */
export const SUGGESTIONS = [
  'Show me waterproof jackets under $400',
  'Compare the Ridgemarrow 2 and the Talvane 3',
  'Remember "I wear size 10 boots and prefer synthetic insulation"',
  'Show me hiking boots in my size',
  'Search the guides: down or synthetic insulation for wet trips?',
  'Add the Harrowind hoody in Spruce, size M, to my cart',
  'Place my order',
  'Track my order DS-24502',
  'Start a return for order DS-24017',
];

const PICKS = ['OG-1101', 'OG-3102', 'OG-2102', 'OG-4101'];

const ask = (text: string): string => `/assistant?ask=${encodeURIComponent(text)}`;

/** Server-rendered store pages. Public pages are cached; stock changes revalidate them. */
@Controller()
export class ShopPages {
  constructor(
    private readonly catalog: Catalog,
    private readonly guides: GuideLibrary,
    private readonly carts: CartService,
    private readonly orders: OrderService,
    private readonly memory: MemoryService,
    private readonly platform: AgentPlatform,
    private readonly runs: RunStore,
  ) {}

  @Page('/')
  @Cached(30, { staleWhileRevalidate: 120 })
  home() {
    const picks = PICKS.map((id) => this.catalog.get(id)!).map((p) => this.catalog.card(p));
    return (
      <Layout title="Demo Outdoor Store" description="Outdoor gear for Canadian trips, sold by an AI shopping assistant that shows products, compares them and remembers your sizes." active="home">
        <section class="hero">
          <div class="hero-copy">
            <h1>Tell us the trip. We'll show you the gear.</h1>
            <p class="lede">
              Demo Outdoor Store's assistant answers with real products, side-by-side comparisons and live stock. It remembers your sizes, checks out when you confirm, and handles
              returns under our 30-day policy.
            </p>
            <form class="hero-ask" action="/assistant" method="get">
              <label for="hero-q">What are you planning?</label>
              <div class="hero-ask-row">
                <input id="hero-q" name="ask" type="text" maxlength="300" placeholder="A wet week on the West Coast Trail" required />
                <button type="submit" class="btn btn-blaze">
                  Ask the assistant
                </button>
              </div>
            </form>
            <ul class="hero-tries" aria-label="Or try">
              {SUGGESTIONS.slice(0, 3).map((s) => (
                <li>
                  <a href={ask(s)}>{s}</a>
                </li>
              ))}
            </ul>
          </div>
          <div class="hero-map" aria-hidden="true">
            <svg viewBox="0 0 520 420">
              <g fill="none" stroke="#13324A" stroke-opacity=".22" stroke-width="1.3">
                <path d="M60 300c30-90 120-160 210-150s170 60 200 130-60 120-170 110-260-10-240-90Z" />
                <path d="M100 290c25-70 100-125 175-118s138 48 160 104-50 92-138 86-215-8-197-72Z" />
                <path d="M140 282c20-50 80-90 140-85s104 36 122 78-40 66-104 62-170-8-158-55Z" />
                <path d="M180 274c15-32 58-58 100-55s74 26 86 54-28 42-72 40-124-6-114-39Z" />
                <path d="M220 266c10-16 34-30 60-28s44 14 50 30-16 24-42 22-74-6-68-24Z" />
                <path d="M30 120c60-50 160-80 250-60s200 20 230-20" />
                <path d="M20 160c70-40 170-60 260-44s200 24 236-12" />
                <path d="M10 70c80-40 170-60 270-40s180 10 230-20" />
              </g>
              <path class="trail" d="M40 380C90 340 120 330 150 300s30-70 80-80 90 20 120-10 40-70 90-80" fill="none" stroke="#F26B1D" stroke-width="4" stroke-dasharray="10 9" stroke-linecap="round" />
              <g fill="#F26B1D">
                <rect x="146" y="286" width="9" height="20" rx="1.5" />
                <rect x="296" y="222" width="9" height="20" rx="1.5" />
                <rect x="436" y="128" width="9" height="20" rx="1.5" />
              </g>
              <path d="M404 92l28-46 28 46Z" fill="#13324A" />
              <path d="M424 92l18-30 18 30Z" fill="#2F5D50" />
              <circle cx="276" cy="262" r="5" fill="#13324A" />
            </svg>
          </div>
        </section>

        <section class="band" aria-labelledby="cats-h">
          <h2 id="cats-h">Shop by category</h2>
          <ul class="cat-grid">
            {CATEGORIES.map((c) => {
              const first = this.catalog.byCategory(c.id)[0];
              return (
                <li>
                  <a class="cat-tile" href={`/shop/${c.id}`}>
                    <img src={artUrl(first.id)} alt="" width="400" height="300" loading="lazy" />
                    <span class="cat-name">{c.name}</span>
                    <span class="cat-blurb">{c.blurb}</span>
                  </a>
                </li>
              );
            })}
          </ul>
        </section>

        <section class="band picks" aria-labelledby="picks-h">
          <div class="band-head">
            <h2 id="picks-h">Trail-tested this season</h2>
            <p>The same cards the assistant shows in a conversation: a React island, rendered on the server and hydrated in the browser.</p>
          </div>
          <Island of={ProductCarousel} title="Staff picks" products={picks} load="visible" />
        </section>

        <section class="band agents-band" aria-labelledby="agents-h">
          <div class="band-head">
            <h2 id="agents-h">Open to other shopping agents</h2>
            <p>
              Customers increasingly shop through their own AI assistants. Demo Outdoor Store's catalog is readable and searchable by them, without screen scraping.
            </p>
          </div>
          <ul class="agent-ways">
            <li>
              <h3>MCP tools</h3>
              <p>
                <code>search_products</code>, <code>compare_products</code> and <code>product_details</code> at <code>/mcp</code>, with live stock.
              </p>
            </li>
            <li>
              <h3>A2A agent card</h3>
              <p>
                Other agents send tasks to the shopping assistant via <code>/.well-known/agent-card.json</code>.
              </p>
            </li>
            <li>
              <h3>Markdown and JSON pages</h3>
              <p>
                Every page has a <code>.md</code> twin and a JSON representation; <a href="/llms.txt">/llms.txt</a> indexes them.
              </p>
            </li>
          </ul>
          <a class="btn" href="/for-agents">
            How agents shop here
          </a>
        </section>
      </Layout>
    );
  }

  @Page('/shop/:category')
  @Cached(30, { staleWhileRevalidate: 120 })
  category(@PathParam() category: string) {
    const meta = CATEGORIES.find((c) => c.id === category);
    if (!meta) return withStatus(404, this.missing('That category'));
    const products = this.catalog.byCategory(meta.id);
    const [a, b] = products;
    const view = (
      <Layout title={meta.name} description={meta.blurb} active={meta.id}>
        <header class="page-head">
          <p class="crumbs">
            <a href="/">Home</a> / {meta.name}
          </p>
          <h1>{meta.name}</h1>
          <p class="lede">{meta.blurb}</p>
          <a class="btn" href={ask(`Compare the ${a.model} and the ${b.model}`)}>
            Ask the assistant to compare the {a.model} and the {b.model}
          </a>
        </header>
        <ul class="grid">
          {products.map((p) => (
            <li>{this.tile(p)}</li>
          ))}
        </ul>
      </Layout>
    );
    return withData(view, { category: meta.id, currency: 'CAD', products: products.map((p) => this.catalog.card(p)) });
  }

  @Page('/products/:id')
  @Cached(60, { staleWhileRevalidate: 300 })
  product(@PathParam() id: string) {
    const p = this.catalog.get(id);
    if (!p) return withStatus(404, this.missing('That product'));
    const meta = CATEGORIES.find((c) => c.id === p.category)!;
    const other = this.catalog.byCategory(p.category).find((x) => x.id !== p.id)!;
    const guide = this.guides.get(p.category === 'sleeping-bags' ? 'sleeping-bag-ratings' : p.category === 'tents' ? 'choosing-a-tent' : p.category === 'footwear' ? 'boot-fit' : p.insulation === 'none' ? 'waterproofing' : 'down-vs-synthetic')!;
    const variants = p.variants.map((v) => ({ id: v.id, label: v.label, stock: this.catalog.stockOf(v.id) }));
    const view = (
      <Layout title={p.name} description={p.summary} active={p.category}>
        <p class="crumbs">
          <a href="/">Home</a> / <a href={`/shop/${p.category}`}>{meta.name}</a> / {p.model}
        </p>
        <article class="product">
          <div class="product-art">
            <img src={artUrl(p.id)} alt={`Illustration of the ${p.name}`} width="800" height="600" />
          </div>
          <div class="product-info">
            <h1>{p.name}</h1>
            <p class="product-price">
              {money(p.priceCents)} <span class="muted">CAD</span>
            </p>
            <p class="lede">{p.summary}</p>
            <Island of={AddToCart} productId={p.id} productName={p.name} variants={variants} />
            <div class="product-ask">
              <p>Not sure? Ask the assistant:</p>
              <a class="chip" href={ask(`Details and stock for the ${p.model}`)}>
                Details and stock for the {p.model}
              </a>
              <a class="chip" href={ask(`Compare the ${p.model} and the ${other.model}`)}>
                Compare with the {other.model}
              </a>
            </div>
          </div>
        </article>
        <section class="product-more">
          <div>
            <h2>About it</h2>
            <p>{p.description}</p>
            <p>
              Buying guide: <a href={guide.url}>{guide.title}</a>
            </p>
          </div>
          <div>
            <h2>Specifications</h2>
            <table class="specs">
              <tbody>
                {p.specs.map((s) => (
                  <tr>
                    <th scope="row">{s.label}</th>
                    <td>{s.value}</td>
                  </tr>
                ))}
                <tr>
                  <th scope="row">Product id</th>
                  <td>{p.id}</td>
                </tr>
              </tbody>
            </table>
            <h2>Stock</h2>
            <table class="specs">
              <tbody>
                {variants.map((v) => (
                  <tr>
                    <th scope="row">{v.label}</th>
                    <td>
                      {stockText(v.stock)} ({v.stock}) <span class="muted">{v.id}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </Layout>
    );
    return withData(view, {
      product: {
        id: p.id,
        name: p.name,
        category: p.category,
        priceCents: p.priceCents,
        currency: 'CAD',
        summary: p.summary,
        description: p.description,
        weightGrams: p.weightGrams,
        ...(p.temperatureC !== undefined ? { temperatureC: p.temperatureC } : {}),
        ...(p.waterproofMm !== undefined ? { waterproofMm: p.waterproofMm } : {}),
        ...(p.insulation ? { insulation: p.insulation } : {}),
        specs: p.specs,
        variants,
        image: artUrl(p.id),
        url: `/products/${p.id}`,
      },
    });
  }

  @Page('/assistant')
  async assistant(@QueryParam() ask: string | undefined, @QueryParam('new') fresh: string | undefined, ctx: RequestContext) {
    const shopper = shopperId(ctx)!;
    let initial: ChatItem[] = [];
    let threadId: string | undefined;
    let resume: { id: string; status: string; lastSeq: number } | undefined;
    if (!fresh) {
      const [latest] = await this.platform.threads(userOwner(shopper), 'shopping-assistant');
      const found = latest ? await this.platform.thread(latest.id) : undefined;
      if (found) {
        threadId = found.thread.id;
        // A run still in progress (e.g. a checkout waiting for confirmation) is shown and resumed.
        const active = (await this.platform.runs(found.thread.id)).find((r) => !['completed', 'failed', 'cancelled'].includes(r.status));
        initial = toChatItems([...found.messages, ...(active?.checkpoint ?? [])]);
        for (const p of active?.pending ?? []) {
          if (!p.decision) initial.push({ kind: 'approval', id: `ap-${p.callId}`, callId: p.callId, tool: p.tool, input: p.input, ...(p.reason ? { reason: p.reason } : {}), status: 'pending' });
        }
        if (active) resume = { id: active.id, status: active.status, lastSeq: (await this.runs.events(active.id, 0)).at(-1)?.seq ?? 0 };
      }
    }
    const cart = this.carts.view(shopper);
    const orders = this.orders.list(shopper).map((o) => ({ id: o.id, placedAt: o.placedAt, status: o.status, totalCents: o.totalCents, itemCount: o.lines.reduce((n, l) => n + l.quantity, 0) }));
    const memories = (await profile(this.memory.for(`principal:${shopper}`))).map((m) => ({ id: m.id, text: m.text }));
    return (
      <Layout title="Shop with the assistant" description="Conversational shopping with product cards, comparisons, a live cart, orders and returns." active="assistant" app>
        <div class="assistant-page">
          <Island of={ShopAssistant} initial={initial} threadId={threadId} suggestions={SUGGESTIONS} ask={ask?.slice(0, 500)} resume={resume} />
          <div class="rail-wrap">
            <Island of={ShopperPanel} cart={cart} orders={orders} memories={memories} />
            <p class="demo-note">Demo: fictional data. Runs offline without an API key; nothing is charged or shipped.</p>
          </div>
        </div>
      </Layout>
    );
  }

  @Page('/guides')
  @Cached(300)
  guideIndex() {
    return (
      <Layout title="Buying guides" description="Gear-buying guides and store policies used by the shopping assistant." active="guides">
        <header class="page-head">
          <h1>Buying guides and policies</h1>
          <p class="lede">The assistant searches these when you ask how to choose, and cites them in its answers.</p>
        </header>
        <ul class="guide-list">
          {this.guides.all().map((g) => (
            <li>
              <a href={g.url}>{g.title}</a>
              <p>{g.summary}</p>
            </li>
          ))}
        </ul>
      </Layout>
    );
  }

  @Page('/guides/:id')
  @Cached(300)
  guide(@PathParam() id: string) {
    const g = this.guides.get(id);
    if (!g) return withStatus(404, this.missing('That guide'));
    const [, ...rest] = g.text.split(/\n\s*\n/);
    return (
      <Layout title={g.title} description={g.summary} active="guides">
        <article class="guide">
          <p class="crumbs">
            <a href="/guides">Guides</a> / {g.title}
          </p>
          <h1>{g.title}</h1>
          {rest.map((para) => (
            <p>{para}</p>
          ))}
          <a class="btn" href={ask(`Search the guides: ${g.title.toLowerCase()}`)}>
            Ask the assistant about this
          </a>
        </article>
      </Layout>
    );
  }

  @Page('/for-agents')
  @Cached(300)
  forAgents() {
    return (
      <Layout title="For AI agents" description="How AI shopping agents can discover and query the Demo Outdoor Store catalog over MCP, A2A, llms.txt and markdown pages." active="agents">
        <header class="page-head">
          <h1>Shopping agents welcome</h1>
          <p class="lede">
            The store is built to be read and queried by other AI agents as well as by people. Everything below is served by the same Amoxi app, from the same tools the assistant uses.
          </p>
        </header>
        <div class="agent-docs">
          <section>
            <h2>MCP: call the catalog tools</h2>
            <p>
              <code>POST /mcp</code> (Streamable HTTP) offers <code>search_products</code>, <code>compare_products</code>, <code>product_details</code> and{' '}
              <code>ask_shopping_assistant</code>. Cart, checkout and returns are never offered: they need the shopper's approval. The demo token is{' '}
              <code>demo-store-mcp-token</code> (fake, for local use only).
            </p>
            <pre>
              <code>{`curl -s localhost:8083/mcp \\
  -H 'authorization: Bearer demo-store-mcp-token' \\
  -H 'content-type: application/json' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_products","arguments":{"query":"waterproof jacket","maxPriceCents":30000}}}'`}</code>
            </pre>
          </section>
          <section>
            <h2>A2A: send the assistant a task</h2>
            <p>
              The agent card at <a href="/.well-known/agent-card.json">/.well-known/agent-card.json</a> lists the shopping assistant as a skill. Tasks map to agent runs.
            </p>
            <pre>
              <code>{`curl -s localhost:8083/a2a \\
  -H 'authorization: Bearer demo-store-a2a-token' \\
  -H 'content-type: application/json' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"message":{"role":"user","messageId":"m1","parts":[{"kind":"text","text":"Compare the Ridgemarrow 2 and the Talvane 3"}]}}}'`}</code>
            </pre>
          </section>
          <section>
            <h2>Pages as markdown and JSON</h2>
            <p>
              Append <code>.md</code> to any page (<a href="/products/OG-1101.md">/products/OG-1101.md</a>) or send <code>Accept: application/json</code> to get the page with its product data,
              including live stock. <a href="/llms.txt">/llms.txt</a> lists the pages, APIs and agents. The plain JSON catalog is at <a href="/api/products">/api/products</a>.
            </p>
          </section>
        </div>
      </Layout>
    );
  }

  @ErrorPage(404)
  notFound() {
    return this.missing('That page');
  }

  private missing(what: string) {
    return (
      <Layout title="Not found">
        <section class="page-head">
          <h1>{what} isn't on the map.</h1>
          <p class="lede">
            Try a <a href="/shop/tents">category</a>, or <a href="/assistant">ask the assistant</a> to find it.
          </p>
        </section>
      </Layout>
    );
  }

  private tile(p: Product) {
    const stock = this.catalog.totalStock(p);
    const highlights = this.catalog.highlights(p);
    return (
      <a class="tile" href={`/products/${p.id}`}>
        <img src={artUrl(p.id)} alt="" width="400" height="300" loading="lazy" />
        <span class="tile-name">{p.name}</span>
        <span class="tile-price">{money(p.priceCents)}</span>
        <span class="tile-specs">{highlights.map((h) => `${h.label} ${h.value}`).join(', ')}</span>
        <span class={stock <= 0 ? 'tile-stock out' : stock <= 5 ? 'tile-stock low' : 'tile-stock'}>{stock <= 0 ? 'Sold out' : stock <= 5 ? `Only ${stock} left` : 'In stock'}</span>
      </a>
    );
  }
}

