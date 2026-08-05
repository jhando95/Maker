/**
 * Capsule-vs-oriented-box narrowphase.
 *
 * The whole test runs in the box's local frame, where the box becomes an
 * origin-centered AABB and clamping is three `min`/`max` pairs. The transform
 * in is a rotation, which preserves distance, so the answer converts straight
 * back out.
 *
 * Finding the closest point on the capsule spine uses bisection on the
 * derivative rather than the usual iterate-and-clamp. Distance to a convex set
 * is convex, and the spine is affine in `t`, so squared distance along the
 * spine is convex in `t` with no local minima — its derivative is monotonic and
 * bisection is exact. Clamp-iteration has no such guarantee and can stall far
 * from the true minimum on the oblique configurations that flush-placed lumber
 * produces constantly.
 */

import { Feature, makeContact, type Capsule, type Contact, type Obb } from './types.ts';
import { BISECT_ITERS } from './constants.ts';

/** Scratch, reused so the hot path never allocates. */
const scratch = {
  // Capsule endpoints and direction in box-local space.
  aLx: 0, aLy: 0, aLz: 0,
  dLx: 0, dLy: 0, dLz: 0,
  // Closest point on the spine and on the box, box-local.
  pLx: 0, pLy: 0, pLz: 0,
  qLx: 0, qLy: 0, qLz: 0,
  clampedAxes: 0,
  inside: false,
};

/**
 * Closest point on an origin-centered AABB to a local point, written into
 * scratch.q*. Also records which axes were clamped and whether the point was
 * strictly inside.
 */
/**
 * How far outside a face a coordinate must be before that axis counts as a
 * genuine clamp for feature classification.
 *
 * The clamp itself is exact — `q` always lands on the surface. But when the
 * spine runs parallel to a face the closest-point set is a plateau, and the
 * bisection settles at its edge, where a second coordinate sits within
 * bisection noise of its own face. Classifying that as an Edge contact would
 * send a flush wall surface through internal-edge removal for no reason. At
 * 0.1mm this is far below anything visible and comfortably above the
 * bisection's worst-case error.
 */
const FEATURE_TOL = 1e-4;

function clampToBox(lx: number, ly: number, lz: number, hx: number, hy: number, hz: number): void {
  let mask = 0;
  let inside = true;

  let qx = lx;
  if (lx > hx) { qx = hx; inside = false; if (lx > hx + FEATURE_TOL) mask |= 1; }
  else if (lx < -hx) { qx = -hx; inside = false; if (lx < -hx - FEATURE_TOL) mask |= 1; }

  let qy = ly;
  if (ly > hy) { qy = hy; inside = false; if (ly > hy + FEATURE_TOL) mask |= 2; }
  else if (ly < -hy) { qy = -hy; inside = false; if (ly < -hy - FEATURE_TOL) mask |= 2; }

  let qz = lz;
  if (lz > hz) { qz = hz; inside = false; if (lz > hz + FEATURE_TOL) mask |= 4; }
  else if (lz < -hz) { qz = -hz; inside = false; if (lz < -hz - FEATURE_TOL) mask |= 4; }

  scratch.qLx = qx;
  scratch.qLy = qy;
  scratch.qLz = qz;
  scratch.clampedAxes = mask;
  // `inside` tracks the exact clamp, not the tolerant mask: a point a hair
  // outside is still outside, and must not take the interior push path.
  scratch.inside = inside;
}

/** Population count of a 3-bit mask. */
function popcount3(mask: number): number {
  return (mask & 1) + ((mask >> 1) & 1) + ((mask >> 2) & 1);
}

/**
 * Does the spine pass through the box, and if so where is it deepest?
 *
 * This has to be answered separately from the bisection. Squared distance is
 * flat at zero everywhere the spine is inside, so its derivative is zero across
 * that whole interval and the bisection converges to the *entry* point — where
 * the spine is a hair outside the surface. The result is a grazing face contact
 * with a plausible-looking normal, when the truth is that the capsule is
 * skewered on the box and needs pushing out the way it came.
 *
 * Standard slab clip against the three local axes, using scratch.aL/dL.
 *
 * @returns the midpoint parameter of the interior interval, or -1 if the spine
 *   never enters the box.
 */
