import { money } from '../ui/format';

interface ComparedProduct {
  id: string;
  name: string;
  priceCents: number;
  url: string;
  art: string;
}

interface ComparisonRow {
  label: string;
  /** One value per product, in the same order as `products`. */
  values: string[];
  /** Index of the product with the best value for this row, if there is a clear winner. */
  best?: number;
}

/** @generative Compares two to four products side by side in a table, marking the best value in each row */
export default function ComparisonTable(props: { products: ComparedProduct[]; rows: ComparisonRow[]; verdict?: string }) {
  return (
    <section class="compare" aria-label="Product comparison">
      <div class="compare-scroll" tabindex="0" role="region" aria-label="Comparison table, scrolls sideways">
        <table>
          <caption class="sr-only">Comparison of {props.products.map((p) => p.name).join(', ')}</caption>
          <thead>
            <tr>
              <td />
              {props.products.map((p) => (
                <th scope="col">
                  <a href={p.url} class="compare-product">
                    <img src={p.art} alt="" width="160" height="120" loading="lazy" />
                    <span>{p.name}</span>
                  </a>
                  <span class="compare-price">{money(p.priceCents)}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {props.rows.map((row) => (
              <tr>
                <th scope="row">{row.label}</th>
                {row.values.map((v, i) => (
                  <td class={row.best === i ? 'best' : undefined}>
                    {v}
                    {row.best === i ? <span class="best-mark"> best</span> : null}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {props.verdict ? <p class="compare-verdict">{props.verdict}</p> : null}
    </section>
  );
}
