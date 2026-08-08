/**
 * The neighborhood: a house with a yard either side of it.
 *
 * The map is described here as plain numbers and consumed twice — once by the
 * scenery batch to draw it, once by the collision world to make it solid. That
 * is the whole reason this file exists separately from scene.ts. Two hand-written
 * lists of the same house drift within a week, and the way you find out is a
 * player standing inside a wall.
 *
 * The house is not decoration. It is the divider: the left yard is -X, the right
 * yard is +X, and the only ways across are round the front, round the back, or
 * over the roof. A fence would have been easier and would have been wrong — a
 * fence is a thing you walk around, and a house is a thing you go over, which
 * makes crossing a building problem instead of a walking problem.
 *
 * The climb up is deliberately incomplete. Porch roof at 2.6m, eaves at 5.0m,
 * treehouse deck at 4.5m with the house eight metres away: every stage is
 * reachable except the last one, which is the part the player is supposed to
 * build.
 */

import * as THREE from 'three';
import { Rng } from '../core/rng.ts';
import { ITEMS } from './items.ts';
import { culDeSacSlabs } from './culDeSac.ts';
import { surroundsSlabs } from './surrounds.ts';
import type { CollisionWorld } from '../physics/collisionWorld.ts';

/**
 * One box in the map.
 *
 * Angles are Euler YXZ in radians, matching the build system's convention so a
 * player-placed part and a piece of the map rotate the same way.
 */
export interface Slab {
  w: number; h: number; d: number;
  x: number; y: number; z: number;
  rx?: number; ry?: number; rz?: number;
  color: number;
  outline?: number;
  chamfer?: number;
  /**
   * Decorative geometry that should not block movement — glass, painted lines,
   * a bunting string. Default is solid, because the surprising case is the one
   * worth spelling out at the call site.
   */
  ghost?: boolean;
  /**
   * Climbable despite being part of the map. Only the treehouse rungs.
   *
   * The default is deliberately the opposite of the rule for player-built parts:
   * anything you nailed together yourself can be climbed, and nothing in the
   * neighbourhood can, or the house is a ladder and the map has no shape.
   */
  climbable?: boolean;
  /**
   * This face is a light, and glows once the lamps come on.
   *
   * Here rather than in a list of lamp coordinates somewhere else, because two
   * records of one fact drift the moment somebody nudges a post. The glow is
   * derived from the slab — its position, its size, its rotation — so it cannot
   * end up somewhere the lamp is not. See `render/nightLights.ts`.
   */
  lit?: Lit;
}

/** What a slab does once the lamps come on. */
export interface Lit {
  /** The colour of the glow. Warmer than the thing it is painted on. */
  color: number;
  /**
   * How far past the slab's own extent the halo bleeds, in metres.
   *
   * A lamp lens is a 20cm box, and a 20cm glow is a lamp that is switched on
   * and unnoticeable. The bloom is what makes it a light rather than a bright
   * face, and it is per-slab because a window pane wants a hint and a street
   * lamp wants a halo you can see from the far end of the garden.
   */
  bloom?: number;
}

/** Colours specific to the neighborhood, beyond the base scene palette. */
export const LOT = {
  wall: 0xf2e3c9,
  wallShade: 0xe4d2b4,
  trim: 0xd8564f,
  roof: 0x7d4f43,
  roofDark: 0x6a4238,
  door: 0x4a7fa8,
  glass: 0x9fd8ee,
  porch: 0xc9a06a,
  chimney: 0xb06a52,
  deck: 0xbf9560,
  plank: 0xc89f6a,
  plankPale: 0xd8b585,
  tyre: 0x3a3a40,
  metal: 0x8c9196,
  swing: 0xe05a4a,
  binGreen: 0x4f8a52,
  binBlue: 0x4a6fa8,
  binGrey: 0x6f7378,
  dogRed: 0xc8503c,
  cart: 0xe8a13a,
  cloth: 0xf4f0e4,
  bbq: 0x2f3238,
  hedge: 0x4f9a3a,
  trunk: 0x8a6242,
  sign: 0xf0e0c8,
  soil: 0x8a5f38,
} as const;

const DARK = 0x3a2c2a;
const WOOD_LINE = 0x4a3122;

/** House footprint. Everything else is positioned relative to these. */
export const HOUSE = {
  halfWidth: 4.6,   // x
  halfDepth: 6.2,   // z
  eaves: 5.0,
  ridge: 7.1,
  porchRoof: 2.6,
} as const;

/**
 * Team anchors.
 *
 * Mirrored in X and identical in Z, so neither side has a shorter run. The props
 * around them are deliberately *not* mirrored — fairness is about distances, and
 * a map that is symmetric down to the prop is a map with no landmarks.
 */
export const LEFT_FLAG = { x: -17.5, z: 1.5 } as const;
export const RIGHT_FLAG = { x: 17.5, z: 1.5 } as const;
export const LEFT_SPAWN = { x: -20.5, y: 0.5, z: -7 } as const;
export const RIGHT_SPAWN = { x: 20.5, y: 0.5, z: -7 } as const;

/**
 * Where Fort Defense puts its stash.
 *
 * Off the centre line, because the centre line is a fence. In the front-left
 * yard, which gives a fort two sides it did not have to build — the house and
 * the divider — and leaves the other two to the player. Better than the open
 * middle it used to occupy, not worse.
 */
export const FORT_YARD = { x: -12, y: 0, z: -13 } as const;

/**
 * The three water sources, and the reason Water War has three fronts.
 *
 * Spread far enough apart that one player cannot stand between them. That is the
 * whole design: a fort has to work while you are somewhere else, which is a
 * different question from Fort Defense's "is it fun to fight inside one".
 */
export const WATER_SOURCES: ReadonlyArray<{ key: string; name: string; x: number; z: number }> = [
  { key: 'pool', name: 'the paddling pool', x: -9.5, z: 9 },
  { key: 'butt', name: 'the rain barrel', x: 16, z: 9 },
  { key: 'tap', name: 'the garden tap', x: 2.5, z: -11 },
];

