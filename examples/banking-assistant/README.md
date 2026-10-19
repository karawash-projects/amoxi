# Demo Bank: an AI banking assistant built with Amoxi

Demo Bank is a fictional Canadian retail bank. This example is its online banking with a digital
assistant that customers talk to in plain language. The assistant reads the signed-in customer's real data (accounts,
transactions, spending) and acts on it (transfers between their own accounts, card freezes), but only with the
customer's approval, inside the bank's limits, and with every step written to a tamper-evident audit trail.

It runs out of the box with no API key: a built-in offline model picks tools by keyword, so the demo, the suggested
prompts and the tests work anywhere. Add a key and the same app uses Claude or an OpenAI-compatible model.

> Demo: fictional data. Demo Bank, its customers, rates and policies are invented. Nothing here is financial advice.

<!-- screenshots -->
## Screenshots

Taken from this app running with the offline demo model. All data is fictional.

**Spending insights as a chart**

<img src="../../website/public/shots/finance-assistant-desktop.jpg" alt="Spending insights as a chart, desktop" width="100%">

**Transfer waiting for approval**

<img src="../../website/public/shots/finance-approval-desktop.jpg" alt="Transfer waiting for approval, desktop" width="100%">

**Receipt after approval**

<img src="../../website/public/shots/finance-receipt-desktop.jpg" alt="Receipt after approval, desktop" width="100%">

On a phone:

| Spending insights as a chart | Transfer waiting for approval | Receipt after approval |
|---|---|---|
| <img src="../../website/public/shots/finance-assistant-mobile.jpg" alt="Spending insights as a chart, phone" width="240"> | <img src="../../website/public/shots/finance-approval-mobile.jpg" alt="Transfer waiting for approval, phone" width="240"> | <img src="../../website/public/shots/finance-receipt-mobile.jpg" alt="Receipt after approval, phone" width="240"> |

## What to try

1. Run the app (below) and open http://localhost:8081. You land on a demo sign-in page; pick **Maya Vellandré**.
2. On the **Assistant** page, use the suggested prompts (they work offline):

| Prompt | What happens |
|---|---|
| Show my accounts and balances | `list_accounts` runs and shows the **AccountsOverview** component |
| Show my recent transactions for groceries | `recent_activity` with `category: groceries`, shown as a **TransactionTable** |
| Show my spending by category this month | `spending_by_category`, shown as a **SpendingChart** (an SVG bar chart island) |
| Transfer $250 from CHQ-4417 to SAV-4418 | `transfer_between_accounts` pauses for your approval; approve it and a **TransferReceipt** appears and the accounts panel updates |
| Freeze my card CRD-7781 | `freeze_card` asks for approval; decline it and nothing changes |
| What is the fee for a foreign transaction? | `search_knowledge` finds "Foreign transactions and currency exchange" in the policy documents |
| What's the exchange rate for $500 CAD to USD? | `quote_exchange_rate` (the one tool also offered to external agents over MCP) |

Each customer sees prompts with their own account ids. Also try: reload the page mid-approval (the pending
transfer is restored), open **Audit trail** to see the hash chain verified, sign in as Daniel in another browser and
try to open Maya's conversation URL (404), and `Remember "I keep $1,000 in chequing for rent"` (long-term memory).

With a real model, plain questions work too: "What does a foreign purchase cost me?", "Move 300 dollars to my
savings", "How much did I spend on dining last month compared with groceries?".

## Amoxi feature -> why it matters in banking

| Amoxi feature | Why it matters in banking |
|---|---|
| `@Agent` with `principal(req)` and `owner(req)` | Runs execute in the background, but always as the signed-in customer; conversations belong to that customer and anyone else gets 404 |
| `@Tool` input types with JSDoc constraints (`@integer @minimum 1`) | Amounts are validated before any code runs; the model can't send fractional cents or negative transfers |
| `approval: true` | Nothing moves money or changes a card until the customer approves it on a clear transfer slip |
| `beforeToolCall` guardrail | A second line of defence, checked before an approval is even requested: refuses transfers over the single-transfer limit and any account or card id the customer doesn't own, whatever the model was talked into |
| Business rules in services, errors back to the model | Daily limit, sufficient funds and same-currency checks live in `MoneyMovementService`; a refusal ("Insufficient funds: ...") reaches the model so it can explain |
| `ctx.step()` plus an idempotency key (`ctx.callId`) | A resumed or retried run never posts the same transfer twice, while two transfers the customer asked and approved separately are two transfers; a repeated approval is rejected (409) |
| `onRunFinished` and `@Intercept` | Every conversation and every money-moving call (successful or refused) lands in a SHA-256 hash-chained audit log; tampering is detected |
| Generative UI (`@generative` islands, `ctx.ui()`) | Balances, transactions, spending charts and receipts appear as real, validated components, not paragraphs of numbers |
| Streaming over SSE with `agentChat()` | Answers appear token by token; tool steps and approvals show as they happen; reconnects resume |
| Knowledge (`knowledge: ['fees']`) | Fee and policy answers come from the bank's own documents, cited by title, not invented |
| Memory (`memory: true`) | The assistant remembers preferences per customer, never across customers |
| MCP with a token, `expose: false` and `ai.mcp.expose-agents: false` | Partners' AI agents can get FX quotes; customer tools and the customer assistant are never offered |
| Auth middleware in front of `/agents` | The same sign-in rule protects pages, JSON APIs and agent endpoints (401 when signed out) |
| `withData()`, `.md` pages, `/llms.txt` | Published rates are machine-readable for comparison sites and AI agents, with no extra API |
| Encrypted cookie sessions, CSP with nonces, CSRF checks | Banking-grade defaults with zero configuration |
| Compile-time DI and validation | Wiring and schemas are generated by `amoxi build`; a typo in a tool or component fails the build, not production |

