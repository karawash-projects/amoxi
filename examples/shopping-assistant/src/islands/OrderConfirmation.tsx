import { day, money } from '../ui/format';

interface OrderLine {
  variantId: string;
  productId: string;
  name: string;
  option: string;
  quantity: number;
  unitCents: number;
  lineCents: number;
  art: string;
}

const STAGES: Array<{ key: string; label: string }> = [
  { key: 'processing', label: 'Placed' },
  { key: 'shipped', label: 'Shipped' },
  { key: 'delivered', label: 'Delivered' },
];

/** @generative Shows an order: a confirmation right after checkout, or its tracking status (placed, shipped, delivered) with lines and totals */
export default function OrderConfirmation(props: {
  kind: 'placed' | 'tracking';
  orderId: string;
  placedAt: string;
  status: 'processing' | 'shipped' | 'delivered' | 'return_started';
  lines: OrderLine[];
  subtotalCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
  /** yyyy-mm-dd */
  estimatedDelivery: string;
  deliveredAt?: string;
  trackingNumber?: string;
  returnId?: string;
}) {
  const reached = props.status === 'return_started' ? 3 : STAGES.findIndex((s) => s.key === props.status) + 1;
  return (
    <section class={`ordercard ${props.kind}`} aria-label={`Order ${props.orderId}`}>
      <header class="ordercard-head">
        <h3>{props.kind === 'placed' ? 'Order placed' : `Order ${props.orderId}`}</h3>
        <p class="muted">
          {props.kind === 'placed' ? `${props.orderId}, ` : ''}placed {day(props.placedAt)}
        </p>
      </header>
      <ol class="ptrail" aria-label="Order progress">
        {STAGES.map((s, i) => (
          <li class={i < reached ? 'done' : undefined} aria-current={i === reached - 1 ? 'step' : undefined}>
            <span class="trail-dot" aria-hidden="true" />
            {s.label}
          </li>
        ))}
      </ol>
      <p class="ordercard-eta">
        {props.status === 'return_started'
          ? `Return ${props.returnId ?? ''} in progress`
          : props.deliveredAt
            ? `Delivered ${day(props.deliveredAt)}`
            : `Arrives by ${day(`${props.estimatedDelivery}T12:00:00Z`)}`}
        {props.trackingNumber ? <span class="muted"> · tracking {props.trackingNumber}</span> : null}
      </p>
      <ul class="cartcard-lines">
        {props.lines.map((l) => (
          <li>
            <img src={l.art} alt="" width="64" height="48" />
            <span class="cartcard-name">
              <a href={`/products/${l.productId}`}>{l.name}</a>
              <span class="muted">
                {l.option} · {l.quantity} × {money(l.unitCents)}
              </span>
            </span>
            <span class="cartcard-amount">{money(l.lineCents)}</span>
          </li>
        ))}
      </ul>
      <p class="ordercard-total">
        <span>Total paid</span>
        <strong>{money(props.totalCents)}</strong>
      </p>
    </section>
  );
}