/** The treehouse deck, which is the left side's high ground. */
export const TREEHOUSE = { x: -13.5, z: 5.5, deck: 4.5 } as const;

/**
 * Where the grass gets walked off.
 *
 * Derived from the map's own landmarks rather than scattered for texture: every
 * patch is somewhere a mode sends people. That makes the ground a record of the
 * traffic the game creates, and it means a player who has never seen this lot
 * can read where the routes go before anything moves — the taps everybody runs
 * to, the flag bases, the tree everybody climbs, the doors everybody comes
 * through.
 *
 * A consequence worth stating: change where a mode puts an objective and the
 * wear follows it, because both read the same constant. A hand-placed patch
 * would quietly start lying the first time a number here moved.
 */
export function wearPoints(): ReadonlyArray<{ x: number; z: number; radius: number; strength?: number }> {
  return [
    // The three taps. Water War's whole traffic pattern.
    ...WATER_SOURCES.map((s) => ({ x: s.x, z: s.z, radius: 4.2, strength: 0.85 })),
    // Both flag bases, and the spawns people run out of.
    { x: LEFT_FLAG.x, z: LEFT_FLAG.z, radius: 3.4, strength: 0.8 },
    { x: RIGHT_FLAG.x, z: RIGHT_FLAG.z, radius: 3.4, strength: 0.8 },
    { x: LEFT_SPAWN.x, z: LEFT_SPAWN.z, radius: 2.8, strength: 0.55 },
    { x: RIGHT_SPAWN.x, z: RIGHT_SPAWN.z, radius: 2.8, strength: 0.55 },
    // Under the tree, which is bare in every real garden that has one.
    { x: TREEHOUSE.x, z: TREEHOUSE.z, radius: 3.6, strength: 0.95 },
    // The stash, and the fort that gets built round it.
    { x: FORT_YARD.x, z: FORT_YARD.z, radius: 3.2, strength: 0.7 },
    // The garden path down the back, from the deck to the far fence, as
    // overlapping steps — a path is a line and this lattice only knows about
    // circles.
    ...pathWear(0, 17.5, 0, 7.4, 1.5, 0.75),
    // And the front path: gate to porch, which is the way everybody comes in.
    // The two were labelled the wrong way round here for a while. The porch is
    // at -Z and the deck at +Z, and since both ends of a lawn look much alike
    // from above, the ground quietly recorded traffic on the wrong side of the
    // house until the cul-de-sac put a gate at one end and not the other.
    ...pathWear(0, -23, 0, -9.5, 1.6, 0.8),
    { x: 0, z: -8.2, radius: 3.0, strength: 0.6 },
  ];
}

/** A worn line, as overlapping circles a metre apart. */
function pathWear(
  x0: number, z0: number, x1: number, z1: number, radius: number, strength: number,
): Array<{ x: number; z: number; radius: number; strength: number }> {
  const span = Math.hypot(x1 - x0, z1 - z0);
  const steps = Math.max(1, Math.round(span));
  const out: Array<{ x: number; z: number; radius: number; strength: number }> = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    out.push({ x: x0 + (x1 - x0) * t, z: z0 + (z1 - z0) * t, radius, strength });
  }
  return out;
}

const slabs: Slab[] = [];

function put(s: Slab): void {
  slabs.push(s);
}

/** A box, with the wood outline everything timber in this map shares. */
function timber(
  w: number, h: number, d: number,
  x: number, y: number, z: number,
  color: number,
  opts: Partial<Slab> = {},
): void {
  put({ w, h, d, x, y, z, color, outline: WOOD_LINE, chamfer: 0.01, ...opts });
}

/**
 * Build the map description.
 *
 * Takes an Rng so the junk can be scattered rather than placed, but every
 * structural piece — house, roof, porch, treehouse, flag surrounds — is fixed.
 * A map whose walls move with the seed is a map you cannot design around.
 */
export function neighborhoodSlabs(rng: Rng): Slab[] {
  slabs.length = 0;

  house();
  roof();
  porch();
  backDeck();
  dividers();
  treehouse();
  leftYard(rng);
  rightYard(rng);
  street();
  // The neighbourhood beyond the fence. Its own module: it is a different job
  // from the lot — nobody plays on it and nothing there is balanced — and
  // mixing scenery you can only look at into the file that also describes the
  // geometry three modes are tuned around is how one starts being edited for
  // the other's reasons.
  for (const s of culDeSacSlabs()) put(s);
  clutter(rng);
  playthings();
  waterworks();

  // Its own Rng, unconnected to the yard's, rather than a fork of it.
  //
  // `rng.fork()` advances the parent, so taking one here shifted every random
  // draw the yard makes afterwards: adding trees to a horizon moved the junk in
  // the garden, and one crate landed on the left spawn. That was caught by the
  // test which says nothing may sit on a spawn — a test with no connection to
  // this change, which is exactly what it is for.
  //
  // Reordering the call would have fixed that one instance and left the hazard
  // in place for the next person to add scenery. A separate stream cannot
  // interact with the lot at all. The cost is that the horizon does not vary
  // with the map seed, and the horizon is the last thing in this world that
  // needs to.
  for (const s of surroundsSlabs(new Rng('surrounds'))) put(s);

  return slabs.map((s) => ({ ...s }));
}

// ── The house ────────────────────────────────────────────────────────────────

