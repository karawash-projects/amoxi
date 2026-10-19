import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { AuditLog } from '../src/audit/audit-log';
import { Ledger } from '../src/bank/ledger';
import { MoneyMovementService } from '../src/bank/money-movement';
import { Client, find, start } from './helpers';

const balance = (ledger: Ledger, customer: string, id: string): number => ledger.account(customer, id)!.balanceCents;

describe('the assistant with the offline model (no API key)', () => {
  test('"Show my accounts and balances" calls list_accounts and shows AccountsOverview', async () => {
    const t = await start();
    try {
      const maya = await new Client(t.base).signIn('C-1001');
      const events = await maya.ask('Show my accounts and balances');
      assert.deepEqual(find(events, 'tool.started').map((e) => e.data.tool), ['list_accounts']);
      const ui = find(events, 'ui');
      assert.equal(ui.length, 1);
      assert.equal(ui[0].data.component, 'AccountsOverview');
      assert.deepEqual(ui[0].data.props.accounts.map((a: { id: string }) => a.id), ['CHQ-4417', 'SAV-4418', 'USD-4419']);
      const done = find(events, 'run.completed')[0];
      // The balances are in the component; the offline answer points to it instead of repeating them.
      assert.match(done.data.output, /details above/);
    } finally {
      await t.close();
    }
  });

  test('every other suggested prompt triggers its tool and component offline', async () => {
    const t = await start();
    try {
      const maya = await new Client(t.base).signIn('C-1001');
      const cases: Array<[string, string, string | undefined]> = [
        ['Show my recent transactions for groceries', 'recent_activity', 'TransactionTable'],
        ['Show my spending by category this month', 'spending_by_category', 'SpendingChart'],
        ["What's the exchange rate for $500 CAD to USD?", 'quote_exchange_rate', undefined],
        ['What is the fee for a foreign transaction?', 'search_knowledge', undefined],
      ];
      for (const [prompt, tool, component] of cases) {
        const events = await maya.ask(prompt);
        assert.deepEqual(find(events, 'tool.started').map((e) => e.data.tool), [tool], prompt);
        assert.deepEqual(find(events, 'ui').map((e) => e.data.component), component ? [component] : [], prompt);
        assert.equal(find(events, 'run.completed').length, 1, prompt);
        if (tool === 'recent_activity') {
          const rows = find(events, 'ui')[0].data.props.transactions as Array<{ category: string }>;
          assert.ok(rows.length > 0 && rows.every((r) => r.category === 'groceries'));
        }
        if (tool === 'quote_exchange_rate') {
          const out = find(events, 'tool.completed')[0].data.output;
          assert.equal(out.sellAmountCents, 50000);
          assert.equal(out.direction, 'CAD to USD');
          assert.equal(out.buyAmountCents, Math.floor(50000 * out.customerRate));
        }
        if (tool === 'search_knowledge') {
          assert.equal(find(events, 'tool.completed')[0].data.output.results[0].title, 'Foreign transactions and currency exchange');
        }
      }
    } finally {
      await t.close();
    }
  });
});

