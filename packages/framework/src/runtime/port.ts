// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import { connect, createServer } from 'node:net';

export class PortInUseError extends Error {
  override name = 'PortInUseError';
  constructor(
    readonly port: number,
    message: string,
  ) {
    super(message);
  }
}

/** True when something accepts TCP connections on this port on localhost (IPv4 or IPv6). */
function accepts(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (result: boolean): void => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** True when we can bind the port ourselves on this host. */
function bindable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen({ host, port, exclusive: true }, () => probe.close(() => resolve(true)));
  });
}

/**
 * Checks whether a port is free, the way it matters on every OS: nothing may already be listening
 * on it (a connection attempt to localhost succeeds when something is, which also catches a
 * process bound only to 127.0.0.1 that Windows would otherwise let us bind next to), and we must
 * be able to bind it on the configured host.
 */
export async function isPortFree(port: number, host: string): Promise<boolean> {
  const [v4, v6] = await Promise.all([accepts('127.0.0.1', port, 300), accepts('::1', port, 300)]);
  if (v4 || v6) return false;
  return bindable(host, port);
}

/**
 * Picks the port to listen on. If `port` is taken and `fallback` is on (development), tries the
 * next ports, like Next.js and Vite do; otherwise throws a clear PortInUseError.
 */
export async function choosePort(port: number, host: string, fallback: boolean, attempts = 10): Promise<number> {
  if (port === 0) return 0; // the OS picks a free port
  if (await isPortFree(port, host)) return port;
  if (fallback) {
    for (let p = port + 1; p < port + attempts && p <= 65535; p++) {
      if (await isPortFree(p, host)) return p;
    }
  }
  throw new PortInUseError(
    port,
    fallback
      ? `Ports ${port}-${port + attempts - 1} are all in use. Stop the other programs, or choose another port with SERVER_PORT=<port>.`
      : `Port ${port} is already in use by another program. Stop it, or choose another port with SERVER_PORT=<port> (or server.port in application.json).`,
  );
}