function house(): void {
  const { halfWidth: hw, halfDepth: hd, eaves } = HOUSE;

  // Solid rather than hollow. An interior would need a door, and a door is a
  // hole through the divider — which undoes the one thing the house is for.
  put({
    w: hw * 2, h: eaves, d: hd * 2,
    x: 0, y: eaves / 2, z: 0,
    color: LOT.wall, outline: 0x8a6a52, chamfer: 0.03,
  });

  // Cladding boards, so a nine-metre wall is not one flat colour. Purely
  // surface: they sit proud of the wall and are not collided with, because a
  // ladder snapping to a decorative batten instead of the wall behind it is
  // maddening in a way that is very hard to diagnose.
  for (let i = 0; i < 6; i++) {
    const y = 0.55 + i * 0.8;
    for (const side of [-1, 1]) {
      put({
        w: 0.06, h: 0.5, d: hd * 2 - 0.4,
        x: side * (hw + 0.03), y, z: 0,
        color: LOT.wallShade, outline: 0x8a6a52, chamfer: 0.008, ghost: true,
      });
    }
  }

  // Windows on both yards, so each side can see the shape of the other.
  for (const side of [-1, 1]) {
    for (const z of [-3.2, 3.2]) {
      put({
        w: 0.12, h: 1.5, d: 1.9,
        x: side * (hw + 0.06), y: 2.5, z,
        color: LOT.trim, outline: 0x6a2320, chamfer: 0.01, ghost: true,
      });
      put({
        w: 0.1, h: 1.2, d: 1.6,
        x: side * (hw + 0.12), y: 2.5, z,
        color: LOT.glass, outline: 0x4a7a8a, chamfer: 0.006, ghost: true,
      });
    }
  }

  // Front door, facing the street. Trim only — it does not open, and pretending
  // otherwise with a recess just makes players walk into it.
  put({
    w: 1.3, h: 2.3, d: 0.14,
    x: -1.2, y: 1.15, z: -(HOUSE.halfDepth + 0.07),
    color: LOT.door, outline: 0x2a4a63, chamfer: 0.012, ghost: true,
  });
  put({
    w: 0.16, h: 0.16, d: 0.1,
    x: -0.55, y: 1.15, z: -(HOUSE.halfDepth + 0.14),
    color: 0xe8c86a, outline: 0x8a6a2a, chamfer: 0.02, ghost: true,
  });

  chimney();
}

function chimney(): void {
  timber(1.0, 3.0, 1.0, 2.7, 5.6, -3.4, LOT.chimney, { outline: 0x6a3a2a, chamfer: 0.02 });
  timber(1.25, 0.28, 1.25, 2.7, 7.2, -3.4, LOT.roofDark, { outline: 0x3a2c2a, chamfer: 0.02 });
}

/**
 * A pitched roof from two rotated slabs.
 *
 * Walkable, because the capsule-vs-box collision handles a tilted box like any
 * other and a roof you cannot stand on is a wall with a hat. The pitch is gentle
 * enough — 23° — that the player does not slide off it.
 */
function roof(): void {
  const { halfWidth: hw, eaves, ridge } = HOUSE;
  const overhang = 0.5;
  const run = hw + overhang;
  const rise = ridge - eaves;
  const slope = Math.hypot(run, rise);
  const angle = Math.atan2(rise, run);
  const depth = HOUSE.halfDepth * 2 + overhang * 2;

  for (const side of [-1, 1]) {
    put({
      w: slope, h: 0.3, d: depth,
      x: (side * run) / 2, y: (eaves + ridge) / 2, z: 0,
      rz: side === 1 ? -angle : angle,
      color: LOT.roof, outline: 0x4a2f28, chamfer: 0.02,
    });
  }

  // Ridge cap, and a gable board at each end so the roof reads as a roof from
  // the side rather than as two floating planes.
  timber(0.5, 0.34, depth, 0, ridge + 0.02, 0, LOT.roofDark, { outline: 0x3a2c2a, chamfer: 0.02 });
  for (const z of [-1, 1]) {
    put({
      w: run * 2, h: rise + 0.3, d: 0.16,
      x: 0, y: eaves + rise / 2, z: z * (HOUSE.halfDepth + overhang),
      color: LOT.trim, outline: 0x6a2320, chamfer: 0.01, ghost: true,
    });
  }
}

/**
 * The front porch: the first step of the climb.
 *
 * Its roof is at 2.6m, which is above what the character can jump to but well
 * within one placed plank of the ground — the intended first move.
 */
function porch(): void {
  const zFront = -(HOUSE.halfDepth + 1.5);

  timber(HOUSE.halfWidth * 2, 0.3, 3.0, 0, 0.15, zFront, LOT.porch);
  // Steps down to the path.
  timber(3.0, 0.16, 0.6, -1.2, 0.07, zFront - 1.8, LOT.porch);

  for (const x of [-HOUSE.halfWidth + 0.4, HOUSE.halfWidth - 0.4]) {
    timber(0.28, 2.3, 0.28, x, 1.45, zFront - 1.3, LOT.plankPale);
  }
  timber(HOUSE.halfWidth * 2 + 0.6, 0.26, 3.4, 0, HOUSE.porchRoof, zFront - 0.2, LOT.roofDark, {
    outline: 0x3a2c2a, chamfer: 0.02,
  });

  // Railing between the posts, low enough to vault.
  timber(HOUSE.halfWidth * 2, 0.12, 0.12, 0, 0.95, zFront - 1.45, LOT.plankPale);

  // The porch light, under the roof beside the door.
  //
  // The one lamp in the game that is *theirs*. Everything else that comes on at
  // dusk is somebody else's house across the road, which is atmosphere; a light
  // over your own front door at the end of a round is the bit that means it is
  // getting late and you live here.
  timber(0.3, 0.34, 0.26, 1.5, HOUSE.porchRoof - 0.42, zFront - 0.3, LOT.cloth, {
    chamfer: 0.07, ghost: true, lit: { color: 0xffe0a8, bloom: 0.62 },
  });
}

/** The back deck: the right side's shortcut onto the roof, two stages up. */
function backDeck(): void {
  const zBack = HOUSE.halfDepth + 1.4;

  timber(6.5, 0.35, 2.8, 1.0, 0.5, zBack, LOT.deck);
  timber(2.0, 0.2, 0.7, 1.0, 0.18, zBack + 1.6, LOT.deck);
  // A crate against the deck: the informal step everyone finds first.
  timber(1.0, 1.0, 1.0, 4.6, 0.5, zBack + 1.2, LOT.plank);
  timber(0.9, 0.9, 0.9, 4.5, 1.45, zBack + 1.0, LOT.plankPale, { ry: 0.4 });

  // A bulkhead light on the back wall. The deck is where The Floor Is Lava
  // starts and where everybody respawns, so this is the one light in the game
  // that a player is looking at on purpose rather than noticing.
  timber(0.26, 0.3, 0.22, 1.0, 2.35, HOUSE.halfDepth + 0.08, LOT.cloth, {
    chamfer: 0.06, ghost: true, lit: { color: 0xffe0a8, bloom: 0.58 },
  });
}

