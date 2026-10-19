import { PostConstruct, Singleton } from 'amoxi';
import { BankClock } from './clock';
import type { Account, AccountType, Card, Category, Currency, Transaction } from './model';

interface AccountSeed {
  id: string;
  name: string;
  type: AccountType;
  currency: Currency;
  balanceCents: number;
}

const SEED: Record<string, { accounts: AccountSeed[]; cards: Array<Omit<Card, 'customerId' | 'frozen'>>; payroll: [string, number]; rent: [string, number] }> = {
  'C-1001': {
    accounts: [
      { id: 'CHQ-4417', name: 'Everyday Chequing', type: 'chequing', currency: 'CAD', balanceCents: 184_235 },
      { id: 'SAV-4418', name: 'High Interest Savings', type: 'savings', currency: 'CAD', balanceCents: 1_265_000 },
      { id: 'USD-4419', name: 'US Dollar Account', type: 'usd', currency: 'USD', balanceCents: 124_018 },
    ],
    cards: [
      { id: 'CRD-7781', name: 'Demo Bank Debit', last4: '7781', linkedAccountId: 'CHQ-4417' },
      { id: 'CRD-7782', name: 'Demo Bank Rewards credit', last4: '7782', linkedAccountId: 'CHQ-4417' },
    ],
    payroll: ['Vireolane Design Studio payroll', 248_000],
    rent: ['Pellmont Properties (rent)', 152_500],
  },
  'C-1002': {
    accounts: [
      { id: 'CHQ-5521', name: 'Everyday Chequing', type: 'chequing', currency: 'CAD', balanceCents: 631_090 },
      { id: 'SAV-5522', name: 'High Interest Savings', type: 'savings', currency: 'CAD', balanceCents: 420_000 },
      { id: 'TFSA-5523', name: 'Tax-Free Savings Account', type: 'tfsa', currency: 'CAD', balanceCents: 1_890_000 },
    ],
    cards: [
      { id: 'CRD-8841', name: 'Demo Bank Debit', last4: '8841', linkedAccountId: 'CHQ-5521' },
      { id: 'CRD-8842', name: 'Demo Bank Rewards credit', last4: '8842', linkedAccountId: 'CHQ-5521' },
    ],
    payroll: ['Quarrowind Energy payroll', 312_000],
    rent: ['Thistlecove Lofts (rent)', 189_000],
  },
  'C-1003': {
    accounts: [
      { id: 'CHQ-6630', name: 'Everyday Chequing', type: 'chequing', currency: 'CAD', balanceCents: 297_540 },
      { id: 'SAV-6631', name: 'High Interest Savings', type: 'savings', currency: 'CAD', balanceCents: 3_012_075 },
      { id: 'USD-6632', name: 'US Dollar Account', type: 'usd', currency: 'USD', balanceCents: 84_500 },
    ],
    cards: [
      { id: 'CRD-9931', name: 'Demo Bank Debit', last4: '9931', linkedAccountId: 'CHQ-6630' },
      { id: 'CRD-9932', name: 'Demo Bank Rewards credit', last4: '9932', linkedAccountId: 'CHQ-6630' },
    ],
    payroll: ['Saltmeadow Health Cooperative payroll', 276_500],
    rent: ['Demo Bank home mortgage', 168_000],
  },
};

const MERCHANTS: Record<Exclude<Category, 'income' | 'transfers' | 'housing'>, Array<[string, number, number]>> = {
  groceries: [
    ['Marrowfield Grocers', 3_500, 16_000],
    ['Gullwick Market', 1_800, 9_000],
    ['Fernlowe Co-op', 2_500, 12_000],
  ],
  dining: [
    ['Lanterwick Noodle House', 1_600, 5_400],
    ['Bluefennel Café', 650, 1_900],
    ['Copperwhistle Diner', 2_200, 7_800],
  ],
  transport: [
    ['Northvane Fuel', 4_500, 9_500],
    ['Metrovane Transit', 300, 1_100],
    ['Ridevane', 1_400, 3_800],
  ],
  utilities: [
    ['Brightwick Hydro', 7_500, 14_500],
    ['Pinewhistle Internet', 8_500, 8_500],
    ['Lumenreach Mobile', 6_500, 6_500],
  ],
  subscriptions: [
    ['Streamorra', 1_699, 1_699],
    ['Pagewhistle Books+', 1_299, 1_299],
    ['Fitmarrow', 2_499, 2_499],
  ],
  shopping: [
    ['Graniteholm Outfitters', 4_500, 22_000],
    ['Brightholm Home', 2_000, 13_500],
    ['Pixelmere Electronics', 3_000, 41_000],
  ],
  travel: [
    ['Gulfmarrow Hotel, Tampa', 18_000, 42_000],
    ['Skyvane Air', 21_000, 38_000],
  ],
};

/** Small deterministic PRNG (mulberry32), so every start seeds the same history. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface TransactionFilter {
  readonly accountId?: string;
  readonly category?: Category;
  readonly merchant?: string;
  readonly since?: string;
  readonly until?: string;
  readonly limit?: number;
}

/**
 * The core-banking ledger: accounts, cards and transactions, in memory and seeded
 * deterministically at startup (about 75 days of history per customer).
 * Every query takes the customer id, so nothing can be read across customers by accident.
 */
@Singleton()
export class Ledger {
  private readonly accounts = new Map<string, Account>();
  private readonly cards = new Map<string, Card>();
  private readonly transactions: Transaction[] = [];
  private nextTx = 1;

