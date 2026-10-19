import { WebSocketEndpoint, type WebSocketConnection } from 'amoxi';
import { ActivityHub } from './activity-hub';

/** ws://host/ws/activity: pushes people changes to every open People page. */
@WebSocketEndpoint('/ws/activity')
export class ActivitySocket {
  constructor(private readonly hub: ActivityHub) {}

  onOpen(socket: WebSocketConnection): void {
    this.hub.join(socket);
  }

  onMessage(socket: WebSocketConnection, data: string | Buffer): void {
    if (data === 'ping') socket.send({ type: 'pong' });
  }

  onClose(socket: WebSocketConnection): void {
    this.hub.leave(socket);
  }
}
