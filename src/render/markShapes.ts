/**
 * The shapes a player paints themselves with.
 *
 * ## Why shapes rather than a canvas
 *
 * "Paint yourself" wants a brush and a grid of pixels, and that is the wrong
 * tool in this renderer specifically. The character geometry is built by
 * `chamferedBox` and `blob`, neither of which writes a UV attribute; there is no
 * texture pipeline anywhere in the project, on purpose, and `neighborhood.ts`
 * already records why — an image pipeline for one lawn would be the heaviest
 * thing in the repository. Adding one for a shirt would mean UVs on every
 * character part, an atlas big enough for everybody on the field, a per-instance
 * attribute to index it and a shader patch to sample it. All so that a sixteen-
 * square design could be smeared across a curved chest half a metre wide and
 * then viewed, in play, from twelve metres away.
 *
 * Flat marks in flat colours are what a cel-shaded world draws well and what
 * still reads at forty metres, which is the distance that decides whether a
 * customisation was worth having. They are also the only kind that stays
 * instanced: one mesh per shape, and a shape nobody is wearing costs nothing at
 * all because its count is zero.
 *
 * ## What a shape is
 *
 * A flat polygon in the XY plane, one unit across, facing -Z — the same
 * direction a character's front is in its own frame, so a mark needs no rotation
 * beyond the one its wearer already has. Built from `THREE.Shape`, which
 * triangulates a path for us and needs no UVs.
 *
 * Two-sided, because a mark on a back is seen from behind and a mark on an arm
 * is seen from whichever way that arm happens to be swinging.
 */

import * as THREE from 'three';
import type { MarkShape } from '../game/appearance.ts';

/** Half a unit, so every shape is one unit across before it is scaled. */
const H = 0.5;

function polygon(points: ReadonlyArray<readonly [number, number]>): THREE.Shape {
  const shape = new THREE.Shape();
  shape.moveTo(points[0]![0], points[0]![1]);
  for (let i = 1; i < points.length; i++) shape.lineTo(points[i]![0], points[i]![1]);
  shape.closePath();
  return shape;
}

function star(spikes: number, outer: number, inner: number): THREE.Shape {
  const points: Array<[number, number]> = [];
  for (let i = 0; i < spikes * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    // Starting at the top rather than at the right, so a star points upwards —
    // which is the only orientation a five-pointed star reads as a star in.
    const a = (i / (spikes * 2)) * Math.PI * 2 - Math.PI / 2;
    points.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return polygon(points);
}

function disc(radius: number, segments = 24): THREE.Shape {
  const points: Array<[number, number]> = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    points.push([Math.cos(a) * radius, Math.sin(a) * radius]);
  }
  return polygon(points);
}

function ring(outer: number, inner: number, segments = 24): THREE.Shape {
  const shape = disc(outer, segments);
  const hole = new THREE.Path();
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const x = Math.cos(a) * inner;
    const y = Math.sin(a) * inner;
    if (i === 0) hole.moveTo(x, y); else hole.lineTo(x, y);
  }
  hole.closePath();
  shape.holes.push(hole);
  return shape;
}

/**
 * A heart, and a splat, from parametric curves rather than by hand.
 *
 * Typed-out coordinate lists are how a shape ends up subtly lopsided and stays
 * that way, because nobody wants to re-derive twenty numbers to fix it.
 */
function heart(): THREE.Shape {
  const points: Array<[number, number]> = [];
  for (let i = 0; i < 40; i++) {
    const t = (i / 40) * Math.PI * 2;
    const x = 16 * Math.sin(t) ** 3;
    const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    points.push([(x / 32) * (H * 2), (y / 32) * (H * 2)]);
  }
  return polygon(points);
}

function splat(): THREE.Shape {
  const points: Array<[number, number]> = [];
  const lobes = 7;
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    // A wobble on the radius rather than random points: random ones self-
    // intersect and triangulate into a knot roughly one time in four.
    const r = H * (0.72 + 0.28 * Math.abs(Math.cos(a * lobes * 0.5)) + 0.06 * Math.sin(a * 3));
    points.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return polygon(points);
}

/**
 * Every shape, in the order `MARK_SHAPES` names them.
 *
 * Keyed by name rather than positional, so adding one to the middle of the
 * palette cannot silently give everybody who was wearing a star a bolt instead.
 */
const SHAPES: Record<Exclude<MarkShape, 'none'>, () => THREE.Shape> = {
  stripe: () => polygon([[-0.14, -H], [0.14, -H], [0.14, H], [-0.14, H]]),
  band: () => polygon([[-H, -0.17], [H, -0.17], [H, 0.17], [-H, 0.17]]),
  circle: () => disc(H),
  ring: () => ring(H, H * 0.58),
  star: () => star(5, H, H * 0.42),
  bolt: () => polygon([
    [0.06, H], [-H * 0.72, 0.02], [-0.04, 0.02],
    [-0.1, -H], [H * 0.72, -0.04], [0.0, -0.04],
  ]),
  heart: heart,
  splat: splat,
  cross: () => polygon([
    [-0.16, -H], [0.16, -H], [0.16, -0.16], [H, -0.16],
    [H, 0.16], [0.16, 0.16], [0.16, H], [-0.16, H],
    [-0.16, 0.16], [-H, 0.16], [-H, -0.16], [-0.16, -0.16],
  ]),
  chevron: () => polygon([
    [-H, H], [0, 0.06], [H, H], [H, 0.2], [0, -0.24], [-H, 0.2],
  ]),
  diamond: () => polygon([[0, H], [H * 0.72, 0], [0, -H], [-H * 0.72, 0]]),
};

/**
 * Build one geometry per shape, once.
 *
 * `ShapeGeometry` puts the polygon in the XY plane facing +Z. A mark sits on a
 * character's chest, and a character's front is **-Z** in its own frame — so
 * every one is turned to face that way here rather than at every use, which is
 * the sort of thing that is right in three places and forgotten in the fourth.
 */
export function markGeometries(): Map<MarkShape, THREE.BufferGeometry> {
  const out = new Map<MarkShape, THREE.BufferGeometry>();
  for (const [name, build] of Object.entries(SHAPES)) {
    const geometry = new THREE.ShapeGeometry(build());
    geometry.rotateY(Math.PI);
    geometry.computeVertexNormals();
    out.set(name as MarkShape, geometry);
  }
  return out;
}
