import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Config, AmoxiApplication } from 'amoxi';
import { applicationModule } from '../src/generated/amoxi.generated';

test('home page renders and the notes API validates input', async () => {
  const app = await AmoxiApplication.run(applicationModule, {
    config: Config.of({ server: { port: 0, host: '127.0.0.1' } }),
    silent: true,
    shutdownHook: false,
  });
  const base = `http://127.0.0.1:${app.port}`;
  const json = { 'content-type': 'application/json' };
  try {
    const home = await fetch(`${base}/`, { headers: { accept: 'text/html' } });
    assert.equal(home.status, 200);
    assert.match(await home.text(), /<h2 id="notes-title">Notes<\/h2>/);

    const blank = await fetch(`${base}/api/notes`, { method: 'POST', headers: json, body: JSON.stringify({ text: '   ' }) });
    assert.equal(blank.status, 400);

    const created = await fetch(`${base}/api/notes`, { method: 'POST', headers: json, body: JSON.stringify({ text: 'Hello' }) });
    assert.equal(created.status, 201);
    const notes = (await (await fetch(`${base}/api/notes`)).json()) as Array<{ text: string }>;
    assert.equal(notes[0].text, 'Hello');

    const missing = await fetch(`${base}/nope`, { headers: { accept: 'text/html' } });
    assert.equal(missing.status, 404);
    assert.match(await missing.text(), /Page not found/);
  } finally {
    await app.close();
  }
});
