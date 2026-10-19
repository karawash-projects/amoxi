import { Singleton } from 'amoxi';
import { Tool, type ToolContext, ToolError } from 'amoxi/ai';
import { BankClock } from '../bank/clock';
import { Ledger } from '../bank/ledger';
import type { CardStatus, Category } from '../bank/model';
import { MoneyMovementService } from '../bank/money-movement';
import { categoryLabel, monthLabel } from '../ui/format';
import type { AccountsResult, SpendingResult, TransactionRow, TransactionsResult } from '../ui/types';

export type { AccountsResult };

/** The customer a run acts for, captured from the session when the run started. */
export function customerOf(ctx: ToolContext): string {
  if (typeof ctx.principal !== 'string' || !ctx.principal) throw new ToolError('No signed-in customer: sign in to online banking first.');
  return ctx.principal;
}

export interface AccountsSummary {
  accounts: Array<{ account: string; balanceCents: number; currency: string }>;
  totalInCadCents: number;
  cards: Array<{ card: string; status: string }>;
}

export interface TransferSummary {
  status: 'posted';
  reference: string;
  amountCents: number;
  from: string;
  to: string;
  fromBalanceAfterCents: number;
  toBalanceAfterCents: number;
  currency: string;
}

const SPENDING: readonly Category[] = ['housing', 'groceries', 'dining', 'transport', 'utilities', 'shopping', 'subscriptions', 'travel'];

/**
 * What the assistant can do with the signed-in customer's money. None of these are offered over
 * MCP (expose: false): they act for a signed-in person, so only the in-app assistant may call them.
 * Every method takes the customer from ctx.principal, never from the model's arguments.
 */
@Singleton()
export class BankingTools {
  constructor(
    private readonly ledger: Ledger,
    private readonly money: MoneyMovementService,
    private readonly clock: BankClock,
  ) {}

  accounts(customerId: string): AccountsResult {
    const accounts = this.ledger.accountsOf(customerId).map((a) => ({ id: a.id, name: a.name, currency: a.currency, balanceCents: a.balanceCents, type: a.type }));
    return {
      accounts,
      totalCadCents: accounts.filter((a) => a.currency === 'CAD').reduce((s, a) => s + a.balanceCents, 0),
      cards: this.ledger.cardsOf(customerId).map((c) => ({ id: c.id, name: c.name, last4: c.last4, status: c.frozen ? 'frozen' : 'active' })),
    };
  }

  /** List the customer's bank accounts with their current balances, and their cards with each card's status. */
  @Tool({ readOnly: true, expose: false })
  listAccounts(_input: {}, ctx: ToolContext): AccountsSummary {
    const result = this.accounts(customerOf(ctx));
    ctx.ui('AccountsOverview', { ...result });
    // The component gets every detail; the model gets a compact, readable summary.
    return {
      accounts: result.accounts.map((a) => ({ account: `${a.name} (${a.id})`, balanceCents: a.balanceCents, currency: a.currency })),
      totalInCadCents: result.totalCadCents,
      cards: result.cards.map((c) => ({ card: `${c.name} (${c.id})`, status: c.status })),
    };
  }

  /** Recent account activity: the customer's latest transactions, newest first, optionally filtered by category, merchant, account or date. */
  @Tool({ readOnly: true, expose: false })
  recentActivity(
    input: {
      /** Only this spending category */
      category?: Category;
      /** Only merchants whose name contains this text, e.g. "Marrowfield" */
      merchant?: string;
      /** Only this account, e.g. CHQ-4417 */
      accountId?: string;
      /**
       * Only transactions on or after this date, yyyy-mm-dd
       * @format date
       */
      sinceDate?: string;
      /**
       * How many days back to look when no date is given (default 30)
       * @integer
       * @minimum 1
       * @maximum 120
       */
      days?: number;
    },
    ctx: ToolContext,
  ): TransactionsResult {
    const customerId = customerOf(ctx);
    if (input.accountId && !this.ledger.account(customerId, input.accountId)) throw new ToolError(`Account ${input.accountId} is not one of your accounts.`);
    const since = input.sinceDate ?? this.clock.daysAgo(input.days ?? 30);
    const all = this.ledger.transactionsOf(customerId, { accountId: input.accountId, category: input.category, merchant: input.merchant, since });
    const rows: TransactionRow[] = all.slice(0, 25).map((t) => ({ date: t.date, merchant: t.merchant, amountCents: t.amountCents, category: t.category, id: t.id, accountId: t.accountId, currency: t.currency }));
    const cad = all.filter((t) => t.currency === 'CAD');
    const filters = [
      input.category ? categoryLabel(input.category) : '',
      input.merchant ? `merchant "${input.merchant}"` : '',
      input.accountId ? input.accountId.toUpperCase() : '',
      `since ${since}`,
    ]
      .filter(Boolean)
      .join(', ');
    const result: TransactionsResult = {
      count: all.length,
      totalOutCents: -cad.filter((t) => t.amountCents < 0).reduce((s, t) => s + t.amountCents, 0),
      totalInCents: cad.filter((t) => t.amountCents > 0).reduce((s, t) => s + t.amountCents, 0),
      filters,
      transactions: rows,
    };
    ctx.ui('TransactionTable', { title: input.category ? `${categoryLabel(input.category)} transactions` : 'Recent transactions', ...result });
    return result;
  }

