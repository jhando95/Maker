/**
 * One socket to the relay, several people on the other end of it.
 *
 * A host has exactly one connection however many guests are in the yard, so the
 * traffic for all of them arrives interleaved down a single pipe. The relay tags
 * each message with who sent it; this splits them back apart and hands the
 * session one ordinary `Transport` per person — so `NetHost` never learns that a
 * relay exists, and works identically against a loopback pair in a test.
 *
 * That is the whole reason this file is separate from `session.ts`. The
 * multiplexing is a property of how the messages get here, not of the game, and
 * mixing the two would mean the tests could only cover the game by also
 * simulating a relay.
 *
 * A guest needs none of this: it only ever talks to one party, so its messages
 * travel bare and `SocketTransport` is enough.
 */

import { decode, encode, type NetMessage } from './protocol.ts';
import type { Transport } from './transport.ts';

/** What the relay wraps a guest's message in on the way to the host. */
interface Envelope {
  f: string;
  d?: string;
  join?: boolean;
  leave?: boolean;
}

/** Never written to; shared so a quiet tick allocates nothing. */
const EMPTY: NetMessage[] = [];

/** One guest's lane through the host's single socket. */
class Lane implements Transport {
  private readonly inbox: NetMessage[] = [];
  open = true;

  constructor(readonly peer: string, private readonly write: (peer: string, raw: string) => void) {}

  deliver(message: NetMessage): void {
    this.inbox.push(message);
  }

  send(message: NetMessage): void {
    if (!this.open) return;
    this.write(this.peer, encode(message));
  }

  drain(): NetMessage[] {
    if (this.inbox.length === 0) return EMPTY;
    return this.inbox.splice(0, this.inbox.length);
  }

  close(): void {
    this.open = false;
  }
}

/**
 * The host's end of a relay connection.
 *
 * Calls `onPeer` with a fresh transport each time somebody arrives. The session
 * hands that straight to `NetHost.accept` and everything downstream is the same
 * code a loopback test runs.
 */
export class RelayHostLink {
  private readonly lanes = new Map<string, Lane>();
  private socket: WebSocket | null = null;
  private ready = false;

  constructor(
    url: string,
    room: string,
    private readonly onPeer: (transport: Transport) => void,
    private readonly onStatus?: (message: string) => void,
  ) {
    const socket = new WebSocket(relayUrl(url, room, true));
    this.socket = socket;
    socket.addEventListener('open', () => {
      this.ready = true;
      this.onStatus?.(`hosting "${room}"`);
    });
    socket.addEventListener('close', () => this.shutDown('the relay went away'));
    socket.addEventListener('error', () => this.shutDown('could not reach the relay'));
    socket.addEventListener('message', (event: MessageEvent) => {
      if (typeof event.data !== 'string') return;
      this.receive(event.data);
    });
  }

  get open(): boolean {
    return this.ready && this.socket?.readyState === WebSocket.OPEN;
  }

  private receive(raw: string): void {
    let envelope: Envelope;
    try {
      envelope = JSON.parse(raw) as Envelope;
    } catch {
      return;
    }
    if (typeof envelope?.f !== 'string') return;

    if (envelope.leave === true) {
      this.lanes.get(envelope.f)?.close();
      this.lanes.delete(envelope.f);
      return;
    }

    let lane = this.lanes.get(envelope.f);
    if (lane === undefined) {
      lane = new Lane(envelope.f, (peer, text) => this.write(peer, text));
      this.lanes.set(envelope.f, lane);
      // Handed over on arrival rather than on their first game message, so the
      // session can turn away a peer that never says hello instead of holding a
      // half-open connection open forever.
      this.onPeer(lane);
    }
    if (envelope.join === true || typeof envelope.d !== 'string') return;

    const message = decode(envelope.d);
    if (message !== null) lane.deliver(message);
  }

  private write(peer: string, raw: string): void {
    if (!this.open) return;
    this.socket!.send(JSON.stringify({ t: peer, d: raw }));
  }

  private shutDown(reason: string): void {
    this.ready = false;
    for (const lane of this.lanes.values()) lane.close();
    this.lanes.clear();
    this.onStatus?.(reason);
  }

  close(): void {
    this.shutDown('stopped hosting');
    this.socket?.close();
    this.socket = null;
  }
}

/**
 * Add the room to a relay address.
 *
 * Shared with the guest side so the two cannot end up in different rooms while
 * both believing they typed the same thing.
 */
export function relayUrl(url: string, room: string, host?: boolean): string {
  const sep = url.includes('?') ? '&' : '?';
  const claim = host === undefined ? '' : `&host=${host ? '1' : '0'}`;
  return `${url}${sep}room=${encodeURIComponent(room)}${claim}`;
}
