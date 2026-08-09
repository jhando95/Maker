/**
 * A number that says whether two machines are looking at the same world.
 *
 * Every other check in this session is about a moment — where somebody is, what
 * they pressed. The parts are different: they are the *world*, they are supposed
 * to be identical on every machine, and when they are not the symptom is the one
 * this project has been afraid of since the netcode was written. A guest
 * standing on a wall the host cannot see is not a graphical glitch. It is two
 * people playing different games.
 *
 * Nothing was watching for it. A `built` broadcast is sent once and never
 * repeated, so a single dropped packet leaves a guest permanently missing a
 * plank, silently, for the rest of the round — and until this file there was no
 * way for either side to find out.
 *
 * ## Why it is order-independent
 *
 * The two sides do not agree on part *ids*. The host's are the order it placed
 * them; a guest's are the order they arrived, which a lossy network reorders and
 * a late joiner gets wholesale from a snapshot of the middle of the game. So the
 * hash cannot depend on order, and combines with addition rather than by mixing
 * one part into the next. That makes it a hash of the *set* of parts, which is
 * exactly the question being asked.
 *
 * The cost of a commutative combine is that two different worlds can collide
 * more easily than under a real digest. This is a smoke alarm, not a signature:
 * a collision means one desync goes unreported for a second until the next part
 * moves, and nothing is trusted on the strength of a match.
 *
 * ## Why it hashes the serialized form
 *
 * `serialize()` quantises positions to a millimetre and rotations to 1e-4, and
 * it is the form both sides were built from — the host sends records, the guest
 * applies them. Hashing what is in the physics store instead would compare two
 * numbers that went through different arithmetic to get there and disagree in
 * the last bit for reasons that are not a desync.
 */

import type { PlacementRecord } from './buildSystem.ts';

/** Millimetres, matching what `serialize` quantises to. */
const POS = 1000;
/** Matching the 1e-4 `serialize` quantises rotations to. */
const ROT = 10000;

function mix(h: number, value: number): number {
  h ^= value | 0;
  h = Math.imul(h, 0x01000193);
  return h >>> 0;
}

/** One part's contribution, which is a hash of everything that identifies it. */
export function hashPart(r: PlacementRecord): number {
  let h = 0x811c9dc5;
  h = mix(h, r.kind);
  h = mix(h, r.colorway);
  h = mix(h, Math.round(r.x * POS));
  h = mix(h, Math.round(r.y * POS));
  h = mix(h, Math.round(r.z * POS));
  h = mix(h, Math.round(r.qx * ROT));
  h = mix(h, Math.round(r.qy * ROT));
  h = mix(h, Math.round(r.qz * ROT));
  h = mix(h, Math.round(r.qw * ROT));
  return h;
}

/**
 * The whole world as one number.
 *
 * The count goes in as well as the sum. Without it, a world whose part hashes
 * happen to add up to zero is the same number as an empty one — and "nothing
 * has been built" is the state a guest is most likely to be wrongly in, so that
 * is the one collision worth spending an instruction to avoid.
 *
 * **This is the one line here no test can falsify**, and it is written up in
 * `docs/verification.md` rather than left to look verified. Falsifying it needs
 * two parts whose hashes sum to zero mod 2^32; two million single-part variants
 * produced no such pair, because `mix` is a bijection over a contiguous range
 * and its outputs are not birthday-random. It stays because it costs one
 * multiply a second and closes a real hole, and it is labelled because a guard
 * nobody can break is a guard nobody can check.
 *
 * An earlier version also nudged a part hashing to zero up to one, on the same
 * reasoning. That one was deleted: with the count mixed in, a part that hashes
 * to zero still changes the world hash, because it still changes the count.
 */
export function hashWorld(records: Iterable<PlacementRecord>): number {
  let sum = 0;
  let count = 0;
  for (const record of records) {
    sum = (sum + hashPart(record)) >>> 0;
    count++;
  }
  return (mix(sum, count) ^ sum) >>> 0;
}
