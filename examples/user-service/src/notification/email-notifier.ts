import { Named, PreDestroy, Singleton, Value } from 'amoxi';
import type { Notifier } from './notifier';

@Singleton()
@Named('email')
export class EmailNotifier implements Notifier {
  readonly channel = 'email';
  readonly outbox: string[] = [];

  constructor(@Value('${notifications.email.from:noreply@example.com}') private readonly from: string) {}

  notify(message: string): void {
    this.outbox.push(`[from ${this.from}] ${message}`);
  }

  @PreDestroy()
  flush(): void {
    console.log(`[email] flushing ${this.outbox.length} queued message(s) on shutdown`);
  }
}
