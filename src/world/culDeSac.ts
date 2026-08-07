/**
 * The street the lot sits at the end of.
 *
 * There was one slab of tarmac here, forty-six metres by five, running off both
 * edges of the world. It answered "is there a road" and nothing else, and the
 * question it left open is the one that matters: *where is this*. A road that
 * runs off the map in both directions says the lot is a sample of somewhere
 * uniform. A road that ends says the lot is a place.
 *
 * So it ends. The tarmac comes in from the west, widens into a turning head in
 * front of the house, and stops — and five other houses stand round it, facing
 * in, close enough to read and far enough to fog. That shape is the whole point:
 * a cul-de-sac is the one street layout where every house is looking at the same
 * patch of ground, which is exactly the fiction this game runs on. The kids on
 * it all know each other because the road made them.
 *
 * ## What it is for, beyond looking right
 *
 * Depth. Standing in the yard, everything used to end at a fence with flat green
 * behind it, so the world was as deep as the lot and the eye had nothing to
 * travel over. Roofs at thirty and forty metres, half in the fog, give the view
 * a middle and a far distance — and they cost nothing to walk to, because you
 * cannot. They are scenery, and they say so: no interiors, no doors that open.
 *
 * ## Everything here is outside the fence
 *
 * Deliberately, and it is the constraint that shaped the layout. The play area
 * is the fenced lot and the modes are balanced around its dimensions — spawns,
 * flag bases, the nav fields' extent. Moving the fence to make room would be a
 * change to three modes disguised as a change to some scenery.
 */

import type { Slab } from './neighborhood.ts';
import { neighbourHouse, farRoof, shade, type NeighbourSpec } from './buildings.ts';

/**
 * Where the tarmac stops being a road and becomes a turning head.
 *
 * Set back far enough to leave a verge between the kerb and the lot's front
 * fence. The first attempt had the head reaching the fence, and the result was
 * one continuous grey field from the pickets to the neighbours' front doors —
 * which reads as a car park rather than as a road, because what makes tarmac a
 * road is the green either side of it.
 */
export const BULB = { x: 0, z: -37, radius: 9.5 } as const;

/** How wide the road is, kerb to kerb. */
const ROAD_WIDTH = 7;

/** The near kerb, which is the first thing you see over the front fence. */
const ROAD_Z = BULB.z;

export const TARMAC = 0x8a8a90;
const TARMAC_LINE = 0x5a5a60;
const KERB = 0xc4c0b6;
const PAVEMENT = 0xb8b4aa;

/**
 * The neighbours.
 *
 * Placed by hand rather than scattered, because a cul-de-sac is a shape and the
 * shape is the content: houses face the head, driveways run off it, and the two
 * at the mouth turn to follow the road in. A seeded scatter would produce a
 * clearing with buildings in it.
 *
 * `ry` is which way the front faces, in radians, with 0 meaning toward +z.
 */
const NEIGHBOURS: readonly NeighbourSpec[] = [
  // Three round the head, turned to face its centre. The angles matter more
  // than the positions: houses in a row read as a terrace on a through road
  // however round the tarmac in front of them is, and it is the fanning that
  // says the street ends here.
  { x: -17, z: -47.5, ry: 0.42, wall: 0xe7d9c2, roof: 0x6e4f7a, trim: 0xc9603f, drive: 3.2 },
  { x: 0.5, z: -51.5, ry: 0.02, wall: 0xf0e2c4, roof: 0x5f7a52, trim: 0xd8564f, drive: 2.6 },
  { x: 17.5, z: -47, ry: -0.4, wall: 0xd9e0e6, roof: 0x8a5040, trim: 0x4a7fa8, drive: -3.0 },
  // And two along the approach, turned to face the road rather than the head,
  // which is what tells you the tarmac arrived from somewhere.
  { x: -30, z: -46, ry: 0.95, wall: 0xe2d6bd, roof: 0x7d4f43, trim: 0x6e8f5a, drive: 3.4 },
  { x: -38, z: -28, ry: 1.5, wall: 0xdedad0, roof: 0x9a6a4a, trim: 0x4a7fa8, drive: 2.8 },
];

/**
 * Roofs with nothing under them, out past everything else.
 *
 * Deep in the fog and never approached, so they are two boxes each: a gable and
 * the suggestion of a wall. What they buy is the difference between a
 * neighbourhood that stops at five houses and one that carries on — which is
 * most of what makes a street feel like it is somewhere rather than a set.
 */
const FAR_ROOFS: ReadonlyArray<[x: number, z: number, ry: number, roof: number]> = [
  [-38, -52, 0.3, 0x7d4f43], [-18, -56, 0.1, 0x6a5548], [5, -57, -0.15, 0x8a5040],
  [30, -50, -0.5, 0x5f7a52], [44, -30, -1.2, 0x6e4f7a], [-48, -18, 1.3, 0x7d4f43],
];

