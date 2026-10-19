// Data shapes shared by tools (server) and generative islands (browser). Types only.
import type { Currency } from './format';

export interface AccountLine {
  id: string;
  name: string;
  currency: Currency;
  balanceCents: number;
  type: string;
}

export interface CardLine {
  id: string;
  name: string;
  last4: string;
  status: 'frozen' | 'active';
}

export interface AccountsResult {
  accounts: AccountLine[];
  totalCadCents: number;
  cards: CardLine[];
}

export interface TransactionRow {
  date: string;
  merchant: string;
  amountCents: number;
  category: string;
  id: string;
  accountId: string;
  currency: Currency;
}

export interface TransactionsResult {
  count: number;
  totalOutCents: number;
  totalInCents: number;
  filters: string;
  transactions: TransactionRow[];
}

export interface SpendingResult {
  month: string;
  totalCents: number;
  categories: Array<{ category: string; amountCents: number; transactions: number }>;
}
