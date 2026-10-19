import { Named, Singleton } from 'amoxi';
import type { Notifier } from './notifier';

@Singleton()
@Named('log')
export class LogNotifier implements Notifier {
  readonly channel = 'log';

  notify(message: string): void {
    console.log(`[notify] ${message}`);
  }
}
