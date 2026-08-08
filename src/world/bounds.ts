/**
 * Where the world stops.
 *
 * Until now it did not. Three things were true at once, and each of them is the
 * kind of hole a player finds in the first ten minutes:
 *
 * - **The ground plane is infinite.** `CollisionWorld.groundY` is a height, not
 *   a surface with edges, so a body at x = 5000 is standing on solid ground.
 *   Measured: sprinting outward for eight seconds leaves the detailed lawn
 *   behind and keeps going, over a flat plane with a skybox on it.
 * - **The fence is a picture.** It is built in `scene.ts` as batched props,
 *   which are drawn and never collided with, so the one thing in this world
 *   that *looks* like a boundary stops nobody. Walking north from the back
 *   garden goes straight through it.
 * - **Under the world is a trap you cannot leave.** A body below the ground
 *   plane settles at −1.19m wedged inside the house's collision box, reports
 *   itself grounded, and cannot move in any direction. Not an exploit — a
 *   soft-lock, and the only escape is to quit.
 *
 * ## Three layers, because one is never enough
 *
 * Every game that keeps players inside a map does it more than once, and the
 * reason is that each layer fails differently.
 *
 * 1. **A wall.** Real collision, at the edge, from `barrierSlabs`. This is what
 *    a player actually meets: you walk into it and slide along it exactly as
 *    you would along a shed. It is what makes the boundary feel like part of
 *    the world rather than like the game saying no.
 * 2. **A clamp.** `enforceBounds` runs after every body's step and puts anybody
 *    outside the box back on its face. A wall can be beaten — by a teleport, by
 *    a spawn placed wrong, by a launcher nobody thought about, by enough speed
 *    to cross it in one tick. The clamp cannot, because it is not a collision
 *    test but a statement about where a body is allowed to be.
 * 3. **A floor.** Below `FLOOR` you are put back on the lawn. Nothing in the
 *    game can fall that far today, which is exactly why it is worth having:
 *    "fell through the world" is the way players end up out of bounds in every
 *    game that has ever shipped, and the recovery has to already exist on the
 *    day it first happens.
 *
 * ## The clamp is the one that has to be right
 *
 * It runs on the host for everybody and on a guest for the body it predicts,
 * and both reach the same answer because it is a pure function of position —
 * the same property that lets `itemField.ts` work without sending a byte. A
 * clamp applied on one side only would be a correction on every snapshot for as
 * long as somebody leaned on the wall.
 */

import { CAP_RADIUS } from '../physics/constants.ts';
import type { CharacterController } from '../player/controller.ts';
import type { CollisionWorld } from '../physics/collisionWorld.ts';

/** An axis-aligned box, in metres, that everything alive stays inside. */
export interface PlayBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  /** Below this a body has fallen out of the world and is put back. */
  readonly floor: number;
  /** Nothing may be built above this. Bodies are not capped; towers are. */
  readonly ceiling: number;
  /** Where a body that fell out of the world reappears. */
  readonly recover: { readonly x: number; readonly y: number; readonly z: number };
}

/**
 * How far out the world goes, in metres from the origin.
 *
 * One box for every mode rather than one per mode, and that is a decision worth
 * defending. Tag is played out on the cul-de-sac and the other three are played
 * in the lot, so the obvious design gives each mode its own box — but a boundary
 * that moves when the round changes is a boundary that has to be installed and
 * removed, and a wall that exists during one mode and not another is a wall
 * somebody will be standing inside when it appears.
 *
 * A single box costs the lot modes nothing. There is no advantage to be had out
 * on the street during Water War: the taps are in the garden and the kids raid
 * the garden, so leaving is a way to lose slowly. And the house is the divider
 * in Capture the Flag, but going out of the front gate and back in through it
 * does not get you past the house — the front of the lot is a legitimate
 * crossing already.
 *
 * 58 metres puts the wall eight metres inside the detailed lawn's own edge at
 * 66, so a player pressed against it is still standing on real ground with real
 * tone in it, and never sees the straight line where the lawn stops.
 */
export const PLAY_HALF = 58;