function spineInteriorMidpoint(hx: number, hy: number, hz: number): number {
  let tEnter = 0;
  let tExit = 1;

  // Unrolled per axis; a loop here would need array indexing into scratch.
  const check = (a: number, d: number, h: number): boolean => {
    if (Math.abs(d) < 1e-12) {
      // Parallel to this slab: either always within it or never.
      return Math.abs(a) <= h;
    }
    const inv = 1 / d;
    let t1 = (-h - a) * inv;
    let t2 = (h - a) * inv;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tEnter) tEnter = t1;
    if (t2 < tExit) tExit = t2;
    return tEnter <= tExit;
  };

  if (!check(scratch.aLx, scratch.dLx, hx)) return -1;
  if (!check(scratch.aLy, scratch.dLy, hy)) return -1;
  if (!check(scratch.aLz, scratch.dLz, hz)) return -1;

  return (tEnter + tExit) * 0.5;
}

/**
 * Derivative of squared spine-to-box distance at parameter `t`, halved.
 *
 * Equals dot(P(t) - Q(t), D). Zero at the minimum, negative before it, positive
 * after — monotonic non-decreasing because the underlying function is convex.
 */
function distanceDerivative(t: number, hx: number, hy: number, hz: number): number {
  const px = scratch.aLx + scratch.dLx * t;
  const py = scratch.aLy + scratch.dLy * t;
  const pz = scratch.aLz + scratch.dLz * t;
  clampToBox(px, py, pz, hx, hy, hz);
  return (
    (px - scratch.qLx) * scratch.dLx +
    (py - scratch.qLy) * scratch.dLy +
    (pz - scratch.qLz) * scratch.dLz
  );
}

/**
 * Test a capsule against an OBB, writing into `out`.
 *
 * A contact is reported when the surfaces are within `margin` of touching, not
 * only when they overlap. Those speculative contacts are what let the solver
 * see a surface before the character reaches it, and they supply the
 * neighbouring face planes that internal-edge removal needs.
 *
 * @returns true if a contact was written.
 */