/**
 * The fences running from the house to the front and back boundaries.
 *
 * Without them the house divides almost nothing: it is twelve metres deep in a
 * forty-eight metre lot, so walking round the front costs about a metre over
 * the straight line and the roof route is a novelty. Continuing the divide out
 * to the fence line is what turns "cross the map" into a decision.
 *
 * Each run has one gap, and the two gaps are at opposite ends. Three routes
 * between the yards, then: the front gate, the back gate, and over the roof. One
 * chokepoint would just mean whoever stands in it wins.
 */
function dividers(): void {
  const height = 1.7;
  const gaps: ReadonlyArray<readonly [number, number]> = [
    [-19.5, -16.0],  // the driveway, out front
    [12.5, 15.5],    // the gap in the back fence everyone uses
  ];

  const inGap = (z: number) => gaps.some(([a, b]) => z > a && z < b);

  for (const dir of [-1, 1]) {
    const from = dir * (HOUSE.halfDepth + 0.1);
    const to = dir * 23.5;
    const span = Math.abs(to - from);
    const count = Math.round(span / 0.26);

    for (let i = 0; i < count; i++) {
      const z = from + ((to - from) * (i + 0.5)) / count;
      if (inGap(z)) continue;
      timber(0.02, height, 0.1, 0, height / 2, z, LOT.plankPale, {
        rx: ((i % 5) - 2) * 0.006,
      });
    }

    // Rails behind the pickets, broken at the gaps so a gate reads as a gate.
    for (const y of [0.5, 1.3]) {
      let runStart = from;
      const step = dir * 0.25;
      for (let z = from; Math.abs(z - from) <= span; z += step) {
        const ending = inGap(z) || Math.abs(z - from) > span - 0.25;
        if (!ending) continue;
        const runEnd = z - step;
        if (Math.abs(runEnd - runStart) > 0.5) {
          timber(0.06, 0.1, Math.abs(runEnd - runStart), 0, y, (runStart + runEnd) / 2, LOT.plank);
        }
        while (inGap(z) && Math.abs(z - from) <= span) z += step;
        runStart = z;
      }
    }
  }

  // Gate posts, so the two ways through are visible from across the yard.
  for (const [a, b] of gaps) {
    for (const z of [a, b]) {
      timber(0.24, 2.1, 0.24, 0, 1.05, z, LOT.trim, { outline: 0x6a2320 });
      timber(0.34, 0.16, 0.34, 0, 2.16, z, LOT.roofDark, { outline: 0x3a2c2a });
    }
  }
}

// ── The treehouse ────────────────────────────────────────────────────────────

/**
 * The left side's high ground.
 *
 * Deck at 4.5m and eight metres of air between it and the eaves. Close enough
 * that the bridge is obviously the thing to build, far enough that it is a
 * project rather than a step.
 */
/**
 * Bark on the big trunk, and a flare where it meets the ground.
 *
 * The trunk is one 1.3m box seven and a half metres tall, and standing anywhere
 * in the left yard it is the largest single-coloured surface on screen — the
 * flatness survey measured it at 26.7% of one frame, higher than the lawn ever
 * was before the lawn was fixed. A toon ramp gives a box two bands and no more,
 * so nothing about the shading was going to break it up.
 *
 * All of it is ghost geometry sitting proud of the trunk, which is the same
 * arrangement the house cladding uses and for the same reason: the ladder up
 * this tree works by a climb probe finding a near-vertical climbable surface,
 * and a decorative strip of bark that the probe hit instead of the backing
 * board would quietly break the one route to the deck.
 */
function bark(x: number, z: number): void {
  // Strips down two faces — the two you can see from the yard. Varying the
  // width matters more than the count: four evenly spaced identical ribs read
  // as a radiator, and it is the irregularity that reads as bark.
  const strips: ReadonlyArray<[offset: number, width: number, tone: number]> = [
    [-0.44, 0.22, 0x7a5438], [-0.14, 0.34, 0x9a7050], [0.2, 0.16, 0x74502f],
    [0.44, 0.26, 0x936a48],
  ];
  for (const [offset, width, tone] of strips) {
    timber(width, 7.2, 0.06, x + offset, 3.6, z - 0.68, tone, { ghost: true, chamfer: 0.02 });
    // The side face gets the *same* box turned a quarter turn rather than one
    // built the other way round. Scenery is instanced by exact dimensions, so
    // (w, 7.2, 0.06) and (0.06, 7.2, w) are two geometries and two draw calls
    // for one shape — and this file is full of places where that adds up.
    timber(width, 7.2, 0.06, x + 0.68, 3.6, z + offset, tone, {
      ghost: true, chamfer: 0.02, ry: Math.PI / 2,
    });
  }

  // The flare. A trunk that meets the lawn at a right angle is the single thing
  // that most says "box with a bark texture on it" — real ones spread.
  for (let i = 0; i < 3; i++) {
    const t = i / 3;
    timber(
      1.3 + 0.5 * (1 - t), 0.34, 1.3 + 0.5 * (1 - t),
      x, 0.17 + i * 0.3, z,
      i % 2 === 0 ? 0x7a5438 : LOT.trunk,
      { ghost: true, chamfer: 0.06 },
    );
  }

  // Two sawn-off branch stubs. What they contribute is a horizontal on a shape
  // that is otherwise nothing but verticals.
  timber(1.5, 0.3, 0.3, x + 0.9, 5.6, z + 0.2, 0x7a5438, { ghost: true, rz: 0.34, chamfer: 0.08 });
  timber(0.3, 0.28, 1.2, x - 0.2, 6.4, z - 0.8, 0x7a5438, { ghost: true, rx: 0.3, chamfer: 0.08 });
}

