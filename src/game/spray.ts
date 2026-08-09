/**
 * A can of spray paint, and the marks it leaves on the garden.
 *
 * Everything else in this project is a rule about winning. This is not: it
 * cannot hit anybody, block anybody, hold anybody up or take anything away, and
 * a round plays out exactly the same whether or not a single tag exists. It is
 * here because a game four friends play in a back garden is partly about
 * leaving something behind — a name on the fence, something rude on somebody
 * else's fort — and that is a different kind of fun from any of the five modes,
 * and cheaper than all of them.
 *
 * ## Marks, not a canvas
 *
 * The same argument `markShapes.ts` already makes for painting a shirt, and it
 * applies harder here. A brush wants a texture per surface; there is no texture
 * pipeline in this project on purpose, and the character marks are flat
 * instanced polygons for exactly that reason. A tag reuses that library
 * unchanged — one instanced mesh per shape, and a shape nobody has sprayed
 * costs nothing at all. Eleven shapes and eight colours is 88 distinguishable
 * tags, which is plenty to sign your name with.
 *
 * ## Why the caps are here rather than in a policy document
 *
 * A shared world where anybody can add unbounded decoration is a griefing tool
 * unless the limits are part of the mechanic. Two, and they are deliberately
 * *self-limiting* rather than blocking:
 *
 * - **Per player.** Spray your `PER_PLAYER` first, and the next one takes your
 *   own oldest. Nobody is ever told "no more paint" — you simply cannot occupy
 *   more of the garden than your share, however long you stand there.
 * - **Per world.** A hard ceiling on the total, so a full lobby cannot make the
 *   renderer the reason the round is unplayable.
 *
 * Eviction is oldest-first and by the sprayer, which means the punishment for
 * spamming falls on the spammer. A rule that took *somebody else's* oldest tag
 * would make spraying an attack, and this is the one system here that is not
 * allowed to be one.
 *
 * ## What it is stuck to
 *
 * A tag records the part it landed on, or −1 for the map. That is not
 * bookkeeping — with the support rule in, parts vanish in groups, and a tag
 * left behind by the plank it was painted on is a mark hanging in mid-air. They
 * go when it goes.
 */

import { MARK_SHAPES, type MarkShape } from './appearance.ts';

/** Every mark except `none`, which is the absence of one. */
export const TAG_SHAPES: readonly MarkShape[] =
  MARK_SHAPES.filter((s) => s !== 'none');

/**
 * Spray colours.
 *
 * Bright and flat, because that is what a cel-shaded world draws well, and
 * chosen to stay apart from each other on a fence, on grass and on bare wood —
 * the three things anybody is going to paint. No white and no black: one
 * disappears on the house and the other reads as a hole.
 */
export const TAG_COLORS: readonly number[] = [
  0xff4f6a, 0xff9f40, 0xffe066, 0x7ddf64,
  0x4fc3e8, 0x6e7bff, 0xc86bff, 0xff7bd0,
];

/** How many any one person may have up at once. */
export const PER_PLAYER = 12;

/** How many the world will hold, whoever put them there. */
export const WORLD_LIMIT = 90;

/** Seconds between sprays, so holding the button is a line rather than a blob. */
export const SPRAY_INTERVAL = 0.18;

/** How far a can carries. Shorter than build reach: it is a can, not a rifle. */
export const SPRAY_RANGE = 3.4;

/** Smallest and largest a tag can be, in metres across. */
export const MIN_SIZE = 0.28;
export const MAX_SIZE = 0.95;

/**
 * A mark on a surface. Plain data, quantised, and this is the wire format.
 *
 * Quantised for the same reason a placement is: two machines have to agree
 * exactly about where somebody's name went, and a float that survived a round
 * trip through JSON with its last bit different is a mark that shimmers.
 */
export interface TagRecord {
  /** Index into `TAG_SHAPES`. */
  shape: number;
  /** Index into `TAG_COLORS`. */
  color: number;
  /** Metres across. */
  size: number;
  /** Turn about the surface normal, radians. */
  spin: number;
  x: number; y: number; z: number;
  /** The surface normal it was sprayed against; the mark lies in that plane. */
  nx: number; ny: number; nz: number;
  /** Who sprayed it, for the per-player cap. */
  by: number;
  /** The part it is stuck to, or −1 for the map itself. */
  part: number;
}

function quantize(v: number, step: number): number {
  return Math.round(v / step) * step;
}

