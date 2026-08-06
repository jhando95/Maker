/**
 * Everything you can see from the yard that is not the street.
 *
 * The cul-de-sac answered one direction. Standing anywhere in the lot and
 * turning round, the other three were flat green to the horizon and then sky —
 * which is worse than it sounds, because a boundary you can see past to nothing
 * tells the player the world ends at the fence. It makes the lot feel like a
 * diorama on a table rather than a garden in a place.
 *
 * So the other three sides get filled, and each one is filled with something
 * different on purpose:
 *
 * - **Behind (+Z)** the back gardens of the next street's houses, seen over
 *   their own hedge. Back-to-back gardens is what a suburban street actually
 *   does, and it is the arrangement that most says "this lot is one of many".
 * - **The sides (±X)** the neighbours either side, turned side-on, with the
 *   fence lines that separate them running away from you. Those lines are the
 *   most valuable thing here: parallel edges receding are what give a flat
 *   plane a sense of distance.
 * - **Everything past that** woods. A treeline is the cheapest possible horizon
 *   and the only one that can close a view without implying a building you
 *   might expect to reach.
 *
 * ## Nothing here is reachable and nothing here is balanced
 *
 * The rules are the two the tests check — stay outside the fence, stay on
 * ground the lawn reaches — plus one this file imposes on itself: keep the
 * distinct box sizes down, because scenery is instanced by exact dimensions and
 * a horizon is a lot of boxes. Fifty trees from three sizes cost three draws.
 */

import type { Slab } from './neighborhood.ts';
import { Rng } from '../core/rng.ts';
import { neighbourHouse, farRoof, woodTree, hedgeRun, type NeighbourSpec } from './buildings.ts';
import { culDeSacSlabs } from './culDeSac.ts';

/**
 * Where the woods begin, measured from the middle of the lot.
 *
 * Behind the houses, not among them. Set to 34 first, which put trees in the
 * band the neighbours occupy — so from the back fence you looked at a wood with
 * roofs behind it, and a ten-metre canopy standing next to a four-metre house
 * makes the house read as a shed. The order has to be hedge, then houses, then
 * trees, because that is the order of distances the eye is being told about.
 */
const TREELINE_INNER = 44;
/** And where they stop, which has to be inside the lawn. */
const TREELINE_OUTER = 62;

/** Canopy tones. Three, so a wood is not one colour at the one scale it is seen. */
const CANOPY = [0x4f9a3a, 0x3d7a2c, 0x5aa845] as const;

/**
 * The houses either side and behind.
 *
 * Turned to show what a neighbour actually shows you: the side of the house and
 * the length of the garden, not the front door. Only the cul-de-sac's houses
 * face the player, because only they are on the same road.
 */
const AROUND: readonly NeighbourSpec[] = [
  // Behind, backing onto the lot across two gardens. Facing away, so what you
  // see is the back of a house at the far end of somebody's lawn.
  { x: -16, z: 46, ry: Math.PI - 0.12, wall: 0xe9dcc4, roof: 0x7d4f43, trim: 0xc9603f, drive: 0, noDrive: true },
  { x: 4, z: 49, ry: Math.PI + 0.05, wall: 0xdde2e6, roof: 0x5f7a52, trim: 0x4a7fa8, drive: 0, noDrive: true },
  { x: 24, z: 45, ry: Math.PI - 0.2, wall: 0xf0e2c4, roof: 0x6e4f7a, trim: 0xd8564f, drive: 0, noDrive: true },
  // Either side, turned side-on.
  { x: -40, z: 6, ry: -Math.PI / 2 + 0.1, wall: 0xe2d6bd, roof: 0x8a5040, trim: 0x6e8f5a, drive: 0, noDrive: true },
  { x: -37, z: 26, ry: -Math.PI / 2 - 0.15, wall: 0xdedad0, roof: 0x7d4f43, trim: 0x4a7fa8, drive: 0, noDrive: true },
  { x: 39, z: 4, ry: Math.PI / 2 - 0.08, wall: 0xe7d9c2, roof: 0x5f7a52, trim: 0xc9603f, drive: 0, noDrive: true },
  { x: 36, z: 24, ry: Math.PI / 2 + 0.12, wall: 0xf0e2c4, roof: 0x9a6a4a, trim: 0xd8564f, drive: 0, noDrive: true },
];