function treehouse(): void {
  const { x, z, deck } = TREEHOUSE;

  timber(1.3, 7.4, 1.3, x, 3.7, z, LOT.trunk, { outline: 0x4a3122, chamfer: 0.03 });
  bark(x, z);

  // Rungs nailed up the trunk. Not a ladder object — the character controller
  // recognises any near-vertical surface with rungs, so this is the same
  // affordance a player gets for nailing rungs to their own wall.
  // A backing board the full height of the ladder, then the rungs on top of it.
  //
  // The board is what actually makes the ladder work. The climb probe is a
  // single ray at chest height, so rungs alone are climbable only when one
  // happens to be at that exact height — measured, the probe passed between two
  // rungs and hit the bare trunk, which is not climbable, and the ladder did
  // nothing. Side rails do not fix it either: a ray straight ahead misses
  // anything offset sideways.
  timber(1.5, 4.6, 0.08, x, 2.4, z - 0.78, LOT.plank, { climbable: true });
  for (let i = 0; i < 8; i++) {
    timber(1.5, 0.12, 0.14, x, 0.75 + i * 0.55, z - 0.86, LOT.plankPale, { climbable: true });
  }

  timber(5.4, 0.28, 5.4, x, deck, z, LOT.plank);
  // Railing: gapped on the +X side, which is the way you would want to leave.
  timber(5.4, 0.75, 0.14, x, deck + 0.5, z - 2.6, LOT.plankPale);
  timber(5.4, 0.75, 0.14, x, deck + 0.5, z + 2.6, LOT.plankPale);
  timber(0.14, 0.75, 5.4, x - 2.6, deck + 0.5, z, LOT.plankPale);

  // A lean-to roof, held up by two posts. Scrap, nailed on at a slight angle.
  for (const [px, pz] of [[x - 2.2, z - 2.2], [x - 2.2, z + 2.2]] as const) {
    timber(0.18, 1.9, 0.18, px, deck + 1.1, pz, LOT.plankPale);
  }
  put({
    w: 5.6, h: 0.2, d: 5.6,
    x: x - 0.2, y: deck + 2.15, z,
    rz: -0.16,
    color: LOT.roofDark, outline: 0x3a2c2a, chamfer: 0.015,
  });

  // The sign every treehouse has.
  put({
    w: 1.6, h: 0.7, d: 0.08,
    x: x + 0.1, y: deck + 1.5, z: z - 2.62,
    rz: 0.09,
    color: LOT.sign, outline: WOOD_LINE, chamfer: 0.01, ghost: true,
  });
}

// ── The yards ────────────────────────────────────────────────────────────────

function leftYard(rng: Rng): void {
  // Three bins by the side path, one knocked over.
  const bins = [LOT.binGreen, LOT.binBlue, LOT.binGrey];
  bins.forEach((color, i) => {
    timber(0.75, 1.1, 0.75, -8.5 + i * 0.95, 0.55, -9.5 + rng.signed(0.3), color, {
      ry: rng.signed(0.3), outline: 0x2a3a2a,
    });
    timber(0.85, 0.1, 0.85, -8.5 + i * 0.95, 1.15, -9.5, 0x2a2c30, { outline: 0x1a1c20 });
  });
  timber(0.75, 1.1, 0.75, -10.6, 0.4, -8.6, LOT.binGrey, { rz: Math.PI / 2, outline: 0x2a3a2a });

  // Kiddie pool, ringed with a lip you trip over rather than climb.
  timber(3.2, 0.35, 3.2, -9.5, 0.17, 9.0, LOT.cart, { outline: 0xa06a20, chamfer: 0.06 });
  put({
    w: 2.7, h: 0.12, d: 2.7,
    x: -9.5, y: 0.3, z: 9.0,
    color: 0x4fc3e8, outline: 0x2a86a8, chamfer: 0.02, ghost: true,
  });

  // Doghouse, with a plank ramp leaning on it that goes nowhere useful.
  timber(1.7, 1.3, 2.0, -19.5, 0.65, -2.5, LOT.dogRed, { outline: 0x7a2a1a });
  put({
    w: 2.1, h: 0.22, d: 2.2,
    x: -19.5, y: 1.45, z: -2.5,
    rz: 0.22,
    color: LOT.roofDark, outline: 0x3a2c2a, chamfer: 0.02,
  });
  put({
    w: 3.0, h: 0.18, d: 0.9,
    x: -17.6, y: 0.7, z: -2.5,
    rz: -0.42,
    color: LOT.plank, outline: WOOD_LINE, chamfer: 0.01,
  });

  // Clothesline between two poles, with sheets that do not block anything.
  for (const z of [-6.5, -0.5]) {
    timber(0.18, 2.6, 0.18, -12.5, 1.3, z, LOT.plankPale);
  }
  put({
    w: 0.06, h: 0.06, d: 6.0,
    x: -12.5, y: 2.5, z: -3.5,
    color: 0x9a8a70, outline: DARK, chamfer: 0.01, ghost: true,
  });
  for (let i = 0; i < 3; i++) {
    put({
      w: 0.05, h: 1.3, d: 1.2,
      x: -12.5, y: 1.85, z: -5.6 + i * 1.9,
      rx: rng.signed(0.05),
      color: LOT.cloth, outline: 0xb8b0a0, chamfer: 0.01, ghost: true,
    });
  }

  // Lumber against the fence — the visual promise that this is a building game.
  for (let i = 0; i < 9; i++) {
    timber(
      rng.pick([1.4, 2.2, 0.9]), 0.09, 0.3,
      -21.5 + rng.signed(0.8), 0.05 + Math.floor(i / 3) * 0.1, 7.5 + rng.signed(1.6),
      i % 2 === 0 ? LOT.plank : LOT.plankPale,
      { ry: rng.range(0, Math.PI), rz: rng.signed(0.03) },
    );
  }

  flagSurround(LEFT_FLAG.x, LEFT_FLAG.z, LOT.swing);
}

