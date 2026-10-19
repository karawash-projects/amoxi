import type { Currency } from '../ui/format';
import { money, stamp } from '../ui/format';

/** @generative Shows the receipt of a completed transfer between the customer's own accounts */
export default function TransferReceipt(props: {
  reference: string;
  fromAccountId: string;
  fromName: string;
  toAccountId: string;
  toName: string;
  amountCents: number;
  currency: Currency;
  fromBalanceCents: number;
  toBalanceCents: number;
  memo: string;
  postedAt: string;
}) {
  return (
    <section class="gen gen-receipt" aria-label={`Transfer receipt ${props.reference}`}>
      <header class="receipt-head">
        <svg viewBox="0 0 24 24" aria-hidden="true" class="receipt-check">
          <circle cx="12" cy="12" r="10" />
          <path d="m7.5 12.5 3 3 6-6.5" />
        </svg>
        <div>
          <h3>Transfer posted</h3>
          <p class="gen-meta">
            {stamp(props.postedAt)}, reference <span class="ref">{props.reference}</span>
          </p>
        </div>
        <p class="receipt-amount num">{money(props.amountCents, props.currency)}</p>
      </header>
      <dl class="receipt-legs">
        <div>
          <dt>From</dt>
          <dd>
            {props.fromName} <span class="ledger-sub">{props.fromAccountId}</span>
          </dd>
          <dd class="num">New balance {money(props.fromBalanceCents, props.currency)}</dd>
        </div>
        <div>
          <dt>To</dt>
          <dd>
            {props.toName} <span class="ledger-sub">{props.toAccountId}</span>
          </dd>
          <dd class="num">New balance {money(props.toBalanceCents, props.currency)}</dd>
        </div>
      </dl>
      {props.memo && <p class="receipt-memo">Note: {props.memo}</p>}
    </section>
  );
}
