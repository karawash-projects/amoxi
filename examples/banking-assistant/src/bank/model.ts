import type { Currency } from '../ui/format';

export type { Currency };

export type AccountType = 'chequing' | 'savings' | 'usd' | 'tfsa';

export type Category = 'groceries' | 'dining' | 'transport' | 'housing' | 'utilities' | 'shopping' | 'subscriptions' | 'travel' | 'income' | 'transfers';

export interface Customer {
  readonly id: string;
  readonly name: string;
  readonly firstName: string;
  readonly city: string;
  readonly since: number;
  /** Shown on the demo sign-in page. */
  readonly persona: string;
}

export interface Account {
  readonly id: string;
  readonly customerId: string;
  readonly name: string;
  readonly type: AccountType;
  readonly currency: Currency;
  /** Integer cents. */
  balanceCents: number;
}

export interface Card {
  readonly id: string;
  readonly customerId: string;
  readonly name: string;
  readonly last4: string;
  readonly linkedAccountId: string;
  frozen: boolean;
}

export interface Transaction {
  readonly id: string;
  readonly customerId: string;
  readonly accountId: string;
  /** ISO date, yyyy-mm-dd. */
  readonly date: string;
  readonly merchant: string;
  readonly category: Category;
  /** Negative for money out. */
  readonly amountCents: number;
  readonly currency: Currency;
}

export interface TransferRequest {
  readonly customerId: string;
  readonly fromAccountId: string;
  readonly toAccountId: string;
  readonly amountCents: number;
  readonly memo?: string;
  /** Same key, same receipt: a retried request never moves money twice. */
  readonly idempotencyKey: string;
}

export interface TransferReceipt {
  readonly reference: string;
  readonly fromAccountId: string;
  readonly fromName: string;
  readonly toAccountId: string;
  readonly toName: string;
  readonly amountCents: number;
  readonly currency: Currency;
  readonly fromBalanceCents: number;
  readonly toBalanceCents: number;
  readonly memo: string;
  readonly postedAt: string;
}

export interface CardRequest {
  readonly customerId: string;
  readonly cardId: string;
  readonly frozen: boolean;
}

export interface CardStatus {
  readonly cardId: string;
  readonly name: string;
  readonly last4: string;
  readonly status: 'frozen' | 'active';
  readonly changed: boolean;
}
