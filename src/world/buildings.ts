/**
 * The buildings and trees that stand outside the fence.
 *
 * Its own module because two very different places need the same house: the
 * cul-de-sac out front, and the back gardens and side plots that fill every
 * other horizon. They were one file for about an hour, and the moment the
 * second caller appeared the arrangement stopped making sense — "the street"
 * is not where a house shape lives.
 *
 * Everything here is scenery. Nobody plays on it, nothing is balanced around
 * it, and the only rules it has to obey are the two the tests check: stay
 * outside the fence, and stay on ground the lawn actually reaches.
 *
 * ## Sizes are shared on purpose
 *
 * Scenery is instanced by exact dimensions, so a size used once is a draw call
 * spent on one box. A treeline of fifty individually-proportioned trees is
 * fifty draw calls; the same fifty picked from three sizes is three. At the
 * distance any of this is seen from, nobody can tell — and it is the difference
 * between a horizon that costs nothing and one that costs more than the yard.
 */

import type { Slab } from './neighborhood.ts';

/** Darken a hex colour by a factor, channel by channel. */
export function shade(hex: number, k: number): number {
  const r = Math.round(((hex >> 16) & 255) * k);
  const g = Math.round(((hex >> 8) & 255) * k);
  const b = Math.round((hex & 255) * k);
  return (r << 16) | (g << 8) | b;
}

/**
 * One house beyond the fence.
 *
 * `ry` is which way the front faces, in radians, with 0 meaning toward +Z.
 * `drive` is where the drive meets the road, measured across the front.
 */
export interface NeighbourSpec {
  x: number;
  z: number;
  ry: number;
  wall: number;
  roof: number;
  trim: number;
  drive: number;
  /** Leave the drive off for a house seen from the back, which has none facing you. */
  noDrive?: boolean;
}

/**
 * One neighbouring house.
 *
 * Solid, and much simpler than the player's own: a body, a gable, a door, two
 * windows, a chimney, a drive and a mailbox. It is thirty to fifty metres away
 * and half in the fog, and detail spent there is detail not spent on the yard
 * the game is actually played in.
 *
 * They *are* collided with, unlike the tarmac. Not because anyone should get
 * there — the fence is in the way — but because a solid-looking house you can
 * walk through is the kind of thing that turns up in a screenshot at the worst
 * possible moment, and the cost of a handful of static fixtures is nothing.
 */
export function neighbourHouse(out: Slab[], n: NeighbourSpec): void {
  const { x, z, ry, wall, roof, trim } = n;
  const w = 9.4;
  const d = 7.6;
  const eaves = 4.2;
  const sin = Math.sin(ry);
  const cos = Math.cos(ry);
  /** House-local (right, forward) into world space. */
  const at = (right: number, forward: number): [number, number] =>
    [x + right * cos + forward * sin, z - right * sin + forward * cos];

  out.push({
    w, h: eaves, d, x, y: eaves / 2, z, ry,
    color: wall, outline: 0x8a6a52, chamfer: 0.04,
  });

  // Two courses of cladding, so a nine-metre wall is not one flat colour at the
  // one distance where a flat colour is most obvious — the middle distance,
  // where it is large on screen and has no other detail to compete with.
  for (const y of [1.1, 2.5]) {
    out.push({
      w: w + 0.1, h: 0.5, d: d + 0.1, x, y, z, ry,
      color: shade(wall, 0.93), outline: 0x8a6a52, chamfer: 0.02, ghost: true,
    });
  }

  // A gable rather than the player's hipped roof, and a deliberately different
  // silhouette: their house should be the one you can pick out.
  for (let i = 0; i < 4; i++) {
    const t = i / 4;
    const width = w * (1 - t * 0.72) + 0.9;
    out.push({
      w: width, h: 0.55, d: d + 1.0 - t * 0.4,
      x, y: eaves + 0.28 + i * 0.5, z, ry,
      color: i % 2 === 0 ? roof : shade(roof, 0.9),
      outline: 0x3a2c2a, chamfer: 0.03,
    });
  }

  const [cx, cz] = at(w * 0.28, -d * 0.2);
  out.push({
    w: 0.8, h: 2.2, d: 0.8, x: cx, y: eaves + 1.4, z: cz, ry,
    color: 0xb06a52, outline: 0x6a4238, chamfer: 0.03,
  });

  // Front door and windows, on the face that looks at the road.
  const [dx, dz] = at(0, d / 2 + 0.06);
  out.push({
    w: 1.1, h: 2.1, d: 0.12, x: dx, y: 1.05, z: dz, ry,
    color: trim, outline: 0x3a2c2a, chamfer: 0.02, ghost: true,
  });
  for (const side of [-1, 1]) {
    const [wx, wz] = at(side * 2.9, d / 2 + 0.06);
    out.push({
      w: 1.5, h: 1.2, d: 0.1, x: wx, y: 2.1, z: wz, ry,
      color: trim, outline: 0x3a2c2a, chamfer: 0.02, ghost: true,
    });
    out.push({
      w: 1.2, h: 0.95, d: 0.14, x: wx, y: 2.1, z: wz, ry,
      color: 0x9fd8ee, outline: 0x3a2c2a, chamfer: 0.01, ghost: true,
      // Ten windows across five houses, all facing the turning head. This is
      // the cheapest thing in the game that says somebody lives here: a pane
      // of daylight blue is scenery, and the same pane warmer than the sky
      // behind it is a room with the light on and a person in it.
      lit: { color: 0xffc266, bloom: 0.26 },
    });
  }

  // The drive, running from the door out toward the road. Shortened to a stub:
  // it only has to read as "this house connects to that road", and a strip
  // solved exactly to the kerb would be a strip that breaks whenever the kerb
  // moves.
  const [px, pz] = at(n.drive, d / 2 + 3.4);
  if (n.noDrive !== true) {
    out.push({
      w: 3.0, h: 0.07, d: 7.0, x: px, y: 0.025, z: pz, ry,
      color: 0xb8b4aa, outline: 0x5a5a60, chamfer: 0.015, ghost: true,
    });
  }

  // Mailbox at the end of it, leaning, as every mailbox in this neighbourhood is.
  if (n.noDrive === true) return;
  const [mx, mz] = at(n.drive + 1.9, d / 2 + 6.4);
  out.push({
    w: 0.13, h: 1.0, d: 0.13, x: mx, y: 0.5, z: mz,
    color: 0xd8b585, outline: 0x5a4432, chamfer: 0.01, rz: 0.1,
  });
  out.push({
    w: 0.38, h: 0.3, d: 0.62, x: mx + 0.1, y: 1.15, z: mz,
    color: 0x8c9196, outline: 0x4a4f54, chamfer: 0.05, rz: 0.1,
  });
}

