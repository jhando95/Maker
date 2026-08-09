/**
 * The prefab catalogue: yard fixtures as named, placeable objects.
 *
 * Until now every fixture was built inline at hard-coded coordinates, which
 * worked for one map and stops working the moment there are three — a chicken
 * coop that exists only as forty lines inside surrounds.ts cannot be put in a
 * custom map, and a second copy of it would be a fork. A prefab is the same
 * forty lines expressed relative to its own origin: `place(out, 'coop', x, z,
 * ry)` stamps it anywhere, on this map or the next one, and the catalogue is
 * the store the user asked for — fixtures kept as objects whether or not the
 * starter maps use them.
 *
 * A builder writes into local coordinates; `place` translates and, if asked,
 * turns the whole thing in quarter turns about its origin (the same rule
 * blueprints follow, and for the same reason: exact arithmetic on a gridded
 * world).
 */

import type { Slab } from './neighborhood.ts';

export type PrefabBuilder = (out: Slab[]) => void;

/** One quarter-turn step: (x, z) -> (z, -x), applied n times. */
function turn(s: Slab, n: number): Slab {
  let { x, z, w, d } = s;
  let ry = s.ry ?? 0;
  for (let i = 0; i < n; i++) {
    const nx = z;
    const nz = -x;
    x = nx; z = nz;
    const nw = d; const nd = w;
    w = nw; d = nd;
  }
  // Rotated boxes keep their own ry; the frame turn is expressed through the
  // swapped extents and moved centre, so an unrotated box stays unrotated.
  return { ...s, x, z, w, d, ry };
}

/** Stamp a named prefab at (x, z), turned n quarter turns about its origin. */
export function place(
  out: Slab[], name: keyof typeof PREFABS, x: number, z: number, turns = 0,
): void {
  const local: Slab[] = [];
  PREFABS[name](local);
  const n = ((turns % 4) + 4) % 4;
  for (const s of local) {
    const t = n === 0 ? s : turn(s, n);
    out.push({ ...t, x: t.x + x, z: t.z + z });
  }
}

/**
 * A rope swing: a high beam between two posts, two ropes, and a tyre seat.
 * The tyre hangs at sitting height; ropes and tyre are ghosts — swinging
 * into a rope should never feel like hitting a pole.
 */
function ropeSwing(out: Slab[]): void {
  const wood = 0x8a6242;
  for (const dx of [-1.1, 1.1]) {
    out.push({ w: 0.14, h: 2.9, d: 0.14, x: dx, y: 1.45, z: 0, color: wood, outline: 0x4a3122, chamfer: 0.02 });
  }
  out.push({ w: 2.6, h: 0.14, d: 0.14, x: 0, y: 2.85, z: 0, color: wood, outline: 0x4a3122, chamfer: 0.02 });
  for (const dx of [-0.22, 0.22]) {
    out.push({ w: 0.04, h: 1.7, d: 0.04, x: dx, y: 1.95, z: 0, color: 0xc9b083, ghost: true });
  }
  out.push({ w: 0.62, h: 0.5, d: 0.16, x: 0, y: 0.85, z: 0, color: 0x1a1a1e, outline: 0x0e0e10, chamfer: 0.22, ghost: true });
}

/**
 * A sand pit with a board edge — the landing zone every garden invents.
 * The sand is a soft-read surface (pale, low); the boards are solid kerbs.
 */
function sandpit(out: Slab[]): void {
  // One kerb size, turned for the sides — a size used once is a draw call.
  for (const [ox, oz, ry] of [[0, -1.3, 0], [0, 1.3, 0], [-1.3, 0, Math.PI / 2], [1.3, 0, Math.PI / 2]] as const) {
    out.push({ w: 2.8, h: 0.28, d: 0.16, x: ox, y: 0.14, z: oz, ry, color: 0xc9a06a, outline: 0x8a6a42, chamfer: 0.02 });
  }
  out.push({ w: 2.5, h: 0.14, d: 2.5, x: 0, y: 0.07, z: 0, color: 0xe8d4a0, outline: 0xc9b083, chamfer: 0.05, ghost: true });
}

/**
 * The chicken coop, exactly as the back lane has it — hutch, pitched lid,
 * gangplank, rail run, two ghost hens.
 */
