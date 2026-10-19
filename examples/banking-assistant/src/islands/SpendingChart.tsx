import { onMount, signal } from 'amoxi';
import { money } from '../ui/format';

interface Slice {
  category: string;
  amountCents: number;
  transactions: number;
}

const ROW = 30;
const LABEL_W = 116;
const VALUE_W = 86;
/** Drawn at the container's real width (1 SVG unit = 1 CSS px), so labels stay 13px on phones too. */
const MAX_WIDTH = 640;

/** @generative Shows the customer's spending for one month as a bar chart by category */
export default function SpendingChart(props: {
  month: string;
  totalCents: number;
  categories: Slice[];
  /** True when the month is still in progress. */
  partial?: boolean;
}) {
  const [active, setActive] = signal<number | undefined>(undefined);
  const max = Math.max(1, ...props.categories.map((c) => c.amountCents));
  const [width, setWidth] = signal(560);
  let box!: HTMLElement;
  onMount(() => {
    const fit = (): void => setWidth(Math.max(260, Math.min(MAX_WIDTH, Math.floor(box.clientWidth))));
    const ro = new ResizeObserver(fit);
    ro.observe(box);
    fit();
    return () => ro.disconnect();
  });
  const height = props.categories.length * ROW + 4;
  const share = (c: Slice): number => (props.totalCents > 0 ? Math.round((c.amountCents / props.totalCents) * 100) : 0);
  const summary = props.categories.map((c) => `${c.category} ${money(c.amountCents)}`).join(', ');
  return (
    <section class="gen gen-chart" aria-label={`Spending in ${props.month}`}>
      <header class="gen-head">
        <h3>Spending in {props.month}</h3>
        <p class="gen-meta">
          <strong class="num">{money(props.totalCents)}</strong> across CAD accounts{props.partial ? ', month to date' : ''}
        </p>
      </header>
      {props.categories.length === 0 ? (
        <p class="gen-empty">No spending recorded for this month yet.</p>
      ) : (
        <>
          <div class="chart-box" ref={(el: HTMLElement) => (box = el)}>
            {() => {
              const W = width();
              const label = W < 380 ? 104 : LABEL_W;
              const plot = W - label - VALUE_W;
              return (
              <svg class="bar-chart" width={W} height={height} viewBox={`0 0 ${W} ${height}`} role="img" aria-label={`Spending by category: ${summary}`}>
                {props.categories.map((c, i) => {
                  const w = Math.max(4, (c.amountCents / max) * plot);
                  const y = i * ROW + 4;
                  return (
                    <g
                      class={() => (active() === i ? 'bar-row is-active' : 'bar-row')}
                      onMouseEnter={() => setActive(i)}
                      onMouseLeave={() => setActive(undefined)}
                      onClick={() => setActive(i)}
                    >
                      <title>{`${c.category}: ${money(c.amountCents)}, ${share(c)}% of the month, ${c.transactions} transactions`}</title>
                      <rect class="bar-hit" x="0" y={y - 3} width={W} height={ROW} />
                      <text class="bar-label" x={label - 10} y={y + 14} text-anchor="end">
                        {c.category}
                      </text>
                      <path class="bar" d={barPath(label, y + 2, w, 18)} />
                      <text class="bar-value" x={label + w + 8} y={y + 15}>
                        {money(c.amountCents)}
                      </text>
                    </g>
                  );
                })}
              </svg>
              );
            }}
          </div>
          <p class="chart-detail" aria-live="polite">
            {() => {
              const i = active();
              if (i === undefined) return 'Point at or tap a bar to see its share of the month.';
              const c = props.categories[i];
              return `${c.category}: ${share(c)}% of spending, ${c.transactions} ${c.transactions === 1 ? 'transaction' : 'transactions'}.`;
            }}
          </p>
          <table class="visually-hidden">
            <caption>Spending by category, {props.month}</caption>
            <thead>
              <tr>
                <th scope="col">Category</th>
                <th scope="col">Amount</th>
                <th scope="col">Transactions</th>
              </tr>
            </thead>
            <tbody>
              {props.categories.map((c) => (
                <tr>
                  <td>{c.category}</td>
                  <td>{money(c.amountCents)}</td>
                  <td>{c.transactions}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

/** A bar anchored at the baseline (square left end) with a 4px rounded data end. */
function barPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h / 2);
  return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
}