/**
 * A regular polygon of tarmac, as overlapping wedges.
 *
 * A `Slab` is a box, so a disc has to be assembled from them. Each wedge is a
 * box reaching from the centre to the rim, rotated into place; twelve of them
 * read as round at any distance a player will ever see this from.
 *
 * They are stacked a fraction of a millimetre apart rather than laid at one
 * height. All twelve overlap at the centre, and coplanar top faces of the same
 * colour z-fight across the whole junction — a shimmering starburst in the
 * middle of the road that moves as you walk. Seven millimetres of total spread
 * across twelve wedges is invisible on a surface nobody stands closer than a
 * fence to, and it gives the depth buffer an order to work with.
 */
function disc(out: Slab[], x: number, z: number, radius: number, wedges = 12): void {
  const chord = 2 * radius * Math.sin(Math.PI / wedges);
  for (let i = 0; i < wedges; i++) {
    const a = (i / wedges) * Math.PI * 2;
    out.push({
      // A shade over the chord, so neighbouring wedges overlap rather than
      // leaving a hairline of grass showing between them.
      w: chord * 1.08, h: 0.06, d: radius,
      x: x + Math.sin(a) * radius * 0.5,
      y: 0.02 + i * 0.0006,
      z: z + Math.cos(a) * radius * 0.5,
      ry: a,
      color: TARMAC, outline: TARMAC_LINE, chamfer: 0.02, ghost: true,
    });
  }
}

/** A box that is scenery: no outline debate, no collision. */
function flat(
  out: Slab[], w: number, d: number, x: number, z: number, color: number,
  opts: Partial<Slab> = {},
): void {
  out.push({
    w, h: 0.07, d, x, y: 0.025, z,
    color, outline: TARMAC_LINE, chamfer: 0.015, ghost: true, ...opts,
  });
}

/**
 * The whole street, as slabs.
 *
 * Returned rather than pushed into the map's own list, so this file never has to
 * know how `neighborhoodSlabs` accumulates — and so the whole neighbourhood can
 * be built and measured on its own.
 */
