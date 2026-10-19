import { Intercept, Singleton, Value } from 'amoxi';
import { AuditInterceptor } from '../audit/audit-interceptor';
import { money } from '../ui/format';
import { BankClock } from './clock';
import { Ledger } from './ledger';
import type { CardRequest, CardStatus, TransferReceipt, TransferRequest } from './model';
import { ToolError } from 'amoxi/ai';

/** A business-rule refusal; its message is safe to show the customer (and the model). */
export class BankingRuleError extends ToolError {
  override name = 'BankingRuleError';
}

/**
 * Everything that moves money or changes what a card can do. The rules live here, not in the
 * agent: the same checks apply to the assistant, the web app and any future API client.
 * Each method is wrapped by AuditInterceptor, so every attempt lands in the audit log.
 */
@Singleton()
export class MoneyMovementService {
  private readonly receipts = new Map<string, TransferReceipt>();
  private readonly sentToday = new Map<string, number>();
  private sequence = 0;

  constructor(
    private readonly ledger: Ledger,
    private readonly clock: BankClock,
    @Value('${bank.limits.daily-transfer-cents:500000}') readonly dailyLimitCents: number,
    @Value('${bank.limits.single-transfer-cents:300000}') readonly singleTransferLimitCents: number,
  ) {}

  /** Moves money between two of the customer's own accounts. Idempotent per idempotencyKey. */
  @Intercept(AuditInterceptor)
  transfer(request: TransferRequest): TransferReceipt {
    const replay = this.receipts.get(request.idempotencyKey);
    if (replay) return replay;

    const { customerId, amountCents } = request;
    if (!Number.isInteger(amountCents) || amountCents < 1) throw new BankingRuleError('The amount must be a whole number of cents, at least $0.01.');
    if (amountCents > this.singleTransferLimitCents) {
      throw new BankingRuleError(`${money(amountCents)} is over the ${money(this.singleTransferLimitCents)} single-transfer limit for online transfers. Larger transfers can be made at a branch or through the contact centre.`);
    }
    const from = this.ledger.account(customerId, request.fromAccountId);
    const to = this.ledger.account(customerId, request.toAccountId);
    // Same message whether the account doesn't exist or belongs to someone else: no probing.
    if (!from) throw new BankingRuleError(`Account ${request.fromAccountId} is not one of your accounts.`);
    if (!to) throw new BankingRuleError(`Account ${request.toAccountId} is not one of your accounts.`);
    if (from.id === to.id) throw new BankingRuleError('Choose two different accounts.');
    if (from.currency !== to.currency) {
      throw new BankingRuleError(`${from.id} is in ${from.currency} and ${to.id} is in ${to.currency}. Transfers between currencies need an exchange; ask for a quote first.`);
    }
    const key = `${customerId}:${this.clock.today()}`;
    const already = this.sentToday.get(key) ?? 0;
    if (already + amountCents > this.dailyLimitCents) {
      const left = Math.max(0, this.dailyLimitCents - already);
      throw new BankingRuleError(`This would exceed your daily transfer limit of ${money(this.dailyLimitCents)}; you can still transfer ${money(left)} today.`);
    }
    if (from.balanceCents < amountCents) {
      throw new BankingRuleError(`Insufficient funds: ${from.name} (${from.id}) has ${money(from.balanceCents, from.currency)} available, less than ${money(amountCents, from.currency)}.`);
    }

    const memo = (request.memo ?? '').trim().slice(0, 60);
    this.ledger.post(customerId, from, to, amountCents, memo);
    this.sentToday.set(key, already + amountCents);
    const receipt: TransferReceipt = {
      reference: `TRF-${this.clock.today().replace(/-/g, '').slice(2)}-${String(++this.sequence).padStart(4, '0')}`,
      fromAccountId: from.id,
      fromName: from.name,
      toAccountId: to.id,
      toName: to.name,
      amountCents,
      currency: from.currency,
      fromBalanceCents: from.balanceCents,
      toBalanceCents: to.balanceCents,
      memo,
      postedAt: this.clock.timestamp(),
    };
    this.receipts.set(request.idempotencyKey, receipt);
    return receipt;
  }

  /** Freezes or unfreezes one of the customer's cards. */
  @Intercept(AuditInterceptor)
  setCardFrozen(request: CardRequest): CardStatus {
    const card = this.ledger.card(request.customerId, request.cardId);
    if (!card) throw new BankingRuleError(`Card ${request.cardId} is not one of your cards.`);
    const changed = card.frozen !== request.frozen;
    this.ledger.setFrozen(card, request.frozen);
    return { cardId: card.id, name: card.name, last4: card.last4, status: card.frozen ? 'frozen' : 'active', changed };
  }

  /** How much the customer has transferred today, in cents. */
  transferredToday(customerId: string): number {
    return this.sentToday.get(`${customerId}:${this.clock.today()}`) ?? 0;
  }
}
