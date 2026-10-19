import { PostConstruct, Singleton, revalidatePath } from 'amoxi';
import { artUrl } from './art';
import type { Category, Product, ProductCard, Spec, Variant } from './model';
import { SEED_PRODUCTS } from './seed';
import { money, weight } from '../ui/format';
import { ToolError } from 'amoxi/ai';

/** Words that say nothing about which product is wanted. */
const NOISE = new Set(
  (
    'a an the and or for with in on of to me my i we us our show find search looking look want need some any good best under below less than ' +
    'cheap cheaper max maximum price budget cad dollars dollar around about please can you get buy shop products product gear something what which ' +
    'is are do does it its this that one ones options option recommend suggest compare vs versus versa size sizes'
  ).split(' '),
);

/** Shopper words that point at a category. */
const CATEGORY_WORDS: Record<string, Category> = {
  tent: 'tents', tents: 'tents', shelter: 'tents', shelters: 'tents',
  bag: 'sleeping-bags', bags: 'sleeping-bags', sleeping: 'sleeping-bags', sleep: 'sleeping-bags',
  jacket: 'jackets', jackets: 'jackets', coat: 'jackets', coats: 'jackets', parka: 'jackets', shell: 'jackets', hoody: 'jackets', fleece: 'jackets', puffy: 'jackets',
  boot: 'footwear', boots: 'footwear', shoe: 'footwear', shoes: 'footwear', footwear: 'footwear', sandal: 'footwear', sandals: 'footwear', runners: 'footwear',
};

const norm = (w: string): string => (w.length > 4 && w.endsWith('es') && !w.endsWith('oes') ? w.slice(0, -2) : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);

export interface SearchCriteria {
  readonly query?: string;
  readonly category?: Category;
  readonly maxPriceCents?: number;
  readonly limit?: number;
}

/**
 * The product catalog with live stock. In memory and seeded at startup; a real shop would back
 * this with its commerce platform. Stock changes revalidate the cached product pages.
 */
@Singleton()
export class Catalog {
  private readonly products = new Map<string, Product>();
  private readonly variants = new Map<string, { product: Product; variant: Variant }>();
  private readonly stock = new Map<string, number>();

  @PostConstruct()
  seed(): void {
    for (const p of SEED_PRODUCTS) {
      const { stock, ...product } = p;
      this.products.set(product.id, product);
      for (const v of product.variants) {
        this.variants.set(v.id, { product, variant: v });
        this.stock.set(v.id, stock[v.id] ?? 0);
      }
    }
  }

  all(): Product[] {
    return [...this.products.values()];
  }

  byCategory(category: Category): Product[] {
    return this.all().filter((p) => p.category === category);
  }

  get(id: string): Product | undefined {
    return this.products.get(id.trim().toUpperCase());
  }

  variant(id: string): { product: Product; variant: Variant } | undefined {
    return this.variants.get(id.trim().toUpperCase());
  }

  stockOf(variantId: string): number {
    return this.stock.get(variantId) ?? 0;
  }

  totalStock(p: Product): number {
    return p.variants.reduce((n, v) => n + this.stockOf(v.id), 0);
  }

  /** Takes stock for a set of lines, all or nothing. Revalidates the affected pages. */
  take(lines: ReadonlyArray<{ variantId: string; quantity: number }>): void {
    for (const l of lines) {
      const have = this.stockOf(l.variantId);
      if (l.quantity > have) {
        const found = this.variant(l.variantId);
        throw new ToolError(`Only ${have} left of ${found ? `${found.product.name} (${found.variant.label})` : l.variantId}; reduce the quantity before checking out.`);
      }
    }
    const touched = new Set<Product>();
    for (const l of lines) {
      this.stock.set(l.variantId, this.stockOf(l.variantId) - l.quantity);
      const found = this.variant(l.variantId);
      if (found) touched.add(found.product);
    }
    for (const p of touched) this.revalidate(p);
  }

  /** Puts stock back (a return that was received). */
  restock(variantId: string, quantity: number): void {
    this.stock.set(variantId, this.stockOf(variantId) + quantity);
    const found = this.variant(variantId);
    if (found) this.revalidate(found.product);
  }

  /** Clears the cached pages that show this product's stock (HTML, markdown and JSON copies). */
  private revalidate(p: Product): void {
    for (const path of [`/products/${p.id}`, `/shop/${p.category}`, '/']) revalidatePath(path);
  }

