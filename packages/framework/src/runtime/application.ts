// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import cluster from 'node:cluster';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import { Config } from './config';
import { ApplicationContext, type BeanToken } from './container';
import { createDevHooks } from './dev';
import { closeWebSockets, createHttpServer, type DevHooks, type HealthState } from './http';
import { configurePages, DEFAULT_CSP } from './jsx';
import { Logger, type LogLevel } from './logger';
import { createManagementHandler } from './management';
import { choosePort, PortInUseError } from './port';
import { StaticFiles } from './static-files';
import type { ApplicationModule, ExtensionInstance } from './types';

export interface ContextOptions {
  config?: Config;
  /** Replace beans (by class or interface name) before anything is created. Ideal for tests. */
  overrides?: ReadonlyArray<readonly [BeanToken<any>, unknown]>;
}

export interface RunOptions extends ContextOptions {
  /** Start the HTTP server when the module has routes or static files. Default true. */
  listen?: boolean;
  /** Suppress all logging (tests). */
  silent?: boolean;
  logger?: Logger;
  /** Install signal/IPC shutdown and process error handlers. Default true. */
  shutdownHook?: boolean;
}

export interface RunningApplication {
  readonly context: ApplicationContext;
  readonly server?: Server;
  readonly port?: number;
  readonly logger: Logger;
  /** Time spent inside the framework (config + context + eager beans + listen), in ms. */
  readonly startupMs: number;
  /** Graceful shutdown: stop accepting, drain in-flight requests, run @PreDestroy hooks. */
  close(): Promise<void>;
}

/** Create a context without starting HTTP: useful for CLIs, workers and tests. */
export function createContext(module: ApplicationModule, options: ContextOptions = {}): ApplicationContext {
  return new ApplicationContext(module, options.config ?? Config.load(), options.overrides);
}

function loggerFrom(config: Config): Logger {
  const level = config.string('amoxi.log.level', 'info') as LogLevel;
  const json = config.string('amoxi.log.format', config.isProduction ? 'json' : 'pretty') === 'json';
  return new Logger(level, json);
}

