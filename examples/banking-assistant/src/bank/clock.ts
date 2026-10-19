import { Singleton, Value } from 'amoxi';

/**
 * The bank's business date. Defaults to the real date; tests (or a demo frozen in time) set
 * `bank.today=2026-10-18` so seeded data, limits and "this month" are reproducible.
 */
@Singleton()
export class BankClock {
  private readonly fixed?: string;

  constructor(@Value('${bank.today:}') today: string) {
    this.fixed = /^\d{4}-\d{2}-\d{2}$/.test(today) ? today : undefined;
  }

  /** yyyy-mm-dd (UTC). */
  today(): string {
    return this.fixed ?? new Date().toISOString().slice(0, 10);
  }

  /** yyyy-mm of today. */
  month(): string {
    return this.today().slice(0, 7);
  }

  /** yyyy-mm of the previous month. */
  previousMonth(): string {
    const [y, m] = this.month().split('-').map(Number);
    return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  }

  /** The date `days` before today, yyyy-mm-dd. */
  daysAgo(days: number): string {
    const d = new Date(`${this.today()}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - days);
    return d.toISOString().slice(0, 10);
  }

  /** A timestamp on the business date (the real time of day). */
  timestamp(): string {
    const now = new Date().toISOString();
    return this.fixed ? `${this.fixed}${now.slice(10)}` : now;
  }
}
