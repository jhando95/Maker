/**
 * The floor is lava.
 *
 * The rules of the mode, as arithmetic, with no world and no renderer in them.
 * The mode object below this is the part that owns a timer and a roster; this
 * is the part that answers *what happens*, and it is separated for the same
 * reason the voice rules were: every failure here is silent. A course you can
 * finish by walking round the outside is not a course, a sink meter that never
 * empties is a mode nobody can play, and neither of them throws.
 *
 * ## What the yard already was
 *
 * Nothing in here places anything. The whole route is made of things the map
 * has had since the day it was built — a back deck, a treehouse with rungs up
 * its trunk, a rain barrel with a lid on it — and the mode's contribution is to
 * declare the grass between them out of bounds. That is the point of it. Four
 * modes have treated the lawn as the floor and the props as scenery; this one
 * inverts that, and every crate and hedge and fence rail in the garden becomes
 * level design without a single new prop being modelled.
 */

/**
 * How long you can stand on the grass before you are out.
 *
 * Not instant, and that is a real decision rather than a kindness. The honest
 * playground rule is that touching it is the end of it, but a landing that
 * clips a corner of lawn for one frame on the way through a gap reads as a bug
 * rather than as a mistake — you did the hard thing and the game said no. A
 * second and a half is long enough to hop back off something you overshot and
 * far too short to walk anywhere, which is the line that matters: you may
 * recover from a slip, you may not use the lawn as a shortcut.
 */
export const SINK_TIME = 1.5;

/**
 * How fast you climb back out once your feet are off it.
 *
 * Faster than you sink, so a course made of tight hops does not accumulate a
 * doom you cannot see coming. Two and a half times, measured off nothing but
 * how it plays: at parity a chain of near-misses kills you three jumps later
 * for a mistake you have already corrected.
 */
export const RECOVER_RATE = 2.5;

/** How close counts as touching a checkpoint. Generous on purpose — see below. */
export const TOUCH_RADIUS = 2.6;

/**
 * How long a round runs before it is called.
 *
 * A round that cannot end is a round nobody leaves. When it expires the winner
 * is whoever got furthest, which is why progress is a number rather than a
 * flag.
 */
export const ROUND_TIME = 300;

/** Seconds of stillness before the wood tops up, and how much arrives. */
export const REFILL_INTERVAL = 6;
export const REFILL_AMOUNT = 4;

/**
 * The plank budget you start with.
 *
 * Sized against the route rather than guessed: the longest crossing is about
 * thirty metres and a plank is one, but a player who bridges the whole thing in
 * a straight line has misunderstood the mode — the yard is full of things to
 * land on and the wood is for the gaps between them. Enough to be generous
 * about mistakes, not enough to ignore the garden.
 */
export const STARTING_LUMBER = 90;

/** A point on the course, in the order it has to be touched. */
export interface Checkpoint {
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * Is a body standing on the lawn?
 *
 * Answered from a downward ray rather than from a height, and the difference is
 * the whole feel of it. A height rule ("anything under knee level is lava")
 * is easier and wrong in both directions: it makes a low crate deadly and a
 * plank laid flat on the grass safe, when a plank laid flat on the grass is the
 * first move every player makes and a crate is the most obvious thing in the
 * garden to stand on.
 *
 * The collision world already separates the two — the ground plane is implicit
 * and everything else is a part with an id — so "did the ray hit the ground"
 * *is* the playground rule, exactly, with nothing approximated.
 *
 * @param groundHit whether a short ray from the feet landed on the ground plane
 * @param airborne  true while they are not standing on anything at all
 */
export function onLava(groundHit: boolean, airborne: boolean): boolean {
  // In the air you are neither safe nor sinking. A jump off a plank is not a
  // reprieve and it is not a death; it is a jump.
  return !airborne && groundHit;
}

/**
 * Advance somebody's sink, and say whether they have gone under.
 *
 * Returns the new depth in 0..1. The caller decides what 1 means, because
 * "out" is a rule about a round and this is a rule about a body.
 */
export function sink(depth: number, dt: number, standingOnLava: boolean): number {
  const rate = standingOnLava ? 1 / SINK_TIME : -RECOVER_RATE / SINK_TIME;
  return Math.min(1, Math.max(0, depth + rate * dt));
}

/**
 * How far round the course somebody has got, as a number that only goes up.
 *
 * Checkpoints cleared, plus how far they are between the last one and the next.
 * The fraction is what makes a timed-out round decidable: two players who both
 * cleared the treehouse are not tied, and the one halfway across the lawn is
 * ahead of the one still on the deck.
 *
 * Deliberately monotonic. A player who falls back to the start has not lost
 * progress they earned — the cost of falling is the time, which is already the
 * thing the mode is scored on, and taking the progress as well means a bad slip
 * near the end is unrecoverable in a way that makes people stop playing.
 */
export function progressOf(
  cleared: number, distanceToNext: number, legLength: number,
): number {
  if (cleared <= 0 && legLength <= 0) return 0;
  const leg = Math.max(legLength, 1e-6);
  const along = 1 - Math.min(1, Math.max(0, distanceToNext / leg));
  return cleared + along;
}

/**
 * Has this body reached the checkpoint it is looking for?
 *
 * A sphere, and a fat one. The alternative is a plate you have to land on,
 * which is a precision test on top of a route-finding test — and the route is
 * the interesting half. Two and a half metres means arriving on the treehouse
 * deck counts wherever on it you land, and swinging past on a plank a metre
 * below it counts too, which is a shot worth rewarding.
 */
export function touching(
  x: number, y: number, z: number, at: Checkpoint, radius = TOUCH_RADIUS,
): boolean {
  return Math.hypot(x - at.x, y - at.y, z - at.z) <= radius;
}

/**
 * Who won when the clock ran out.
 *
 * Furthest round the course, and ties broken by nobody — a genuine tie is a
 * genuine tie and inventing a rule to separate two players who did the same
 * thing is worse than saying so. Returns every id level at the front.
 */
export function leaders(progress: ReadonlyMap<number, number>): number[] {
  let best = -Infinity;
  for (const value of progress.values()) if (value > best) best = value;
  if (best === -Infinity) return [];
  const out: number[] = [];
  // Float progress, so a tolerance rather than equality: two players who
  // cleared the same checkpoint this tick differ by whatever their last frame's
  // distance happened to be.
  for (const [id, value] of progress) if (value >= best - 1e-6) out.push(id);
  return out.sort((a, b) => a - b);
}

/**
 * A par time to beat when nobody else is playing.
 *
 * Solo has no bots — see the mode — so without this there is nothing to lose
 * to, and a time trial with no target is a stopwatch. Scaled by the course
 * rather than fixed, so adding a checkpoint does not silently make par
 * impossible: forty seconds a leg is a comfortable walk plus the building.
 */
export const PAR_PER_LEG = 40;

export function parTime(legs: number): number {
  return Math.max(PAR_PER_LEG, legs * PAR_PER_LEG);
}