## How to run

From this folder (each command works in PowerShell too):

```bash
npm run build
```

`npm start` runs in production, which refuses the demo secrets (they are in `application-development.json`, used by `npm run dev` only). Before the first start, create a file named `.env.production.local` in this folder (git ignores it) with your own values, each at least 16 characters:

```
AI_MCP_TOKEN=replace-with-a-long-random-value
```

```bash
npm start
```

`npm start` runs one worker because this demo keeps its data in memory, which each worker process would hold separately. A production version with a database (and `ai.store.type` set to `postgres`) can run one worker per CPU core with `amoxi start dist/src/main.js --workers auto`.

Then open http://localhost:8081. For development with live reload:

```bash
npm run dev
```

Run the tests (14 tests, offline model and scripted model):

```bash
npm test
```

### Use a real model

Create a `.env` file in this folder (it is git-ignored) with one of:

```bash
ANTHROPIC_API_KEY=...
```

```bash
OPENAI_API_KEY=...
```

Restart the app. The footer of the conversation shows which model answers. Tests always use the offline or a scripted model.

## For AI agents and partners

- **Rates as data:** `curl -H "Accept: application/json" http://localhost:8081/rates` returns the page with a `data`
  object (exchange rates, interest rates, fees, limits). `http://localhost:8081/rates.md` is the markdown version.
- **`/llms.txt`** lists the pages, APIs, the agent and the MCP endpoint.
- **MCP:** enabled in `application.json`; in development the token is `demo-mcp-token-NOT-A-SECRET-replace-in-production`
  (from `application-development.json`), a published placeholder, not a secret. Production refuses it: set a real one
  through the environment (`AI_MCP_TOKEN`) and never commit it. Only `quote_exchange_rate` is offered:
  customer tools are `expose: false`, approval tools are never offered, and `"expose-agents": false` hides the
  `ask_banking_assistant` tool (an external agent has no signed-in customer, so it must never drive the assistant).

An external MCP client lists and calls the tool like this:

```bash
curl -s http://localhost:8081/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -H "Authorization: Bearer demo-mcp-token-NOT-A-SECRET-replace-in-production" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

```bash
curl -s http://localhost:8081/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -H "Authorization: Bearer demo-mcp-token-NOT-A-SECRET-replace-in-production" -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"quote_exchange_rate","arguments":{"amountCents":50000,"direction":"CAD to USD"}}}'
```

In Claude Desktop, Cursor or another MCP client, add a Streamable HTTP server with the URL `http://localhost:8081/mcp`
and the header `Authorization: Bearer <token>`.

## File map

```
application.json                 limits, MCP (no ask_ tools), in-memory AI store
application-development.json     the demo MCP token (development only)
src/agent/banking-assistant.ts   the @Agent: instructions with date and rules, principal/owner, guardrail, audit hook
src/agent/banking-tools.ts       customer tools (expose: false): accounts, transactions, spending, transfer, freeze/unfreeze
src/agent/fx-tools.ts            quote_exchange_rate (readOnly, expose: true for MCP)
src/agent/policies.ts            8 policy documents for the 'fees' knowledge base
src/agent/policy-library.ts      @Eager bean that ingests them at startup
src/bank/ledger.ts               accounts, cards, ~75 days of seeded transactions per customer
src/bank/money-movement.ts       transfers and card status: limits, funds, ownership, idempotency (@Intercept audited)
src/bank/fx.ts, clock.ts, customers.ts
src/audit/audit-log.ts           SHA-256 hash-chained log with verify()
src/audit/audit-interceptor.ts   AOP: audits every money-moving call
src/auth/auth-middleware.ts      sign-in required: redirect for pages, 401 for /agents and /api
src/auth/session-controller.ts   demo sign-in/out (stands in for the bank's IdP)
src/pages/pages.tsx              sign-in, assistant, accounts, audit trail, rates (withData), 404
src/islands/Assistant.tsx        the conversation: streaming, tool steps, approval slips, generative components
src/islands/AccountsPanel.tsx    accounts rail that refreshes after transfers and card changes
src/islands/AccountsOverview.tsx, TransactionTable.tsx, SpendingChart.tsx, TransferReceipt.tsx   @generative components
test/                            14 tests (offline prompts, approvals, guardrails, ownership, audit, MCP, pages)
```

## What production adds

- The bank's identity provider (OIDC with MFA and step-up authentication for transfers) instead of the demo sign-in.
- The core-banking system behind `Ledger` and `MoneyMovementService` (with its own idempotency keys and holds),
  and a database for runs and conversations (`"ai": { "store": { "type": "postgres" } }`; this demo keeps them in
  memory because its ledger resets on restart).
- The audit log in WORM storage with its head hash anchored externally, and retention rules for conversations.
- Per-customer limits from the bank's risk engine, fraud scoring before approval, notifications after each transfer.
- A real MCP token from a secret store, rate limiting, and monitoring of model quality and refusals.
