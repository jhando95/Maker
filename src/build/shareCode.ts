/**
 * Blueprint share codes: a structure as a string you can send to a friend.
 *
 * The friends list carries presence and parties carry people, but the thing a
 * builder actually wants to hand somebody is *the fort* — and a blueprint is
 * already a small list of exact, quantized placements, which is to say it is
 * already almost a string. This encodes one as text that survives a chat
 * message: a version prefix, then base64url over a fixed binary layout, with a
 * checksum so a mangled paste is refused rather than half-stamped.
 *
 * ## Layout, after the `MKR1.` prefix
 *
 * ```
 * u8         part count (1..MAX_BLUEPRINT_PARTS)
 * u8         name length in bytes (0..MAX_NAME_BYTES)
 * bytes      name, UTF-8
 * per part (16 bytes):
 *   u8       kind          u8   colorway
 *   i16      x, y, z       millimetres
 *   i16      qx, qy, qz, qw    quaternion x 10^4
 * u32        FNV-1a over everything above
 * ```
 *
 * Millimetres in an i16 give ±32m, which is over four times the span any
 * legal blueprint can reach; 10^-4 on the quaternion is the same step the
 * placement path already quantizes to, so a round trip is *exact* — the
 * decoded parts are the encoded parts, not near neighbours of them.
 *
 * ## Decode trusts nothing
 *
 * A share code arrives from outside the program: a chat paste, a forum post, a
 * friend's typo. Every reject path returns null rather than throwing, and the
 * caller offers "that is not a blueprint code" rather than a stack. The
 * checksum catches corruption; the field checks catch *forgery* — a code that
 * checksums correctly but names a part kind that does not exist, or a
 * quaternion that is not a rotation, is refused just the same.
 */

import { PART_KINDS, COLORWAYS } from './partKit.ts';
import { MAX_BLUEPRINT_PARTS, cleanBlueprintName } from './blueprint.ts';
import type { PlacementRecord } from './buildSystem.ts';

export const SHARE_PREFIX = 'MKR1.';

/** UTF-8 bytes, not characters: a name of 24 emoji still has to fit. */
const MAX_NAME_BYTES = 96;

/** ±32.7m in millimetres; anything outside is not a legal blueprint offset. */
const MAX_MM = 32767;

const PART_BYTES = 16;

/** FNV-1a, 32-bit. Small, dependency-free, and plenty against line noise. */
function fnv1a(bytes: Uint8Array, end: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < end; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64_BACK = new Map([...B64].map((c, i) => [c, i]));

/** base64url without padding — the code has to survive a chat box verbatim. */
function toBase64url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    out += B64[a >> 2]! + B64[((a & 3) << 4) | (b >> 4)]!;
    if (i + 1 < bytes.length) out += B64[((b & 15) << 2) | (c >> 6)]!;
    if (i + 2 < bytes.length) out += B64[c & 63]!;
  }
  return out;
}