describe('moving money needs the customer\'s approval', () => {
  test('approve: the balance changes exactly once, even if the decision is sent again', async () => {
    const t = await start();
    try {
      const ledger = t.get(Ledger);
      const maya = await new Client(t.base).signIn('C-1001');
      const events = await maya.ask('Transfer $250 from CHQ-4417 to SAV-4418');
      const approval = find(events, 'approval.required')[0];
      assert.ok(approval, 'asks for approval');
      assert.deepEqual(approval.data.input, { fromAccountId: 'CHQ-4417', toAccountId: 'SAV-4418', amountCents: 25000 });
      assert.equal(balance(ledger, 'C-1001', 'CHQ-4417'), 184235, 'nothing moves before approval');
      const runId = events[0].data.runId as string;

      const first = await maya.decide(runId, approval.data.callId, true);
      assert.equal(first.status, 200);
      const again = await maya.decide(runId, approval.data.callId, true);
      assert.equal(again.status, 409, 'a repeated decision is rejected');

      assert.equal(find(first.events, 'ui')[0].data.component, 'TransferReceipt');
      assert.equal(balance(ledger, 'C-1001', 'CHQ-4417'), 184235 - 25000);
      assert.equal(balance(ledger, 'C-1001', 'SAV-4418'), 1265000 + 25000);
      const posted = t.get(AuditLog).entries().filter((e) => e.action === 'transfer' && e.outcome === 'ok');
      assert.equal(posted.length, 1);

      // The money-moving service is idempotent too: the same key returns the same receipt.
      const money = t.get(MoneyMovementService);
      const req = { customerId: 'C-1001', fromAccountId: 'CHQ-4417', toAccountId: 'SAV-4418', amountCents: 100, idempotencyKey: 'k-1' };
      assert.equal(money.transfer(req).reference, money.transfer(req).reference);
      assert.equal(balance(ledger, 'C-1001', 'CHQ-4417'), 184235 - 25000 - 100);
    } finally {
      await t.close();
    }
  });

  test('two identical transfers in one conversation move the money twice', async () => {
    const transfer = { name: 'transfer_between_accounts', input: { fromAccountId: 'CHQ-4417', toAccountId: 'SAV-4418', amountCents: 20000 } };
    const t = await start([{ toolCalls: [transfer, transfer] }, { text: 'Both transfers are done.' }]);
    try {
      const ledger = t.get(Ledger);
      const before = balance(ledger, 'C-1001', 'CHQ-4417');
      const maya = await new Client(t.base).signIn('C-1001');
      const events = await maya.ask('Move $200 to savings, twice');
      const approvals = find(events, 'approval.required');
      assert.equal(approvals.length, 2);
      const runId = events[0].data.runId;
      await maya.decide(runId, approvals[0].data.callId, true);
      const last = await maya.decide(runId, approvals[1].data.callId, true);
      assert.equal(find(last.events, 'run.completed').length, 1);
      const receipts = find(last.events, 'tool.completed').map((e) => e.data.output.reference);
      assert.equal(new Set(receipts).size, 2, 'the second transfer got the first one\'s receipt');
      assert.equal(balance(ledger, 'C-1001', 'CHQ-4417'), before - 40000);
    } finally {
      await t.close();
    }
  });

  test('the money service enforces the single-transfer limit for every client, not only the assistant', async () => {
    const t = await start();
    try {
      const money = t.get(MoneyMovementService);
      assert.throws(
        () => money.transfer({ customerId: 'C-1001', fromAccountId: 'SAV-4418', toAccountId: 'CHQ-4417', amountCents: 300001, idempotencyKey: 'limit-1' }),
        /single-transfer limit/,
      );
    } finally {
      await t.close();
    }
  });

  test('decline: nothing changes and the model is told', async () => {
    const t = await start();
    try {
      const ledger = t.get(Ledger);
      const maya = await new Client(t.base).signIn('C-1001');
      const events = await maya.ask('Freeze my card CRD-7781');
      const approval = find(events, 'approval.required')[0];
      const result = await maya.decide(events[0].data.runId, approval.data.callId, false);
      const completed = find(result.events, 'tool.completed')[0];
      assert.equal(completed.data.isError, true);
      assert.deepEqual(completed.data.output, { declined: true });
      assert.equal(ledger.card('C-1001', 'CRD-7781')!.frozen, false);
      assert.equal(find(result.events, 'run.completed').length, 1);
    } finally {
      await t.close();
    }
  });

  test('approving a card freeze freezes it and shows the updated accounts', async () => {
    const t = await start();
    try {
      const maya = await new Client(t.base).signIn('C-1001');
      const events = await maya.ask('Freeze my card CRD-7781');
      const approval = find(events, 'approval.required')[0];
      const result = await maya.decide(events[0].data.runId, approval.data.callId, true);
      assert.equal(t.get(Ledger).card('C-1001', 'CRD-7781')!.frozen, true);
      const ui = find(result.events, 'ui')[0];
      assert.equal(ui.data.component, 'AccountsOverview');
      assert.equal(ui.data.props.highlight, 'CRD-7781');
      const api = (await (await maya.fetch('/api/accounts')).json()) as { cards: Array<{ id: string; status: string }> };
      assert.equal(api.cards.find((c) => c.id === 'CRD-7781')!.status, 'frozen');
    } finally {
      await t.close();
    }
  });

  test('guardrail: a transfer over the single-transfer limit is refused before any approval is asked', async () => {
    const t = await start([
      { text: 'I will set that up.', toolCalls: [{ name: 'transfer_between_accounts', input: { fromAccountId: 'SAV-4418', toAccountId: 'CHQ-4417', amountCents: 500000 } }] },
      { text: 'That is over your limit.' },
    ]);
    try {
      const ledger = t.get(Ledger);
      const maya = await new Client(t.base).signIn('C-1001');
      const events = await maya.ask('Move $5,000 from savings to chequing');
      assert.equal(find(events, 'approval.required').length, 0, 'a refused call never shows an approval card');
      const completed = find(events, 'tool.completed')[0];
      assert.equal(completed.data.isError, true);
      assert.match(completed.data.output.error, /single-transfer limit/);
      assert.equal(find(events, 'run.completed').length, 1);
      assert.equal(balance(ledger, 'C-1001', 'SAV-4418'), 1265000);
      const toolMsg = t.model!.requests[1].messages.at(-1)!;
      assert.equal(toolMsg.role, 'tool');
      assert.ok(t.get(AuditLog).entries().some((e) => e.action === 'guardrail' && e.outcome === 'refused'));
      // The bank's rules reach the model in its instructions, with today's date.
      assert.match(t.model!.requests[0].system!, /2026-10-18/);
      assert.match(t.model!.requests[0].system!, /\$3,000\.00/);
    } finally {
      await t.close();
    }
  });

  test('insufficient funds: the service refuses and the reason reaches the model', async () => {
    const t = await start([
      { toolCalls: [{ name: 'transfer_between_accounts', input: { fromAccountId: 'CHQ-4417', toAccountId: 'SAV-4418', amountCents: 200000 } }] },
      { text: 'You do not have enough in chequing.' },
    ]);
    try {
      const maya = await new Client(t.base).signIn('C-1001');
      const events = await maya.ask('Move $2,000 to savings');
      const approval = find(events, 'approval.required')[0];
      await maya.decide(events[0].data.runId, approval.data.callId, true);
      const result = t.model!.requests[1].messages.at(-1)!.content.find((p) => p.type === 'tool_result') as { isError?: boolean; output: { error: string } };
      assert.equal(result.isError, true);
      assert.match(result.output.error, /Insufficient funds/);
      assert.equal(balance(t.get(Ledger), 'C-1001', 'CHQ-4417'), 184235);
      // The interceptor audited the refused attempt.
      assert.ok(t.get(AuditLog).entries().some((e) => e.action === 'transfer' && e.outcome === 'refused' && /Insufficient funds/.test(e.summary)));
    } finally {
      await t.close();
    }
  });
});
