/**
 * The pipe, with the game on one side and a socket on the other.
 *
 * An interface rather than calling WebSocket directly, for one reason that
 * matters more than the usual arguments about abstraction: it lets the whole of
 * multiplayer be tested without a network. `LoopbackPair` puts a host and a
 * client in the same process — or the same browser tab — connected by two
 * queues, and every rule about joining, prediction, reconciliation and building
 * is exercised through exactly the code path a real socket uses.
 *
 * That matters because the alternative is a test that stands up a server, and a
 * test that stands up a server is a test that gets skipped in CI and then stops
 * being true.
 *
 * The queue is deliberately not drained on arrival. Messages sit until the game
 * asks for them at a tick boundary, which is what keeps a simulation driven by a
 * fixed timestep from being poked at by a socket in the middle of one.
 */

import { decode, encode, type NetMessage } from './protocol.ts';

export interface Transport {
  send(message: NetMessage): void;
  /** Everything that arrived since the last call. Empties the queue. */
  drain(): NetMessage[];
  readonly open: boolean;
  close(): void;
}

/**
 * A transport backed by a real WebSocket.
 *
 * Sends before the socket is open are dropped rather than buffered. The only
 * thing sent that early is a command for a tick that will be stale by the time
 * anyone could act on it, and a buffer of those is worse than none.
 */
export class SocketTransport implements Transport {
  private readonly inbox: NetMessage[] = [];
  private socket: WebSocket | null = null;
  private closed = false;

  constructor(url: string, private readonly onOpen?: () => void, private readonly onClose?: () => void) {
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.addEventListener('open', () => this.onOpen?.());
    socket.addEventListener('message', (event: MessageEvent) => {
      if (typeof event.data !== 'string') return;
      const message = decode(event.data);
      if (message !== null) this.inbox.push(message);
    });
    const done = (): void => {
      this.closed = true;
      this.onClose?.();
    };
    socket.addEventListener('close', done);
    // An error on a WebSocket is always followed by a close, so this only marks
    // the connection dead early rather than reporting anything of its own.
    socket.addEventListener('error', () => { this.closed = true; });
  }

  get open(): boolean {
    return !this.closed && this.socket?.readyState === WebSocket.OPEN;
  }

  send(message: NetMessage): void {
    if (!this.open) return;
    this.socket!.send(encode(message));
  }

  drain(): NetMessage[] {
    if (this.inbox.length === 0) return EMPTY;
    return this.inbox.splice(0, this.inbox.length);
  }

  close(): void {
    this.closed = true;
    this.socket?.close();
    this.socket = null;
  }
}

/** Shared so a quiet tick allocates nothing. Never written to. */
const EMPTY: NetMessage[] = [];

/** One end of a loopback pair. */
class LoopbackEnd implements Transport {
  private readonly inbox: NetMessage[] = [];
  other: LoopbackEnd | null = null;
  open = true;

  send(message: NetMessage): void {
    if (!this.open || this.other === null || !this.other.open) return;
    // Round-tripped through the encoder rather than pushed as an object, so a
    // field that would not survive JSON — an undefined, a Map, a class instance
    // — fails here rather than only on a real socket.
    const copy = JSON.parse(JSON.stringify(message)) as NetMessage;
    this.other.inbox.push(copy);
  }

  drain(): NetMessage[] {
    if (this.inbox.length === 0) return EMPTY;
    return this.inbox.splice(0, this.inbox.length);
  }

  close(): void {
    this.open = false;
    // Both ends, because that is what a socket does. Closing only this side left
    // the host still believing a departed guest was connected, which is the
    // difference between a test that models a network and one that models a
    // queue.
    if (this.other !== null && this.other.open) this.other.close();
  }
}

/**
 * Two transports wired to each other, with no socket in between.
 *
 * The delivery is immediate, which is the one way this differs from a real
 * network. Tests that care about lag drive it themselves by holding messages
 * back, which is more controllable than a real socket and repeats exactly.
 */
export function loopbackPair(): { host: Transport; client: Transport } {
  const a = new LoopbackEnd();
  const b = new LoopbackEnd();
  a.other = b;
  b.other = a;
  return { host: a, client: b };
}