export function capsuleVsObb(cap: Capsule, box: Obb, out: Contact, margin = 0): boolean {
  // World -> box-local. Rotation only; the basis is orthonormal so this is just
  // three dot products against the box axes.
  const adx = cap.ax - box.cx;
  const ady = cap.ay - box.cy;
  const adz = cap.az - box.cz;
  const bdx = cap.bx - box.cx;
  const bdy = cap.by - box.cy;
  const bdz = cap.bz - box.cz;

  const aLx = adx * box.ux + ady * box.uy + adz * box.uz;
  const aLy = adx * box.vx + ady * box.vy + adz * box.vz;
  const aLz = adx * box.wx + ady * box.wy + adz * box.wz;

  const bLx = bdx * box.ux + bdy * box.uy + bdz * box.uz;
  const bLy = bdx * box.vx + bdy * box.vy + bdz * box.vz;
  const bLz = bdx * box.wx + bdy * box.wy + bdz * box.wz;

  scratch.aLx = aLx;
  scratch.aLy = aLy;
  scratch.aLz = aLz;
  scratch.dLx = bLx - aLx;
  scratch.dLy = bLy - aLy;
  scratch.dLz = bLz - aLz;

  const { hx, hy, hz } = box;

  // Locate the closest spine parameter.
  let t: number;
  const dLen2 = scratch.dLx * scratch.dLx + scratch.dLy * scratch.dLy + scratch.dLz * scratch.dLz;
  const pierced = spineInteriorMidpoint(hx, hy, hz);
  if (pierced >= 0) {
    // The spine is skewered on the box. Work from the middle of the interior
    // span, which is the deepest part of the overlap and gives a stable push
    // direction; the bisection would settle on the entry point instead.
    t = pierced;
  } else if (dLen2 < 1e-12) {
    // Degenerate spine — the capsule is a sphere.
    t = 0;
  } else {
    const g0 = distanceDerivative(0, hx, hy, hz);
    if (g0 >= 0) {
      // Distance is already increasing at the start: the minimum is the A cap.
      t = 0;
    } else {
      const g1 = distanceDerivative(1, hx, hy, hz);
      if (g1 <= 0) {
        // Still decreasing at the end: the minimum is the B cap.
        t = 1;
      } else {
        // Sign change bracketed; bisect. Monotonic derivative makes this exact
        // to within 2^-BISECT_ITERS of the spine length.
        let lo = 0;
        let hi = 1;
        for (let i = 0; i < BISECT_ITERS; i++) {
          const mid = (lo + hi) * 0.5;
          if (distanceDerivative(mid, hx, hy, hz) < 0) lo = mid;
          else hi = mid;
        }
        t = (lo + hi) * 0.5;
      }
    }
  }

  // Evaluate once more at the chosen t so scratch holds that configuration.
  const pLx = scratch.aLx + scratch.dLx * t;
  const pLy = scratch.aLy + scratch.dLy * t;
  const pLz = scratch.aLz + scratch.dLz * t;
  clampToBox(pLx, pLy, pLz, hx, hy, hz);
  scratch.pLx = pLx;
  scratch.pLy = pLy;
  scratch.pLz = pLz;

  let nLx: number;
  let nLy: number;
  let nLz: number;
  let depth: number;
  let feature: Feature;

  if (scratch.inside) {
    // The spine passes through the box. There is no outward direction from the
    // clamp, so push out along whichever face is nearest — the minimum
    // translation that resolves the overlap.
    const dx = hx - Math.abs(pLx);
    const dy = hy - Math.abs(pLy);
    const dz = hz - Math.abs(pLz);

    if (dx <= dy && dx <= dz) {
      const s = pLx >= 0 ? 1 : -1;
      nLx = s; nLy = 0; nLz = 0;
      depth = dx + cap.radius;
      scratch.qLx = s * hx;
      scratch.qLy = pLy;
      scratch.qLz = pLz;
    } else if (dy <= dz) {
      const s = pLy >= 0 ? 1 : -1;
      nLx = 0; nLy = s; nLz = 0;
      depth = dy + cap.radius;
      scratch.qLx = pLx;
      scratch.qLy = s * hy;
      scratch.qLz = pLz;
    } else {
      const s = pLz >= 0 ? 1 : -1;
      nLx = 0; nLy = 0; nLz = s;
      depth = dz + cap.radius;
      scratch.qLx = pLx;
      scratch.qLy = pLy;
      scratch.qLz = s * hz;
    }
    feature = Feature.Inside;
  } else {
    const ox = pLx - scratch.qLx;
    const oy = pLy - scratch.qLy;
    const oz = pLz - scratch.qLz;
    const dist2 = ox * ox + oy * oy + oz * oz;
    const reach = cap.radius + margin;

    if (dist2 > reach * reach) return false;

    const dist = Math.sqrt(dist2);
    if (dist < 1e-9) {
      // Sitting exactly on the surface, so the offset gives no direction. Use
      // the nearest face, which is well defined whatever the clamp recorded.
      const dx = hx - Math.abs(pLx);
      const dy = hy - Math.abs(pLy);
      const dz = hz - Math.abs(pLz);
      if (dx <= dy && dx <= dz) { nLx = pLx >= 0 ? 1 : -1; nLy = 0; nLz = 0; }
      else if (dy <= dz) { nLx = 0; nLy = pLy >= 0 ? 1 : -1; nLz = 0; }
      else { nLx = 0; nLy = 0; nLz = pLz >= 0 ? 1 : -1; }
      depth = cap.radius;
    } else {
      const inv = 1 / dist;
      nLx = ox * inv;
      nLy = oy * inv;
      nLz = oz * inv;
      depth = cap.radius - dist;
    }

    // Zero means outside, but within FEATURE_TOL of every face it crossed —
    // a plateau artefact, which is a face contact in every way that matters.
    const clamped = popcount3(scratch.clampedAxes);
    feature = clamped <= 1 ? Feature.Face : clamped === 2 ? Feature.Edge : Feature.Vertex;
  }

  // Box-local -> world. The basis vectors are the columns going back out.
  out.nx = nLx * box.ux + nLy * box.vx + nLz * box.wx;
  out.ny = nLx * box.uy + nLy * box.vy + nLz * box.wy;
  out.nz = nLx * box.uz + nLy * box.vz + nLz * box.wz;

  out.px = box.cx + pLx * box.ux + pLy * box.vx + pLz * box.wx;
  out.py = box.cy + pLx * box.uy + pLy * box.vy + pLz * box.wy;
  out.pz = box.cz + pLx * box.uz + pLy * box.vz + pLz * box.wz;

  out.qx = box.cx + scratch.qLx * box.ux + scratch.qLy * box.vx + scratch.qLz * box.wx;
  out.qy = box.cy + scratch.qLx * box.uy + scratch.qLy * box.vy + scratch.qLz * box.wy;
  out.qz = box.cz + scratch.qLx * box.uz + scratch.qLy * box.vz + scratch.qLz * box.wz;

  out.depth = depth;
  out.feature = feature;
  out.clampedAxes = scratch.clampedAxes;
  out.t = t;
  return true;
}

