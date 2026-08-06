/**
 * A pipe between two browsers.
 *
 *   npm run server            # ws://localhost:8787
 *   npm run server -- 9000    # somewhere else
 *
 * Two tabs cannot talk to each other directly, so something in the middle has to
 * carry the bytes. This is that and nothing else: it knows about rooms and
 * sockets, and nothing whatsoever about the game. It never parses a message, so
 * it cannot disagree with the client about what one means — and the protocol can
 * change without this file being touched.
 *
 * The first socket into a room is the host. Everybody after that is a guest, and
 * their traffic goes to the host and only to the host; the host's traffic goes
 * to the guest it names, or to everybody. That is the whole routing table, and it
 * matches the game's shape exactly: one authority, several followers.
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
 * ## Why the WebSocket protocol is implemented here rather than installed
 *
 * The whole project has one runtime dependency, and a relay is not a good reason
 * for a second. The parts of RFC 6455 a game needs — the handshake, text frames,
 * client masking, close and ping — are about a hundred lines, and they are all
 * below. What is deliberately *not* implemented is fragmentation of outgoing
 * frames and the permessage-deflate extension, neither of which a browser needs
 * from a server that only ever relays small text messages.
 *
 * This is a development relay. It has no TLS, no authentication and no rate
 * limiting, so it belongs on a machine you trust and a network you control.
 */

import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';

/** The constant RFC 6455 requires in the handshake. Not a secret. */
const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OPCODE = { text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa };

/**
 * Cap on one message.
 *
 * A snapshot of eight people is a few hundred bytes. Anything approaching this
 * is either a bug or somebody probing, and both are better refused than
 * buffered.
 */
const MAX_FRAME = 1 << 20;

/** Rooms, each a list of sockets with the host first. */
const rooms = new Map();

function accept(request, socket) {
  const key = request.headers['sec-websocket-key'];
  if (typeof key !== 'string') {
    socket.destroy();
    return null;
  }
  const digest = createHash('sha1').update(key + WS_MAGIC).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n'
    + 'Upgrade: websocket\r\n'
    + 'Connection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${digest}\r\n\r\n`,
  );
  socket.setNoDelay(true);
  return socket;
}

/** Build one unfragmented frame. Server frames are never masked. */
function frame(opcode, payload) {
  const body = Buffer.from(payload, 'utf8');
  const length = body.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, body]);
}

/**
 * Pull whole frames out of a growing buffer.
 *
 * Returns what is left over, because TCP has no idea what a message is: one
 * read can carry half a frame or three of them, and treating a read as a message
 * is the classic way to write a relay that works on localhost and nowhere else.
 */
function readFrames(buffer, onMessage, onClose) {
  let offset = 0;
  for (;;) {
    if (buffer.length - offset < 2) break;
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let cursor = offset + 2;

    if (length === 126) {
      if (buffer.length - cursor < 2) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (buffer.length - cursor < 8) break;
      const big = buffer.readBigUInt64BE(cursor);
      if (big > BigInt(MAX_FRAME)) { onClose(); return buffer.subarray(buffer.length); }
      length = Number(big);
      cursor += 8;
    }
    if (length > MAX_FRAME) { onClose(); return buffer.subarray(buffer.length); }

    let mask = null;
    if (masked) {
      if (buffer.length - cursor < 4) break;
      mask = buffer.subarray(cursor, cursor + 4);
      cursor += 4;
    }
    if (buffer.length - cursor < length) break;

    const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
    if (mask !== null) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    }
    cursor += length;
    offset = cursor;

    if (opcode === OPCODE.close) { onClose(); break; }
    if (opcode === OPCODE.text) onMessage(payload.toString('utf8'));
    // Binary, ping and pong are ignored: nothing here sends any of them, and a
    // browser only sends a ping if asked to.
  }
  return buffer.subarray(offset);
}

const port = Number(process.argv[2] ?? process.env.PORT ?? 8787);

const server = createServer((request, response) => {
  // A plain GET is somebody checking the relay is up, which is worth answering.
  response.writeHead(200, { 'content-type': 'text/plain' });
  response.end(`maker relay: ${rooms.size} room(s)\n`);
});

server.on('upgrade', (request, socket) => {
  if (accept(request, socket) === null) return;

  const url = new URL(request.url ?? '/', 'http://relay');
  const room = url.searchParams.get('room') ?? 'yard';
  const peers = rooms.get(room) ?? [];
  rooms.set(room, peers);

  const peer = { socket, id: randomUUID().slice(0, 8), host: peers.length === 0 };
  peers.push(peer);
  console.log(`[relay] ${peer.id} joined "${room}" as ${peer.host ? 'host' : 'guest'}`);
  // The host is told who arrived and who left, so it can open and close a lane
  // for each without waiting for them to speak first.
  if (!peer.host) {
    const host = peers.find((p) => p.host);
    host?.socket.write(frame(OPCODE.text, JSON.stringify({ f: peer.id, join: true })));
  }

  let pending = Buffer.alloc(0);

  const leave = () => {
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

  socket.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    pending = readFrames(
      pending,
      (text) => {
        if (peer.host) {
          // Addressed, because several guests share this one socket.
          let envelope;
          try {
            envelope = JSON.parse(text);
          } catch {
            return;
          }
          if (envelope === null || typeof envelope !== 'object') return;
          const out = frame(OPCODE.text, String(envelope.d ?? ''));
          for (const target of peers) {
            if (target === peer) continue;
            if (envelope.t === '*' || envelope.t === target.id) target.socket.write(out);
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
});

server.listen(port, () => {
  console.log(`[relay] listening on ws://localhost:${port}`);
  console.log('[relay] first tab in a room hosts; the rest join it');
});
