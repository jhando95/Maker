/**
 * The parts of RFC 6455 a game server needs, and nothing else.
 *
 * This used to live inside `relay.mjs`, at module scope, alongside the routing.
 * It was moved out for a reason that arrived with the lobby: there are two
 * servers now, and two implementations of frame parsing is the kind of
 * duplication that stays in agreement right up until it does not — at which
 * point one endpoint mysteriously drops long messages and the other does not.
 *
 * The move also gave it the test it never had. The framing was verified once, by
 * hand, against a real browser; nothing in the suite covered it, so the length
 * boundaries below — the three cases at 125, 126 and 65536 bytes that every
 * naive implementation gets wrong — were being protected by nothing.
 *
 * ## What is deliberately not implemented
 *
 * Fragmented *outgoing* frames, and `permessage-deflate`. A browser needs
 * neither from a server that only relays small text messages, and a compression
 * extension is a large amount of code to negotiate for traffic that is already
 * a few hundred bytes.
 *
 * Incoming fragmentation is not handled either, and that is worth stating
 * plainly rather than leaving as an omission: a browser sends a single
 * unfragmented frame for a `send()` of any size this game produces. A client
 * that fragmented would have its continuation frames ignored.
 */

import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

/** The constant RFC 6455 requires in the handshake. Not a secret. */
const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const OPCODE = {
  text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa,
} as const;

/**
 * Cap on one message.
 *
 * A snapshot of eight people is a few hundred bytes, and the largest thing the
 * lobby ever sends is a friends list. Anything approaching this is either a bug
 * or somebody probing, and both are better refused than buffered.
 */
export const MAX_FRAME = 1 << 20;

/**
 * Complete the handshake, or destroy the socket.
 *
 * Returns the socket on success and null on failure, so a caller can bail with
 * a single check rather than remembering to test for a header it never read.
 */
export function acceptUpgrade(request: IncomingMessage, socket: Duplex): Duplex | null {
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

/**
 * Build one unfragmented frame. Server frames are never masked.
 *
 * The three length encodings are the whole of the interesting part. Under 126
 * the length rides in the second byte; up to 65535 it is a 16-bit extension;
 * beyond that a 64-bit one. Getting the boundary wrong by one produces a server
 * that works until somebody builds a big enough fort.
 */
export function frame(opcode: number, payload: string): Buffer {
  const body = Buffer.from(payload, 'utf8');
  const length = body.length;
  let header: Buffer;
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
 * Returns what is left over, because TCP has no idea what a message is: one read
 * can carry half a frame or three of them, and treating a read as a message is
 * the classic way to write a relay that works on localhost and nowhere else.
 */
export function readFrames(
  buffer: Buffer,
  onMessage: (text: string) => void,
  onClose: () => void,
): Buffer {
  let offset = 0;
  for (;;) {
    if (buffer.length - offset < 2) break;
    const first = buffer[offset]!;
    const second = buffer[offset + 1]!;
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
      // Compared as a BigInt before narrowing. A length near 2^64 would survive
      // Number() as Infinity and the check below would still catch it, but only
      // by luck; comparing first is the version that is correct on purpose.
      if (big > BigInt(MAX_FRAME)) { onClose(); return buffer.subarray(buffer.length); }
      length = Number(big);
      cursor += 8;
    }
    if (length > MAX_FRAME) { onClose(); return buffer.subarray(buffer.length); }

    let mask: Buffer | null = null;
    if (masked) {
      if (buffer.length - cursor < 4) break;
      mask = buffer.subarray(cursor, cursor + 4);
      cursor += 4;
    }
    if (buffer.length - cursor < length) break;

    // Copied rather than referenced, because the mask is undone in place and the
    // caller's buffer is about to be reused for the next read.
    const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
    if (mask !== null) {
      for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i & 3]!;
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

/** A client frame, for tests: same as `frame` but masked, as a browser sends. */
export function maskedFrame(opcode: number, payload: string, mask = [0x12, 0x34, 0x56, 0x78]): Buffer {
  const body = Buffer.from(payload, 'utf8');
  const length = body.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode;
  const key = Buffer.from(mask);
  const masked = Buffer.from(body);
  for (let i = 0; i < masked.length; i++) masked[i]! ^= key[i & 3]!;
  return Buffer.concat([header, key, masked]);
}
