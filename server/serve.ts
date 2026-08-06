/**
 * One process, two servers, one port.
 *
 *   npm run server            # ws://localhost:8787
 *   npm run server -- 9000    # somewhere else
 *
 * They are separate on purpose and share only a port and a frame parser:
 *
 * | path | knows about | lives for |
 * |---|---|---|
 * | anything else | sockets, rooms, opaque bytes | one match |
 * | `/lobby` | players, friends, parties, a queue | the whole session |
 *
 * The relay is the older and the dumber, and it stays that way. The lobby's
 * only output is a room name: it gathers people, decides who hosts, mints a
 * room and steps back, after which the game talks to the relay in a protocol
 * the lobby has never heard of. A lobby that fell over could not interrupt a
 * match already running, because by then it is not in the path.
 *
 * The relay answers on every path except the lobby's rather than on one of its
 * own, so an address a player already has in a text field keeps working.
 *
 * This is a development server: no TLS, no authentication beyond a bearer id
 * that `identity.ts` is explicit about not trusting, and no rate limiting beyond
 * the frame cap. It belongs on a machine you trust and a network you control.
 */

import { createServer } from 'node:http';
import { roomCount, upgradeToRelay } from './relay.ts';
import { lobbySize, upgradeToLobby } from './lobby.ts';

const port = Number(process.argv[2] ?? process.env['PORT'] ?? 8787);

const server = createServer((request, response) => {
  // A plain GET is somebody checking the server is up, which is worth
  // answering — and worth answering with both numbers, because "the lobby is
  // empty" and "the lobby is down" look identical from a browser otherwise.
  response.writeHead(200, { 'content-type': 'text/plain' });
  response.end(`maker: ${roomCount()} room(s), ${lobbySize()} in the lobby\n`);
  void request;
});

server.on('upgrade', (request, socket) => {
  const path = new URL(request.url ?? '/', 'http://server').pathname;
  if (path === '/lobby') upgradeToLobby(request, socket);
  else upgradeToRelay(request, socket);
});

server.listen(port, () => {
  console.log(`[maker] listening on ws://localhost:${port}`);
  console.log('[maker]   relay   — first tab in a room hosts; the rest join it');
  console.log('[maker]   /lobby  — friends, parties and the queue');
});