  /** Finds product ids ("OG-1101", "OG-3101-SPRUCE-M") and model names ("Ridgemarrow", "Harrowind") in free text, in order. */
  resolveMentions(text: string): Product[] {
    const found: Array<{ at: number; product: Product }> = [];
    const upper = text.toUpperCase();
    for (const m of upper.matchAll(/\bFH-(\d{4})/g)) {
      const p = this.products.get(`OG-${m[1]}`);
      if (p) found.push({ at: m.index ?? 0, product: p });
    }
    const lower = text.toLowerCase();
    for (const p of this.products.values()) {
      const at = lower.indexOf(p.model.toLowerCase());
      if (at >= 0) found.push({ at, product: p });
    }
    found.sort((a, b) => a.at - b.at);
    const out: Product[] = [];
    for (const f of found) if (!out.includes(f.product)) out.push(f.product);
    return out;
  }

  /** Keyword search with category and price filters, ranked by how many words match. */
  search(criteria: SearchCriteria): Product[] {
    const words = (criteria.query ?? '').toLowerCase().match(/[\p{L}\p{N}-]+/gu) ?? [];
    let category = criteria.category;
    const terms: string[] = [];
    for (const w of words) {
      if (/^\d+$/.test(w) || NOISE.has(w)) continue;
      if (!category && CATEGORY_WORDS[w]) category = CATEGORY_WORDS[w];
      terms.push(norm(w));
    }
    // A mentioned model name ("Harrowind") is the strongest signal.
    const mentioned = this.resolveMentions(criteria.query ?? '');
    const candidates = this.all().filter((p) => (!category || p.category === category) && (criteria.maxPriceCents === undefined || p.priceCents <= criteria.maxPriceCents));
    const scored = candidates.map((p) => {
      const hay = [p.name, p.summary, p.insulation ?? '', ...p.tags].join(' ').toLowerCase();
      const hayWords = new Set((hay.match(/[\p{L}\p{N}-]+/gu) ?? []).map(norm));
      let score = mentioned.includes(p) ? 10 : 0;
      for (const t of terms) if (hayWords.has(t)) score += 2;
      // Category words alone ("jackets") say nothing about which one: they only break ties.
      if (score > 0 && terms.every((t) => CATEGORY_WORDS[t] || CATEGORY_WORDS[`${t}s`])) score = 1;
      return { p, score };
    });
    const anyMatch = scored.some((s) => s.score > 0);
    const results = scored
      .filter((s) => s.score > 0 || !anyMatch)
      .sort((a, b) => b.score - a.score || a.p.priceCents - b.p.priceCents)
      .map((s) => s.p);
    // Free text that matched nothing at all, with no category or price to go on: no results.
    if (!anyMatch && terms.length > 0 && !category && criteria.maxPriceCents === undefined) return [];
    return results.slice(0, criteria.limit ?? 6);
  }

  /** Key facts for cards and comparisons. */
  highlights(p: Product): Spec[] {
    const out: Spec[] = [{ label: 'Weight', value: weight(p.weightGrams) }];
    if (p.capacity) out.push({ label: 'Sleeps', value: String(p.capacity) });
    if (p.temperatureC !== undefined) out.push({ label: p.category === 'footwear' ? 'Rated to' : 'Limit', value: `${p.temperatureC}°C` });
    if (p.insulation && p.insulation !== 'none') out.push({ label: 'Insulation', value: p.insulation === 'down' ? 'Down' : 'Synthetic' });
    if (p.waterproofMm) out.push({ label: 'Waterproof', value: `${p.waterproofMm.toLocaleString('en-CA')} mm` });
    return out.slice(0, 4);
  }

  card(p: Product): ProductCard {
    return {
      id: p.id,
      name: p.name,
      category: p.category,
      priceCents: p.priceCents,
      summary: p.summary,
      url: `/products/${p.id}`,
      art: artUrl(p.id),
      highlights: this.highlights(p),
      variants: p.variants.map((v) => ({ id: v.id, label: v.label, ...(v.size ? { size: v.size } : {}), stock: this.stockOf(v.id) })),
    };
  }

  /** One line per product, for llms-friendly text and the agent's own summaries. */
  line(p: Product): string {
    return `${p.id} ${p.name}, ${money(p.priceCents)}`;
  }
}
