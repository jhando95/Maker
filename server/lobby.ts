/**
 * The lobby, wired to sockets.
 *
 * Everything interesting is in `lobbyCore.ts`, which has no idea what a socket
 * is. This file is the thin part: accept an upgrade, read frames, hand text to
 * the core, write what the core wants to send. It exists so that every rule
 * about friends, parties and matching can be tested in-process against a
 * callback, which is the same trade `transport.ts` makes for the game.
 *
 * The one rule that lives here rather than in the core is the first message. A
 * connection that has not said `hello` has no identity, so there is nothing for
 * the core to attribute anything to — it is turned away rather than queued up,
 * because unlike the game's relay there is no ordering hazard to protect
 * against: a lobby client sends its hello and then waits.
 */

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { OPCODE, acceptUpgrade, frame, readFrames } from './websocket.ts';
import { Lobby, QUEUE_TICK_MS } from './lobbyCore.ts';
import { decodeLobby, encodeLobby, type LobbyServerMessage } from '../src/net/lobbyProtocol.ts';

const lobby = new Lobby();

/**
 * The matchmaker runs on a clock, not on arrivals.
 *
 * A queue that only reconsidered when somebody joined would leave the last
 * party in it waiting forever after the person ahead of them disconnected. The
 * timer is unref'd so it never keeps the process alive on its own.
 */
const ticker = setInterval(() => lobby.tick(Date.now()), QUEUE_TICK_MS);
ticker.unref?.();

export function lobbySize(): number {
  return lobby.size;
}

export function upgradeToLobby(request: IncomingMessage, socket: Duplex): void {
  if (acceptUpgrade(request, socket) === null) return;

  let pending = Buffer.alloc(0);
  let playerId: string | null = null;

  const send = (message: LobbyServerMessage): void => {
    if (socket.destroyed) return;
    socket.write(frame(OPCODE.text, encodeLobby(message)));
  };

  const leave = (): void => {
    if (playerId !== null) {
      lobby.goodbye(playerId);
      console.log(`[lobby] ${lobby.codeOf(playerId) ?? playerId} left`);
      playerId = null;
    }
    socket.destroy();
  };

  socket.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    pending = readFrames(
      pending,
      (text) => {
        const message = decodeLobby(text);
        if (message === null) return;
        const now = Date.now();

        if (playerId === null) {
          // Only a hello can start a connection, and only once.
          if (message.t !== 'hello' || typeof message.id !== 'string' || message.id.length === 0) {
            send({ t: 'refused', why: 'malformed' });
            leave();
            return;
          }
          const code = lobby.hello(message.id, message.name, message.v, send, now);
          if (code === null) { leave(); return; }
          playerId = message.id;
          console.log(`[lobby] ${code} joined as "${message.name}"`);
          return;
        }

        // A second hello on a live connection is not a thing a client does, and
        // honouring one would let a socket change whose it is mid-stream.
        if (message.t === 'hello') return;
        lobby.handle(playerId, message, now);
      },
      leave,
    );
  });

  socket.on('close', leave);
  socket.on('error', leave);
}
