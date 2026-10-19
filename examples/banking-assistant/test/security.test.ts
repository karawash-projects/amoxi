import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { AuditLog } from '../src/audit/audit-log';
import { MoneyMovementService } from '../src/bank/money-movement';
import { Client, MCP_TOKEN, find, start } from './helpers';

describe('access control', () => {
  test('signed out: pages redirect to sign-in, agent and account APIs answer 401, public pages stay open', async () => {
    const t = await start();
    try {
      const anon = new Client(t.base);
      const page = await anon.fetch('/assistant', { headers: { accept: 'text/html' } });
      assert.equal(page.status, 303);
      assert.equal(page.headers.get('location'), '/signin?next=%2Fassistant');
      assert.equal((await anon.fetch('/agents/banking-assistant/runs', { method: 'POST', body: JSON.stringify({ input: 'Show my accounts' }) })).status, 401);
      assert.equal((await anon.fetch('/agents/banking-assistant/threads')).status, 401);
      assert.equal((await anon.fetch('/api/accounts')).status, 401);
      assert.equal((await anon.fetch('/signin')).status, 200);
      assert.equal((await anon.fetch('/rates')).status, 200);
    } finally {
      await t.close();
    }
  });

  test('sign-out is final: a copy of the cookie taken before sign-out no longer works', async () => {
    const t = await start();
    try {
      const maya = await new Client(t.base).signIn('C-1001');
      assert.equal((await maya.fetch('/api/accounts')).status, 200);
      const stolen = maya.cookie;
      assert.equal((await maya.fetch('/api/session/end', { method: 'POST' })).status, 200);
      const thief = new Client(t.base);
      thief.cookie = stolen;
      assert.equal((await thief.fetch('/api/accounts')).status, 401, 'replayed cookie after sign-out');
      assert.equal((await thief.fetch('/agents/banking-assistant/runs', { method: 'POST', body: JSON.stringify({ input: 'balance' }) })).status, 401);
      // Signing in again issues a new session id, so an older cookie never comes back to life.
      await maya.signIn('C-1001');
      assert.notEqual(maya.cookie, stolen);
      assert.equal((await thief.fetch('/api/accounts')).status, 401);
    } finally {
      await t.close();
    }
  });

  test("another customer can't read the conversation, and tools can't touch other customers' accounts", async () => {
    const t = await start([
      { text: 'Done.' },
      { toolCalls: [{ name: 'recent_activity', input: { accountId: 'CHQ-5521' } }] },
      { text: 'I can only look at your own accounts.' },
    ]);
    try {
      const maya = await new Client(t.base).signIn('C-1001');
      const daniel = await new Client(t.base).signIn('C-1002');
      const events = await maya.ask('Hello');
      const { runId, threadId } = events[0].data as { runId: string; threadId: string };
      assert.equal((await maya.fetch(`/agents/banking-assistant/threads/${threadId}`)).status, 200);
      assert.equal((await daniel.fetch(`/agents/banking-assistant/runs/${runId}`)).status, 404);
      assert.equal((await daniel.fetch(`/agents/banking-assistant/threads/${threadId}`)).status, 404);
      const hijack = await daniel.fetch('/agents/banking-assistant/runs', { method: 'POST', body: JSON.stringify({ input: 'continue', threadId }) });
      assert.equal(hijack.status, 404);

      // The model (say, after a prompt injection) asks for Daniel's chequing while Maya is signed in.
      const second = await maya.ask("Show transactions for CHQ-5521", threadId);
      const completed = find(second, 'tool.completed')[0];
      assert.equal(completed.data.isError, true);
      assert.match(completed.data.output.error, /not one of this customer's accounts/);
      assert.equal(find(second, 'ui').length, 0, 'no data was shown');
      // And the service itself refuses, whoever calls it.
      assert.throws(
        () => t.get(MoneyMovementService).transfer({ customerId: 'C-1001', fromAccountId: 'CHQ-5521', toAccountId: 'SAV-4418', amountCents: 100, idempotencyKey: 'x' }),
        /not one of your accounts/,
      );
    } finally {
      await t.close();
    }
  });

  test('MCP needs the token and offers only the FX quote tool', async () => {
    const t = await start();
    try {
      const rpc = (body: object, token?: string) =>
        fetch(`${t.base}/mcp`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25', ...(token ? { authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }),
        });
      assert.equal((await rpc({ method: 'tools/list', params: {} })).status, 401);
      assert.equal((await rpc({ method: 'tools/list', params: {} }, 'wrong-token-wrong-token')).status, 401);

      const list = (await (await rpc({ method: 'tools/list', params: {} }, MCP_TOKEN)).json()) as { result: { tools: Array<{ name: string }> } };
      assert.deepEqual(list.result.tools.map((x) => x.name), ['quote_exchange_rate']);

      const ask = (await (await rpc({ method: 'tools/call', params: { name: 'ask_banking_assistant', arguments: { message: 'Show my accounts' } } }, MCP_TOKEN)).json()) as { error?: { message: string } };
      assert.match(ask.error!.message, /Unknown tool/);
      const hidden = (await (await rpc({ method: 'tools/call', params: { name: 'list_accounts', arguments: {} } }, MCP_TOKEN)).json()) as { error?: unknown };
      assert.ok(hidden.error);

      const quote = (await (await rpc({ method: 'tools/call', params: { name: 'quote_exchange_rate', arguments: { amountCents: 100000, direction: 'USD to CAD' } } }, MCP_TOKEN)).json()) as {
        result: { structuredContent: { buyCurrency: string; buyAmountCents: number } };
      };
      assert.equal(quote.result.structuredContent.buyCurrency, 'CAD');
      assert.ok(quote.result.structuredContent.buyAmountCents > 100000);
    } finally {
      await t.close();
    }
  });
});

describe('audit trail', () => {
  test('the hash chain verifies, and any edit to a past entry is detected', async () => {
    const t = await start();
    try {
      const maya = await new Client(t.base).signIn('C-1001');
      const events = await maya.ask('Transfer $100 from CHQ-4417 to SAV-4418');
      const approval = find(events, 'approval.required')[0];
      await maya.decide(events[0].data.runId, approval.data.callId, true);
      const audit = t.get(AuditLog);
      const actions = audit.entries().map((e) => e.action);
      assert.ok(actions.includes('session.signin') && actions.includes('transfer') && actions.includes('agent.run'), actions.join(','));
      assert.equal(audit.verify().ok, true);
      for (let i = 1; i < audit.entries().length; i++) assert.equal(audit.entries()[i].prevHash, audit.entries()[i - 1].hash);

      const page = await (await maya.fetch('/audit', { headers: { accept: 'text/html' } })).text();
      assert.match(page, /Chain verified/);
      assert.match(page, /Transferred \$100\.00 from CHQ-4417 to SAV-4418/);

      // Tamper: someone edits the amount of the transfer entry after the fact.
      const chain = audit.entries();
      const at = chain.findIndex((e) => e.action === 'transfer');
      chain[at] = { ...chain[at], summary: 'Transferred $1.00 from CHQ-4417 to SAV-4418' };
      const check = audit.verify();
      assert.equal(check.ok, false);
      assert.equal(check.brokenAt, chain[at].seq);
      const broken = await (await maya.fetch('/audit', { headers: { accept: 'text/html' } })).text();
      assert.match(broken, /Chain broken at entry/);
    } finally {
      await t.close();
    }
  });
});
