import { Controller, ErrorPage, HttpResponse, Island, Page, QueryParam, Value, withData, withStatus, type RequestContext } from 'amoxi';
import { AgentPlatform, ChatModel, RunStore, toChatItems, userOwner, type ChatItem } from 'amoxi/ai';
import { BankingTools } from '../agent/banking-tools';
import { POLICIES } from '../agent/policies';
import { AuditLog } from '../audit/audit-log';
import { BankClock } from '../bank/clock';
import { CustomerDirectory } from '../bank/customers';
import { FX_SPREAD_PERCENT, FxDesk } from '../bank/fx';
import { Ledger } from '../bank/ledger';
import type { Customer } from '../bank/model';
import { MoneyMovementService } from '../bank/money-movement';
import AccountsPanel from '../islands/AccountsPanel';
import Assistant from '../islands/Assistant';
import SignIn from '../islands/SignIn';
import { categoryLabel, money, shortDate, stamp } from '../ui/format';
import { Layout, Mark } from '../ui/layout';

const AGENT = 'banking-assistant';

/** Published product rates (fictional). */
const INTEREST = [
  { product: 'High Interest Savings', ratePercent: 2.35, note: 'On the full balance, paid monthly' },
  { product: 'Tax-Free Savings Account', ratePercent: 2.6, note: 'Within your contribution room' },
  { product: 'US Dollar Account', ratePercent: 0.75, note: 'Paid monthly in USD' },
  { product: 'Everyday Chequing', ratePercent: 0, note: 'No interest' },
];

const FEES = [
  { item: 'Everyday Chequing monthly fee', amountCents: 495, note: 'Waived with a $3,000 minimum daily balance or a payroll deposit' },
  { item: 'Transfers between your own accounts', amountCents: 0, note: 'Unlimited' },
  { item: 'Foreign transaction fee', amountCents: null, note: '2.5% of the converted amount' },
  { item: 'Other Canadian ATM withdrawal', amountCents: 200, note: 'Demo Bank ATMs are free' },
  { item: 'ATM withdrawal outside Canada', amountCents: 500, note: 'Plus the foreign transaction fee' },
  { item: 'Replacement card', amountCents: 1000, note: 'First one each year is free' },
  { item: 'Returned item (NSF)', amountCents: 4800, note: 'Per item' },
  { item: 'Overdraft protection', amountCents: 500, note: 'Per month used, plus 21% interest' },
];

@Controller()
export class Pages {
  constructor(
    private readonly customers: CustomerDirectory,
    private readonly ledger: Ledger,
    private readonly banking: BankingTools,
    private readonly money: MoneyMovementService,
    private readonly fx: FxDesk,
    private readonly audit: AuditLog,
    private readonly clock: BankClock,
    private readonly platform: AgentPlatform,
    private readonly runs: RunStore,
    private readonly chatModel: ChatModel,
    @Value('${bank.limits.single-transfer-cents:300000}') private readonly singleLimitCents: number,
  ) {}

  private customer(ctx: RequestContext): Customer {
    return ctx.state.customer as Customer;
  }

  @Page('/')
  home() {
    return HttpResponse.redirect('/assistant', 303);
  }

  @Page('/signin')
  signIn(@QueryParam() next: string | undefined, ctx: RequestContext) {
    const current = this.customers.find(ctx.session.get('customerId'));
    return (
      <Layout title="Sign in" description="Demo sign-in to Demo Bank online banking.">
        <div class="signin">
          <section class="signin-intro">
            <Mark />
            <h1>Online banking, with an assistant that asks before it acts.</h1>
            <p class="lede">
              Choose a demo customer to sign in. Each has their own accounts, cards and transaction history, and the assistant only ever sees the one who is signed in.
            </p>
            <div class="callout">
              <h2>About this sign-in</h2>
              <p>
                This page stands in for the bank's identity provider. In production, customers sign in through Demo Bank's IdP (OpenID Connect with multi-factor
                authentication) and the app keeps only the verified customer id in its encrypted session. Everything after sign-in works the same.
              </p>
            </div>
            {current && (
              <p class="muted">
                You're signed in as {current.name}. <a href="/assistant">Continue to the assistant</a>
              </p>
            )}
          </section>
          <section class="signin-panel" aria-labelledby="choose">
            <h2 id="choose">Choose a customer</h2>
            <Island of={SignIn} customers={this.customers.all().map((c) => ({ id: c.id, name: c.name, city: c.city, since: c.since, persona: c.persona }))} next={next && next.startsWith('/') ? next : undefined} />
          </section>
        </div>
      </Layout>
    );
  }

