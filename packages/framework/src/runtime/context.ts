// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from 'node:crypto';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { TLSSocket } from 'node:tls';
import { Cookies } from './cookies';
import { negotiateLocale, Translator, type I18nBundle } from './i18n';
import { Session, type SessionSettings } from './session';
import type { RequestContext } from './types';

export interface ContextSettings {
  /**
   * Number of proxies you run in front of the app (0: none, so forwarded headers are ignored). Each
   * proxy appends to X-Forwarded-For, so the client address is the entry this many places from the
   * end; anything before it was sent by the client and can be forged.
   */
  readonly trustProxy: number;
  readonly secureCookies: boolean;
  readonly session?: SessionSettings;
  /** Explains why sessions are unavailable (e.g. no secret in production). */
  readonly sessionError?: string;
  readonly i18n?: I18nBundle;
}

const LOCALE_COOKIE = 'amoxi_locale';

const COOKIE_LIMIT = 4000;

/** The per-request object handed to handlers and middleware. Expensive parts are created lazily. */
export class HttpContext implements RequestContext {
  params: Record<string, string> = {};
  body: unknown = undefined;
  readonly state: Record<string, unknown> = {};
  /**
   * @internal Request-specific data this request read: 'session', 'cookies', 'query', 'headers',
   * 'locale'. `amoxi export` uses it to explain what a static copy of a page can't reproduce.
   */
  readonly used = new Set<string>();
  private tracking = true;
  /** @internal How often this request read cookies or the session: @Cached uses it to spot personal pages. */
  personalReads = 0;
  private readonly background: Promise<unknown>[] = [];
  private track(what: string): void {
    if (!this.tracking) return;
    this.used.add(what);
    if (what === 'session' || what === 'cookies') this.personalReads++;
  }

  /** @internal Work started by this request that must finish before its request scope is cleaned up. */
  waitUntil(work: Promise<unknown>): void {
    this.background.push(work);
  }

  /** @internal Waits for everything passed to waitUntil(). */
  async settled(): Promise<void> {
    while (this.background.length > 0) await Promise.allSettled(this.background.splice(0));
  }
  /** Runs framework-internal reads without recording them as the page's own usage. */
  private internal<T>(fn: () => T): T {
    const prev = this.tracking;
    this.tracking = false;
    try {
      return fn();
    } finally {
      this.tracking = prev;
    }
  }
  private _query?: URLSearchParams;
  private _cookies?: Cookies;
  private _session?: Session;
  private _nonce?: string;
  private _translator?: Translator;
  // Read while the socket is attached: Node detaches it (req.socket becomes null) once a response
  // on a closing connection has finished, and the request log reads the address after that.
  private readonly remoteAddress: string;
  private readonly encrypted: boolean;
  /** The negotiated page representation (set by the server before middleware runs). */
  representation: 'html' | 'markdown' | 'json' = 'html';

  constructor(
    readonly req: IncomingMessage,
    readonly res: ServerResponse,
    readonly method: string,
    /** Set to the page's own path when the request is for its markdown alias (/x.md, /x/index.md). */
    public path: string,
    readonly search: string,
    readonly id: string,
    private readonly settings: ContextSettings,
  ) {
    this.remoteAddress = req.socket?.remoteAddress ?? '';
    this.encrypted = !!(req.socket as TLSSocket | null)?.encrypted;
  }

  get headers(): IncomingHttpHeaders {
    this.track('headers');
    return this.req.headers;
  }

  get query(): URLSearchParams {
    this.track('query');
    return (this._query ??= new URLSearchParams(this.search));
  }

  get protocol(): 'http' | 'https' {
    if (this.encrypted) return 'https';
    if (this.settings.trustProxy > 0) {
      const proto = this.forwarded('x-forwarded-proto')?.toLowerCase();
      if (proto === 'https') return 'https';
    }
    return 'http';
  }

  get ip(): string {
    if (this.settings.trustProxy > 0) {
      const forwarded = this.forwarded('x-forwarded-for');
      if (forwarded) return forwarded;
    }
    return this.remoteAddress;
  }

