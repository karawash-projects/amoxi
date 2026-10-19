import { createHash } from 'node:crypto';
import { Singleton } from 'amoxi';

export type AuditValue = string | number | boolean | null;

export interface AuditEntry {
  readonly seq: number;
  readonly at: string;
  /** Customer id, or "system". */
  readonly actor: string;
  /** e.g. "transfer", "card.freeze", "agent.run", "guardrail", "session.signin". */
  readonly action: string;
  /** "ok", "refused", "completed", "failed", ... */
  readonly outcome: string;
  readonly summary: string;
  readonly data: Readonly<Record<string, AuditValue>>;
  /** Hash of the previous entry (64 zeros for the first). */
  readonly prevHash: string;
  /** SHA-256 over prevHash and this entry's content. */
  readonly hash: string;
}

export interface ChainCheck {
  readonly ok: boolean;
  readonly entries: number;
  /** First entry whose hash or link doesn't match, when not ok. */
  readonly brokenAt?: number;
  readonly reason?: string;
  readonly head: string;
}

export const GENESIS = '0'.repeat(64);

/** Stable JSON: object keys sorted, so the hash doesn't depend on insertion order. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
    .join(',')}}`;
}

export function entryHash(e: Omit<AuditEntry, 'hash'>): string {
  const { seq, at, actor, action, outcome, summary, data, prevHash } = e;
  return createHash('sha256')
    .update(prevHash)
    .update('\n')
    .update(canonical({ seq, at, actor, action, outcome, summary, data }))
    .digest('hex');
}

/**
 * Append-only, hash-chained audit log. Each entry's hash covers the previous entry's hash, so
 * editing, removing or reordering any entry breaks every link after it, and verify() finds it.
 * In production the head hash would be anchored externally (WORM storage, a daily notarised
 * digest) so the whole log can't be silently rewritten either.
 */
@Singleton()
export class AuditLog {
  private readonly chain: AuditEntry[] = [];

  append(entry: { actor: string; action: string; outcome: string; summary: string; data?: Record<string, AuditValue | undefined> }): AuditEntry {
    const prev = this.chain[this.chain.length - 1];
    const data: Record<string, AuditValue> = {};
    for (const [k, v] of Object.entries(entry.data ?? {})) if (v !== undefined) data[k] = v;
    const base = {
      seq: this.chain.length + 1,
      at: new Date().toISOString(),
      actor: entry.actor,
      action: entry.action,
      outcome: entry.outcome,
      summary: entry.summary.slice(0, 300),
      data,
      prevHash: prev ? prev.hash : GENESIS,
    };
    const full: AuditEntry = { ...base, hash: entryHash(base) };
    this.chain.push(full);
    return full;
  }

  /** All entries, oldest first. The array is the live chain (tests use it to simulate tampering). */
  entries(): AuditEntry[] {
    return this.chain;
  }

  forActor(actor: string): AuditEntry[] {
    return this.chain.filter((e) => e.actor === actor);
  }

  verify(): ChainCheck {
    let prev = GENESIS;
    for (let i = 0; i < this.chain.length; i++) {
      const e = this.chain[i];
      if (e.seq !== i + 1) return { ok: false, entries: this.chain.length, brokenAt: i + 1, reason: 'entry out of sequence', head: prev };
      if (e.prevHash !== prev) return { ok: false, entries: this.chain.length, brokenAt: e.seq, reason: 'link to the previous entry does not match', head: prev };
      if (entryHash(e) !== e.hash) return { ok: false, entries: this.chain.length, brokenAt: e.seq, reason: 'content does not match its hash', head: prev };
      prev = e.hash;
    }
    return { ok: true, entries: this.chain.length, head: prev };
  }
}