export class AmoxiApplication {
  static async run(module: ApplicationModule, options: RunOptions = {}): Promise<RunningApplication> {
    const t0 = performance.now();
    const config = options.config ?? Config.load();
    const logger = options.logger ?? (options.silent ? Logger.silent() : loggerFrom(config));
    const context = new ApplicationContext(module, config, options.overrides);
    const eagerCount = context.start(config.boolean('amoxi.eager-init', 'false'));

    const devMode = process.env.AMOXI_DEV === '1';
    const dev: DevHooks | undefined = devMode ? createDevHooks(process.env.AMOXI_BUILD_ID ?? module.buildInfo.generatedAt) : undefined;
    const securityHeaders = config.boolean('server.security-headers', 'true');
    const exporting = config.boolean('amoxi.export', 'false');
    configurePages({
      inlineStreams: exporting,
      manifest: module.client,
      csp: securityHeaders && !exporting ? config.string('server.csp', DEFAULT_CSP) : '',
      navigation: config.boolean('amoxi.client-navigation', 'true'),
      streamTimeoutMs: config.number('amoxi.stream-timeout', '10000'),
      dev: devMode ? { buildId: process.env.AMOXI_BUILD_ID ?? module.buildInfo.generatedAt } : undefined,
      onStreamError: (err) => logger.error('Streamed section failed', { err }),
    });

    const staticFiles = StaticFiles.create(config.string('server.static-dir', 'public'));
    const management = config.boolean('amoxi.management.enabled', 'false') ? createManagementHandler(context) : undefined;
    const health: HealthState = { ready: false };
    const extensions: ExtensionInstance[] = (module.extensions ?? []).map((e) => e.install({ context, config, logger }));
    const extensionRoutes = extensions.flatMap((e) => e.routes ?? []);

    let server: Server | undefined;
    let port: number | undefined;
    if ((module.routes.length > 0 || extensionRoutes.length > 0 || staticFiles) && options.listen !== false) {
      const s = createHttpServer(context, {
        config,
        logger,
        staticFiles,
        management,
        health,
        dev,
        extensionRoutes,
        extensionInfo: () => extensions.map((e) => e.describe?.() ?? {}),
      });
      const host = config.string('server.host', '0.0.0.0');
      const wanted = config.number('server.port', '8080');
      // Check the port first. In development, move to the next free port (like Next.js); in
      // production fail clearly, since a load balancer expects the configured port. Cluster
      // workers share the port the `amoxi start` supervisor already checked.
      const fallback = config.boolean('server.port-fallback', config.profile === 'development' ? 'true' : 'false');
      const listenPort = cluster.isWorker ? wanted : await choosePort(wanted, host, fallback);
      if (listenPort !== wanted) logger.warn(`Port ${wanted} is in use by another program; using ${listenPort} instead.`);
      await new Promise<void>((resolve, reject) => {
        s.once('error', (err: NodeJS.ErrnoException) =>
          reject(err.code === 'EADDRINUSE' ? new PortInUseError(listenPort, `Port ${listenPort} is already in use by another program. Stop it, or choose another port with SERVER_PORT=<port>.`) : err),
        );
        s.listen(listenPort, host, () => resolve());
      });
      server = s;
      port = (s.address() as AddressInfo).port;
    }
    for (const e of extensions) await e.start?.({ port });
    health.ready = true;

    const startupMs = performance.now() - t0;
    context.startup.ms = startupMs;
    logger.info(
      `Startup completed in ${performance.now().toFixed(0)}ms (framework: ${startupMs.toFixed(2)}ms, ` +
        `${module.beans.length} beans, ${eagerCount} eager, ${module.routes.length} routes, profile ${config.profile})` +
        (port !== undefined ? `. Server Running: http://localhost:${port}` : ''),
      logger.json ? { startupMs, port, profile: config.profile, pid: process.pid } : undefined,
    );
    if (port !== undefined && staticFiles) logger.debug(`Serving static files from ${staticFiles.directory}`);
    if (port !== undefined && management) logger.info('Management endpoints enabled under /amoxi/');

    const drainMs = config.number('server.shutdown-timeout', devMode ? '500' : '10000');
    const delayMs = config.number('server.shutdown-delay', '0');
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> =>
      (closing ??= (async () => {
        health.ready = false; // readiness probes now fail, so load balancers stop sending traffic
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        dev?.close();
        // Extensions first: they end long-lived streams (clients reconnect elsewhere) and
        // checkpoint background work before connections are drained.
        for (const e of [...extensions].reverse()) {
          try {
            await e.stop?.();
          } catch (err) {
            logger.error('Extension failed to stop cleanly', { err });
          }
        }
        if (server) closeWebSockets(server);
        if (server) {
          const srv = server;
          await new Promise<void>((resolve) => {
            const force = setTimeout(() => srv.closeAllConnections(), drainMs);
            force.unref();
            srv.close(() => {
              clearTimeout(force);
              resolve();
            });
            srv.closeIdleConnections();
          });
        }
        await context.close();
      })());

    if (options.shutdownHook !== false) {
      const shutdown = (reason: string, code = 0): void => {
        logger.info(`Shutting down (${reason})`);
        close().then(
          () => process.exit(code),
          (err) => {
            logger.error('Error during shutdown', { err });
            process.exit(1);
          },
        );
      };
      process.once('SIGINT', () => shutdown('SIGINT'));
      process.once('SIGTERM', () => shutdown('SIGTERM'));
      // Cluster workers and `amoxi dev` children are told to stop over IPC (works on Windows too).
      process.on('message', (m: { type?: string }) => {
        if (m?.type === 'amoxi:shutdown') shutdown('requested by supervisor');
      });
      process.on('unhandledRejection', (reason) => logger.error('Unhandled promise rejection', { err: reason }));
      process.once('uncaughtException', (err) => {
        logger.error('Uncaught exception', { err });
        shutdown('uncaught exception', 1);
      });
    }

    return { context, server, port, logger, startupMs, close };
  }
}
