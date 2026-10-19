import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AiServices } from 'amoxi/ai';
import { Client, find, start } from './helpers';

test('the Rates page has JSON and markdown representations with the rate table as data', async () => {
  const t = await start();
  try {
    const anon = new Client(t.base);
    const json = (await (await anon.fetch('/rates', { headers: { accept: 'application/json' } })).json()) as {
      title: string;
      data: { asOf: string; exchange: { spreadPercent: number; rates: Array<{ pair: string; mid: number; customerRate: number }> }; fees: unknown[]; limits: { singleTransferCents: number } };
    };
    assert.match(json.title, /Rates and fees/);
    assert.equal(json.data.asOf, '2026-10-18');
    assert.deepEqual(json.data.exchange.rates.map((r) => r.pair), ['CAD to USD', 'USD to CAD']);
    assert.equal(json.data.exchange.rates[0].mid, 0.7312);
    assert.ok(json.data.exchange.rates[0].customerRate < json.data.exchange.rates[0].mid);
    assert.equal(json.data.limits.singleTransferCents, 300000);
    assert.ok(json.data.fees.length >= 6);

    const md = await anon.fetch('/rates.md');
    assert.equal(md.status, 200);
    assert.match(await md.text(), /# Rates and fees/);
    const llms = await (await anon.fetch('/llms.txt')).text();
    assert.match(llms, /\/rates\.md/);
  } finally {
    await t.close();
  }
});

test('signed-in pages render real content, and the assistant page restores the last conversation', async () => {
  const t = await start();
  try {
    const priya = await new Client(t.base).signIn('C-1003');
    const html = (path: string) => priya.fetch(path, { headers: { accept: 'text/html' } }).then(async (r) => ({ status: r.status, body: await r.text() }));

    const first = await html('/assistant');
    assert.equal(first.status, 200);
    assert.match(first.body, /Transfer \$250 from CHQ-6630 to SAV-6631/, 'suggested prompts use her own accounts');
    assert.match(first.body, /Hello Priya/);
    assert.match(first.body, /\$2,975\.40/, 'accounts panel');

    await priya.ask('Show my spending by category last month');
    const again = await html('/assistant');
    assert.match(again.body, /Show my spending by category last month/, 'the conversation is restored after a reload');
    assert.doesNotMatch(again.body, /Hello Priya/);
    assert.match((await html('/assistant?new=1')).body, /Hello Priya/);

    const accounts = await html('/accounts');
    assert.equal(accounts.status, 200);
    assert.match(accounts.body, /High Interest Savings/);
    assert.match(accounts.body, /\$30,120\.75/);
    assert.equal((await html('/audit')).status, 200);
    assert.equal((await html('/no-such-page')).status, 404);
  } finally {
    await t.close();
  }
});

test('memory: a saved preference is recalled in the next conversation', async () => {
  const t = await start();
  try {
    const maya = await new Client(t.base).signIn('C-1001');
    const events = await maya.ask('Remember "I keep at least $1,000 in chequing for rent"');
    assert.deepEqual(find(events, 'tool.started').map((e) => e.data.tool), ['remember']);
    // Memory is per person (the principal), shared by every conversation of that customer.
    const recalled = await AiServices.of(t.app.context).memory().for('principal:C-1001').recall('How much do I keep in chequing for rent?');
    assert.match(recalled[0]?.text ?? '', /at least \$1,000 in chequing/);
    const other = await AiServices.of(t.app.context).memory().for('principal:C-1002').recall('chequing for rent');
    assert.equal(other.length, 0, "another customer's memory is separate");
  } finally {
    await t.close();
  }
});
