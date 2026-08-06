/**
 * A pipe between two browsers.
 *
 * Two tabs cannot talk to each other directly, so something in the middle has to
 * carry the bytes. This is that and nothing else: it knows about rooms and
 * sockets, and nothing whatsoever about the game. It never parses a message, so
 * it cannot disagree with the client about what one means — and the protocol can
 * change without this file being touched.
 *
 * That property is load-bearing rather than tidy, and it is why the lobby is a
 * separate thing on a separate path. Friends, parties and a queue need a server
 * that knows what a player is; the moment this file knew that, it would stop
 * being a pipe and start being something that can be wrong about a game.
 *
 * By default the first socket into a room is the host. Everybody after that is a
 * guest, and their traffic goes to the host and only to the host; the host's
 * traffic goes to the guest it names, or to everybody. That is the whole routing
 * table, and it matches the game's shape exactly: one authority, several
 * followers.
 *
 * ## Saying who hosts, when somebody already decided
 *
 * Arrival order is the right rule when two people type a room name at each
 * other, and the wrong one the moment anything else picks the host — because
 * two browsers told to join at the same instant arrive in whichever order the
 * network felt like, and the one running the simulation may not be first.
 *
 * That was not a hypothetical. The lobby elects a host and hands both machines
 * the same room; without a way to say so, roughly half of all matches wired a
 * `NetClient` to the relay's host lane and a `NetHost` to a guest lane, and
 * nobody connected to anybody. The symptom is a match that hands over cleanly
 * and then simply never starts.
 *
 * So `?host=1` claims the lane and `?host=0` declines it, and leaving the
 * parameter off keeps the arrival-order rule exactly as it was. This is still
 * not the relay knowing anything about the game: which socket is the authority
 * is a fact it already had to hold, and this only lets somebody else state it.
 *
 * ## The envelope
 *
 * Several guests share one socket to the host, so the host has to be able to
 * tell them apart. Everything it receives is wrapped:
 *
 *     {"f": "<peer>", "d": "<the guest's message, verbatim>"}
 *
 * and everything it sends is addressed:
 *
 *     {"t": "<peer>", "d": "..."}      one guest
 *     {"t": "*",      "d": "..."}      all of them
 *
 * A guest sends and receives the game's own messages with nothing round them,
 * because a guest only ever talks to one party. The relay never looks inside
 * `d`, so the game's protocol can change entirely without this file moving.
 *
 * This is a development relay. It has no TLS, no authentication and no rate
 * limiting, so it belongs on a machine you trust and a network you control.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { OPCODE, acceptUpgrade, frame, readFrames } from './websocket.ts';

interface Peer {
  socket: Duplex;
  id: string;
  host: boolean;
}

/** Rooms, each a list of sockets with the host first. */
const rooms = new Map<string, Peer[]>();

export function roomCount(): number {
  return rooms.size;
}

/**
 * Take on one upgraded connection.
 *
 * Handed an already-accepted socket rather than doing the handshake itself, so
 * the process can serve this and the lobby from one port and decide between them
 * by path.
 */
export function joinRelay(request: IncomingMessage, socket: Duplex): void {
  const url = new URL(request.url ?? '/', 'http://relay');
  const room = url.searchParams.get('room') ?? 'yard';
  const peers = rooms.get(room) ?? [];
  rooms.set(room, peers);

  const claim = url.searchParams.get('host');
  const taken = peers.some((p) => p.host);
  // A claim is honoured unless somebody already holds the lane; with no claim,
  // the old rule stands. Two claimants is not a case worth failing loudly on —
  // the second is simply a guest, which is what it would have been anyway.
  const host = claim === null ? peers.length === 0 : claim === '1' && !taken;

  const peer: Peer = { socket, id: randomUUID().slice(0, 8), host };
  peers.push(peer);
  console.log(`[relay] ${peer.id} joined "${room}" as ${peer.host ? 'host' : 'guest'}`);

  // The host is told who arrived and who left, so it can open and close a lane
  // for each without waiting for them to speak first.
  if (!peer.host) {
    peers.find((p) => p.host)?.socket
      .write(frame(OPCODE.text, JSON.stringify({ f: peer.id, join: true })));
  } else {
    // And a host that arrives *after* its guests is told about each of them, or
    // they sit in the room unannounced forever. Impossible under arrival order
    // — the host was always first — and routine once anybody else picks.
    for (const waiting of peers) {
      if (waiting === peer) continue;
      socket.write(frame(OPCODE.text, JSON.stringify({ f: waiting.id, join: true })));
    }
  }

  let pending = Buffer.alloc(0);

  const leave = (): void => {
    const at = peers.indexOf(peer);
    if (at === -1) return;
    peers.splice(at, 1);
    socket.destroy();
    console.log(`[relay] ${peer.id} left "${room}"`);
    if (!peer.host) {
      const host = peers.find((p) => p.host);
      host?.socket.write(frame(OPCODE.text, JSON.stringify({ f: peer.id, leave: true })));
    }
    // The host leaving ends the room. There is no migration and there should
    // not be: the host's browser *was* the simulation, and picking a new one
    // means picking whose idea of the world is now true.
    if (peer.host) {
      for (const other of peers) other.socket.destroy();
      peers.length = 0;
    }
    if (peers.length === 0) rooms.delete(room);
  };

  socket.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    pending = readFrames(
      pending,
      (text) => {
        if (peer.host) {
          // Addressed, because several guests share this one socket.
          let envelope: unknown;
          try {
            envelope = JSON.parse(text);
          } catch {
            return;
          }
          if (envelope === null || typeof envelope !== 'object') return;
          const { t, d } = envelope as { t?: unknown; d?: unknown };
          const out = frame(OPCODE.text, String(d ?? ''));
          for (const target of peers) {
            if (target === peer) continue;
            if (t === '*' || t === target.id) target.socket.write(out);
          }
          return;
        }

        // A guest speaks only to the host, and is tagged so the host can tell
        // several of them apart.
        const host = peers.find((p) => p.host);
        if (host === undefined) return;
        host.socket.write(frame(OPCODE.text, JSON.stringify({ f: peer.id, d: text })));
      },
      leave,
    );
  });

  socket.on('close', leave);
  socket.on('error', leave);
}

/** Complete the handshake and take the connection on. */
export function upgradeToRelay(request: IncomingMessage, socket: Duplex): void {
  if (acceptUpgrade(request, socket) === null) return;
  joinRelay(request, socket);
}
