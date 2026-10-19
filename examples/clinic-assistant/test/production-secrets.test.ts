import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AmoxiApplication, Config } from 'amoxi';
import { applicationModule } from '../src/generated/amoxi.generated';

// The demo secrets live in application-development.json, which production never loads. These
// tests start the app with the production profile, as `npm start` does.
const DEMO = 'demo-clinic-partner-token-NOT-A-SECRET';
const REAL = 'a-real-secret-from-the-environment-0123456789';

const start = (ai: object, extra: object = { clinic: { 'pseudonym-key': REAL } }) =>
  AmoxiApplication.run(applicationModule, {
    config: Config.of({ server: { port: 0, host: '127.0.0.1' }, amoxi: { log: { level: 'silent' } }, ai: { ...ai, store: { type: 'memory' } }, ...extra }, 'production'),
    silent: true,
    shutdownHook: false,
  });

/** Expects startup to fail; an app that starts anyway is closed so the test process can end. */
async function refused(starting: ReturnType<typeof start>, message: RegExp): Promise<void> {
  const outcome = await starting.then(
    async (app) => {
      await app.close();
      return undefined;
    },
    (err: unknown) => err,
  );
  assert.ok(outcome instanceof Error, 'the app started');
  assert.match(outcome.message, message);
}

test('production refuses to start with a published demo secret or none at all', async () => {
  await refused(start({ a2a: { enabled: true, token: DEMO }, mcp: { enabled: false } }), /still has a published demo value \(set AI_A2A_TOKEN/);
  await refused(start({ a2a: { enabled: true }, mcp: { enabled: false } }, {}), /is not set/);
});

test('production starts once every secret is set', async () => {
  const app = await start({ a2a: { enabled: true, token: REAL }, mcp: { enabled: false } });
  await app.close();
});