/**
 * How far below the lawn counts as having fallen out.
 *
 * Half a metre, and the number is the interesting part: the obvious answer is
 * *well below anything*, and the obvious answer does not work.
 *
 * A body put under the world does not stay under it. Depenetration runs inside
 * `step`, so by the time anything downstream looks, the capsule has been shoved
 * up against the underside of whatever it was inside and come to rest — measured
 * at **−1.19m**, wedged in the house's collision box, reporting itself grounded
 * and unable to move in any direction. That is the failure, and it is a soft
 * lock rather than a fall: the only way out was to quit.
 *
 * So the floor has to sit *above* where the wedge ends up rather than below
 * where the fall started, which is the opposite of how one of these is usually
 * placed. Half a metre does, and it has enormous margin in the other direction:
 * dropped from one metre, from the eaves, from the ridge and from forty metres,
 * the lowest a body ever reaches is **0.004m**. Three orders of magnitude, and
 * `bounds.test.ts` walks a body around for two seconds asserting it is never
 * tripped.
 */
export const FLOOR = -0.5;

/**
 * The highest a placed part may reach.
 *
 * Forty metres is about six house-heights, which is far more tower than anybody
 * will build and still a number. Without it a player builds upward forever —
 * and more to the point, so does a guest, whose placements the host applies.
 */
export const BUILD_CEILING = 40;

/**
 * How high the invisible wall goes.
 *
 * Fourteen metres: twice the house ridge, so it covers every height a body can
 * reach by walking, climbing, mantling or bouncing. Not the build ceiling, and
 * that is the layering doing its job.
 *
 * The tempting version is a wall taller than the tallest possible tower, so
 * that no arrangement of parts gets anybody over it. It works, and it costs
 * four times as much broadphase for a case the clamp already covers: somebody
 * who builds forty metres of scaffolding against the edge and leaps off the top
 * is outside the box for one tick and back on its face the next. A wall exists
 * to be met, and nobody meets one at forty metres.
 */
const BARRIER_TOP = 14;

/**
 * How thick.
 *
 * Two metres. Collision here is discrete rather than swept, so thickness is the
 * whole of the answer to tunnelling — and the number to measure it against is
 * not the sprint but the slip-n-slide, which states 17 m/s and is the fastest
 * anything in this world moves. That is 0.28m in a tick, so this is seven times
 * over.
 *
 * Kept as small as that margin allows because of a cost that does not show up
 * in a frame time. These four boxes are enormous — a hundred and twenty metres
 * long and fifty tall — and the broadphase is a uniform grid with one-metre
 * cells, so each one is inserted into every cell it touches. Installing the
 * barrier takes the world from fifteen thousand occupied cells to well over a
 * hundred thousand, which is memory rather than time: the benchmark is
 * unchanged, and `bounds.test.ts` puts a ceiling on the count so it cannot
 * quietly grow again.
 */
const BARRIER_THICKNESS = 2;

export const PLAY_AREA: PlayBounds = {
  minX: -PLAY_HALF,
  maxX: PLAY_HALF,
  minZ: -PLAY_HALF,
  maxZ: PLAY_HALF,
  floor: FLOOR,
  ceiling: BUILD_CEILING,
  // The middle of the back garden: open lawn, inside every mode's field, and
  // not on anybody's spawn or objective.
  recover: { x: 0, y: 1.5, z: 12 },
};

/** Is this spot inside the world? `margin` shrinks the box before asking. */
export function inBounds(x: number, z: number, margin = 0, b: PlayBounds = PLAY_AREA): boolean {
  return x >= b.minX + margin && x <= b.maxX - margin
    && z >= b.minZ + margin && z <= b.maxZ - margin;
}

/** Is this whole box inside the world, and under the ceiling? */
export function boxInBounds(
  box: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number },
  b: PlayBounds = PLAY_AREA,
): boolean {
  return box.minX >= b.minX && box.maxX <= b.maxX
    && box.minZ >= b.minZ && box.maxZ <= b.maxZ
    && box.maxY <= b.ceiling;
}

/** What `enforceBounds` had to do about a body. */
export type Breach = 'none' | 'wall' | 'fell';