/** A roof and the top of a wall, sixty metres out. Two boxes, no interior. */
export function farRoof(out: Slab[], x: number, z: number, ry: number, roof: number): void {
  out.push({
    w: 11, h: 3.6, d: 8.5, x, y: 1.8, z, ry,
    color: 0xe4dac6, outline: 0x8a6a52, chamfer: 0.05, ghost: true,
  });
  for (let i = 0; i < 3; i++) {
    const t = i / 3;
    out.push({
      w: 11 * (1 - t * 0.7) + 1, h: 0.7, d: 9.4 - t * 0.4,
      x, y: 3.9 + i * 0.62, z, ry,
      color: i % 2 === 0 ? roof : shade(roof, 0.9),
      outline: 0x3a2c2a, chamfer: 0.04, ghost: true,
    });
  }
}


/**
 * How big a distant tree is.
 *
 * Three sizes, and every tree in the treeline is one of them. Not laziness —
 * see the note at the top of this file: fifty individually proportioned trees
 * are fifty draw calls and these are all at least thirty metres away. What
 * varies per tree instead is rotation, position and tint, all of which are free.
 */
export const TREE_SIZES = [
  { trunk: 0.42, height: 2.6, crown: 2.9, cap: 2.1 },
  { trunk: 0.5, height: 3.5, crown: 3.9, cap: 2.7 },
  { trunk: 0.6, height: 4.6, crown: 5.0, cap: 3.5 },
] as const;

/**
 * A tree for the middle distance.
 *
 * Boxes with a heavy chamfer rather than the lumpy `blob()` geometry the yard's
 * own trees use. A blob is its own mesh and its own draw call, which is fine for
 * five trees in the garden and impossible for fifty on a horizon; a chamfered
 * box at forty metres, half in the fog, is a green mass with a soft edge, which
 * is all a tree is from there.
 *
 * The trunk is solid and the canopy is not. Nobody should be out here at all,
 * but a canopy floating at four metres is not something to collide with, and a
 * trunk is — if only so that the one thing out here shaped like an obstacle
 * behaves like one.
 */
export function woodTree(
  out: Slab[], x: number, z: number, size: number, tone: number, spin = 0,
): void {
  const s = TREE_SIZES[Math.min(TREE_SIZES.length - 1, Math.max(0, size))]!;
  out.push({
    w: s.trunk, h: s.height, d: s.trunk, x, y: s.height / 2, z, ry: spin,
    color: 0x7a5438, outline: 0x4a3122, chamfer: 0.04,
  });
  out.push({
    w: s.crown, h: s.crown * 0.62, d: s.crown,
    x, y: s.height + s.crown * 0.24, z, ry: spin * 0.5,
    color: tone, outline: 0x2f5a24, chamfer: s.crown * 0.26, ghost: true,
  });
  out.push({
    w: s.cap, h: s.cap * 0.66, d: s.cap,
    x, y: s.height + s.crown * 0.58, z, ry: spin,
    color: shade(tone, 1.12), outline: 0x2f5a24, chamfer: s.cap * 0.3, ghost: true,
  });
}

/**
 * A run of hedge, as overlapping blocks.
 *
 * What a hedge does that a fence cannot is end a view softly: a picket line
 * says "the lot stops here" and a hedge says "there is more, and it is somebody
 * else's". Overlapped rather than butted, so the run reads as one mass instead
 * of a row of cubes.
 */
export function hedgeRun(
  out: Slab[], x0: number, z0: number, x1: number, z1: number, height = 1.9,
): void {
  const span = Math.hypot(x1 - x0, z1 - z0);
  const step = 2.4;
  const count = Math.max(1, Math.round(span / step));
  const angle = Math.atan2(x1 - x0, z1 - z0);
  for (let i = 0; i < count; i++) {
    const t = (i + 0.5) / count;
    out.push({
      w: 3.0, h: height, d: 1.5,
      x: x0 + (x1 - x0) * t,
      y: height / 2,
      z: z0 + (z1 - z0) * t,
      ry: angle + (i % 2 === 0 ? 0.05 : -0.05),
      color: i % 3 === 0 ? 0x458a34 : 0x4f9a3a,
      outline: 0x2f5a24, chamfer: 0.3,
    });
  }
}
