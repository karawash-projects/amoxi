// Copyright 2026 Ahmad Karawash
// SPDX-License-Identifier: Apache-2.0

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Seals session data into a cookie with AES-256-GCM: the browser can neither read nor
 * modify it. The key is derived with HKDF from AMOXI_SESSION_SECRET when set, otherwise from
 * the key `amoxi build` generated.
 */
export class SessionCodec {
  private readonly key: Buffer;

  constructor(secret: string) {
    this.key = Buffer.from(hkdfSync('sha256', secret, 'amoxi', 'session-v1', 32));
  }

  seal(payload: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url');
  }

  open(token: string): unknown {
    try {
      const buf = Buffer.from(token, 'base64url');
      if (buf.length < 29) return undefined;
      const decipher = createDecipheriv('aes-256-gcm', this.key, buf.subarray(0, 12));
      decipher.setAuthTag(buf.subarray(12, 28));
      return JSON.parse(Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8'));
    } catch {
      return undefined; // tampered, wrong key, or corrupt: treat as no session
    }
  }
}

export interface SessionSettings {
  readonly codec: SessionCodec;
  readonly cookie: string;
  /** Seconds. */
  readonly maxAge: number;
}

const newSessionId = (): string => randomBytes(16).toString('base64url');

/**
 * Per-user data stored in an encrypted cookie (stateless: works across cluster workers and restarts).
 *
 * Because the session lives in the cookie, `destroy()` removes it from this browser but a copy of the
 * cookie captured earlier stays valid until it expires (`amoxi.session.max-age`). Apps that need
 * server-side revocation keep the `id` of each signed-in session (e.g. in their database), check it in a
 * middleware, and delete it on logout. See "Sessions" in the README.
 */
export class Session {
  private data: Record<string, unknown>;
  private changed = false;
  private destroyed = false;
  private _id: string | undefined;
  private _issuedAt: number | undefined;
  readonly isNew: boolean;

  constructor(initial: Record<string, unknown> | undefined, meta?: { id?: string; issuedAt?: number }) {
    this.data = initial ?? {};
    this.isNew = initial === undefined;
    this._id = meta?.id;
    this._issuedAt = meta?.issuedAt;
  }

  /** Random id of this session, stable for its lifetime (new after `destroy()` or `regenerate()`). */
  get id(): string {
    return (this._id ??= newSessionId());
  }

  /** When this session was created (ms since epoch). */
  get issuedAt(): number {
    return (this._issuedAt ??= Date.now());
  }

  /** Keeps the data under a new id. Call it on sign-in (prevents session fixation). */
  regenerate(): void {
    this._id = newSessionId();
    this._issuedAt = Date.now();
    this.changed = true;
  }

  get<T = unknown>(key: string): T | undefined {
    return this.data[key] as T | undefined;
  }

  set(key: string, value: unknown): void {
    this.data[key] = value;
    this.changed = true;
  }

  delete(key: string): void {
    if (key in this.data) {
      delete this.data[key];
      this.changed = true;
    }
  }

  /** Remove all data and the cookie (e.g. on logout). */
  destroy(): void {
    this.data = {};
    this.destroyed = true;
    this.changed = true;
    this._id = undefined;
    this._issuedAt = undefined;
  }

  /** @internal */
  get pendingWrite(): { destroyed: boolean; data: Record<string, unknown>; id: string; issuedAt: number } | undefined {
    return this.changed ? { destroyed: this.destroyed, data: this.data, id: this.id, issuedAt: this.issuedAt } : undefined;
  }
}
