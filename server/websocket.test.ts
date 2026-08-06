/**
 * The frame parser, which until now was protected by nothing.
 *
 * It was verified once by hand against a real browser and then left alone
 * inside `relay.mjs` while the game grew around it. That was survivable while
 * there was one server; there are two now, and the parser is the piece both of
 * them stand on.
 *
 * Almost every test here is about a boundary, because boundaries are the whole
 * difficulty of RFC 6455. The length is encoded three different ways depending
 * on how big it is, TCP delivers halves and pairs of frames rather than
 * messages, and a browser masks everything it sends. Get any one of those wrong
 * and you have a server that works perfectly on localhost with short messages —
 * which is to say, one that passes every casual test and fails the moment
 * somebody builds a big enough fort.
 */

import { describe, it, expect } from 'vitest';
import { OPCODE, MAX_FRAME, frame, maskedFrame, readFrames } from './websocket.ts';

/** Read every message out of a buffer, returning them and whatever is left. */
function readAll(buffer: Buffer): { messages: string[]; rest: Buffer; closed: boolean } {
  const messages: string[] = [];
  let closed = false;
  const rest = readFrames(buffer, (m) => messages.push(m), () => { closed = true; });
  return { messages, rest, closed };
}

describe('frame lengths', () => {
  // The three encodings, and the two places they change over. 125 is the last
  // length that fits in the second byte; 126 is the first that needs the 16-bit
  // extension; 65535 is the last that fits in it and 65536 the first that needs
  // 64 bits. An implementation that is wrong by one at any of these looks
  // completely healthy until a message happens to land on it.
  for (const length of [0, 1, 125, 126, 127, 65535, 65536, 70_000]) {
    it(`round-trips a ${length}-byte message`, () => {
      const text = 'x'.repeat(length);
      const { messages, rest, closed } = readAll(frame(OPCODE.text, text));
      expect(closed).toBe(false);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toHaveLength(length);
      expect(messages[0]).toBe(text);
      expect(rest).toHaveLength(0);
    });
  }

  it('uses the shortest header that fits, so the boundary is where it claims', () => {
    // Checked on the bytes rather than only through a round trip, because a
    // parser and a builder that are wrong in the same direction agree with each
    // other perfectly and with nobody else.
    expect(frame(OPCODE.text, 'x'.repeat(125))).toHaveLength(2 + 125);
    expect(frame(OPCODE.text, 'x'.repeat(126))).toHaveLength(4 + 126);
    expect(frame(OPCODE.text, 'x'.repeat(65535))).toHaveLength(4 + 65535);
    expect(frame(OPCODE.text, 'x'.repeat(65536))).toHaveLength(10 + 65536);
  });

  it('measures in bytes and not in characters', () => {
    // A JSON payload of names can carry anything somebody typed. Measuring an
    // emoji as one byte writes a header that disagrees with the body, and every
    // frame after it in the stream is then read at the wrong offset — one
    // multi-byte character silently corrupts the rest of the connection.
    const text = 'mia 🎈 café';
    const bytes = Buffer.byteLength(text, 'utf8');
    expect(bytes).toBeGreaterThan(text.length);
    const built = frame(OPCODE.text, text);
    expect(built).toHaveLength(2 + bytes);

    const { messages } = readAll(Buffer.concat([built, frame(OPCODE.text, 'after')]));
    expect(messages).toEqual([text, 'after']);
  });
});

describe('what TCP actually delivers', () => {
  it('reads several frames out of one chunk', () => {
    const buffer = Buffer.concat([
      frame(OPCODE.text, 'one'),
      frame(OPCODE.text, 'two'),
      frame(OPCODE.text, 'three'),
    ]);
    const { messages, rest } = readAll(buffer);
    expect(messages).toEqual(['one', 'two', 'three']);
    expect(rest).toHaveLength(0);
  });

  it('keeps a half-arrived frame for next time, at every split point', () => {
    // The failure this prevents is the classic one: treating a read as a
    // message. It works on localhost, where a small frame almost always arrives
    // whole, and falls apart over a real network.
    const whole = Buffer.concat([
      frame(OPCODE.text, 'hello'),
      frame(OPCODE.text, 'x'.repeat(300)),
    ]);

    for (let split = 0; split < whole.length; split++) {
      const first = readAll(whole.subarray(0, split));
      const carried = Buffer.concat([first.rest, whole.subarray(split)]);
      const second = readAll(carried);
      expect(
        [...first.messages, ...second.messages],
        `split at ${split} lost or duplicated a message`,
      ).toEqual(['hello', 'x'.repeat(300)]);
    }
  });

  it('returns an empty remainder when everything was consumed', () => {
    const { rest } = readAll(frame(OPCODE.text, 'done'));
    expect(rest).toHaveLength(0);
  });

  it('holds on to a header too short to read at all', () => {
    const { messages, rest } = readAll(Buffer.from([0x81]));
    expect(messages).toEqual([]);
    expect(rest).toHaveLength(1);
  });
});

