/**
 * Turned shapes — the class of form a box cannot approximate.
 *
 * This exists to answer a design question with geometry rather than an
 * argument. The worry was that procedural shapes are stuck at "primitive and
 * boxy", and for half the yard that worry is misplaced: planks are boxes
 * because lumber is boxes, and the canopies are already `blob()`s. The class
 * that was genuinely out of reach is the *turned* form — a flower pot, a
 * birdbath, a bollard, a bottle — anything a lathe or a potter's wheel makes.
 * Which is itself the answer, because a lathe is a profile swept in a circle,
 * and a profile is twelve numbers.
 *
 * ## Faceted on purpose, twice over
 *
 * `segments` defaults low (10) and the result is flat-shaded: each face gets
 * its true face normal rather than a smoothed one, so the toon ramp breaks
 * across facets the way it breaks across a chamfered box. That is what makes a
 * turned prop sit beside the existing world instead of looking imported —
 * smooth-shaded curves under a three-band ramp read as a different material
 * entirely. The professional low-poly playbook is exactly this: silhouette
 * first, faceting as a feature, colour from a palette rather than a texture.
 *
 * The outline pass needs the *other* normals — smoothed, or the inverted hull
 * splits at every hard edge — and `addOutlineNormals` already solves that for
 * the chamfered boxes, so these shapes reuse it unchanged.
 */

import * as THREE from 'three';

/** One point of a profile: distance from the axis, and height. */
export interface ProfilePoint {
  r: number;
  y: number;
}

/**
 * Sweep a profile around the Y axis, flat-shaded, origin at the base.
 *
 * The profile runs bottom to top. A first or last point with `r > 0` leaves an
 * open rim (a pot's mouth); close it yourself with a point at `r: 0` — the cap
 * is part of the shape's design, not something to guess at.
 */
export function lathe(profile: readonly ProfilePoint[], segments = 10): THREE.BufferGeometry {
  if (profile.length < 2) throw new Error('lathe: a profile needs at least two points');
  const points = profile.map((p) => new THREE.Vector2(Math.max(0, p.r), p.y));
  const turned = new THREE.LatheGeometry(points, segments);
  // LatheGeometry is indexed and smooth. Unweld to give every triangle its own
  // vertices, then recompute normals so each face carries its true one — the
  // faceting is the style.
  const flat = turned.toNonIndexed();
  // On a non-indexed geometry, three's computeVertexNormals gives every face
  // its own true normal — which is the faceted look this file exists for. That
  // is the library's current behaviour rather than its documented promise, so
  // the *test* asserts flatness directly: if three ever smooths this, the test
  // fails and this comment says what to write instead. A hand-rolled flattener
  // lived here for one commit and was deleted for being unfalsifiable — it
  // duplicated what the library already did, so no test could catch its loss.
  flat.computeVertexNormals();
  turned.dispose();
  return flat;
}

/**
 * A rock: an icosahedron squashed, lumped and sat flat on the ground.
 *
 * The bottom is *cut*, not just flattened — vertices below ground snap to it —
 * so a rock never shows daylight under its own belly however it is scaled.
 */
export function rock(
  radius: number, random: () => number, squash = 0.62, lumpiness = 0.3,
): THREE.BufferGeometry {
  // Icosahedrons come out of three non-indexed already, and toNonIndexed()
  // warns on a no-op — but the flat shading below *depends* on unwelded
  // vertices, so the conversion stays, guarded, in case that ever changes.
  const ico = new THREE.IcosahedronGeometry(radius, 1);
  const geometry = ico.index === null ? ico : ico.toNonIndexed();
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  // Push each *unique* location by a seeded amount, keyed by quantized
  // position so the unwelded copies of one corner move together — otherwise
  // the faces tear apart at every seam.
  const push = new Map<string, number>();
  for (let i = 0; i < position.count; i++) {
    const key = `${position.getX(i).toFixed(3)},${position.getY(i).toFixed(3)},${position.getZ(i).toFixed(3)}`;
    if (!push.has(key)) push.set(key, 1 + (random() * 2 - 1) * lumpiness);
    const k = push.get(key)!;
    position.setXYZ(i, position.getX(i) * k, position.getY(i) * k * squash + radius * squash, position.getZ(i) * k);
  }
  for (let i = 0; i < position.count; i++) {
    if (position.getY(i) < 0) position.setY(i, 0);
  }
  geometry.computeVertexNormals();
  return geometry;
}