function fromBase64url(text: string): Uint8Array | null {
  // Length 1 mod 4 encodes a partial byte, which no whole payload produces.
  if (text.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let w = 0;
  for (const ch of text) {
    const v = B64_BACK.get(ch);
    if (v === undefined) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[w++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

/** Round-to-nearest at the wire's own steps, so encode(decode(x)) is x. */
const mm = (v: number): number => Math.round(v * 1000);
const q4 = (v: number): number => Math.round(v * 10000);

/**
 * A blueprint as a pasteable code.
 *
 * Throws rather than returning null: the only caller feeds it blueprints that
 * already passed the placement path, so an out-of-range coordinate here is a
 * program error, not user input to be soft about.
 */
export function encodeBlueprint(name: string, parts: readonly PlacementRecord[]): string {
  if (parts.length === 0 || parts.length > MAX_BLUEPRINT_PARTS) {
    throw new RangeError(`cannot encode ${parts.length} parts`);
  }
  let nameBytes = new TextEncoder().encode(name);
  if (nameBytes.length > MAX_NAME_BYTES) nameBytes = nameBytes.slice(0, MAX_NAME_BYTES);

  const bytes = new Uint8Array(2 + nameBytes.length + parts.length * PART_BYTES + 4);
  const view = new DataView(bytes.buffer);
  bytes[0] = parts.length;
  bytes[1] = nameBytes.length;
  bytes.set(nameBytes, 2);

  let at = 2 + nameBytes.length;
  for (const p of parts) {
    if (p.kind < 0 || p.kind >= PART_KINDS.length) throw new RangeError(`bad kind ${p.kind}`);
    const x = mm(p.x); const y = mm(p.y); const z = mm(p.z);
    if (Math.abs(x) > MAX_MM || Math.abs(y) > MAX_MM || Math.abs(z) > MAX_MM) {
      throw new RangeError(`part out of range at (${p.x}, ${p.y}, ${p.z})`);
    }
    if (p.colorway < 0 || p.colorway >= COLORWAYS.length) {
      throw new RangeError(`bad colorway ${p.colorway}`);
    }
    bytes[at] = p.kind;
    bytes[at + 1] = p.colorway;
    view.setInt16(at + 2, x); view.setInt16(at + 4, y); view.setInt16(at + 6, z);
    view.setInt16(at + 8, q4(p.qx)); view.setInt16(at + 10, q4(p.qy));
    view.setInt16(at + 12, q4(p.qz)); view.setInt16(at + 14, q4(p.qw));
    at += PART_BYTES;
  }
  view.setUint32(at, fnv1a(bytes, at));
  return SHARE_PREFIX + toBase64url(bytes);
}

export interface SharedBlueprint {
  name: string;
  parts: PlacementRecord[];
}

// ── The whole yard ───────────────────────────────────────────────────────────
//
// A second codec rather than a big blueprint, because the two differ in every
// dimension that matters. A blueprint is a structure's parts *relative to its
// own base*, named, capped small, and stamped somewhere; a yard is absolute,
// nameless, and replaces the lot wholesale on import. The positions need the
// room to prove it: the field runs to ±58m and building to 40m up, which
// overflows the blueprint's i16 millimetres — so a yard part carries i32
// positions and costs 22 bytes. The prefixes differ in their fourth character,
// so neither decoder can be fed the other's code by accident: each refuses
// the other at the first check, with the same "not one of mine" null.

export const YARD_PREFIX = 'MKRY1.';

/**
 * Parts a yard code will carry. Far above any yard the game produces — the
 * lumber economy and the lot make a thousand-part yard an achievement — and
 * low enough that a forged count cannot ask the decoder for a gigabyte.
 */
export const YARD_PARTS_MAX = 2000;

const YARD_PART_BYTES = 22;

/** The field plus a margin; a checksummed code placing a fort on the moon is
 *  still a forgery. Mirrors `PLAY_HALF` and `BUILD_CEILING` without importing
 *  them — the wire format must not move because the map grew. */
const YARD_MAX_XZ_MM = 64_000;
const YARD_MIN_Y_MM = -2_000;
const YARD_MAX_Y_MM = 44_000;

/**
 * The yard as a pasteable code: `MKRY1.` then base64url over
 * `u16 count, count × 22-byte parts, u32 FNV-1a`.
 *
 * Zero parts is legal — a fresh lawn is a thing somebody can want to send.
 * Throws on anything else out of range, because the only caller feeds it the
 * live store, whose contents already passed the placement path.
 */
export function encodeYard(parts: readonly PlacementRecord[]): string {
  if (parts.length > YARD_PARTS_MAX) {
    throw new RangeError(`cannot encode a ${parts.length}-part yard`);
  }
  const bytes = new Uint8Array(2 + parts.length * YARD_PART_BYTES + 4);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, parts.length);

  let at = 2;
  for (const p of parts) {
    if (p.kind < 0 || p.kind >= PART_KINDS.length) throw new RangeError(`bad kind ${p.kind}`);
    if (p.colorway < 0 || p.colorway >= COLORWAYS.length) {
      throw new RangeError(`bad colorway ${p.colorway}`);
    }
    const x = mm(p.x); const y = mm(p.y); const z = mm(p.z);
    if (Math.abs(x) > YARD_MAX_XZ_MM || Math.abs(z) > YARD_MAX_XZ_MM
      || y < YARD_MIN_Y_MM || y > YARD_MAX_Y_MM) {
      throw new RangeError(`part outside the field at (${p.x}, ${p.y}, ${p.z})`);
    }
    bytes[at] = p.kind;
    bytes[at + 1] = p.colorway;
    view.setInt32(at + 2, x); view.setInt32(at + 6, y); view.setInt32(at + 10, z);
    view.setInt16(at + 14, q4(p.qx)); view.setInt16(at + 16, q4(p.qy));
    view.setInt16(at + 18, q4(p.qz)); view.setInt16(at + 20, q4(p.qw));
    at += YARD_PART_BYTES;
  }
  view.setUint32(at, fnv1a(bytes, at));
  return YARD_PREFIX + toBase64url(bytes);
}

/**
 * A pasted yard, decoded — or null, with no exceptions and no partial yards.
 *
 * The same trust-nothing rules as a blueprint, plus one of its own: every
 * position must be inside the world the game actually has. A blueprint's
 * offsets are checked against a structure's largest legal span; a yard's are
 * absolute, so the bound is the field itself.
 */
export function decodeYard(code: string): PlacementRecord[] | null {
  const trimmed = code.trim();
  if (!trimmed.startsWith(YARD_PREFIX)) return null;
  const bytes = fromBase64url(trimmed.slice(YARD_PREFIX.length));
  if (bytes === null || bytes.length < 2 + 4) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(0);
  if (count > YARD_PARTS_MAX) return null;
  const expected = 2 + count * YARD_PART_BYTES + 4;
  if (bytes.length !== expected) return null;
  if (view.getUint32(expected - 4) !== fnv1a(bytes, expected - 4)) return null;

  const parts: PlacementRecord[] = [];
  let at = 2;
  for (let i = 0; i < count; i++) {
    const kind = bytes[at]!;
    const colorway = bytes[at + 1]!;
    if (kind >= PART_KINDS.length) return null;
    if (colorway >= COLORWAYS.length) return null;
    const xMm = view.getInt32(at + 2);
    const yMm = view.getInt32(at + 6);
    const zMm = view.getInt32(at + 10);
    if (Math.abs(xMm) > YARD_MAX_XZ_MM || Math.abs(zMm) > YARD_MAX_XZ_MM
      || yMm < YARD_MIN_Y_MM || yMm > YARD_MAX_Y_MM) return null;
    const qx = view.getInt16(at + 14) * 1e-4;
    const qy = view.getInt16(at + 16) * 1e-4;
    const qz = view.getInt16(at + 18) * 1e-4;
    const qw = view.getInt16(at + 20) * 1e-4;
    const len2 = qx * qx + qy * qy + qz * qz + qw * qw;
    if (len2 < 0.98 || len2 > 1.02) return null;
    parts.push({
      kind, colorway,
      // Multiplied by the step, not divided by its reciprocal — see the
      // blueprint decoder for the two doubles that taught this file why.
      x: xMm * 0.001, y: yMm * 0.001, z: zMm * 0.001,
      qx, qy, qz, qw,
    });
    at += YARD_PART_BYTES;
  }
  return parts;
}

/**
 * The paste, decoded — or null, with no exceptions and no partial results.
 */
export function decodeBlueprint(code: string): SharedBlueprint | null {
  const trimmed = code.trim();
  if (!trimmed.startsWith(SHARE_PREFIX)) return null;
  const bytes = fromBase64url(trimmed.slice(SHARE_PREFIX.length));
  if (bytes === null || bytes.length < 2 + PART_BYTES + 4) return null;

  const count = bytes[0]!;
  const nameLen = bytes[1]!;
  if (count < 1 || count > MAX_BLUEPRINT_PARTS) return null;
  if (nameLen > MAX_NAME_BYTES) return null;
  const expected = 2 + nameLen + count * PART_BYTES + 4;
  if (bytes.length !== expected) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sum = view.getUint32(expected - 4);
  if (sum !== fnv1a(bytes, expected - 4)) return null;

  let name: string;
  try {
    name = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(2, 2 + nameLen));
  } catch {
    return null;
  }

  const parts: PlacementRecord[] = [];
  let at = 2 + nameLen;
  for (let i = 0; i < count; i++) {
    const kind = bytes[at]!;
    const colorway = bytes[at + 1]!;
    if (kind >= PART_KINDS.length) return null;
    if (colorway >= COLORWAYS.length) return null;
    // Multiplied by the step rather than divided by its reciprocal, and not as
    // a style point: the game's quantizer computes `round(v/step) * step`, and
    // 300 * 0.001 and 300 / 1000 are *different doubles* (the former is
    // 0.30000000000000004). Divide here and every third coordinate comes back
    // a few ulps off the record that went in — same fort, but no longer
    // equal to it, which save files and world hashes are entitled to expect.
    const qx = view.getInt16(at + 8) * 1e-4;
    const qy = view.getInt16(at + 10) * 1e-4;
    const qz = view.getInt16(at + 12) * 1e-4;
    const qw = view.getInt16(at + 14) * 1e-4;
    // A rotation has unit length. The wire's quantization moves it by parts in
    // ten thousand, so anything outside a few percent is not quantization —
    // it is a forged or corrupted record dressed as one.
    const len2 = qx * qx + qy * qy + qz * qz + qw * qw;
    if (len2 < 0.98 || len2 > 1.02) return null;
    parts.push({
      kind, colorway,
      x: view.getInt16(at + 2) * 0.001,
      y: view.getInt16(at + 4) * 0.001,
      z: view.getInt16(at + 6) * 0.001,
      qx, qy, qz, qw,
    });
    at += PART_BYTES;
  }

  return { name: cleanBlueprintName(name) ?? 'Shared', parts };
}