function rightYard(rng: Rng): void {
  // Swing set: two A-frames and a bar, the classic silhouette.
  const sx = 11.5;
  const sz = -4.0;
  for (const side of [-1, 1]) {
    for (const lean of [-1, 1]) {
      put({
        w: 0.18, h: 3.0, d: 0.18,
        x: sx + side * 2.4, y: 1.45, z: sz + lean * 0.75,
        rx: lean * -0.24,
        color: LOT.metal, outline: 0x4a4f54, chamfer: 0.02,
      });
    }
  }
  timber(5.4, 0.2, 0.2, sx, 2.85, sz, LOT.swing, { outline: 0x8a3226, chamfer: 0.02 });
  for (const dx of [-1.2, 1.2]) {
    put({
      w: 0.06, h: 1.9, d: 0.06,
      x: sx + dx, y: 1.9, z: sz,
      color: 0x6a6a70, outline: DARK, chamfer: 0.01, ghost: true,
    });
    timber(0.8, 0.1, 0.34, sx + dx, 0.95, sz, LOT.plank);
  }

  // Tyre stack, the universal backyard obstacle.
  for (let i = 0; i < 4; i++) {
    timber(1.5, 0.42, 1.5, 7.2 + rng.signed(0.12), 0.21 + i * 0.42, 8.5 + rng.signed(0.12),
      LOT.tyre, { ry: rng.range(0, Math.PI), outline: 0x1a1a1e, chamfer: 0.12 });
  }

  // Sandbox and a plank across it.
  for (const [w, d, ox, oz] of [[3.4, 0.2, 0, -1.6], [3.4, 0.2, 0, 1.6], [0.2, 3.4, -1.6, 0], [0.2, 3.4, 1.6, 0]] as const) {
    timber(w, 0.34, d, 15.5 + ox, 0.17, 6.5 + oz, LOT.plank);
  }
  timber(3.8, 0.12, 0.34, 15.5, 0.42, 6.5, LOT.plankPale, { ry: 0.2 });

  // Barbecue and two lawn chairs, because someone's dad is always out here.
  timber(1.1, 0.9, 0.8, 8.5, 0.45, -9.5, LOT.bbq, { outline: 0x16181c });
  timber(1.25, 0.16, 0.95, 8.5, 0.98, -9.5, LOT.metal, { outline: 0x4a4f54, chamfer: 0.04 });
  for (let i = 0; i < 2; i++) {
    put({
      w: 0.9, h: 0.12, d: 1.5,
      x: 10.6 + i * 1.3, y: 0.42, z: -9.0 + rng.signed(0.4),
      rx: -0.5, ry: rng.signed(0.3),
      color: i === 0 ? LOT.swing : LOT.door,
      outline: DARK, chamfer: 0.02,
    });
  }

  // Wheelbarrow, tipped, half full of nothing.
  timber(1.5, 0.5, 0.9, 19.0, 0.45, 8.0, LOT.metal, { rz: 0.5, outline: 0x4a4f54, chamfer: 0.05 });
  timber(0.12, 0.9, 0.12, 18.2, 0.5, 8.4, LOT.plankPale, { rz: 1.1 });

  // A hedge, the only thing on this side that hides anything.
  for (let i = 0; i < 5; i++) {
    timber(1.7, 1.5, 1.7, 21.0, 0.75, -2.0 + i * 1.7, LOT.hedge, {
      ry: rng.range(0, Math.PI), outline: 0x2f5f22, chamfer: 0.22,
    });
  }

  flagSurround(RIGHT_FLAG.x, RIGHT_FLAG.z, LOT.door);
}

/**
 * A low ring of crates around a flag stand.
 *
 * Cover you did not have to build, so the first thirty seconds of a round are
 * not spent on the same four walls every time — and low enough that it is a
 * starting point rather than a finished fort.
 */
function flagSurround(x: number, z: number, accent: number): void {
  const ring: ReadonlyArray<readonly [number, number]> = [
    [-2.6, -1.4], [-2.6, 1.4], [2.6, -1.4], [2.6, 1.4], [0, -2.8], [0, 2.8],
  ];
  for (const [ox, oz] of ring) {
    timber(1.1, 0.85, 1.1, x + ox, 0.42, z + oz, LOT.plank, { ry: (ox + oz) * 0.1 });
  }
  timber(1.6, 0.22, 1.6, x, 0.11, z, accent, { outline: DARK, chamfer: 0.04 });
}

/**
 * The front of the property: the drive inside the fence, and the cart.
 *
 * This used to be the street itself — a strip of tarmac running off both edges
 * of the world, inside the lot's own fence, which is not where a road goes. The
 * road is outside now, in `culDeSac.ts`, and what is left here is the drive it
 * arrives at.
 */
function street(): void {
  put({
    w: 12, h: 0.06, d: 5.0,
    x: 0, y: 0.02, z: -20.5,
    color: 0xb8b4aa, outline: 0x7a776e, chamfer: 0.02, ghost: true,
  });
  timber(2.4, 0.25, 1.3, -4.5, 0.42, -18.5, LOT.cart, { outline: 0xa06a20 });
  for (const [ox, oz] of [[-0.9, -0.6], [-0.9, 0.6], [0.9, -0.6], [0.9, 0.6]] as const) {
    timber(0.5, 0.5, 0.22, -4.5 + ox, 0.25, -18.5 + oz, LOT.tyre, {
      outline: 0x1a1a1e, chamfer: 0.08,
    });
  }
  // Mailbox, leaning, as every mailbox in this neighborhood is.
  timber(0.14, 1.1, 0.14, 5.5, 0.55, -17.5, LOT.plankPale, { rz: 0.12 });
  timber(0.4, 0.35, 0.7, 5.62, 1.25, -17.5, LOT.metal, { rz: 0.12, outline: 0x4a4f54, chamfer: 0.05 });
}

/**
 * The second pass: everything that makes the lot look lived in.
 *
 * Deliberately a small catalogue of repeated sizes rather than a unique box per
 * object. Scenery is instanced by exact dimensions, so nine crates that are all
 * 0.9m are one draw call and nine crates that are all slightly different are
 * eighteen. Variety comes from rotation, colour and placement, which are free.
 *
 * The back lawns needed this most. A house and two flags on open grass is a
 * diagram of a map rather than a place, and there is nowhere to take cover on
 * the way across.
 */
