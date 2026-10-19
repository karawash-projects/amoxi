import { onMount, signal } from 'amoxi';

/** Header cart link with a live item count (pages are cached for everyone, so the count loads in the browser). */
export default function CartBadge(props: { label: string }) {
  const [count, setCount] = signal(0);
  onMount(() => {
    const load = (): void =>
      void fetch('/api/cart', { headers: { accept: 'application/json' } })
        .then((r) => r.json())
        .then((c: { itemCount?: number }) => setCount(c.itemCount ?? 0))
        .catch(() => undefined);
    load();
    window.addEventListener('demo-store:cart', load);
    return () => window.removeEventListener('demo-store:cart', load);
  });
  return (
    <a class="cart-link" href="/assistant#cart">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M3 4h2.5l2.2 10.5h10.6L20.5 7H7" />
        <circle cx="9.5" cy="19" r="1.5" />
        <circle cx="17" cy="19" r="1.5" />
      </svg>
      <span>{props.label}</span>
      <span class="cart-count" aria-label={() => `${count()} items`}>
        {count}
      </span>
    </a>
  );
}
