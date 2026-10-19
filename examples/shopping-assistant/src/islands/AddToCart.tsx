import { signal } from 'amoxi';
import { stockText } from '../ui/format';

/** Option picker and Add to cart button on a product page (calls the cart API directly). */
export default function AddToCart(props: { productId: string; productName: string; variants: Array<{ id: string; label: string; stock: number }> }) {
  const first = props.variants.find((v) => v.stock > 0) ?? props.variants[0];
  const [selected, setSelected] = signal(first.id);
  const [quantity, setQuantity] = signal(1);
  const [state, setState] = signal<{ kind: 'idle' | 'busy' | 'ok' | 'error'; text: string }>({ kind: 'idle', text: '' });
  const current = () => props.variants.find((v) => v.id === selected()) ?? first;

  const add = async (): Promise<void> => {
    setState({ kind: 'busy', text: '' });
    try {
      const res = await fetch('/api/cart/items', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ variantId: selected(), quantity: quantity() }),
      });
      const body = (await res.json()) as { error?: string; itemCount?: number };
      if (!res.ok) throw new Error(body.error ?? 'Could not add it');
      setState({ kind: 'ok', text: `Added. Your cart has ${body.itemCount} item(s).` });
      window.dispatchEvent(new CustomEvent('demo-store:cart'));
    } catch (err) {
      setState({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <form
      class="buybox"
      onSubmit={(e: Event) => {
        e.preventDefault();
        void add();
      }}
    >
      {props.variants.length > 1 ? (
        <fieldset class="options">
          <legend>Option</legend>
          {props.variants.map((v) => (
            <label class={() => (selected() === v.id ? 'opt selected' : 'opt')}>
              <input type="radio" name="variant" value={v.id} checked={() => selected() === v.id} disabled={v.stock <= 0} onChange={() => setSelected(v.id)} />
              <span>{v.label}</span>
              <span class={v.stock <= 0 ? 'opt-stock out' : v.stock <= 3 ? 'opt-stock low' : 'opt-stock'}>{stockText(v.stock)}</span>
            </label>
          ))}
        </fieldset>
      ) : (
        <p class={() => (current().stock <= 3 ? 'stock low' : 'stock ok')}>{stockText(first.stock)}</p>
      )}
      <div class="buy-row">
        <div class="field qty">
          <label for={`qty-${props.productId}`}>Quantity</label>
          <select id={`qty-${props.productId}`} onChange={(e: Event) => setQuantity(Number((e.target as HTMLSelectElement).value))}>
            {[1, 2, 3, 4, 5].map((n) => (
              <option value={String(n)}>{n}</option>
            ))}
          </select>
        </div>
        <button type="submit" class="btn btn-blaze" disabled={() => state().kind === 'busy' || current().stock <= 0}>
          {() => (state().kind === 'busy' ? 'Adding…' : 'Add to cart')}
        </button>
      </div>
      <p class={() => `buy-status ${state().kind}`} role="status">
        {() => state().text}
        {() => (state().kind === 'ok' ? <a href="/assistant#cart"> View cart</a> : null)}
      </p>
    </form>
  );
}