export function culDeSacSlabs(): Slab[] {
  const out: Slab[] = [];

  // ── The tarmac ─────────────────────────────────────────────────────────────
  disc(out, BULB.x, BULB.z, BULB.radius);
  // The approach, running west out of the head and into the fog. Long enough
  // that it leaves the drawn world rather than stopping in it, which is the
  // difference between a road going somewhere and a road that has been cut off.
  out.push({
    w: 40, h: 0.06, d: ROAD_WIDTH,
    x: -30, y: 0.021, z: ROAD_Z,
    color: TARMAC, outline: TARMAC_LINE, chamfer: 0.02, ghost: true,
  });

  // ── Kerb and pavement ──────────────────────────────────────────────────────
  //
  // A kerb is what makes tarmac read as a road rather than as a grey patch: it
  // is the one line in the whole scene that is dead straight and dead level, and
  // the eye uses it to place everything else.
  for (const side of [-1, 1]) {
    out.push({
      w: 38, h: 0.14, d: 0.34,
      x: -31, y: 0.07, z: ROAD_Z + side * (ROAD_WIDTH / 2 + 0.17),
      color: KERB, outline: 0x7a776e, chamfer: 0.03, ghost: true,
    });
  }
  // And round the head, following the same twelve facets as the tarmac.
  {
    const r = BULB.radius + 0.2;
    const chord = 2 * r * Math.sin(Math.PI / 16);
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      // The mouth, where the approach comes in, has no kerb across it.
      if (Math.sin(a) < -0.72) continue;
      out.push({
        w: chord * 1.1, h: 0.14, d: 0.34,
        x: BULB.x + Math.sin(a) * r,
        y: 0.07,
        z: BULB.z + Math.cos(a) * r,
        ry: a,
        color: KERB, outline: 0x7a776e, chamfer: 0.03, ghost: true,
      });
    }
  }

  // The lot's own drive, crossing the verge from the kerb up to the gate. It
  // stops a whisker short of the fence line rather than running through it,
  // because everything out here does — the moment one piece of scenery is
  // allowed inside, "outside the fence" stops being a rule anyone can check.
  flat(out, 5.4, 5.0, 0, -26.8, PAVEMENT);

  // Paint on the tarmac. Two things at once: a road with a marking on it is
  // unmistakably a road, and this is the largest single-coloured surface left
  // in the scene now that the lawn is not — so it is also the only thing
  // breaking up eleven metres of grey.
  // Stopping short of the far end of the tarmac, not running past it — the
  // dashes outlived the road by six metres when the road was shortened, and
  // painted a dotted line across open grass.
  for (let i = 0; i < 6; i++) {
    flat(out, 1.9, 0.16, -20 - i * 4.4, ROAD_Z, 0xd8d2bc, { h: 0.075 });
  }

  // ── The neighbours ─────────────────────────────────────────────────────────
  for (const n of NEIGHBOURS) neighbourHouse(out, n);
  for (const [x, z, ry, roof] of FAR_ROOFS) farRoof(out, x, z, ry, roof);

  // ── The clutter that makes it a street somebody lives on ───────────────────
  //
  // Every one of these is a silhouette at a distance rather than an object: what
  // a lamp post contributes at forty metres is a vertical, and what a parked car
  // contributes is a horizontal with a bright colour on it. That is the whole
  // job, and it is why they are boxes.
  for (const [x, z] of [[-11, -30], [10.5, -44], [-27, -41]] as const) {
    out.push({
      w: 0.22, h: 5.2, d: 0.22, x, y: 2.6, z,
      color: 0x8c9196, outline: 0x4a4f54, chamfer: 0.02,
    });
    out.push({
      w: 1.5, h: 0.18, d: 0.3, x: x + 0.6, y: 5.2, z,
      color: 0x8c9196, outline: 0x4a4f54, chamfer: 0.04, ghost: true,
    });
    out.push({
      w: 0.5, h: 0.22, d: 0.34, x: x + 1.25, y: 5.05, z,
      color: 0xf6e7a8, outline: 0x8a7a3a, chamfer: 0.06, ghost: true,
      // Thirty to forty-five metres out, over tarmac, with nothing else lit
      // near it — so the halo is the biggest on the map. It is the thing you
      // see come on from the back garden without looking for it.
      lit: { color: 0xffd98a, bloom: 0.82 },
    });
  }

  // Two cars parked on the head. Old-school: boxy, one bright, one beige.
  car(out, -7.5, -44, 0.4, 0xc8503c);
  car(out, 13.5, -42.5, -0.4, 0xd8c9a0);

  // A hoop over one of the drives. The thing that says kids live here, and the
  // only object on the street that is above eye level and not a roof.
  {
    const x = 6.4;
    const z = -29.2;
    out.push({ w: 0.2, h: 3.5, d: 0.2, x, y: 1.75, z, color: 0x8c9196, outline: 0x4a4f54, chamfer: 0.02 });
    out.push({
      w: 1.7, h: 1.1, d: 0.12, x, y: 3.5, z: z + 0.4,
      color: 0xf4f0e4, outline: 0x3a2c2a, chamfer: 0.02, ghost: true,
    });
    out.push({
      w: 0.62, h: 0.07, d: 0.62, x, y: 3.05, z: z + 0.85,
      color: 0xe05a4a, outline: 0x8a2f24, chamfer: 0.03, ghost: true,
    });
  }

  // Bins out for collection, because they always are.
  for (const [x, z, color] of [
    [-3.4, -28.2, 0x4f8a52], [-2.5, -28.2, 0x4a6fa8], [12.5, -33.5, 0x6f7378],
  ] as const) {
    out.push({
      w: 0.62, h: 1.05, d: 0.58, x, y: 0.52, z,
      color, outline: 0x2a2a2e, chamfer: 0.05,
    });
    out.push({
      w: 0.66, h: 0.09, d: 0.62, x, y: 1.09, z,
      color: 0x2f3238, outline: 0x1a1a1e, chamfer: 0.03, ghost: true,
    });
  }

  // A hydrant, which is four inches of scenery doing the work of a landmark:
  // it is the only saturated red at ground level out there.
  out.push({ w: 0.3, h: 0.75, d: 0.3, x: 13.4, y: 0.37, z: -29.5, color: 0xc8402c, outline: 0x6a2018, chamfer: 0.07 });
  out.push({ w: 0.62, h: 0.16, d: 0.22, x: 13.4, y: 0.56, z: -29.5, color: 0xc8402c, outline: 0x6a2018, chamfer: 0.05, ghost: true });

  return out;
}

/** A boxy old car, parked. */
function car(out: Slab[], x: number, z: number, ry: number, color: number): void {
  out.push({ w: 4.3, h: 0.9, d: 1.85, x, y: 0.62, z, ry, color, outline: 0x3a2c2a, chamfer: 0.12 });
  out.push({
    w: 2.4, h: 0.72, d: 1.7, x, y: 1.42, z, ry,
    color: shade(color, 0.88), outline: 0x3a2c2a, chamfer: 0.1,
  });
  out.push({
    w: 2.1, h: 0.5, d: 1.76, x, y: 1.45, z, ry,
    color: 0x9fd8ee, outline: 0x3a2c2a, chamfer: 0.06, ghost: true,
  });
  const sin = Math.sin(ry);
  const cos = Math.cos(ry);
  for (const [ox, oz] of [[-1.4, -0.9], [-1.4, 0.9], [1.4, -0.9], [1.4, 0.9]] as const) {
    out.push({
      w: 0.7, h: 0.7, d: 0.28,
      x: x + ox * cos + oz * sin,
      y: 0.35,
      z: z - ox * sin + oz * cos,
      ry,
      color: 0x3a3a40, outline: 0x1a1a1e, chamfer: 0.16, ghost: true,
    });
  }
}
