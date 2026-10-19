// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export interface CookieOptions {
  /** Lifetime in seconds. Omit for a session cookie. */
  maxAge?: number;
  expires?: Date;
  path?: string;
  domain?: string;
  /** Defaults to true when the request arrived over HTTPS (or in production). */
  secure?: boolean;
  /** Defaults to true: scripts cannot read the cookie. */
  httpOnly?: boolean;
  /** Defaults to 'Lax'. */
  sameSite?: 'Strict' | 'Lax' | 'None';
}

/** Request cookies (parsed lazily) plus the Set-Cookie headers queued for the response. */
export class Cookies {
  private parsed: Map<string, string> | undefined;
  /** @internal Serialized Set-Cookie values. */
  readonly outgoing: string[] = [];

  constructor(
    private readonly header: string | undefined,
    private readonly secureByDefault: boolean,
  ) {}

  private map(): Map<string, string> {
    if (!this.parsed) {
      this.parsed = new Map();
      for (const part of (this.header ?? '').split(';')) {
        const i = part.indexOf('=');
        if (i < 0) continue;
        const name = part.slice(0, i).trim();
        if (!name || this.parsed.has(name)) continue;
        let value = part.slice(i + 1).trim();
        if (value.length > 1 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
        try {
          value = decodeURIComponent(value);
        } catch {
          /* keep the raw value */
        }
        this.parsed.set(name, value);
      }
    }
    return this.parsed;
  }

  get(name: string): string | undefined {
    return this.map().get(name);
  }

  has(name: string): boolean {
    return this.map().has(name);
  }

  all(): Record<string, string> {
    return Object.fromEntries(this.map());
  }

  set(name: string, value: string, options: CookieOptions = {}): void {
    if (!TOKEN.test(name)) throw new Error(`Invalid cookie name '${name}'`);
    const sameSite = options.sameSite ?? 'Lax';
    let cookie = `${name}=${encodeURIComponent(value)}; Path=${options.path ?? '/'}`;
    if (options.domain) cookie += `; Domain=${options.domain}`;
    if (options.maxAge !== undefined) cookie += `; Max-Age=${Math.floor(options.maxAge)}`;
    if (options.expires) cookie += `; Expires=${options.expires.toUTCString()}`;
    if (options.httpOnly ?? true) cookie += '; HttpOnly';
    cookie += `; SameSite=${sameSite}`;
    if (options.secure ?? (this.secureByDefault || sameSite === 'None')) cookie += '; Secure';
    this.outgoing.push(cookie);
    this.map().set(name, value);
  }

  delete(name: string, options: Pick<CookieOptions, 'path' | 'domain'> = {}): void {
    this.set(name, '', { ...options, maxAge: 0, expires: new Date(0) });
    this.map().delete(name);
  }
}
