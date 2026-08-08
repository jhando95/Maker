/**
 * Things in the garden that do something to you when you stand on them.
 *
 * The yard has had exactly one verb for years — *build* — and three for combat.
 * Nothing in the world itself changed how a kid moved. A trampoline does, and it
 * is the cheapest possible way to add a second thing worth knowing about the
 * map: where the high ground is now depends on where the launch pads are, and
 * that is a fact a good player learns and a new one does not.
 *
 * ## Why these are physics and not rules
 *
 * Every item here changes velocity and nothing else. No ammo, no score, no
 * wetness, no ownership. That is a deliberate line, and it is what makes them
 * work over a network for free:
 *
 * **The effect is a pure function of where a body is.** So the host applies it,
 * and the guest predicting its own body applies exactly the same thing on the
 * same tick, and the two agree without a single byte being sent. An item that
 * granted ammo would have to be a message — one machine has to decide who got
 * the last one — and that is a different and much larger design.
 *
 * The moment an item needs to be *consumed*, it belongs to a mode and goes
 * through the host. Until then, this stays in the world where it costs nothing.
 *
 * ## What they are for
 *
 * - **Trampoline.** Launch. Reaches roofs and the treehouse deck without a
 *   ladder, which turns "is there a way up" from a fixed answer into a route
 *   somebody has to spot. Chains into a mantle: bounce to a ledge you could not
 *   otherwise reach, then haul over it.
 * - **Slip-n-slide.** A shove along its length. Crossing the lawn fast in one
 *   direction only, so it is a commitment rather than a free upgrade — and in a
 *   chase it is the thing that makes a corner worth cutting.
 */

/** What an item does. */
export type ItemKind = 'trampoline' | 'slide';

export interface Item {
  kind: ItemKind;
  x: number;
  z: number;
  /** Half-extents on the ground. Items are rectangles because the props are. */
  halfW: number;
  halfD: number;
  /** Top surface, so a body has to be on it rather than under it. */
  y: number;
  /** Yaw, which is the direction a slide shoves along. Unused by a trampoline. */
  ry: number;
}

/**
 * Upward speed a trampoline gives, in metres per second.
 *
 * Sized against a landmark rather than picked, and the landmark is the porch
 * roof at 2.73m. A mat sits at 0.32m, so clearing it takes 2.41m of lift; this
 * gives 3.03m, which is enough to arrive over the roof with a little drift
 * still to spend rather than scraping the gutter.
 *
 * The interesting part is the ceiling. Gravity here is 23 m/s², more than twice
 * the real thing, so heights come at a steep price in speed: 3.03m costs 11.8
 * and the treehouse deck at 4.64m would cost 14.6. That is deliberately not
 * paid. `neighborhood.ts` opens with the rule this map is built on — every
 * stage of the climb is reachable except the last, which is the part the player
 * is supposed to build — and a launch pad that put you on the deck for free
 * would repeal it. What this does is make the *first* stage instant, which is
 * a shortcut along a route that already exists.
 *
 * The arithmetic is checked rather than trusted: `items.test.ts` derives the
 * apex from this and `GRAVITY` and asserts both ends of that claim, so lifting
 * the number to make a bounce feel better fails the test that says what the
 * bounce is for.
 */
export const TRAMPOLINE_SPEED = 11.8;

/**
 * The velocity a slide stamps on a body each tick, in metres per second.
 *
 * A speed the slide *states* rather than an impulse it adds, so stepping on
 * slowly and arriving at a sprint end up in the same place — a shortcut anybody
 * can take, not a reward for already going fast.
 *
 * **This is not the speed you travel at, and the gap is large.** The item pass
 * runs after `CharacterController.step`, and a body with no input on it is one
 * the controller is actively stopping: it blends the velocity toward zero at
 * `GROUND_ACCEL` and then applies `GROUND_FRICTION` on top, and the movement
 * for the tick happens between the two. Between them they take about a third
 * back, so seventeen here is about eleven metres a second of ground covered —
 * half again a sprint, which is the number the design actually wanted and is
 * worth crossing a lane for without putting a runner out of reach.
 *
 * Two numbers with a fudge factor between them is a bad thing to leave written
 * down and unchecked, so it is not: `itemField.test.ts` runs a body through the
 * real step-then-item pair on a floor and asserts the distance it covers is
 * `SLIDE_TRAVEL`. Change any of the three movement constants and that test says
 * the slide moved, rather than the slide quietly moving.
 */
export const SLIDE_SPEED = 17;

/**
 * What that comes out as on the ground, in metres per second.
 *
 * The number the design is stated in, and the one a player experiences. Derived
 * by measurement rather than arithmetic — see `SLIDE_SPEED`.
 */
export const SLIDE_TRAVEL = 11;

