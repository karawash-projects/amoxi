/** @jsxImportSource react */
import { useId, useState } from 'react';
import { money, stockText } from '../ui/format';

interface CarouselVariant {
  id: string;
  label: string;
  size?: string;
  stock: number;
}

interface CarouselProduct {
  id: string;
  name: string;
  category: string;
  priceCents: number;
  summary: string;
  url: string;
  art: string;
  highlights: ReadonlyArray<{ label: string; value: string }>;
  variants: readonly CarouselVariant[];
}

export interface ProductCarouselProps {
  /** Heading above the cards, e.g. "3 matches under $300". */
  title: string;
  products: readonly CarouselProduct[];
  /** Sizes the shopper told the assistant about; preselected on matching cards. */
  preferredSizes?: { footwear?: string; jackets?: string };
  /** One line under the title (e.g. why a size is preselected). */
  note?: string;
  /** One product shown with every option's stock (product details). */
  expanded?: boolean;
}

type AddState = { status: 'idle' | 'busy' | 'sent' | 'added' | 'error'; message?: string };

function initialVariant(p: CarouselProduct, sizes: ProductCarouselProps['preferredSizes']): string {
  const wanted = p.category === 'footwear' ? sizes?.footwear : p.category === 'jackets' ? sizes?.jackets : undefined;
  const inStock = p.variants.filter((v) => v.stock > 0);
  const preferred = wanted ? inStock.find((v) => v.size?.toUpperCase() === wanted.toUpperCase()) : undefined;
  return (preferred ?? inStock[0] ?? p.variants[0]).id;
}

/**
 * Adds a variant to the cart. Inside the assistant, the request goes through the conversation
 * (the chat island accepts the "demo-store:ask" event), so the agent's transcript stays the
 * record of what happened; anywhere else, or while the agent is busy, it calls the cart API.
 */
async function addToCart(product: CarouselProduct, variant: CarouselVariant): Promise<AddState> {
  const detail = { text: `Add 1 × ${product.name} (${variant.label}) to my cart, variant ${variant.id}`, accepted: false };
  window.dispatchEvent(new CustomEvent('demo-store:ask', { detail }));
  if (detail.accepted) return { status: 'sent', message: 'Asked the assistant to add it' };
  const res = await fetch('/api/cart/items', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ variantId: variant.id, quantity: 1 }),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) return { status: 'error', message: body.error ?? 'Could not add it to the cart' };
  window.dispatchEvent(new CustomEvent('demo-store:cart'));
  return { status: 'added', message: 'Added to your cart' };
}

function Card(props: { product: CarouselProduct; sizes: ProductCarouselProps['preferredSizes']; expanded: boolean }) {
  const p = props.product;
  const selectId = useId();
  const [variantId, setVariantId] = useState(() => initialVariant(p, props.sizes));
  const [state, setState] = useState<AddState>({ status: 'idle' });
  const variant = p.variants.find((v) => v.id === variantId) ?? p.variants[0];
  const preferred = variant.size && (variant.size === props.sizes?.footwear || variant.size === props.sizes?.jackets);

  const onAdd = (): void => {
    setState({ status: 'busy' });
    addToCart(p, variant).then(setState, () => setState({ status: 'error', message: 'Network error: try again' }));
  };

  return (
    <article className={props.expanded ? 'pcard pcard-wide' : 'pcard'} aria-labelledby={`${selectId}-name`}>
      <a className="pcard-art" href={p.url} tabIndex={-1} aria-hidden="true">
        <img src={p.art} alt="" width={400} height={300} loading="lazy" />
      </a>
      <div className="pcard-body">
        <h3 id={`${selectId}-name`} className="pcard-name">
          <a href={p.url}>{p.name}</a>
        </h3>
        <p className="pcard-price">{money(p.priceCents)}</p>
        <p className="pcard-summary">{p.summary}</p>
        <dl className="pcard-specs">
          {p.highlights.map((h) => (
            <div key={h.label}>
              <dt>{h.label}</dt>
              <dd>{h.value}</dd>
            </div>
          ))}
        </dl>
        {props.expanded ? (
          <ul className="pcard-stock" aria-label="Stock by option">
            {p.variants.map((v) => (
              <li key={v.id} className={v.stock <= 0 ? 'out' : v.stock <= 3 ? 'low' : ''}>
                <span>{v.label}</span>
                <span>{stockText(v.stock)}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="pcard-buy">
          {p.variants.length > 1 ? (
            <div className="field">
              <label htmlFor={selectId}>Option</label>
              <select id={selectId} value={variantId} onChange={(e) => { setVariantId(e.target.value); setState({ status: 'idle' }); }}>
                {p.variants.map((v) => (
                  <option key={v.id} value={v.id} disabled={v.stock <= 0}>
                    {v.label}
                    {v.stock <= 0 ? ' (sold out)' : ''}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <p className={`stock ${variant.stock <= 0 ? 'out' : variant.stock <= 3 ? 'low' : 'ok'}`}>
            {stockText(variant.stock)}
            {preferred ? <span className="your-size"> · your size</span> : null}
          </p>
          <button type="button" className="btn btn-blaze" onClick={onAdd} disabled={variant.stock <= 0 || state.status === 'busy'}>
            {state.status === 'busy' ? 'Adding…' : 'Add to cart'}
          </button>
          <p className={`pcard-status ${state.status}`} role="status">
            {state.message ?? ''}
          </p>
        </div>
      </div>
    </article>
  );
}

/** @generative Shows products as browsable cards with price, key specs, live stock, an option picker and an Add to cart button */
export default function ProductCarousel(props: ProductCarouselProps) {
  const one = props.products.length === 1;
  return (
    <section className={one ? 'carousel carousel-one' : 'carousel'} aria-label={props.title}>
      <header className="carousel-head">
        <h3>{props.title}</h3>
        {props.note ? <p className="carousel-note">{props.note}</p> : null}
      </header>
      <div className="carousel-track" tabIndex={one ? undefined : 0} role={one ? undefined : 'region'} aria-label={one ? undefined : `${props.title}: scroll for more`}>
        {props.products.map((p) => (
          <Card key={p.id} product={p} sizes={props.preferredSizes} expanded={props.expanded === true || one} />
        ))}
      </div>
    </section>
  );
}
