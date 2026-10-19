import { signal } from 'amoxi';
import { categoryLabel, money, shortDate } from '../ui/format';
import type { TransactionRow } from '../ui/types';

const PAGE = 8;

/** @generative Shows a table of the customer's transactions with dates, merchants, categories and amounts */
export default function TransactionTable(props: {
  title: string;
  count: number;
  totalOutCents: number;
  totalInCents: number;
  filters: string;
  transactions: TransactionRow[];
}) {
  const [all, setAll] = signal(false);
  const rows = (): TransactionRow[] => (all() ? props.transactions : props.transactions.slice(0, PAGE));
  return (
    <section class="gen gen-tx" aria-label={props.title}>
      <header class="gen-head">
        <h3>{props.title}</h3>
        <p class="gen-meta">
          {props.count} {props.count === 1 ? 'transaction' : 'transactions'}, {props.filters}
        </p>
      </header>
      {props.transactions.length === 0 ? (
        <p class="gen-empty">No transactions match. Try a longer period or another category.</p>
      ) : (
        <div class="table-wrap">
          <table class="tx-table">
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Merchant</th>
                <th scope="col" class="hide-sm">Category</th>
                <th scope="col" class="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {() =>
                rows().map((t) => (
                  <tr>
                    <td class="tx-date">{shortDate(t.date)}</td>
                    <td>
                      <span class="tx-merchant">{t.merchant}</span>
                      {' '}
                      <span class="ledger-sub">{t.accountId}</span>
                    </td>
                    <td class="hide-sm">
                      <span class={`cat cat-${t.category}`}>{categoryLabel(t.category)}</span>
                    </td>
                    <td class={`num ${t.amountCents > 0 ? 'credit' : ''}`}>{money(t.amountCents, t.currency, { sign: true })}</td>
                  </tr>
                ))
              }
            </tbody>
          </table>
        </div>
      )}
      <footer class="gen-foot">
        <span>
          Out <strong class="num">{money(props.totalOutCents)}</strong>
        </span>
        {props.totalInCents > 0 && (
          <span>
            In <strong class="num credit">{money(props.totalInCents)}</strong>
          </span>
        )}
        {props.transactions.length > PAGE && (
          <button type="button" class="link-btn" onClick={() => setAll(!all())} aria-expanded={() => String(all())}>
            {() => (all() ? 'Show fewer' : `Show all ${props.transactions.length}`)}
          </button>
        )}
      </footer>
    </section>
  );
}
