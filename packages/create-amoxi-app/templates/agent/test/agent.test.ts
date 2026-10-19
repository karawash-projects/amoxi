import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Config, AmoxiApplication } from 'amoxi';
import { AiServices, ScriptedChatModel, type AgentPlatform, type RunEvent } from 'amoxi/ai';
import { applicationModule } from '../src/generated/amoxi.generated';

async function start(model?: ScriptedChatModel) {
  const app = await AmoxiApplication.run(applicationModule, {
    config: Config.of({ server: { port: 0, host: '127.0.0.1' } }), // 'test' profile: offline model, in-memory stores
    silent: true,
    shutdownHook: false,
    overrides: model ? [['ChatModel', model]] : [],
  });
  return { app, platform: AiServices.of(app.context).platform() };
}

async function finished(platform: AgentPlatform, id: string) {
  for (let i = 0; i < 200; i++) {
    const run = await platform.getRun(id);
    if (run && ['completed', 'failed', 'cancelled', 'awaiting_approval'].includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('run did not finish');
}

test('the offline demo model saves and lists notes with the tools', async () => {
  const { app, platform } = await start();
  try {
    const added = await finished(platform, (await platform.startRun({ agent: 'assistant', input: 'Add a note "Buy coffee beans"', owner: 'me' })).id);
    assert.equal(added.status, 'completed');
    const listed = await platform.startRun({ agent: 'assistant', input: 'Show my notes', owner: 'me' });
    const events: RunEvent[] = [];
    for await (const e of platform.subscribe(listed.id, 0)) events.push(e);
    const ui = events.find((e) => e.type === 'ui');
    assert.equal(ui?.data.component, 'NoteList');
    assert.match(JSON.stringify(ui?.data.props), /Buy coffee beans/);
  } finally {
    await app.close();
  }
});

test('a scripted model drives the agent loop deterministically', async () => {
  const model = new ScriptedChatModel([{ toolCalls: [{ name: 'add_note', input: { content: 'Call the bank' } }] }, { text: 'Saved.' }]);
  const { app, platform } = await start(model);
  try {
    const run = await finished(platform, (await platform.startRun({ agent: 'assistant', input: 'remind me to call the bank', owner: 'me' })).id);
    assert.equal(run.output, 'Saved.');
    assert.match(model.requests[0].system ?? '', /notes app/);
    assert.deepEqual(model.requests[0].tools?.map((t) => t.name).sort(), ['add_note', 'list_notes', 'show_note_list']);
  } finally {
    await app.close();
  }
});

test('the assistant page renders and the agent is listed', async () => {
  const { app } = await start();
  const base = `http://127.0.0.1:${app.port}`;
  try {
    const page = await fetch(`${base}/assistant`, { headers: { accept: 'text/html' } });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<amoxi-island data-c="Assistant"/);
    const agents = (await (await fetch(`${base}/agents`)).json()) as { agents: Array<{ name: string }> };
    assert.deepEqual(agents.agents.map((a) => a.name), ['assistant']);
  } finally {
    await app.close();
  }
});
