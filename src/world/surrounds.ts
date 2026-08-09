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
function woods(out: Slab[], rng: Rng, canopy: readonly [number, number, number]): void {
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
    woodTree(out, x, z, size, canopy[rng.int(0, 2)]!, rng.next() * Math.PI);
    placed++;
  }
}

/**
 * The building site's footprint, exported so the test that keeps it clear and
 * the site itself cannot drift apart.
 *
 * At radius ~37.6 from the origin it sits inside the treeline's inner ring
 * (44), so no scattered trunk can land in it by construction — the annulus is
 * the keepout, and adding a second one here would be a guard nothing can
 * falsify. The houses either side at (39, 4) and (36, 24) leave this stretch
 * south of the side lawn clear.
 */
export const SITE = { x: 36.5, z: -9, halfW: 4.2, halfD: 3.6 } as const;

/**
 * Every dressed pocket outside the fence, footprint by footprint, exported so
 * one sweep can hold them all clear. The bands around the lot are where Tag
 * actually runs, and a pocket is a landmark before it is cover: "behind the
 * pond", "at the coop", "round the firepit" are callouts, and callouts are
 * what a chase is made of.
 */
/**
 * The pond's shoreline: radius by angle, three low-frequency lobes. One
 * function serves the water polygon and the stone ring, which is what keeps
 * the stones on the shore however the shape is tuned.
 */
export const POND_EDGE = (a: number): number =>
  2.7 + 0.85 * Math.abs(Math.sin(a + 0.85)) + 0.4 * Math.sin(a * 3 + 1.2);

export const POCKETS = [
  { name: 'site', ...SITE },
  { name: 'pond', x: -35, z: -7, halfW: 4.6, halfD: 4.2 },
  { name: 'coop', x: 10, z: 27.2, halfW: 3.2, halfD: 2.4 },
  { name: 'firepit', x: -35, z: 16, halfW: 2.9, halfD: 2.9 },
] as const;

/**
 * The building site: the one corner of the neighbourhood that is *about* the
 * thing this game is about.
 *
 * Two pallet stacks at step heights, a skip you can get on top of from them, a
 * half-framed stud wall, a sand heap you can walk up, and some dropped lumber.
 * In Tag this is cover and a vantage; everywhere it is the world telling you
 * that building is what people do here. Everything is solid — it collides,
 * shows on the minimap, and can be stood on.
 */
function buildingSite(out: Slab[]): void {
  const { x, z } = SITE;
  const lumber = 0xc9a06a;
  const pale = 0xdbc99e;
  const steel = 0x4a6b5e;

  // Pallet stacks: two heights, deliberately a staircase onto the skip.
  out.push({ w: 1.8, h: 0.45, d: 1.2, x: x - 2.3, y: 0.225, z: z - 1.8, color: lumber, outline: 0x8a6a42, chamfer: 0.03 });
  out.push({ w: 1.8, h: 0.9, d: 1.2, x: x - 2.3, y: 0.45, z: z - 0.4, color: pale, outline: 0x8a6a42, chamfer: 0.03 });
  // A plank leaning against the low stack, as one always is.
  out.push({ w: 2.0, h: 0.06, d: 0.3, x: x - 3.4, y: 0.32, z: z - 2.1, rz: 0.42, color: pale, outline: 0x8a6a42, chamfer: 0.01 });

  // The skip. A body and two lip rails, dark painted steel.
  out.push({ w: 2.6, h: 1.2, d: 1.5, x: x + 1.9, y: 0.6, z: z - 1.3, color: steel, outline: 0x263832, chamfer: 0.04 });
  for (const dz of [-0.7, 0.7]) {
    out.push({ w: 2.7, h: 0.1, d: 0.14, x: x + 1.9, y: 1.25, z: z - 1.3 + dz, color: 0x5f8272, outline: 0x263832, chamfer: 0.02 });
  }

  // A stud wall somebody framed and has not clad: a bottom plate, five studs,
  // a top plate. The most legible "under construction" shape there is.
  out.push({ w: 3.4, h: 0.1, d: 0.14, x: x + 0.6, y: 0.05, z: z + 2.6, color: pale, outline: 0x8a6a42, chamfer: 0.01 });
  for (let i = 0; i < 5; i++) {
    out.push({
      w: 0.12, h: 2.0, d: 0.12, x: x - 0.9 + i * 0.76, y: 1.1, z: z + 2.6,
      color: pale, outline: 0x8a6a42, chamfer: 0.01,
    });
  }
  out.push({ w: 3.4, h: 0.1, d: 0.14, x: x + 0.6, y: 2.15, z: z + 2.6, color: pale, outline: 0x8a6a42, chamfer: 0.01 });

  // The sand heap, as a stepped mound: each rise is under STEP_HEIGHT, so it
  // is climbed by walking, which is what a heap of sand is for.
  out.push({ w: 2.6, h: 0.5, d: 2.2, x: x - 0.6, y: 0.25, z: z - 0.2, ry: 0.2, color: 0xe8d4a0, outline: 0xc9b083, chamfer: 0.2 });
  out.push({ w: 1.7, h: 0.45, d: 1.4, x: x - 0.6, y: 0.72, z: z - 0.2, ry: 0.5, color: 0xefdcae, outline: 0xc9b083, chamfer: 0.16 });
  out.push({ w: 0.9, h: 0.35, d: 0.8, x: x - 0.6, y: 1.1, z: z - 0.2, ry: 0.8, color: 0xe8d4a0, outline: 0xc9b083, chamfer: 0.12 });

  // Dropped blocks, because no site is tidy.
  out.push({ w: 0.5, h: 0.5, d: 0.5, x: x + 1.1, y: 0.25, z: z + 1.6, ry: 0.5, color: lumber, outline: 0x8a6a42, chamfer: 0.04 });
  out.push({ w: 0.4, h: 0.4, d: 0.4, x: x + 0.4, y: 0.2, z: z - 2.4, ry: 1.1, color: pale, outline: 0x8a6a42, chamfer: 0.04 });
}