/** Roofs with nothing under them, filling the gaps between the above. */
const BEYOND: ReadonlyArray<[x: number, z: number, ry: number, roof: number]> = [
  [-30, 56, 0.2, 0x6a5548], [14, 58, -0.1, 0x8a5040], [40, 40, -0.7, 0x7d4f43],
  [-48, 38, 0.8, 0x5f7a52], [-52, 12, 1.5, 0x6e4f7a], [50, 20, -1.4, 0x7d4f43],
  [52, -8, -1.6, 0x8a5040], [-54, -6, 1.6, 0x6a5548],
];

/**
 * Everything the street already occupies, as circles to keep clear of.
 *
 * Derived from the street's own slabs rather than described here as a rectangle
 * or two. The hand-written version worked and was quietly wrong in an expensive
 * way: to be safe it had to claim the whole southern sector, which meant no
 * trees anywhere behind the cul-de-sac — the one direction that most needed
 * something on the horizon, blanked to avoid a collision with a road seven
 * metres wide.
 *
 * Computed once, because this runs a few hundred times against a hundred-odd
 * slabs and neither number is worth doing twice.
 */
const STREET_KEEPOUT: ReadonlyArray<readonly [x: number, z: number, r: number]> =
  culDeSacSlabs().map((s) => {
    const c = Math.abs(Math.cos(s.ry ?? 0));
    const n = Math.abs(Math.sin(s.ry ?? 0));
    return [
      s.x, s.z,
      Math.max((s.w / 2) * c + (s.d / 2) * n, (s.w / 2) * n + (s.d / 2) * c) + 3.5,
    ] as const;
  });

/**
 * Is this spot already spoken for?
 *
 * The lot itself, anything the street put down, and a margin round each
 * building. A tree growing through a roof is the failure mode a scattered
 * treeline has, and it is why the scatter is rejected against a list rather
 * than confined to an annulus and hoped for.
 */
function occupied(x: number, z: number): boolean {
  // The lot, with room to spare so nothing crowds the fence.
  if (Math.abs(x) < 30 && Math.abs(z) < 30) return true;
  for (const [sx, sz, r] of STREET_KEEPOUT) {
    if (Math.abs(x - sx) < r && Math.abs(z - sz) < r) return true;
  }
  for (const n of AROUND) {
    if (Math.abs(x - n.x) < 9 && Math.abs(z - n.z) < 9) return true;
  }
  for (const [bx, bz] of BEYOND) {
    if (Math.abs(x - bx) < 8.5 && Math.abs(z - bz) < 8.5) return true;
  }
  return false;
}

/**
 * The woods, scattered on a ring.
 *
 * Rejection sampling on an annulus rather than a neat arc, because a treeline
 * placed on a curve reads as a hedge someone let grow: what makes woods look
 * like woods is depth — some trees in front of others — and that needs a band
 * rather than a line.
 */
function woods(out: Slab[], rng: Rng): void {
  let placed = 0;
  for (let tries = 0; tries < 2400 && placed < 170; tries++) {
    const angle = rng.next() * Math.PI * 2;
    const radius = TREELINE_INNER + rng.next() * (TREELINE_OUTER - TREELINE_INNER);
    const x = Math.sin(angle) * radius;
    const z = Math.cos(angle) * radius;
    if (occupied(x, z)) continue;
    // Bigger further out, so the near edge of the wood does not tower over the
    // houses in front of it.
    const size = radius > 56 ? 2 : radius > 50 ? rng.int(1, 2) : rng.int(0, 1);
    woodTree(out, x, z, size, CANOPY[rng.int(0, 2)]!, rng.next() * Math.PI);
    placed++;
  }
}

/**
 * Everything beyond the fence that is not the cul-de-sac.
 *
 * Takes an Rng because the woods are scattered, and a seeded one because two
 * players have to be looking at the same horizon and none of it is sent.
 */
export function surroundsSlabs(rng: Rng): Slab[] {
  const out: Slab[] = [];

  for (const n of AROUND) neighbourHouse(out, n);
  for (const [x, z, ry, roof] of BEYOND) farRoof(out, x, z, ry, roof);

  // The hedge along the back, which is the boundary the lot's own back fence
  // looks across. Two runs with a gap, because an unbroken thirty-metre hedge
  // reads as a wall.
  hedgeRun(out, -34, 30, -6, 30.6);
  hedgeRun(out, 4, 30.6, 32, 30);
  // And the two fence lines running away either side, which are the most
  // valuable thing out here: parallel edges receding are what give a flat plane
  // a sense of distance.
  hedgeRun(out, -31, 28, -31, 44, 1.6);
  hedgeRun(out, 29, 28, 29, 44, 1.6);
  hedgeRun(out, -30, -18, -30, 2, 1.7);
  hedgeRun(out, 30, -18, 30, 2, 1.7);

  woods(out, rng);
  return out;
}
