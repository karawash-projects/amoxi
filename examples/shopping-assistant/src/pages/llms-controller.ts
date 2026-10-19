import { Controller, Get, HttpResponse, Value, buildLlmsTxt, type RequestContext } from 'amoxi';
import { Catalog } from '../catalog/catalog';
import { CATEGORIES } from '../catalog/model';
import { GuideLibrary } from '../guides/guides';
import { money } from '../ui/format';

/**
 * `/llms.txt` for shopping agents. The built-in index lists only pages without parameters, so a
 * store's most useful pages (every product and category) would be missing; defining this route
 * replaces the built-in one, built with the same `buildLlmsTxt()` helper.
 */
@Controller()
export class LlmsController {
  constructor(
    private readonly catalog: Catalog,
    private readonly guides: GuideLibrary,
    @Value('${app.name:Demo Outdoor Store}') private readonly name: string,
    @Value('${ai.mcp.enabled:false}') private readonly mcp: boolean,
    @Value('${ai.a2a.enabled:false}') private readonly a2a: boolean,
  ) {}

  @Get('/llms.txt')
  llms(ctx: RequestContext) {
    const baseUrl = `${ctx.protocol}://${ctx.req.headers.host ?? 'localhost'}`;
    const text = buildLlmsTxt({
      name: this.name,
      description: 'Canadian outdoor gear store (tents, sleeping bags, jackets, footwear; prices in CAD) with an AI shopping assistant. Agents can search and compare the catalog over MCP, send tasks over A2A, or read any page as markdown or JSON.',
      baseUrl,
      pages: [
        { path: '/', title: 'Home', description: 'Categories and staff picks' },
        { path: '/for-agents', title: 'For AI agents', description: 'How to query the catalog over MCP and A2A, with examples' },
        ...CATEGORIES.map((c) => ({ path: `/shop/${c.id}`, title: c.name, description: c.blurb })),
        ...this.catalog.all().map((p) => ({ path: `/products/${p.id}`, title: p.name, description: `${money(p.priceCents)} CAD. ${p.summary}` })),
        ...this.guides.all().map((g) => ({ path: g.url, title: g.title, description: g.summary, optional: true })),
        { path: '/assistant', title: 'Shop with the assistant', description: 'The conversational shopping page (for people)', optional: true },
      ],
      apis: [
        { method: 'GET', path: '/api/products', summary: 'The catalog as JSON with live stock per variant; filter with ?q=, ?category=, ?maxPriceCents=' },
        { method: 'GET', path: '/art/OG-1101.svg', summary: 'Product illustrations (SVG)' },
      ],
      agents: [{ name: 'shopping-assistant', description: 'Finds, compares and explains Demo Outdoor Store gear; checkout and returns need the shopper.', url: '/agents/shopping-assistant' }],
      links: { ...(this.mcp ? { mcp: '/mcp' } : {}), ...(this.a2a ? { agentCard: '/.well-known/agent-card.json' } : {}) },
    });
    // Parameterised pages are listed with their .md twins, which ShopPages serves.
    return new HttpResponse(200, text, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=300' });
  }
}
