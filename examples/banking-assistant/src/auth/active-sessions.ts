import { Singleton } from 'amoxi';

/**
 * Signed-in sessions, by session id. Session cookies are sealed and stateless, so on their own a
 * copy of a cookie stays valid until it expires even after sign-out. Keeping the ids of live
 * sessions on the server makes sign-out final: AuthMiddleware ignores any session not listed here.
 *
 * Demo: kept in memory (one worker; a restart signs everyone out). In production keep them where
 * every server can see them, e.g. a database table or Redis key with the same expiry.
 */
@Singleton()
export class ActiveSessions {
  private readonly sessions = new Map<string, number>();
  private readonly ttlMs = 8 * 3600_000; // banking: sign in again after 8 hours

  add(id: string): void {
    this.prune();
    this.sessions.set(id, Date.now() + this.ttlMs);
  }

  has(id: string): boolean {
    const expires = this.sessions.get(id);
    if (expires === undefined) return false;
    if (expires < Date.now()) {
      this.sessions.delete(id);
      return false;
    }
    return true;
  }

  remove(id: string): void {
    this.sessions.delete(id);
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, expires] of this.sessions) if (expires < now) this.sessions.delete(id);
  }
}