function whole(v: unknown, limit: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : 0;
  return ((n % limit) + limit) % limit;
}

function real(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * Anything at all in, a valid tag out.
 *
 * Total, like `clampAppearance`, and for the same reason: this arrives from a
 * client, and the host repeats what it received to everybody else. A shape
 * index of 4,000 or a size of a hundred metres has to become a legal tag rather
 * than a thrown exception or a wall of paint on every screen in the lobby.
 */
export function clampTag(raw: unknown, by = 0): TagRecord {
  const t = (raw ?? {}) as Partial<TagRecord>;
  const nx = real(t.nx);
  const ny = real(t.ny, 1);
  const nz = real(t.nz);
  const length = Math.hypot(nx, ny, nz);
  // A zero normal is not a direction. Straight up is the one that cannot look
  // like a bug: a mark on the ground.
  const unit = length > 1e-6
    ? { x: nx / length, y: ny / length, z: nz / length }
    : { x: 0, y: 1, z: 0 };

  // Quantised first and clamped second, which is the order that keeps the
  // promise. `Math.round(v / 0.001) * 0.001` is not exact — 0.95 comes back as
  // 0.9500000000000001 — so clamping first lets the rounding push a value a
  // hair past the bound the range says it has, and a test comparing against
  // `MAX_SIZE` catches it. The range is the promise; the quantisation is an
  // implementation detail that must not be able to break it.
  const size = Math.min(MAX_SIZE, Math.max(MIN_SIZE, quantize(real(t.size, MIN_SIZE), 0.001)));
  const part = typeof t.part === 'number' && Number.isFinite(t.part) && t.part >= 0
    ? Math.floor(t.part)
    : -1;

  return {
    shape: whole(t.shape, TAG_SHAPES.length),
    color: whole(t.color, TAG_COLORS.length),
    size,
    spin: quantize(((real(t.spin) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2), 1e-4),
    x: quantize(real(t.x), 0.001),
    y: quantize(real(t.y), 0.001),
    z: quantize(real(t.z), 0.001),
    nx: quantize(unit.x, 1e-4),
    ny: quantize(unit.y, 1e-4),
    nz: quantize(unit.z, 1e-4),
    by: typeof by === 'number' && Number.isFinite(by) ? Math.floor(by) : 0,
    part,
  };
}

/**
 * Add one, and say what fell off to make room.
 *
 * Returns a **new** list rather than mutating, because the host sends the
 * removals as well as the addition and wants them named — and because a
 * function that both edits an array and reports on it is one nobody reads
 * twice.
 */
export function addTag(
  existing: readonly TagRecord[],
  tag: TagRecord,
): { tags: TagRecord[]; dropped: TagRecord[] } {
  const dropped: TagRecord[] = [];
  const tags = existing.slice();
  tags.push(tag);

  // Your own oldest first. A rule that took somebody else's would turn a can of
  // paint into a weapon, and this is the one system here that must not be one.
  let mine = tags.reduce((n, t) => (t.by === tag.by ? n + 1 : n), 0);
  while (mine > PER_PLAYER) {
    const i = tags.findIndex((t) => t.by === tag.by);
    dropped.push(tags[i]!);
    tags.splice(i, 1);
    mine--;
  }
  while (tags.length > WORLD_LIMIT) {
    dropped.push(tags[0]!);
    tags.shift();
  }
  return { tags, dropped };
}

/**
 * Everything that has to come off when these parts do.
 *
 * With the support rule in, parts vanish in groups — take a leg out and a whole
 * tower goes. A tag left behind by the plank it was painted on is a mark
 * hanging in mid-air, which is the sort of thing that looks like a rendering
 * bug and is really a bookkeeping one.
 */
export function orphaned(
  tags: readonly TagRecord[],
  gone: ReadonlySet<number>,
): TagRecord[] {
  return tags.filter((t) => t.part >= 0 && gone.has(t.part));
}

/** Is this close enough to spray, and is there anything there to spray onto? */
export function inRange(distance: number, hitSomething: boolean): boolean {
  return hitSomething && distance >= 0 && distance <= SPRAY_RANGE;
}

/**
 * How far the mark sits off the surface it is on, in metres.
 *
 * Enough to clear z-fighting on a face two metres away and little enough that
 * it does not read as floating on one you are standing against. A millimetre is
 * not enough at this project's near plane; a centimetre is visible on a plank.
 */
export const TAG_LIFT = 0.004;
