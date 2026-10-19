import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Config, AmoxiApplication } from 'amoxi';
import { applicationModule } from '../src/generated/amoxi.generated';

test('notes API validates input and stores notes', async () => {
  const app = await AmoxiApplication.run(applicationModule, {
    config: Config.of({ server: { port: 0, host: '127.0.0.1' } }),
    silent: true,
    shutdownHook: false,
  });
  const base = `http://127.0.0.1:${app.port}`;
  const json = { 'content-type': 'application/json' };
  try {
    const bad = await fetch(`${base}/api/notes`, { method: 'POST', headers: json, body: JSON.stringify({ text: 42 }) });
    assert.equal(bad.status, 400);
    const ok = await fetch(`${base}/api/notes`, { method: 'POST', headers: json, body: JSON.stringify({ text: 'Hello' }) });
    assert.equal(ok.status, 201);
    const notes = (await (await fetch(`${base}/api/notes`)).json()) as Array<{ text: string }>;
    assert.equal(notes[0].text, 'Hello');
    assert.deepEqual(await (await fetch(`${base}/amoxi/health/ready`)).json(), { status: 'UP' });
  } finally {
    await app.close();
  }
});
