import { money } from '../ui/format';

interface SummaryLine {
  variantId: string;
  productId: string;
  name: string;
  option: string;
  quantity: number;
  unitCents: number;
  lineCents: number;
  art: string;
}

function checkout(): void {
  const detail = { text: 'Place my order', accepted: false };
  window.dispatchEvent(new CustomEvent('demo-store:ask', { detail }));
  if (!detail.accepted) document.getElementById('cart')?.scrollIntoView({ behavior: 'smooth' });
}

/** @generative Shows the shopper's cart after a change: lines with quantities, shipping, tax and the total, with a checkout button */
export default function CartSummary(props: {
  lines: SummaryLine[];
  itemCount: number;
  subtotalCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
  /** Variant id of the line that was just added. */
  highlight?: string;
}) {
  return (
    <section class="cartcard" aria-label="Your cart">
      <h3>
        Cart <span class="muted">· {props.itemCount} {props.itemCount === 1 ? 'item' : 'items'}</span>
      </h3>
      <ul class="cartcard-lines">
        {props.lines.map((l) => (
          <li class={l.variantId === props.highlight ? 'just-added' : undefined}>
            <img src={l.art} alt="" width="64" height="48" />
            <span class="cartcard-name">
              <a href={`/products/${l.productId}`}>{l.name}</a>
              <span class="muted">
                {l.option} · {l.quantity} × {money(l.unitCents)}
              </span>
            </span>
            <span class="cartcard-amount">{money(l.lineCents)}</span>
            {l.variantId === props.highlight ? <span class="tag-new">Added</span> : null}
          </li>
        ))}
      </ul>
      <dl class="totals">
        <div>
          <dt>Subtotal</dt>
          <dd>{money(props.subtotalCents)}</dd>
        </div>
        <div>
          <dt>Shipping</dt>
          <dd>{props.shippingCents === 0 ? 'Free' : money(props.shippingCents)}</dd>
        </div>
        <div>
          <dt>HST (13%)</dt>
          <dd>{money(props.taxCents)}</dd>
        </div>
        <div class="grand">
          <dt>Total</dt>
          <dd>{money(props.totalCents)}</dd>
        </div>
      </dl>
      <button type="button" class="btn btn-blaze" onClick={checkout}>
        Check out
      </button>
    </section>
  );
}
