export interface Notifier {
  readonly channel: string;
  notify(message: string): void;
}