  constructor(private readonly clock: BankClock) {}

  @PostConstruct()
  seed(): void {
    let customerNo = 0;
    for (const [customerId, seed] of Object.entries(SEED)) {
      customerNo++;
      for (const a of seed.accounts) this.accounts.set(a.id, { ...a, customerId });
      for (const c of seed.cards) this.cards.set(c.id, { ...c, customerId, frozen: false });
      const random = prng(1000 + customerNo * 7919);
      const chequing = seed.accounts.find((a) => a.type === 'chequing')!;
      const usd = seed.accounts.find((a) => a.currency === 'USD');
      const pick = <T,>(list: readonly T[]): T => list[Math.floor(random() * list.length)];
      const amount = (lo: number, hi: number): number => lo + Math.round((random() * (hi - lo)) / 5) * 5;
      for (let ago = 75; ago >= 0; ago--) {
        const date = this.clock.daysAgo(ago);
        const day = Number(date.slice(8, 10));
        const add = (category: Category, merchant: string, cents: number, account = chequing): void => {
          this.transactions.push({
            id: `TX-${customerNo}${String(this.nextTx++).padStart(5, '0')}`,
            customerId,
            accountId: account.id,
            date,
            merchant,
            category,
            amountCents: cents,
            currency: account.currency,
          });
        };
        if (day === 1 || day === 15) add('income', seed.payroll[0], seed.payroll[1]);
        if (day === 1) add('housing', seed.rent[0], -seed.rent[1]);
        if (day === 5) add('utilities', MERCHANTS.utilities[0][0], -amount(MERCHANTS.utilities[0][1], MERCHANTS.utilities[0][2]));
        if (day === 12) add('utilities', MERCHANTS.utilities[1][0], -MERCHANTS.utilities[1][1]);
        if (day === 20) add('utilities', MERCHANTS.utilities[2][0], -MERCHANTS.utilities[2][1]);
        if (day === 9) for (const [m, lo] of MERCHANTS.subscriptions.slice(0, customerNo === 2 ? 3 : 2)) add('subscriptions', m, -lo);
        if (random() < 0.36) {
          const [m, lo, hi] = pick(MERCHANTS.groceries);
          add('groceries', m, -amount(lo, hi));
        }
        if (random() < 0.3) {
          const [m, lo, hi] = pick(MERCHANTS.dining);
          add('dining', m, -amount(lo, hi));
        }
        if (random() < 0.22) {
          const [m, lo, hi] = pick(MERCHANTS.transport);
          add('transport', m, -amount(lo, hi));
        }
        if (random() < 0.08) {
          const [m, lo, hi] = pick(MERCHANTS.shopping);
          add('shopping', m, -amount(lo, hi));
        }
        if (usd && random() < 0.05) {
          const [m, lo, hi] = pick(MERCHANTS.travel);
          add('travel', m, -amount(lo, hi), usd);
        }
      }
    }
  }

  accountsOf(customerId: string): Account[] {
    return [...this.accounts.values()].filter((a) => a.customerId === customerId).map((a) => ({ ...a }));
  }

  cardsOf(customerId: string): Card[] {
    return [...this.cards.values()].filter((c) => c.customerId === customerId).map((c) => ({ ...c }));
  }

  /** The account, only if it belongs to the customer. */
  account(customerId: string, accountId: string): Account | undefined {
    const a = this.accounts.get(accountId.toUpperCase());
    return a && a.customerId === customerId ? a : undefined;
  }

  /** The card, only if it belongs to the customer. */
  card(customerId: string, cardId: string): Card | undefined {
    const c = this.cards.get(cardId.toUpperCase());
    return c && c.customerId === customerId ? c : undefined;
  }

  /** Whether an account or card id belongs to the customer. */
  owns(customerId: string, id: string): boolean {
    return this.account(customerId, id) !== undefined || this.card(customerId, id) !== undefined;
  }

  /** Newest first. */
  transactionsOf(customerId: string, filter: TransactionFilter = {}): Transaction[] {
    const merchant = filter.merchant?.toLowerCase();
    const out = this.transactions.filter(
      (t) =>
        t.customerId === customerId &&
        (!filter.accountId || t.accountId === filter.accountId.toUpperCase()) &&
        (!filter.category || t.category === filter.category) &&
        (!merchant || t.merchant.toLowerCase().includes(merchant)) &&
        (!filter.since || t.date >= filter.since) &&
        (!filter.until || t.date <= filter.until),
    );
    out.reverse();
    return filter.limit ? out.slice(0, filter.limit) : out;
  }

  /** Posts a balanced pair of entries (used by MoneyMovementService only). */
  post(customerId: string, from: Account, to: Account, amountCents: number, memo: string): void {
    const date = this.clock.today();
    from.balanceCents -= amountCents;
    to.balanceCents += amountCents;
    const base = { customerId, date, category: 'transfers' as const, currency: from.currency };
    this.transactions.push({ ...base, id: `TX-T${String(this.nextTx++).padStart(5, '0')}`, accountId: from.id, merchant: memo ? `Transfer to ${to.id}: ${memo}` : `Transfer to ${to.id}`, amountCents: -amountCents });
    this.transactions.push({ ...base, id: `TX-T${String(this.nextTx++).padStart(5, '0')}`, accountId: to.id, merchant: memo ? `Transfer from ${from.id}: ${memo}` : `Transfer from ${from.id}`, amountCents });
  }

  setFrozen(card: Card, frozen: boolean): void {
    card.frozen = frozen;
  }
}
