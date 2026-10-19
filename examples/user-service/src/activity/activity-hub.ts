import { Singleton, type WebSocketConnection } from 'amoxi';

export interface ActivityEvent {
  readonly kind: 'added' | 'removed' | 'photo';
  readonly name: string;
  readonly at: string;
}

/**
 * Keeps the connected WebSocket clients and the latest events. Services publish here; the
 * WebSocket endpoint registers sockets. In cluster mode each worker has its own hub.
 */
@Singleton()
export class ActivityHub {
  private readonly sockets = new Set<WebSocketConnection>();
  private events: ActivityEvent[] = [];

  get recent(): readonly ActivityEvent[] {
    return this.events;
  }

  get connections(): number {
    return this.sockets.size;
  }

  join(socket: WebSocketConnection): void {
    this.sockets.add(socket);
    socket.send({ type: 'history', events: this.events });
  }

  leave(socket: WebSocketConnection): void {
    this.sockets.delete(socket);
  }

  publish(kind: ActivityEvent['kind'], name: string): void {
    const event: ActivityEvent = { kind, name, at: new Date().toISOString() };
    this.events = [event, ...this.events].slice(0, 10);
    for (const socket of this.sockets) socket.send({ type: 'event', event });
  }
}