/**
 * The trampolines and the slides, as things you can see and stand on.
 *
 * Built from the item list rather than typed out again, so a pad that moves
 * moves its picture with it. The one thing that must line up is the top
 * surface: `items.ts` states a `y` and the effect keys on it, so the geometry
 * has to put a real surface there or the player falls through a working
 * trampoline. `items.test.ts` holds the two together.
 */
function playthings(): void {
  for (const item of ITEMS) {
    if (item.kind === 'trampoline') {
      // A sprung mat on a frame: the mat is the surface the effect keys on, the
      // legs are why it is off the ground.
      timber(item.halfW * 2, 0.1, item.halfD * 2, item.x, item.y - 0.05, item.z,
        0x2b4c8c, { outline: 0x16294d, chamfer: 0.04 });
      timber(item.halfW * 2 + 0.18, 0.12, item.halfD * 2 + 0.18,
        item.x, item.y - 0.16, item.z, 0x3a3f45, { chamfer: 0.05 });
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          timber(0.12, item.y - 0.2, 0.12,
            item.x + sx * (item.halfW - 0.05), (item.y - 0.2) / 2, item.z + sz * (item.halfD - 0.05),
            0x3a3f45);
        }
      }
      continue;
    }

    // A slide is a wet plastic sheet: almost flat, and bright enough that
    // somebody sprinting past reads it as a lane rather than as a puddle.
    //
    // Ghosted, and that is load-bearing rather than tidy. A sheet six
    // centimetres thick is walked straight over by any character — the step-up
    // clears nine times that — but the flow field the kids route on marks a
    // cell occupied when anything solid is in it, whatever its height. Solid,
    // these two lanes quietly diverted every bot on their side of the house
    // and three of Water War's balance measurements moved. The effect keys on
    // position, not on standing on a slab, so nothing is lost by making it
    // scenery.
    timber(item.halfW * 2, 0.06, item.halfD * 2, item.x, item.y - 0.03, item.z,
      0x37b9d8, { ry: item.ry, outline: 0x1d7791, chamfer: 0.03, ghost: true });
    // A darker stripe down the middle, ghosted so it cannot catch a toe.
    timber(item.halfW * 0.5, 0.02, item.halfD * 2 - 0.3, item.x, item.y + 0.01, item.z,
      0x1d7791, { ry: item.ry, ghost: true });
  }
}

function clutter(rng: Rng): void {
  const crate = (x: number, z: number, y = 0.45, tint: number = LOT.plank) =>
    timber(0.9, 0.9, 0.9, x, y, z, tint, { ry: rng.range(0, Math.PI) });
  const bush = (x: number, z: number) =>
    timber(1.4, 1.4, 1.4, x, 0.7, z, LOT.hedge, {
      ry: rng.range(0, Math.PI), outline: 0x2f5f22, chamfer: 0.2,
    });
  const log = (x: number, z: number, ry = 0) =>
    timber(1.8, 0.36, 0.36, x, 0.18, z, LOT.trunk, { ry, outline: 0x4a3122, chamfer: 0.08 });
  const gnome = (x: number, z: number, hat: number) => {
    timber(0.3, 0.42, 0.3, x, 0.21, z, LOT.cloth, { chamfer: 0.06, ghost: true });
    timber(0.26, 0.3, 0.26, x, 0.55, z, hat, { chamfer: 0.09, ghost: true });
  };

  // ── Right back: the garden shed everyone's dad keeps locked ────────────────
  timber(3.4, 2.4, 2.8, 13.5, 1.2, 14.5, LOT.wallShade, { outline: 0x8a6a52, chamfer: 0.02 });
  put({
    w: 3.9, h: 0.22, d: 3.2,
    x: 13.5, y: 2.55, z: 14.5,
    rz: -0.18,
    color: LOT.roofDark, outline: 0x3a2c2a, chamfer: 0.02,
  });
  timber(0.9, 1.8, 0.1, 13.5, 0.9, 13.05, LOT.trim, { outline: 0x6a2320, ghost: true });
  // A crate against the shed: the step onto its roof, and onto the roof beyond.
  crate(11.4, 13.6);
  crate(11.5, 14.6, 1.35);

  // ── Picnic table ──────────────────────────────────────────────────────────
  timber(2.2, 0.14, 1.2, 8.0, 0.78, 3.0, LOT.plankPale);
  for (const [ox, oz] of [[-0.9, -0.45], [-0.9, 0.45], [0.9, -0.45], [0.9, 0.45]] as const) {
    timber(0.14, 0.78, 0.14, 8.0 + ox, 0.39, 3.0 + oz, LOT.plank);
  }
  for (const oz of [-0.85, 0.85]) {
    timber(2.2, 0.12, 0.4, 8.0, 0.46, 3.0 + oz, LOT.plankPale);
  }

  // ── Left back: a see-saw, permanently stuck one end down ──────────────────
  timber(0.5, 0.55, 0.9, -8.0, 0.27, 15.0, LOT.tyre, { outline: 0x1a1a1e, chamfer: 0.12 });
  put({
    w: 3.8, h: 0.16, d: 0.5,
    x: -8.0, y: 0.62, z: 15.0,
    rz: 0.2,
    color: LOT.swing, outline: 0x8a3226, chamfer: 0.02,
  });

  // ── A bike, leaning where bikes lean ──────────────────────────────────────
  for (const oz of [-0.55, 0.55]) {
    timber(1.1, 1.1, 0.14, -18.5, 0.55, 12.0 + oz, LOT.tyre, {
      rz: 0.18, outline: 0x1a1a1e, chamfer: 0.5,
    });
  }
  timber(1.5, 0.12, 0.12, -18.5, 0.85, 12.0, LOT.door, { rz: 0.18 });

  // ── Compost bin and a woodpile ────────────────────────────────────────────
  timber(1.4, 1.2, 1.4, -20.0, 0.6, 17.0, LOT.binGreen, { outline: 0x2a3a2a });
  for (let i = 0; i < 6; i++) {
    log(-16.5 + (i % 3) * 0.42, 17.5, Math.PI / 2);
  }
  for (let i = 0; i < 3; i++) {
    log(-16.5 + i * 0.42, 17.5, Math.PI / 2);
  }

  // ── Bushes, softening the fence lines on both sides ───────────────────────
  for (const [x, z] of [
    [-22.0, -6.0], [-22.0, -3.0], [-21.5, 0.5], [-22.0, 20.0], [-13.0, 21.5],
    [-4.0, 21.0], [5.0, 20.5], [18.5, 18.0], [22.0, 12.0], [22.0, 8.5],
    [21.0, -13.0], [17.0, -18.5], [-8.0, -18.0], [-15.5, -19.0],
  ] as const) {
    bush(x + rng.signed(0.4), z + rng.signed(0.4));
  }

  // ── Crates and junk, scattered where the crossing routes run ──────────────
  for (const [x, z] of [
    [-6.5, 10.5], [-7.4, 11.2], [-6.9, 10.8], [-11.0, -16.5], [-9.8, -16.0],
    [6.5, 10.0], [7.4, 10.6], [4.5, -16.0], [5.6, -16.4], [3.5, 17.5],
    [-3.5, 16.0], [-19.0, 5.5], [19.5, 3.0], [20.2, 4.0],
  ] as const) {
    crate(x, z, 0.45, rng.chance(0.4) ? LOT.plankPale : LOT.plank);
  }
  crate(-6.9, 10.8, 1.35, LOT.plankPale);
  crate(5.0, -16.2, 1.35, LOT.plank);

  // ── Logs and pipes, low cover you can vault ───────────────────────────────
  log(-14.0, -11.0, 0.3);
  log(-12.5, -10.6, 0.3);
  log(10.0, 17.0, 1.2);
  log(-2.0, -11.5, 0.0);
  log(2.5, 12.0, 0.6);

  // ── Flower beds against the house, and gnomes guarding them ───────────────
  for (const side of [-1, 1]) {
    for (const z of [-4.4, 0, 4.4]) {
      timber(0.8, 0.34, 3.4, side * (HOUSE.halfWidth + 0.7), 0.17, z, LOT.soil, {
        outline: 0x6a4a2a, chamfer: 0.03,
      });
    }
  }
  gnome(-6.4, -6.0, LOT.trim);
  gnome(6.4, 6.0, LOT.door);
  gnome(-17.0, -6.5, LOT.binGreen);

  // ── A lamp post out front, because the street needed a vertical ───────────
  timber(0.22, 4.4, 0.22, 8.5, 2.2, -17.5, LOT.metal, { outline: 0x4a4f54 });
  timber(0.6, 0.5, 0.6, 8.5, 4.6, -17.5, LOT.cloth, {
    chamfer: 0.12, ghost: true,
    // The nearest street light to the lot, and the only one inside the fog's
    // near plane, so it is the one that reads as an object with a light in it
    // rather than as a glow on the horizon.
    lit: { color: 0xffdc96, bloom: 0.85 },
  });
}

