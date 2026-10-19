import { Named, Requires, Singleton, Value } from 'amoxi';
import type { Notifier } from './notifier';

/**
 * Exists only when `notifications.slack.webhook` is configured (e.g. NOTIFICATIONS_SLACK_WEBHOOK).
 * NotificationService receives every *enabled* Notifier, so nothing else needs to change.
 */
@Singleton()
@Named('slack')
@Requires({ property: 'notifications.slack.webhook' })
export class SlackNotifier implements Notifier {
  readonly channel = 'slack';
  readonly sent: string[] = [];

  constructor(@Value('${notifications.slack.webhook}') readonly webhook: string) {}

  notify(message: string): void {
    // A real app would POST to this.webhook; the example records the message instead.
    this.sent.push(message);
  }
}
