import { money } from '../ui/format';
import type { AccountLine, CardLine } from '../ui/types';

/** @generative Shows the customer's accounts with balances and their cards with frozen/active status */
export default function AccountsOverview(props: {
  accounts: AccountLine[];
  totalCadCents: number;
  cards: CardLine[];
  /** A card or account id to emphasise (e.g. the card just frozen). */
  highlight?: string;
}) {
  return (
    <section class="gen gen-accounts" aria-label="Your accounts">
      <header class="gen-head">
        <h3>Your accounts</h3>
        <p class="gen-meta">
          Total in CAD <strong class="num">{money(props.totalCadCents)}</strong>
        </p>
      </header>
      <ul class="ledger-list">
        {props.accounts.map((a) => (
          <li class={props.highlight === a.id ? 'is-highlight' : undefined}>
            <span class={`acct-mark acct-${a.type}`} aria-hidden="true">
              {a.currency === 'USD' ? 'US' : a.type === 'savings' ? 'SV' : a.type === 'tfsa' ? 'TF' : 'CQ'}
            </span>
            <span class="ledger-label">
              <span class="ledger-name">{a.name}</span>
              {' '}
              <span class="ledger-sub">{a.id}</span>
            </span>
            <span class="num ledger-amount">{money(a.balanceCents, a.currency)}</span>
          </li>
        ))}
      </ul>
      {props.cards.length > 0 && (
        <ul class="card-chips" aria-label="Cards">
          {props.cards.map((c) => (
            <li class={`card-chip ${c.status === 'frozen' ? 'is-frozen' : ''} ${props.highlight === c.id ? 'is-highlight' : ''}`}>
              <span>
                {c.name} <span class="ledger-sub">•••• {c.last4}</span>
              </span>
              <span class={`pill pill-${c.status}`}>{c.status === 'frozen' ? 'Frozen' : 'Active'}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