  /** Summarize the customer's spending by category for a month (this month by default) as a chart. */
  @Tool({ readOnly: true, expose: false })
  spendingByCategory(
    input: {
      /** Which month, relative to today (default this month) */
      period?: 'this month' | 'last month';
      /**
       * A specific month, yyyy-mm (overrides period)
       * @pattern ^\d{4}-(0[1-9]|1[0-2])$
       */
      month?: string;
    },
    ctx: ToolContext,
  ): SpendingResult {
    const customerId = customerOf(ctx);
    const month = input.month ?? (input.period === 'last month' ? this.clock.previousMonth() : this.clock.month());
    const tx = this.ledger.transactionsOf(customerId, { since: `${month}-01`, until: `${month}-31` }).filter((t) => t.currency === 'CAD' && t.amountCents < 0);
    const categories = SPENDING.map((c) => {
      const list = tx.filter((t) => t.category === c);
      return { category: categoryLabel(c), amountCents: -list.reduce((s, t) => s + t.amountCents, 0), transactions: list.length };
    })
      .filter((c) => c.amountCents > 0)
      .sort((a, b) => b.amountCents - a.amountCents);
    const result: SpendingResult = { month: monthLabel(month), totalCents: categories.reduce((s, c) => s + c.amountCents, 0), categories };
    ctx.ui('SpendingChart', { ...result, partial: month === this.clock.month() });
    return result;
  }

  /** Transfer money between two of the customer's own accounts in the same currency. Runs only after the customer approves it. */
  @Tool({ approval: true, idempotent: true, expose: false })
  async transferBetweenAccounts(
    input: {
      /** Account to take the money from, e.g. CHQ-4417 */
      fromAccountId: string;
      /** Account to put the money in, e.g. SAV-4418 */
      toAccountId: string;
      /**
       * Amount in cents, e.g. 25000 for $250.00
       * @integer
       * @minimum 1
       */
      amountCents: number;
      /**
       * Optional note shown on both accounts' history
       * @maxLength 60
       */
      memo?: string;
    },
    ctx: ToolContext,
  ): Promise<TransferSummary> {
    const customerId = customerOf(ctx);
    // idempotent + ctx.step: if the server restarts mid-call, the call runs again on resume and the
    // recorded receipt is replayed, never re-posted.
    const receipt = await ctx.step('post-transfer', () => {
      const r = this.money.transfer({
        customerId,
        fromAccountId: input.fromAccountId,
        toAccountId: input.toAccountId,
        amountCents: input.amountCents,
        memo: input.memo,
        // One key per tool call (stable when a call is resumed), so asking twice for the same
        // transfer in one conversation moves the money twice, as the customer approved twice.
        idempotencyKey: `${ctx.runId}:${ctx.callId}`,
      });
      return { ...r };
    });
    ctx.ui('TransferReceipt', { ...receipt });
    return {
      status: 'posted',
      reference: receipt.reference,
      amountCents: receipt.amountCents,
      from: `${receipt.fromName} (${receipt.fromAccountId})`,
      to: `${receipt.toName} (${receipt.toAccountId})`,
      fromBalanceAfterCents: receipt.fromBalanceCents,
      toBalanceAfterCents: receipt.toBalanceCents,
      currency: receipt.currency,
    };
  }

  /** Freeze one of the customer's cards so it declines new purchases and withdrawals (lost or stolen card). Needs the customer's approval. */
  @Tool({ approval: true, expose: false })
  freezeCard(
    input: {
      /** The card, e.g. CRD-7781 */
      cardId: string;
    },
    ctx: ToolContext,
  ): Promise<CardStatus> {
    return this.cardStatus(input.cardId, true, ctx);
  }

  /** Unfreeze a frozen card so it works again. Needs the customer's approval. */
  @Tool({ approval: true, expose: false })
  unfreezeCard(
    input: {
      /** The card, e.g. CRD-7781 */
      cardId: string;
    },
    ctx: ToolContext,
  ): Promise<CardStatus> {
    return this.cardStatus(input.cardId, false, ctx);
  }

  private async cardStatus(cardId: string, frozen: boolean, ctx: ToolContext): Promise<CardStatus> {
    const customerId = customerOf(ctx);
    const status = await ctx.step('card-status', () => ({ ...this.money.setCardFrozen({ customerId, cardId, frozen }) }));
    ctx.ui('AccountsOverview', { ...this.accounts(customerId), highlight: status.cardId });
    return status;
  }
}