  /** The value a trusted proxy added to a comma-separated forwarding header (see `trustProxy`). */
  private forwarded(header: string): string | undefined {
    const raw = this.req.headers[header];
    const entries = (Array.isArray(raw) ? raw.join(',') : (raw ?? ''))
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean);
    if (entries.length === 0) return undefined;
    return entries[Math.max(0, entries.length - this.settings.trustProxy)];
  }

  get cookies(): Cookies {
    this.track('cookies');
    return (this._cookies ??= new Cookies(this.req.headers.cookie, this.settings.secureCookies || this.protocol === 'https'));
  }

  get session(): Session {
    this.track('session');
    if (!this._session) return this.internal(() => this.loadSession());
    return this._session;
  }

  private loadSession(): Session {
    if (!this._session) {
      const s = this.settings.session;
      if (!s) throw new Error(this.settings.sessionError ?? 'Sessions are not configured');
      const token = this.cookies.get(s.cookie);
      const payload = token ? (s.codec.open(token) as { d?: Record<string, unknown>; e?: number; i?: unknown; t?: unknown } | undefined) : undefined;
      const valid = payload && typeof payload.e === 'number' && payload.e > Date.now() && payload.d && typeof payload.d === 'object';
      this._session = valid
        ? new Session(payload.d, { id: typeof payload.i === 'string' ? payload.i : undefined, issuedAt: typeof payload.t === 'number' ? payload.t : undefined })
        : new Session(undefined);
    }
    return this._session;
  }

  get locale(): string {
    return this.translator.locale;
  }

  t(key: string, params?: Readonly<Record<string, string | number>>): string {
    return this.translator.t(key, params);
  }

  private get translator(): Translator {
    if (this.settings.i18n && this.settings.i18n.locales.length > 1) this.track('locale');
    return this._translator ?? this.internal(() => this.createTranslator());
  }

  private createTranslator(): Translator {
    if (!this._translator) {
      const bundle = this.settings.i18n;
      let locale = bundle?.defaultLocale ?? 'en';
      if (bundle) {
        const supported = (l: string | null | undefined): string | undefined => (l ? bundle.locales.find((x) => x.toLowerCase() === l.toLowerCase()) : undefined);
        const fromQuery = supported(this.query.get('lang'));
        if (fromQuery && this.res) {
          locale = fromQuery;
          this.cookies.set(LOCALE_COOKIE, fromQuery, { maxAge: 365 * 24 * 3600, httpOnly: false });
        } else {
          locale = fromQuery ?? supported(this.cookies.get(LOCALE_COOKIE)) ?? negotiateLocale(this.req.headers['accept-language'], bundle.locales, bundle.defaultLocale);
        }
      }
      this._translator = new Translator(bundle, locale);
    }
    return this._translator;
  }

  get nonce(): string {
    return (this._nonce ??= randomBytes(16).toString('base64'));
  }

  /** @internal Writes session and cookie headers. Called once, right before the response head is sent. */
  commit(): void {
    const s = this.settings.session;
    const write = this._session?.pendingWrite;
    if (s && write) {
      if (write.destroyed && Object.keys(write.data).length === 0) {
        this.cookies.delete(s.cookie);
      } else {
        const token = s.codec.seal({ d: write.data, e: Date.now() + s.maxAge * 1000, i: write.id, t: write.issuedAt });
        if (token.length > COOKIE_LIMIT) throw new Error(`Session data is too large for a cookie (${token.length} bytes, limit ${COOKIE_LIMIT})`);
        this.cookies.set(s.cookie, token, { maxAge: s.maxAge, httpOnly: true, sameSite: 'Lax' });
      }
    }
    if (this._cookies?.outgoing.length && !this.res.headersSent) {
      const existing = this.res.getHeader('set-cookie');
      const prior = existing === undefined ? [] : Array.isArray(existing) ? existing : [String(existing)];
      this.res.setHeader('set-cookie', [...prior, ...this._cookies.outgoing]);
      this._cookies.outgoing.length = 0;
    }
  }
}