/**
 * Put one body back inside the world.
 *
 * Runs after the step, like the item pass and for the same reason: it is about
 * where a body ended up, and it has to be the last word. Returns what it had to
 * do, which is what a message on the screen or a sound hangs off — silently
 * teleporting somebody is how a player learns to distrust the game.
 *
 * The outward velocity is zeroed along with the position, and that matters more
 * than it looks. Clamping position alone leaves a body pressed against the face
 * at full speed, so the next tick moves it out again and the one after clamps it
 * back: a stationary player, vibrating, with the walk cycle running.
 */
export function enforceBounds(
  body: CharacterController,
  b: PlayBounds = PLAY_AREA,
): Breach {
  if (body.y < b.floor) {
    body.teleport(b.recover.x, b.recover.y, b.recover.z);
    body.vx = 0;
    body.vy = 0;
    body.vz = 0;
    return 'fell';
  }

  // The capsule's own radius, so a body stops with its whole width inside
  // rather than with its middle on the line and its shoulder through it.
  const margin = CAP_RADIUS;
  let x = body.x;
  let z = body.z;
  let hit = false;

  if (x < b.minX + margin) { x = b.minX + margin; hit = true; if (body.vx < 0) body.vx = 0; }
  else if (x > b.maxX - margin) { x = b.maxX - margin; hit = true; if (body.vx > 0) body.vx = 0; }

  if (z < b.minZ + margin) { z = b.minZ + margin; hit = true; if (body.vz < 0) body.vz = 0; }
  else if (z > b.maxZ - margin) { z = b.maxZ - margin; hit = true; if (body.vz > 0) body.vz = 0; }

  if (!hit) return 'none';
  // `place`, not `teleport`. Teleporting drops all three velocity components,
  // which would undo the careful part just above: a body bounced off the wall
  // and heading back inside would be frozen against it, and a body pressed on
  // it would have its fall cancelled and hang in the air.
  body.place(x, body.y, z);
  return 'wall';
}

/** A box in the shape `installFixtures` and the renderer both understand. */
export interface BarrierBox {
  w: number; h: number; d: number;
  x: number; y: number; z: number;
}

/**
 * The four walls, as boxes.
 *
 * Overlapping at the corners on purpose: two walls that merely met would leave
 * a seam a capsule can be squeezed into, and a corner is exactly where a player
 * running along one wall arrives.
 */
export function barrierBoxes(b: PlayBounds = PLAY_AREA): BarrierBox[] {
  const t = BARRIER_THICKNESS;
  const h = BARRIER_TOP - b.floor;
  const y = b.floor + h / 2;
  const spanX = (b.maxX - b.minX) + t * 2;
  const spanZ = (b.maxZ - b.minZ) + t * 2;
  const midX = (b.minX + b.maxX) / 2;
  const midZ = (b.minZ + b.maxZ) / 2;
  return [
    { w: t, h, d: spanZ, x: b.minX - t / 2, y, z: midZ },
    { w: t, h, d: spanZ, x: b.maxX + t / 2, y, z: midZ },
    { w: spanX, h, d: t, x: midX, y, z: b.minZ - t / 2 },
    { w: spanX, h, d: t, x: midX, y, z: b.maxZ + t / 2 },
  ];
}

/**
 * Put the walls in the collision world.
 *
 * Added as fixtures, so the build system refuses to delete them for the same
 * reason it refuses to delete the house — and so the flow field the kids route
 * on treats them as solid, which keeps a bot chasing somebody near the edge
 * from walking out of the world after them.
 *
 * Separate from `installFixtures` rather than folded into `neighborhoodSlabs`,
 * because the slab list is a description of the *scenery* and half a dozen tests
 * count it, measure its extent, or assert that nothing in it sits on a spawn.
 * Four invisible boxes the size of the sky would be a strange thing to find in
 * any of those answers.
 */
export function installBarrier(world: CollisionWorld, b: PlayBounds = PLAY_AREA): void {
  for (const box of barrierBoxes(b)) {
    world.addFixture(
      0, 0,
      box.x, box.y, box.z,
      0, 0, 0, 1,
      box.w / 2, box.h / 2, box.d / 2,
      null,
      { climbable: false },
    );
  }
}