/**
 * The pond: a ring of stepping rocks round a coin of still water, and a stand
 * of cattails. The rocks are solid — the ring is a parkour circle and the
 * water is ankle-deep decoration you can wade through, because a ghost sheet
 * five centimetres up reads as shallow water and blocks nothing.
 */
function pond(out: Slab[]): void {
  const p = POCKETS[1];
  const stone = 0x9a958c;
  // Two stone sizes only, spun for variety — the draw-budget rule: a unique
  // box size is a draw call, and a ring does not need six of them.
  for (let i = 0; i < 13; i++) {
    const a = (i / 13) * Math.PI * 2;
    // The ring hugs the waterline: the shared edge, plus half a stone.
    const r = POND_EDGE(a) + 0.42 + (i % 3) * 0.12;
    const big = i % 2 === 0;
    out.push({
      w: big ? 0.72 : 0.52, h: big ? 0.46 : 0.34, d: big ? 0.62 : 0.46,
      x: p.x + Math.sin(a) * r, y: big ? 0.23 : 0.17, z: p.z + Math.cos(a) * r,
      ry: a * 0.7, color: stone, outline: 0x6a665e, chamfer: 0.09,
    });
  }
  // The water itself is not a slab at all — boxes make squares however they
  // overlap, and the first two versions proved it. The scene draws the sheet
  // as a real polygon from POND_EDGE (see addPondWater); the stones below use
  // the same edge, so ring and water cannot disagree about the shoreline.
  for (const [dx, dz] of [[-1.2, 1.6], [-0.9, 1.9], [1.5, -1.3]] as const) {
    out.push({ w: 0.06, h: 1.0, d: 0.06, x: p.x + dx, y: 0.54, z: p.z + dz, color: 0x5f7a3a, ghost: true });
    out.push({ w: 0.1, h: 0.22, d: 0.1, x: p.x + dx, y: 1.14, z: p.z + dz, color: 0x6a4a2a, chamfer: 0.03, ghost: true });
  }
}

/**
 * The chicken coop on the back strip, between the lot's fence and the
 * neighbours' hedge — the lane every suburban kid knows. A hutch with a
 * pitched lid and a gangplank, a corner of wire run, and two hens who are
 * ghosts in the collision sense only.
 */