  @Page('/assistant')
  async assistant(@QueryParam('new') fresh: string | undefined, ctx: RequestContext) {
    const customer = this.customer(ctx);
    const accounts = this.ledger.accountsOf(customer.id);
    const cards = this.ledger.cardsOf(customer.id);
    const restored = fresh ? undefined : await this.latestConversation(customer.id);
    const chq = accounts.find((a) => a.type === 'chequing')!;
    const sav = accounts.find((a) => a.type === 'savings')!;
    const debit = cards[0];
    const prompts = [
      { label: 'Accounts and balances', text: 'Show my accounts and balances' },
      { label: 'Recent grocery spending', text: 'Show my recent transactions for groceries' },
      { label: 'Spending this month', text: 'Show my spending by category this month' },
      { label: `Move $250 to savings`, text: `Transfer $250 from ${chq.id} to ${sav.id}` },
      { label: 'Freeze my debit card', text: `Freeze my card ${debit.id}` },
      { label: 'Foreign transaction fee', text: 'What is the fee for a foreign transaction?' },
      { label: 'CAD to USD quote', text: "What's the exchange rate for $500 CAD to USD?" },
    ];
    const names: Record<string, string> = {};
    for (const a of accounts) names[a.id] = a.name;
    for (const c of cards) names[c.id] = `${c.name} •••• ${c.last4}`;
    return (
      <Layout title="Assistant" active="assistant" customer={customer} workspace description="Demo Bank's digital assistant.">
        <h1 class="visually-hidden">Assistant</h1>
        <div class="desk">
          <Island
            of={Assistant}
            firstName={customer.firstName}
            initial={restored?.items ?? []}
            threadId={restored?.threadId}
            prompts={prompts}
            names={names}
            pending={restored?.pending}
            model={this.chatModel.provider === 'offline' ? 'Offline demo model (no API key)' : `${this.chatModel.provider} ${this.chatModel.model}`}
          />
          <Island of={AccountsPanel} initial={this.banking.accounts(customer.id)} singleLimitCents={this.singleLimitCents} dailyLimitCents={this.money.dailyLimitCents} />
        </div>
      </Layout>
    );
  }

  /** The customer's most recent conversation, as chat items, plus any approval still waiting. */
  private async latestConversation(customerId: string): Promise<{ threadId: string; items: ChatItem[]; pending?: { runId: string; approvals: Array<{ callId: string; tool: string; input: Record<string, unknown> }> } } | undefined> {
    // The same owner key the agent endpoints use for owner(req).
    const threads = await this.platform.threads(userOwner(customerId), AGENT);
    const thread = threads[0];
    if (!thread) return undefined;
    const found = await this.platform.thread(thread.id);
    if (!found) return undefined;
    const items = toChatItems(found.messages);
    const waiting = (await this.runs.listByThread(thread.id)).find((r) => r.status === 'awaiting_approval');
    if (!waiting) return { threadId: thread.id, items };
    const open = (waiting.pending ?? []).filter((p) => !p.decision);
    const ids = new Set(open.map((p) => p.callId));
    const inFlight = toChatItems(waiting.checkpoint ?? []).filter((i) => !(i.kind === 'tool' && ids.has(i.id)));
    return {
      threadId: thread.id,
      items: [...items, ...inFlight],
      pending: { runId: waiting.id, approvals: open.map((p) => ({ callId: p.callId, tool: p.tool, input: (p.input ?? {}) as Record<string, unknown> })) },
    };
  }

