import { onMount, signal } from 'amoxi';
import { ACCOUNTS_CHANGED, money } from '../ui/format';
import type { AccountsResult } from '../ui/types';

/** The accounts rail beside the conversation. Refreshes when the assistant moves money or changes a card. */
export default function AccountsPanel(props: { initial: AccountsResult; singleLimitCents: number; dailyLimitCents: number }) {
  const [data, setData] = signal<AccountsResult>(props.initial);
  const [changed, setChanged] = signal<ReadonlySet<string>>(new Set());
  const [note, setNote] = signal('');

  const refresh = async (): Promise<void> => {
    try {
      const res = await fetch('/api/accounts', { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(String(res.status));
      const next = (await res.json()) as AccountsResult;
      const before = data();
      const diff = new Set<string>();
      for (const a of next.accounts) if (before.accounts.find((b) => b.id === a.id)?.balanceCents !== a.balanceCents) diff.add(a.id);
      for (const c of next.cards) if (before.cards.find((b) => b.id === c.id)?.status !== c.status) diff.add(c.id);
      setData(next);
      setChanged(diff);
      setNote(diff.size > 0 ? 'Updated just now' : '');
      setTimeout(() => setChanged(new Set()), 2600);
    } catch {
      setNote('Could not refresh balances. Reload the page to see the latest.');
    }
  };

  onMount(() => {
    const on = (): void => void refresh();
    window.addEventListener(ACCOUNTS_CHANGED, on);
    return () => window.removeEventListener(ACCOUNTS_CHANGED, on);
  });

  return (
    <aside class="rail" aria-labelledby="rail-title">
      <div class="rail-head">
        <h2 id="rail-title">Accounts</h2>
        <p class="rail-note" role="status">
          {note}
        </p>
      </div>
      <ul class="rail-accounts">
        {() =>
          data().accounts.map((a) => (
            <li class={changed().has(a.id) ? 'is-changed' : undefined}>
              <a href={`/accounts#${a.id}`}>
                <span class="ledger-name">{a.name}</span>
                {' '}
                <span class="ledger-sub">
                  {a.id}, {a.currency}
                </span>
              </a>
              <span class="num rail-balance">{money(a.balanceCents, a.currency)}</span>
            </li>
          ))
        }
      </ul>
      <p class="rail-total">
        <span>Total in CAD</span>
        <strong class="num">{() => money(data().totalCadCents)}</strong>
      </p>
      <h3 class="rail-sub">Cards</h3>
      <ul class="rail-cards">
        {() =>
          data().cards.map((c) => (
            <li class={changed().has(c.id) ? 'is-changed' : undefined}>
              <span>
                <span class="ledger-name">{c.name}</span>
                {' '}
                <span class="ledger-sub">
                  {c.id}, •••• {c.last4}
                </span>
              </span>
              <span class={`pill pill-${c.status}`}>{c.status === 'frozen' ? 'Frozen' : 'Active'}</span>
            </li>
          ))
        }
      </ul>
      <p class="rail-limits">
        Own-account transfers: up to {money(props.singleLimitCents)} each and {money(props.dailyLimitCents)} a day. Every transfer needs your approval.
      </p>
    </aside>
  );
}
