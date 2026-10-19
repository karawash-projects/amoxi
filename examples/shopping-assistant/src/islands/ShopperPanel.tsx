import { onMount, signal } from 'amoxi';
import { day, money } from '../ui/format';

interface PanelCart {
  lines: ReadonlyArray<{ variantId: string; productId: string; name: string; option: string; quantity: number; lineCents: number; art: string }>;
  itemCount: number;
  subtotalCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
}

interface PanelOrder {
  id: string;
  placedAt: string;
  status: string;
  totalCents: number;
  itemCount: number;
}

interface PanelMemory {
  id: string;
  text: string;
}

const STATUS: Record<string, string> = { processing: 'Processing', shipped: 'On its way', delivered: 'Delivered', return_started: 'Return started' };
const JSON_HEADERS = { accept: 'application/json', 'content-type': 'application/json' };

/** Sends a request to the assistant (the chat island accepts it), so actions stay in the conversation. */
function ask(text: string): void {
  const detail = { text, accepted: false };
  window.dispatchEvent(new CustomEvent('demo-store:ask', { detail }));
  if (!detail.accepted) document.getElementById('chat-input')?.focus();
}

/** The live side rail of the assistant page: cart, orders and what the assistant remembers. */
export default function ShopperPanel(props: { cart: PanelCart; orders: PanelOrder[]; memories: PanelMemory[] }) {
  const [cart, setCart] = signal(props.cart);
  const [orders, setOrders] = signal(props.orders);
  const [memories, setMemories] = signal(props.memories);
  const [flash, setFlash] = signal(false);

  const refreshCart = async (): Promise<void> => {
    const [c, o] = await Promise.all([fetch('/api/cart', { headers: JSON_HEADERS }).then((r) => r.json()), fetch('/api/orders', { headers: JSON_HEADERS }).then((r) => r.json())]);
    setCart(c as PanelCart);
    setOrders((o as { orders: PanelOrder[] }).orders);
    setFlash(true);
    setTimeout(() => setFlash(false), 900);
  };
  const refreshProfile = async (): Promise<void> => {
    const p = (await fetch('/api/profile', { headers: JSON_HEADERS }).then((r) => r.json())) as { memories: PanelMemory[] };
    setMemories(p.memories);
  };

  onMount(() => {
    const onCart = (): void => void refreshCart().catch(() => undefined);
    const onProfile = (): void => void refreshProfile().catch(() => undefined);
    window.addEventListener('demo-store:cart', onCart);
    window.addEventListener('demo-store:profile', onProfile);
    return () => {
      window.removeEventListener('demo-store:cart', onCart);
      window.removeEventListener('demo-store:profile', onProfile);
    };
  });

  const remove = async (variantId: string): Promise<void> => {
    await fetch(`/api/cart/items/${encodeURIComponent(variantId)}`, { method: 'DELETE', headers: JSON_HEADERS });
    window.dispatchEvent(new CustomEvent('demo-store:cart'));
  };
  const forget = async (id: string): Promise<void> => {
    await fetch(`/api/profile/memories/${encodeURIComponent(id)}`, { method: 'DELETE', headers: JSON_HEADERS });
    await refreshProfile();
  };

  return (
    <aside class="rail" aria-label="Your cart, orders and profile">
      <section id="cart" class={() => (flash() ? 'rail-block rail-cart flash' : 'rail-block rail-cart')} aria-labelledby="rail-cart-h">
        <h2 id="rail-cart-h">
          Cart <span class="count">{() => cart().itemCount}</span>
        </h2>
        {() =>
          cart().lines.length === 0 ? (
            <p class="muted">Empty for now. Add from any product card.</p>
          ) : (
            <div>
              <ul class="rail-lines">
                {cart().lines.map((l) => (
                  <li>
                    <img src={l.art} alt="" width="56" height="42" />
                    <span class="rail-line-name">
                      <a href={`/products/${l.productId}`}>{l.name}</a>
                      <span class="muted">
                        {l.option}, qty {l.quantity}
                      </span>
                    </span>
                    <span class="rail-line-amount">{money(l.lineCents)}</span>
                    <button type="button" class="icon-btn" aria-label={`Remove ${l.name} (${l.option})`} onClick={() => void remove(l.variantId)}>
                      <svg viewBox="0 0 16 16" aria-hidden="true">
                        <path d="M4 4l8 8M12 4l-8 8" />
                      </svg>
                    </button>
                  </li>
                ))}
              </ul>
              <dl class="totals compact">
                <div>
                  <dt>Shipping</dt>
                  <dd>{cart().shippingCents === 0 ? 'Free' : money(cart().shippingCents)}</dd>
                </div>
                <div>
                  <dt>HST</dt>
                  <dd>{money(cart().taxCents)}</dd>
                </div>
                <div class="grand">
                  <dt>Total</dt>
                  <dd>{money(cart().totalCents)}</dd>
                </div>
              </dl>
              <button type="button" class="btn btn-blaze wide" onClick={() => ask('Place my order')}>
                Check out
              </button>
            </div>
          )
        }
      </section>

      <section class="rail-block" aria-labelledby="rail-orders-h">
        <h2 id="rail-orders-h">Your orders</h2>
        <ul class="rail-orders">
          {() =>
            orders().map((o) => (
              <li>
                <span class="rail-order-id">{o.id}</span>
                <span class={`badge badge-${o.status}`}>{STATUS[o.status] ?? o.status}</span>
                <span class="muted rail-order-meta">
                  {day(o.placedAt)}, {money(o.totalCents)}
                </span>
                <span class="rail-order-actions">
                  <button type="button" class="link-btn" onClick={() => ask(`Track my order ${o.id}`)}>
                    Track
                  </button>
                  {o.status === 'delivered' ? (
                    <button type="button" class="link-btn" onClick={() => ask(`Start a return for order ${o.id}`)}>
                      Return
                    </button>
                  ) : null}
                </span>
              </li>
            ))
          }
        </ul>
      </section>

      <section class="rail-block" aria-labelledby="rail-memory-h">
        <h2 id="rail-memory-h">What I remember</h2>
        {() =>
          memories().length === 0 ? (
            <p class="muted">Nothing yet. Tell me your sizes or what you prefer, and I'll keep it for next time.</p>
          ) : (
            <ul class="rail-memories">
              {memories().map((m) => (
                <li>
                  <span>{m.text}</span>
                  <button type="button" class="link-btn" aria-label={`Forget: ${m.text}`} onClick={() => void forget(m.id)}>
                    Forget
                  </button>
                </li>
              ))}
            </ul>
          )
        }
      </section>
    </aside>
  );
}
