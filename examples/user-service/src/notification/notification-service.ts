import { Named, Singleton } from 'amoxi';
import type { Notifier } from './notifier';

@Singleton()
export class NotificationService {
  constructor(
    // Collection injection: every bean implementing Notifier, resolved at build time.
    private readonly notifiers: readonly Notifier[],
    // Qualified injection: exactly the bean named 'log'.
    @Named('log') private readonly audit: Notifier,
  ) {}

  broadcast(message: string): string[] {
    this.notifiers.forEach((n) => n.notify(message));
    return this.notifiers.map((n) => n.channel);
  }

  auditLog(message: string): void {
    this.audit.notify(`AUDIT ${message}`);
  }
}
