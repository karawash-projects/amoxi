import { type RequestContext } from 'amoxi';
import { Agent, type AgentRunContext, type RunRecord, type ToolContext } from 'amoxi/ai';
import { AuditLog } from '../audit/audit-log';
import { CustomerDirectory } from '../bank/customers';
import { Ledger } from '../bank/ledger';
import { MoneyMovementService } from '../bank/money-movement';
import { money } from '../ui/format';
import { BankingTools } from './banking-tools';
import { FxTools } from './fx-tools';
import { BankClock } from '../bank/clock';

/** Input fields that name an account or a card. */
const ID_FIELD = /(account|card)Id$/i;

/**
 * Demo Bank's digital assistant: answers questions about the signed-in customer's
 * accounts, spending and fees, and moves money or freezes cards only with their approval.
 */
@Agent({
  name: 'banking-assistant',
  tools: [BankingTools, FxTools],
  ui: ['AccountsOverview', 'TransactionTable', 'SpendingChart', 'TransferReceipt'],
  knowledge: ['fees'],
  memory: true,
  examples: ['Show my accounts and balances', 'Show my spending by category this month', 'What is the fee for a foreign transaction?'],
})
export class BankingAssistant {
  constructor(
    private readonly customers: CustomerDirectory,
    private readonly ledger: Ledger,
    private readonly money: MoneyMovementService,
    private readonly audit: AuditLog,
    private readonly clock: BankClock,
  ) {}

  /** The limit MoneyMovementService enforces; the guardrail below refuses earlier, before approval. */
  get singleTransferLimitCents(): number {
    return this.money.singleTransferLimitCents;
  }

  instructions(ctx: AgentRunContext): string {
    const customer = this.customers.find(ctx.principal);
    // The bank's business date (bank.today when set), the same one the ledger and limits use.
    const today = this.clock.today();
    if (!customer) return `You are Demo Bank's digital assistant. Today is ${today}. Nobody is signed in: answer only general questions about Demo Bank's published fees and rates, and never access accounts.`;
    const accounts = this.ledger.accountsOf(customer.id);
    const cards = this.ledger.cardsOf(customer.id);
    return [
      `You are the digital assistant inside Demo Bank online banking (a Canadian retail bank). Today is ${today}.`,
      `You are helping ${customer.name} (customer ${customer.id}). Their accounts: ${accounts.map((a) => `${a.id} ${a.name} (${a.currency})`).join('; ')}. Their cards: ${cards.map((c) => `${c.id} ${c.name}`).join('; ')}.`,
      'Bank rules you must follow:',
      '- Only work with this customer\'s own accounts and cards listed above. Never reveal or act on anyone else\'s.',
      '- Use the tools for balances, transactions and spending; never estimate or invent numbers. Amounts are in CAD unless an account is a USD account.',
      `- Money moves only through transfer_between_accounts, between two of the customer's own accounts in the same currency. The single-transfer limit is ${money(this.singleTransferLimitCents)} and the daily limit is ${money(this.money.dailyLimitCents)}; larger transfers are done at a branch.`,
      '- Transfers and card freezes/unfreezes run only after the customer approves them in the app. Propose them with the exact accounts and amount; if a request is ambiguous, ask first.',
      '- For fees, limits, cards, overdraft, disputes and exchange rules, call search_knowledge and cite the policy title. Never make up a fee.',
      '- Never ask for passwords, PINs, full card numbers or one-time codes.',
      'Keep answers short and plain. When a tool shows a component (accounts, transactions, chart, receipt), add one or two sentences of insight instead of repeating its numbers.',
    ].join('\n');
  }

  /** Runs execute in the background: capture the signed-in customer while the request is here. */
  principal(req: RequestContext): string | undefined {
    return this.customers.find(req.session.get('customerId'))?.id;
  }

  /** Conversations belong to the customer: another customer gets 404. */
  owner(req: RequestContext): string | undefined {
    return this.customers.find(req.session.get('customerId'))?.id;
  }

  /**
   * Guardrail, checked before every tool call (defence in depth: the services check again).
   * Refuses transfers above the single-transfer limit and any account or card id that isn't the
   * signed-in customer's, whatever the model was talked into.
   */
  beforeToolCall(call: { tool: string; input: unknown; ctx: ToolContext }): string | undefined {
    const customerId = typeof call.ctx.principal === 'string' ? call.ctx.principal : undefined;
    const input = (call.input ?? {}) as Record<string, unknown>;
    const ids = Object.entries(input).filter(([k, v]) => ID_FIELD.test(k) && typeof v === 'string') as Array<[string, string]>;
    const refuse = (reason: string, data: Record<string, string | number>): string => {
      this.audit.append({ actor: customerId ?? 'anonymous', action: 'guardrail', outcome: 'refused', summary: `${call.tool}: ${reason}`, data: { tool: call.tool, runId: call.ctx.runId, ...data } });
      return reason;
    };
    if (ids.length > 0 && !customerId) return refuse('Refused: no signed-in customer for this conversation.', {});
    for (const [field, id] of ids) {
      if (!this.ledger.owns(customerId!, id)) return refuse(`Refused by policy: ${id} is not one of this customer's accounts or cards.`, { field, id });
    }
    if (call.tool === 'transfer_between_accounts') {
      const amount = Number(input.amountCents);
      if (amount > this.singleTransferLimitCents) {
        return refuse(
          `Refused by policy: ${money(amount)} is over the ${money(this.singleTransferLimitCents)} single-transfer limit for online and assistant transfers. Larger transfers can be made at a branch or through the contact centre.`,
          { amountCents: amount },
        );
      }
    }
    return undefined;
  }

  /** Audit trail: one entry per finished conversation turn. */
  onRunFinished(run: RunRecord): void {
    this.audit.append({
      actor: typeof run.principal === 'string' ? run.principal : 'anonymous',
      action: 'agent.run',
      outcome: run.status,
      summary: `Asked: ${run.input.replace(/\s+/g, ' ').slice(0, 140)}`,
      data: {
        runId: run.id,
        turns: run.turns,
        inputTokens: run.usage.inputTokens,
        outputTokens: run.usage.outputTokens,
        error: run.error?.message,
      },
    });
  }
}