/**
 * Where they are.
 *
 * Placed against things worth reaching rather than scattered.
 *
 * The first stands off the left-hand end of the porch, and lands you on the
 * porch roof — the first stage of the climb over the house, which until now
 * cost a plank and a moment standing still to place it.
 *
 * The second is out in the right-hand lane, short of the right flag. Nothing
 * up there is worth landing on, and that is the point: three metres of lift on
 * the approach to a flag is a way over whatever somebody built around it, and
 * a way to be seen doing it. It is the one item whose value depends entirely on
 * what the other player made, which is the kind of thing this game should have
 * more of.
 *
 * The slides run down either side of the house between the flag and the spawn,
 * which is a lane a Capture the Flag runner already uses — so the item makes an
 * existing route faster rather than inventing a new one nobody has a reason to
 * take. They stop short of the flags themselves; a shove while you are standing
 * on an objective is a different and much worse idea.
 *
 * Nothing is under the treehouse, which was the obvious spot and is wrong twice
 * over. Its deck overhangs at 4.36m, so a bounce there is a bang on the head;
 * and the trunk already has rungs up it, so the one thing a pad could offer is
 * the one thing that side of the garden already has.
 *
 * ## Where a prop may not stand, and what that cost to find out
 *
 * The first placement put a trampoline two and a half metres from the garden
 * tap, and three of Water War's balance tests failed on the spot. They were
 * right to: those tests measure how much water a ring of planks saves at radii
 * out to 4.2m, and a solid prop inside that ring is a wall somebody did not
 * build. A decoration that silently re-tunes a mode is the worst kind, because
 * the number it changes has a test but the reason does not.
 *
 * `SOURCE_KEEPOUT` came out of that, and it is **necessary and not sufficient**
 * — which is the part worth reading. The second placement stood a trampoline at
 * (9, 2), nearly ten metres from the closest tap and comfortably outside the
 * keepout, and one balance measurement still moved by a factor of three: a
 * 4.2m ring went from keeping a fifth of its water to keeping five eighths. The
 * prop was not standing in a ring, it was standing in the corridor beside the
 * house that every raiding kid walks down, and blocking a lane is worth as much
 * as blocking a tap.
 *
 * There is no cheap invariant for "not on a lane" — the honest answer is that
 * the flow field decides, and the only way to know is to run the afternoon. So
 * the division of labour is: `items.test.ts` enforces the keepout, which is
 * checkable in a millisecond and catches the crude mistake, and Water War's
 * balance suite catches the subtle one. Five candidate positions were measured
 * for the front trampoline before this one; four left every number untouched
 * and the fifth, out by the rain barrel, moved two. That is what those slow
 * tests are for, and it is why they are worth their runtime.
 */
export const ITEMS: readonly Item[] = [
  // Off the left end of the porch, clear of its roof and pointing at it.
  { kind: 'trampoline', x: -6.6, z: -8, halfW: 1.1, halfD: 1.1, y: 0.32, ry: 0 },
  // Out in the right lane, on the approach to the right flag.
  { kind: 'trampoline', x: 11.5, z: -3, halfW: 1.1, halfD: 1.1, y: 0.32, ry: 0 },
  // The two runs down either side of the house, spawn end to flag end.
  { kind: 'slide', x: -16.5, z: -6, halfW: 1.3, halfD: 3.5, y: 0.06, ry: 0 },
  { kind: 'slide', x: 16.5, z: -6, halfW: 1.3, halfD: 3.5, y: 0.06, ry: Math.PI },
];

/** Is this body standing on that item? */
export function onItem(item: Item, x: number, y: number, z: number): boolean {
  // Rotated into the item's own frame, so a turned slide is still a rectangle.
  const c = Math.cos(-item.ry);
  const s = Math.sin(-item.ry);
  const dx = x - item.x;
  const dz = z - item.z;
  const lx = dx * c - dz * s;
  const lz = dx * s + dz * c;
  if (Math.abs(lx) > item.halfW || Math.abs(lz) > item.halfD) return false;
  // A generous vertical window rather than an exact touch: a body that lands
  // hard is briefly a few centimetres into the surface, and one that is walking
  // sits a skin's width above it. Missing the frame it was in contact would
  // read as a trampoline that only works sometimes, which is worse than one
  // that does not work at all.
  return y >= item.y - 0.35 && y <= item.y + 0.6;
}

/**
 * How far every item's footprint stays from a water source.
 *
 * Comfortably outside the largest ring Water War's balance tests build — 4.2m
 * — so a prop can never stand in for a plank in a measurement about planks.
 *
 * Measured from the nearest point of the item's rectangle rather than from its
 * centre, which matters for a slide: eight metres of sheet with its middle ten
 * metres from a tap still has a corner five metres away, and it is the corner
 * that would be in the ring.
 */
export const SOURCE_KEEPOUT = 6;

/** Nearest point of an item's footprint to a spot on the ground, in metres. */
export function distanceToItem(item: Item, x: number, z: number): number {
  const c = Math.cos(-item.ry);
  const s = Math.sin(-item.ry);
  const dx = x - item.x;
  const dz = z - item.z;
  const lx = dx * c - dz * s;
  const lz = dx * s + dz * c;
  const ox = Math.max(0, Math.abs(lx) - item.halfW);
  const oz = Math.max(0, Math.abs(lz) - item.halfD);
  return Math.hypot(ox, oz);
}
