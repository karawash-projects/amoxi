// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

function serializeError(err: unknown): unknown {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack, ...(err.cause ? { cause: serializeError(err.cause) } : {}) };
  }
  return err;
}

/**
 * Minimal structured logger. `json` mode writes one JSON object per line (for log shippers);
 * otherwise it writes readable lines for local development.
 */
export class Logger {
  constructor(
    readonly level: LogLevel = 'info',
    readonly json = false,
  ) {}

  static silent(): Logger {
    return new Logger('silent');
  }

  enabled(level: Exclude<LogLevel, 'silent'>): boolean {
    return ORDER[level] >= ORDER[this.level];
  }

  debug(msg: string, fields?: Record<string, unknown>): void {
    this.write('debug', msg, fields);
  }
  info(msg: string, fields?: Record<string, unknown>): void {
    this.write('info', msg, fields);
  }
  warn(msg: string, fields?: Record<string, unknown>): void {
    this.write('warn', msg, fields);
  }
  error(msg: string, fields?: Record<string, unknown>): void {
    this.write('error', msg, fields);
  }

  private write(level: Exclude<LogLevel, 'silent'>, msg: string, fields?: Record<string, unknown>): void {
    if (ORDER[level] < ORDER[this.level]) return;
    const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
    const time = new Date().toISOString();
    if (this.json) {
      const out: Record<string, unknown> = { time, level, msg };
      if (fields) for (const k in fields) out[k] = k === 'err' ? serializeError(fields[k]) : fields[k];
      stream.write(`${JSON.stringify(out)}\n`);
      return;
    }
    let line = `${time} ${level.toUpperCase().padEnd(5)} [amoxi] ${msg}`;
    if (fields) {
      for (const k in fields) {
        if (k === 'err' || fields[k] === undefined) continue;
        line += ` ${k}=${typeof fields[k] === 'string' ? fields[k] : JSON.stringify(fields[k])}`;
      }
      const err = fields.err;
      if (err !== undefined) line += `\n${err instanceof Error ? err.stack : JSON.stringify(err)}`;
    }
    stream.write(`${line}\n`);
  }
}