/**
 * The rain barrel and the garden tap.
 *
 * The paddling pool is already in the left yard, so only two need building. Each
 * one is a landmark before it is an objective — you should be able to say "the
 * tap" and have somebody know where you mean.
 */
function waterworks(): void {
  const butt = WATER_SOURCES.find((w) => w.key === 'butt')!;
  timber(1.8, 1.9, 1.8, butt.x, 0.95, butt.z, 0x4a6f5a, {
    outline: 0x2a4436, chamfer: 0.28,
  });
  timber(2.0, 0.16, 2.0, butt.x, 1.96, butt.z, LOT.plank);
  // A tap on the barrel, and a puddle under it that never dries.
  timber(0.14, 0.14, 0.4, butt.x, 0.7, butt.z - 1.0, LOT.metal, { outline: 0x4a4f54 });
  put({
    w: 2.6, h: 0.05, d: 2.6,
    x: butt.x, y: 0.03, z: butt.z - 1.6,
    color: 0x6fb8d8, outline: 0x3a7a96, chamfer: 0.2, ghost: true,
  });

  const tap = WATER_SOURCES.find((w) => w.key === 'tap')!;
  timber(0.5, 0.9, 0.5, tap.x, 0.45, tap.z, 0x8a8f96, { outline: 0x4a4f54, chamfer: 0.06 });
  timber(0.16, 0.5, 0.16, tap.x, 1.1, tap.z, LOT.metal, { outline: 0x4a4f54 });
  timber(0.16, 0.16, 0.5, tap.x, 1.28, tap.z - 0.2, LOT.metal, { outline: 0x4a4f54 });
  // A coiled hose, which is what makes the tap worth standing next to.
  for (let i = 0; i < 3; i++) {
    timber(1.5 - i * 0.35, 0.12, 1.5 - i * 0.35, tap.x + 0.9, 0.07 + i * 0.12, tap.z + 0.5,
      0x3f8a4f, { outline: 0x246030, chamfer: 0.05 });
  }
  put({
    w: 2.4, h: 0.05, d: 2.4,
    x: tap.x, y: 0.03, z: tap.z,
    color: 0x6fb8d8, outline: 0x3a7a96, chamfer: 0.2, ghost: true,
  });
}

// ── Making it solid ──────────────────────────────────────────────────────────

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

/**
 * Install the map's solid geometry into the collision world.
 *
 * Fixtures rather than parts: the player can stand on the roof, snap a ladder to
 * the wall and route bots around the house, but cannot delete any of it.
 */
export function installFixtures(world: CollisionWorld, list: readonly Slab[]): void {
  for (const s of list) {
    if (s.ghost === true) continue;
    _e.set(s.rx ?? 0, s.ry ?? 0, s.rz ?? 0, 'YXZ');
    _q.setFromEuler(_e);
    world.addFixture(
      0, 0,
      s.x, s.y, s.z,
      _q.x, _q.y, _q.z, _q.w,
      s.w / 2, s.h / 2, s.d / 2,
      null,
      { climbable: s.climbable === true },
    );
  }
}