function coop(out: Slab[]): void {
  const wood = 0x9a6a4a;
  out.push({ w: 1.6, h: 1.1, d: 1.2, x: -1.2, y: 0.75, z: 0, color: wood, outline: 0x5a3a26, chamfer: 0.03 });
  out.push({ w: 1.9, h: 0.08, d: 1.5, x: -1.2, y: 1.38, z: 0, rz: -0.16, color: 0x6a5548, outline: 0x3a2c2a, chamfer: 0.02 });
  out.push({ w: 0.34, h: 0.05, d: 1.1, x: -0.25, y: 0.42, z: 0.15, ry: 0.5, rz: 0.6, color: 0xc9a06a, outline: 0x8a6a42, chamfer: 0.01 });
  for (const [dx, dz] of [[0.2, -1.4], [2.4, -1.4], [2.4, 0.8]] as const) {
    out.push({ w: 0.08, h: 0.9, d: 0.08, x: dx, y: 0.45, z: dz, color: wood, chamfer: 0.01 });
  }
  out.push({ w: 2.2, h: 0.05, d: 0.05, x: 1.3, y: 0.82, z: -1.4, color: 0xc9a06a, chamfer: 0.01 });
  out.push({ w: 2.2, h: 0.05, d: 0.05, x: 2.4, y: 0.82, z: -0.3, ry: Math.PI / 2, color: 0xc9a06a, chamfer: 0.01 });
  for (const [dx, dz, ry] of [[1.3, -0.3, 0.7], [1.9, 0.6, 2.4]] as const) {
    out.push({ w: 0.3, h: 0.26, d: 0.22, x: dx, y: 0.13, z: dz, ry, color: 0xf2ede2, outline: 0xb9b4a8, chamfer: 0.07, ghost: true });
    out.push({ w: 0.12, h: 0.14, d: 0.12, x: dx + Math.cos(ry) * 0.17, y: 0.32, z: dz - Math.sin(ry) * 0.17, color: 0xf2ede2, chamfer: 0.03, ghost: true });
    out.push({ w: 0.05, h: 0.06, d: 0.08, x: dx + Math.cos(ry) * 0.17, y: 0.42, z: dz - Math.sin(ry) * 0.17, color: 0xd8564f, chamfer: 0.01, ghost: true });
  }
}

/** The firepit ring, embers and log benches, as the northwest band has it. */
function firepit(out: Slab[]): void {
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    out.push({
      w: 0.52, h: 0.34, d: 0.46, x: Math.sin(a) * 0.98, y: 0.17, z: Math.cos(a) * 0.98,
      ry: a, color: 0x8a8578, outline: 0x5a564e, chamfer: 0.09,
    });
  }
  out.push({
    w: 1.2, h: 0.12, d: 1.2, x: 0, y: 0.06, z: 0, color: 0x2e2a28,
    outline: 0x1a1816, chamfer: 0.04, ghost: true,
    lit: { color: 0xff9a3c, bloom: 0.9 },
  });
  out.push({ w: 1.9, h: 0.4, d: 0.4, x: -0.4, y: 0.2, z: 1.9, ry: 0.25, color: 0x8a6242, outline: 0x4a3122, chamfer: 0.1 });
  out.push({ w: 1.9, h: 0.4, d: 0.4, x: 1.7, y: 0.2, z: -0.7, ry: 1.75, color: 0x8a6242, outline: 0x4a3122, chamfer: 0.1 });
}

/**
 * A see-saw: a tyre fulcrum and a plank resting one end down, walkable as
 * low cover and a step. The tilt is authored (rz), not simulated — a plank
 * that pivots under live weight is a moving collision platform, which this
 * world's static collision does not do yet; when it learns to, the motion
 * belongs here and every map with a see-saw gets it at once. That is the
 * point of the catalogue.
 */
function seesaw(out: Slab[]): void {
  out.push({ w: 0.5, h: 0.55, d: 0.9, x: 0, y: 0.27, z: 0, color: 0x2a2a30, outline: 0x1a1a1e, chamfer: 0.12 });
  out.push({ w: 3.8, h: 0.16, d: 0.5, x: 0, y: 0.62, z: 0, rz: 0.2, color: 0xd8564f, outline: 0x8a3226, chamfer: 0.02 });
  // Handles at both ends, the detail that says see-saw rather than plank.
  for (const dx of [-1.55, 1.55]) {
    out.push({ w: 0.06, h: 0.3, d: 0.06, x: dx, y: 0.62 + dx * 0.2 + 0.22, z: 0, color: 0x4a4f54, chamfer: 0.01, ghost: true });
  }
}

/**
 * The catalogue itself. Everything here is placeable on any map, present or
 * future — being listed is not a promise that any particular map uses it.
 */
export const PREFABS = {
  ropeSwing,
  sandpit,
  coop,
  firepit,
  seesaw,
} as const;