  @Page('/accounts')
  accounts(ctx: RequestContext) {
    const customer = this.customer(ctx);
    const overview = this.banking.accounts(customer.id);
    return (
      <Layout title="Accounts" active="accounts" customer={customer} description="Your Demo Bank accounts, balances, cards and recent activity.">
        <header class="page-head">
          <h1>Accounts</h1>
          <p class="lede">
            {customer.name}, {overview.accounts.length} accounts. Total in Canadian dollars: <strong class="num">{money(overview.totalCadCents)}</strong>
          </p>
        </header>
        <div class="account-grid">
          {overview.accounts.map((a) => {
            const tx = this.ledger.transactionsOf(customer.id, { accountId: a.id, limit: 8 });
            return (
              <section class="account-card" id={a.id} aria-labelledby={`h-${a.id}`}>
                <header>
                  <h2 id={`h-${a.id}`}>{a.name}</h2>
                  <p class="ledger-sub">
                    {a.id}, {a.currency}
                  </p>
                  <p class="account-balance num">{money(a.balanceCents, a.currency)}</p>
                </header>
                {tx.length === 0 ? (
                  <p class="muted">No activity in the last 75 days.</p>
                ) : (
                  <table class="tx-table compact">
                    <caption class="visually-hidden">Latest activity in {a.name}</caption>
                    <thead>
                      <tr>
                        <th scope="col">Date</th>
                        <th scope="col">Description</th>
                        <th scope="col" class="num">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tx.map((t) => (
                        <tr>
                          <td class="tx-date">{shortDate(t.date)}</td>
                          <td>
                            <span class="tx-merchant">{t.merchant}</span>
                            {' '}
                            <span class="ledger-sub">{categoryLabel(t.category)}</span>
                          </td>
                          <td class={`num ${t.amountCents > 0 ? 'credit' : ''}`}>{money(t.amountCents, t.currency, { sign: true })}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>
            );
          })}
        </div>
        <section class="cards-section" aria-labelledby="cards-h">
          <h2 id="cards-h">Cards</h2>
          <table class="tx-table">
            <thead>
              <tr>
                <th scope="col">Card</th>
                <th scope="col">Number</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {overview.cards.map((c) => (
                <tr>
                  <td>
                    {c.name} <span class="ledger-sub">{c.id}</span>
                  </td>
                  <td class="num">•••• {c.last4}</td>
                  <td>
                    <span class={`pill pill-${c.status}`}>{c.status === 'frozen' ? 'Frozen' : 'Active'}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p class="muted">
            To freeze or unfreeze a card, ask the <a href="/assistant">assistant</a>; it asks for your approval first.
          </p>
        </section>
      </Layout>
    );
  }

  @Page('/audit')
  auditTrail(ctx: RequestContext) {
    const customer = this.customer(ctx);
    const check = this.audit.verify();
    const mine = this.audit.forActor(customer.id).slice().reverse();
    return (
      <Layout title="Audit trail" active="audit" customer={customer} description="Tamper-evident record of everything done on your behalf.">
        <header class="page-head">
          <h1>Audit trail</h1>
          <p class="lede">Every sign-in, assistant conversation, transfer, card change and policy refusal on your profile, newest first.</p>
        </header>
        <section class={`chain ${check.ok ? 'chain-ok' : 'chain-broken'}`} aria-labelledby="chain-h">
          <svg viewBox="0 0 24 24" aria-hidden="true" class="chain-icon">
            {check.ok ? <path d="M9 12.5 11 14.5 15.5 10M12 3l7.5 3v5.5c0 4.5-3.2 8.2-7.5 9.5-4.3-1.3-7.5-5-7.5-9.5V6L12 3Z" /> : <path d="M12 8v5M12 16.5v.5M12 3l9 16H3L12 3Z" />}
          </svg>
          <div>
            <h2 id="chain-h">{check.ok ? 'Chain verified' : `Chain broken at entry ${check.brokenAt}`}</h2>
            <p>
              {check.ok
                ? `All ${check.entries} entries in the bank-wide log were re-hashed just now and every link matches. Each entry's SHA-256 hash covers the previous entry's hash, so changing any past entry would break every link after it.`
                : `Entry ${check.brokenAt}: ${check.reason}. The log has been altered since it was written.`}
            </p>
            <p class="ledger-sub hash">Head {check.head}</p>
          </div>
        </section>
        {mine.length === 0 ? (
          <p class="muted">Nothing recorded for your profile yet.</p>
        ) : (
          <div class="table-wrap">
            <table class="tx-table audit-table">
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">When</th>
                  <th scope="col">What happened</th>
                  <th scope="col">Outcome</th>
                  <th scope="col" class="hide-sm">Hash (previous)</th>
                </tr>
              </thead>
              <tbody>
                {mine.map((e) => (
                  <tr>
                    <td class="num">{e.seq}</td>
                    <td class="tx-date">{stamp(e.at)}</td>
                    <td>
                      <span class="tx-merchant">{e.summary}</span>
                      {' '}
                      <span class="ledger-sub">{e.action}</span>
                    </td>
                    <td>
                      <span class={`pill pill-${['ok', 'completed'].includes(e.outcome) ? 'active' : e.outcome === 'refused' || e.outcome === 'failed' ? 'frozen' : 'neutral'}`}>{e.outcome}</span>
                    </td>
                    <td class="hide-sm hash">
                      {e.hash.slice(0, 12)}
                      {' '}
                      <span class="ledger-sub">{e.prevHash.slice(0, 12)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Layout>
    );
  }

  @Page('/rates')
  rates(ctx: RequestContext) {
    const customer = this.customers.find(ctx.session.get('customerId'));
    const fx = this.fx.table();
    const data = {
      bank: 'Demo Bank (fictional)',
      asOf: this.clock.today(),
      currency: 'CAD',
      exchange: { spreadPercent: FX_SPREAD_PERCENT, rates: fx },
      interest: INTEREST,
      fees: FEES,
      limits: { singleTransferCents: this.singleLimitCents, dailyTransferCents: this.money.dailyLimitCents },
    };
    return withData(
      <Layout title="Rates and fees" active="rates" customer={customer} description="Demo Bank's published exchange rates, interest rates, fees and limits (fictional).">
        <header class="page-head">
          <h1>Rates and fees</h1>
          <p class="lede">Published rates for {shortDate(data.asOf, true)}. Fictional figures for this demo. AI agents can read this page as JSON or markdown.</p>
        </header>
        <div class="rates-grid">
          <section id="fx" aria-labelledby="fx-h" class="rate-block">
            <h2 id="fx-h">Exchange rates</h2>
            <table class="tx-table">
              <thead>
                <tr>
                  <th scope="col">Conversion</th>
                  <th scope="col" class="num">Mid-market</th>
                  <th scope="col" class="num">Customer rate</th>
                </tr>
              </thead>
              <tbody>
                {fx.map((r) => (
                  <tr>
                    <td>{r.pair}</td>
                    <td class="num">{r.mid.toFixed(4)}</td>
                    <td class="num">{r.customerRate.toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p class="muted">Customer rates include a {FX_SPREAD_PERCENT}% spread. No separate commission.</p>
          </section>
          <section id="interest" aria-labelledby="int-h" class="rate-block">
            <h2 id="int-h">Interest rates</h2>
            <table class="tx-table">
              <thead>
                <tr>
                  <th scope="col">Account</th>
                  <th scope="col" class="num">Annual rate</th>
                </tr>
              </thead>
              <tbody>
                {INTEREST.map((r) => (
                  <tr>
                    <td>
                      {r.product}
                      {' '}
                      <span class="ledger-sub">{r.note}</span>
                    </td>
                    <td class="num">{r.ratePercent.toFixed(2)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section id="fees" aria-labelledby="fees-h" class="rate-block wide">
            <h2 id="fees-h">Everyday fees</h2>
            <table class="tx-table">
              <thead>
                <tr>
                  <th scope="col">Service</th>
                  <th scope="col" class="num">Fee</th>
                </tr>
              </thead>
              <tbody>
                {FEES.map((f) => (
                  <tr>
                    <td>
                      {f.item}
                      {' '}
                      <span class="ledger-sub">{f.note}</span>
                    </td>
                    <td class="num">{f.amountCents === null ? '2.5%' : f.amountCents === 0 ? 'Free' : money(f.amountCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section id="limits" aria-labelledby="lim-h" class="rate-block">
            <h2 id="lim-h">Transfer limits</h2>
            <dl class="facts">
              <dt>Per transfer</dt>
              <dd class="num">{money(this.singleLimitCents)}</dd>
              <dt>Per business day</dt>
              <dd class="num">{money(this.money.dailyLimitCents)}</dd>
            </dl>
            <p class="muted">Applies to online banking and the assistant. Larger transfers: visit a branch.</p>
          </section>
        </div>
        <section class="policies" aria-labelledby="pol-h">
          <h2 id="pol-h">Policies the assistant follows</h2>
          <p class="muted">The assistant searches these documents to answer fee and policy questions, and cites them by title.</p>
          <div class="policy-list">
            {POLICIES.map((p) => (
              <details id={`policy-${p.id}`}>
                <summary>{p.title}</summary>
                {p.text
                  .split('\n')
                  .slice(1)
                  .map((line) => (
                    <p>{line}</p>
                  ))}
              </details>
            ))}
          </div>
        </section>
      </Layout>,
      data,
    );
  }

  @ErrorPage(404)
  notFound(ctx: RequestContext) {
    const customer = this.customers.find(ctx.session.get('customerId'));
    return withStatus(
      404,
      <Layout title="Page not found" customer={customer}>
        <div class="error-view">
          <h1>We couldn't find that page</h1>
          <p class="lede">The address may be mistyped, or the page has moved.</p>
          <p>
            <a class="btn btn-primary" href={customer ? '/assistant' : '/signin'}>
              {customer ? 'Back to the assistant' : 'Go to sign-in'}
            </a>
          </p>
        </div>
      </Layout>,
    );
  }
}