function coop(out: Slab[]): void {
  const p = POCKETS[2];
  const wood = 0x9a6a4a;
  out.push({ w: 1.6, h: 1.1, d: 1.2, x: p.x - 1.2, y: 0.75, z: p.z, color: wood, outline: 0x5a3a26, chamfer: 0.03 });
  out.push({ w: 1.9, h: 0.08, d: 1.5, x: p.x - 1.2, y: 1.38, z: p.z, rz: -0.16, color: 0x6a5548, outline: 0x3a2c2a, chamfer: 0.02 });
  out.push({ w: 0.34, h: 0.05, d: 1.1, x: p.x - 0.25, y: 0.42, z: p.z + 0.15, ry: 0.5, rz: 0.6, color: 0xc9a06a, outline: 0x8a6a42, chamfer: 0.01 });
  // The run: three posts and two rails, open toward the lane.
  for (const [dx, dz] of [[0.2, -1.4], [2.4, -1.4], [2.4, 0.8]] as const) {
    out.push({ w: 0.08, h: 0.9, d: 0.08, x: p.x + dx, y: 0.45, z: p.z + dz, color: wood, chamfer: 0.01 });
  }
  // One rail size, turned for the second run — a size used once is a draw
  // call, and a fence corner does not need two of them.
  out.push({ w: 2.2, h: 0.05, d: 0.05, x: p.x + 1.3, y: 0.82, z: p.z - 1.4, color: 0xc9a06a, chamfer: 0.01 });
  out.push({ w: 2.2, h: 0.05, d: 0.05, x: p.x + 2.4, y: 0.82, z: p.z - 0.3, ry: Math.PI / 2, color: 0xc9a06a, chamfer: 0.01 });
  // Hens. Body, head, comb; ghost, because a chicken is not a wall.
  for (const [dx, dz, ry] of [[1.3, -0.3, 0.7], [1.9, 0.6, 2.4]] as const) {
    out.push({ w: 0.3, h: 0.26, d: 0.22, x: p.x + dx, y: 0.13, z: p.z + dz, ry, color: 0xf2ede2, outline: 0xb9b4a8, chamfer: 0.07, ghost: true });
    out.push({ w: 0.12, h: 0.14, d: 0.12, x: p.x + dx + Math.cos(ry) * 0.17, y: 0.32, z: p.z + dz - Math.sin(ry) * 0.17, color: 0xf2ede2, chamfer: 0.03, ghost: true });
    out.push({ w: 0.05, h: 0.06, d: 0.08, x: p.x + dx + Math.cos(ry) * 0.17, y: 0.42, z: p.z + dz - Math.sin(ry) * 0.17, color: 0xd8564f, chamfer: 0.01, ghost: true });
  }
}

/**
 * The firepit: a stone circle round cold embers, with two log benches. The
 * logs are solid seats and low cover; the embers are a dark coin nobody
 * trips over.
 */
function firepit(out: Slab[]): void {
  const p = POCKETS[3];
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    // The pond's small stone, re-dressed — same box, same draw.
    out.push({
      w: 0.52, h: 0.34, d: 0.46, x: p.x + Math.sin(a) * 0.98, y: 0.17, z: p.z + Math.cos(a) * 0.98,
      ry: a, color: 0x8a8578, outline: 0x5a564e, chamfer: 0.09,
    });
  }
  out.push({
    w: 1.2, h: 0.12, d: 1.2, x: p.x, y: 0.06, z: p.z, color: 0x2e2a28,
    outline: 0x1a1816, chamfer: 0.04, ghost: true,
    // The pit is lit: embers glow through the night lights pipeline, and the
    // flames themselves are live geometry the scene animates — see addCampfire.
    lit: { color: 0xff9a3c, bloom: 0.9 },
  });
  out.push({ w: 1.9, h: 0.4, d: 0.4, x: p.x - 0.4, y: 0.2, z: p.z + 1.9, ry: 0.25, color: 0x8a6242, outline: 0x4a3122, chamfer: 0.1 });
  out.push({ w: 1.9, h: 0.4, d: 0.4, x: p.x + 1.7, y: 0.2, z: p.z - 0.7, ry: 1.75, color: 0x8a6242, outline: 0x4a3122, chamfer: 0.1 });
}

/**
 * The pockets alone, with nothing else of the world in them.
 *
 * Exported for exactly one reason: the sweep that keeps their footprints
 * clear needs a reference that is *not* the world it validates. Its first
 * version derived "the pocket's own slabs" from the assembled surrounds — so
 * a pocket parked on a neighbour's house simply absorbed the house into its
 * reference set, and the sweep, comparing the world to itself, could not
 * fail. The pockets take no randomness, so this list is the same on every
 * call and every machine.
 */
export function pocketSlabs(): Slab[] {
  const out: Slab[] = [];
  buildingSite(out);
  pond(out);
  coop(out);
  firepit(out);
  return out;
}

/**
 * Everything beyond the fence that is not the cul-de-sac.
 *
 * Takes an Rng because the woods are scattered, and a seeded one because two
 * players have to be looking at the same horizon and none of it is sent.
 */
export function surroundsSlabs(
  rng: Rng,
  /** Canopy tones for the woods — the season's, or summer's. See themes.ts. */
  canopy: readonly [number, number, number] = CANOPY,
): Slab[] {
  const out: Slab[] = [];

  for (const n of AROUND) neighbourHouse(out, n);
  for (const [x, z, ry, roof] of BEYOND) farRoof(out, x, z, ry, roof);
  out.push(...pocketSlabs());

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

  woods(out, rng, canopy);
  return out;
}
