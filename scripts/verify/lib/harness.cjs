// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0
'use strict';
/**
 * Runs one compiled app in this process (production profile) so the verifier can read its memory
 * and internals over IPC. Start with: node --expose-gc harness.cjs <appDir> <port> [--key=value...]
 *
 * IPC requests: { type: 'stats' } -> { type: 'stats', memory, ai }   (after a full GC)
 *               { type: 'amoxi:shutdown' } -> graceful stop
 */
const path = require('node:path');

async function main() {
  const [appDir, port, ...extra] = process.argv.slice(2);
  const fromApp = (id) => require(require.resolve(id, { paths: [appDir] }));
  const amoxi = fromApp('amoxi');
  const { applicationModule } = require(path.join(appDir, 'dist', 'src', 'generated', 'amoxi.generated.js'));
  const config = amoxi.Config.load({ cwd: appDir, profile: 'production', argv: [`--server.port=${port}`, '--server.host=127.0.0.1', '--server.request-log=false', ...extra] });
  const app = await amoxi.AmoxiApplication.run(applicationModule, { config, shutdownHook: false, logger: new amoxi.Logger('warn', true) });

  let ai;
  try {
    ai = fromApp('amoxi/ai');
  } catch {
    ai = undefined;
  }
  process.on('message', async (m) => {
    if (m?.type === 'stats') {
      for (let i = 0; i < 3; i++) global.gc?.();
      const mem = process.memoryUsage();
      let hub;
      if (ai && applicationModule.ai) {
        const services = ai.AiServices.of(app.context);
        hub = { listeners: services.hub.listeners.size, bufferedRuns: services.hub.recent.size };
      }
      process.send({ type: 'stats', memory: { heapUsed: mem.heapUsed, rss: mem.rss, external: mem.external }, hub, handles: process.getActiveResourcesInfo().length });
    } else if (m?.type === 'amoxi:shutdown') {
      await app.close();
      process.exit(0);
    }
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