/**
 * Distance between a capsule's spine and an OBB surface, ignoring the radius.
 * Zero when the spine is inside. Exposed for tests and debug tooling.
 */
export function spineDistanceToObb(cap: Capsule, box: Obb): number {
  const probe = makeContact();
  // Zero radius plus an unbounded margin guarantees a contact is written, so
  // the closest-point pair is always available to measure.
  const zeroRadius: Capsule = { ...cap, radius: 0 };
  if (!capsuleVsObb(zeroRadius, box, probe, Number.POSITIVE_INFINITY)) {
    return Number.POSITIVE_INFINITY;
  }
  // An Inside contact reports the closest point on the nearest *face*, since
  // that is the direction to push out. The spine itself is within the box, so
  // its distance to the box is zero.
  if (probe.feature === Feature.Inside) return 0;
  return Math.hypot(probe.px - probe.qx, probe.py - probe.qy, probe.pz - probe.qz);
}

/** Build an OBB from a position, a unit-quaternion rotation, and half-extents. */
export function obbFromQuaternion(
  cx: number, cy: number, cz: number,
  qx: number, qy: number, qz: number, qw: number,
  hx: number, hy: number, hz: number,
): Obb {
  // Rotation matrix columns are the rotated basis vectors.
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;

  return {
    cx, cy, cz,
    ux: 1 - (yy + zz), uy: xy + wz, uz: xz - wy,
    vx: xy - wz, vy: 1 - (xx + zz), vz: yz + wx,
    wx: xz + wy, wy: yz - wx, wz: 1 - (xx + yy),
    hx, hy, hz,
  };
}

/** World-space AABB enclosing an OBB, for insertion into the broadphase. */
export function obbAabb(box: Obb): {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
} {
  // Projecting the box onto each world axis: the extent is the sum of each
  // local half-extent times the magnitude of that axis's world component.
  const ex = Math.abs(box.ux) * box.hx + Math.abs(box.vx) * box.hy + Math.abs(box.wx) * box.hz;
  const ey = Math.abs(box.uy) * box.hx + Math.abs(box.vy) * box.hy + Math.abs(box.wy) * box.hz;
  const ez = Math.abs(box.uz) * box.hx + Math.abs(box.vz) * box.hy + Math.abs(box.wz) * box.hz;
  return {
    minX: box.cx - ex, minY: box.cy - ey, minZ: box.cz - ez,
    maxX: box.cx + ex, maxY: box.cy + ey, maxZ: box.cz + ez,
  };
}
