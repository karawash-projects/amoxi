import { Singleton } from 'amoxi';
import { BankClock } from './clock';

/** Fictional mid-market rate: 1 CAD = 0.7312 USD. */
export const MID_CAD_USD = 0.7312;
/** The bank's spread on each side of the mid rate, in percent. */
export const FX_SPREAD_PERCENT = 1.5;

export type FxDirection = 'CAD to USD' | 'USD to CAD';

export interface FxQuote {
  readonly direction: FxDirection;
  readonly sellCurrency: 'CAD' | 'USD';
  readonly buyCurrency: 'CAD' | 'USD';
  readonly sellAmountCents: number;
  readonly buyAmountCents: number;
  /** Units of buy currency per 1 unit of sell currency, the customer rate after spread. */
  readonly customerRate: number;
  readonly midRate: number;
  readonly spreadPercent: number;
  readonly validUntil: string;
  readonly note: string;
}

export interface RateRow {
  readonly pair: string;
  readonly mid: number;
  /** What a customer gets per unit, after the spread. */
  readonly customerRate: number;
}

/** The FX desk: fictional rates, refreshed nowhere (this is a demo). */
@Singleton()
export class FxDesk {
  constructor(private readonly clock: BankClock) {}

  rate(direction: FxDirection): { mid: number; customer: number } {
    const mid = direction === 'CAD to USD' ? MID_CAD_USD : 1 / MID_CAD_USD;
    const customer = mid * (1 - FX_SPREAD_PERCENT / 100);
    return { mid: round(mid, 4), customer: round(customer, 4) };
  }

  quote(direction: FxDirection, sellAmountCents: number): FxQuote {
    const { mid, customer } = this.rate(direction);
    const [sell, buy] = direction === 'CAD to USD' ? (['CAD', 'USD'] as const) : (['USD', 'CAD'] as const);
    return {
      direction,
      sellCurrency: sell,
      buyCurrency: buy,
      sellAmountCents,
      buyAmountCents: Math.floor(sellAmountCents * customer),
      customerRate: customer,
      midRate: mid,
      spreadPercent: FX_SPREAD_PERCENT,
      validUntil: `${this.clock.today()}T23:59:59Z`,
      note: 'Indicative quote with fictional rates; the rate is locked only when an exchange is booked.',
    };
  }

  table(): RateRow[] {
    const row = (pair: string, direction: FxDirection): RateRow => {
      const { mid, customer } = this.rate(direction);
      return { pair, mid, customerRate: customer };
    };
    return [row('CAD to USD', 'CAD to USD'), row('USD to CAD', 'USD to CAD')];
  }
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