describe('masking', () => {
  it('unmasks what a browser sends', () => {
    // Every frame from a browser is masked; a server that ignored the mask bit
    // would deliver scrambled bytes and nothing would say why.
    const { messages } = readAll(maskedFrame(OPCODE.text, 'from a browser'));
    expect(messages).toEqual(['from a browser']);
  });

  it('unmasks a long one, where the key sits after a longer header', () => {
    const text = 'y'.repeat(70_000);
    const { messages } = readAll(maskedFrame(OPCODE.text, text));
    expect(messages).toEqual([text]);
  });

  it('leaves the caller\'s buffer exactly as it found it', () => {
    // The mask is undone by xor, so the obvious implementation does it in place
    // and mutates whatever it was handed.
    //
    // Worth being precise about why that matters, because the obvious reason is
    // wrong: unmasking frame one touches only frame one's bytes, so it cannot
    // corrupt a frame it has not read yet, and a test built on that idea passes
    // against both versions. What it really costs is the caller's ability to
    // keep the bytes — to log the raw stream, to hash it, to hand the same
    // chunk to a second reader. This is the assertion that pins it.
    const buffer = Buffer.concat([
      maskedFrame(OPCODE.text, 'first'),
      maskedFrame(OPCODE.text, 'second'),
    ]);
    const untouched = Buffer.from(buffer);

    const { messages } = readAll(buffer);
    expect(messages).toEqual(['first', 'second']);
    expect(buffer.equals(untouched), 'the parser rewrote the buffer it was given').toBe(true);
  });

  it('leaves the caller a remainder it can safely reuse', () => {
    const partial = maskedFrame(OPCODE.text, 'later');
    const buffer = Buffer.concat([maskedFrame(OPCODE.text, 'now'), partial.subarray(0, 3)]);
    const { messages, rest } = readAll(buffer);
    expect(messages).toEqual(['now']);
    const finished = readAll(Buffer.concat([rest, partial.subarray(3)]));
    expect(finished.messages).toEqual(['later']);
  });
});

describe('refusing what should be refused', () => {
  it('closes on a frame larger than the cap rather than buffering it', () => {
    // Anything this big is a bug or somebody probing, and both are better
    // refused than held in memory on a server several people are waiting in.
    const header = Buffer.alloc(10);
    header[0] = 0x80 | OPCODE.text;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(MAX_FRAME + 1), 2);
    const { closed, messages } = readAll(header);
    expect(closed).toBe(true);
    expect(messages).toEqual([]);
  });

  it('closes on an absurd 64-bit length without trying to allocate it', () => {
    // Compared as a BigInt before narrowing. Through Number() this is a value
    // the length check would still catch, but only by accident.
    const header = Buffer.alloc(10);
    header[0] = 0x80 | OPCODE.text;
    header[1] = 127;
    header.writeBigUInt64BE(2n ** 63n, 2);
    expect(readAll(header).closed).toBe(true);
  });

  it('has the cap above everything a 16-bit length can express', () => {
    // Not a behaviour test — a statement about which guard does the work, and
    // it is here because the first version of this file tried to test the other
    // one and could not fail.
    //
    // There are two length checks. The BigInt comparison on the 64-bit path is
    // the one that ever fires; the `length > MAX_FRAME` below it is unreachable
    // while the cap sits above 65535, because that is the largest number a
    // 16-bit extension can hold. Lower the cap under 65535 and it comes alive,
    // which is exactly the change somebody would make without re-reading the
    // parser — so this fails at that moment and says so.
    expect(
      MAX_FRAME,
      'the second length check is now reachable and has no test of its own',
    ).toBeGreaterThan(65535);
  });

  it('stops at a close frame and reports it', () => {
    const buffer = Buffer.concat([
      frame(OPCODE.text, 'goodbye'),
      frame(OPCODE.close, ''),
      frame(OPCODE.text, 'never read'),
    ]);
    const { messages, closed } = readAll(buffer);
    expect(messages).toEqual(['goodbye']);
    expect(closed).toBe(true);
  });

  it('ignores ping and binary rather than delivering them as text', () => {
    const buffer = Buffer.concat([
      frame(OPCODE.ping, 'hi'),
      frame(OPCODE.binary, 'bytes'),
      frame(OPCODE.text, 'the real one'),
    ]);
    expect(readAll(buffer).messages).toEqual(['the real one']);
  });
});
