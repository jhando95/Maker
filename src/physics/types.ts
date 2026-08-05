/**
 * Core collision shapes. Deliberately plain data with no Three.js dependency,
 * so the collision math stays testable in plain Node and can later run on a
 * server with no renderer.
 */

export type PartId = number;
export const NO_PART = -1;

/**
 * Oriented bounding box — every placed piece of lumber is one of these.
 *
 * Rotation is stored as three world-space unit axes rather than a quaternion.
 * Parts are placed once and then tested thousands of times, so paying the
 * conversion at placement keeps quaternion math entirely out of the hot loop.
 */
export interface Obb {
  /** World-space center. */
  cx: number; cy: number; cz: number;
  /** Box-local X axis, in world space. */
  ux: number; uy: number; uz: number;
  /** Box-local Y axis, in world space. */
  vx: number; vy: number; vz: number;
  /** Box-local Z axis, in world space. */
  wx: number; wy: number; wz: number;
  /** Half-extents along u, v, w. */
  hx: number; hy: number; hz: number;
}

/** A segment swept by a radius. `a` is the lower endpoint for the character. */
export interface Capsule {
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
  radius: number;
}

/**
 * Which feature of the box the closest point landed on, derived from how many
 * axes had to be clamped to reach it.
 *
 * This drives internal-edge removal: two boards placed flush share a seam, and
 * an Edge contact on that seam has a diagonal normal that shoves the player
 * sideways for no visible reason. Knowing a contact is an Edge rather than a
 * Face is what lets us check whether it should have been a face contact on a
 * neighbouring board instead.
 */
export const enum Feature {
  /** Outside along one axis — a genuine flat surface. */
  Face = 0,
  /** Outside along two axes. */
  Edge = 1,
  /** Outside along all three. */
  Vertex = 2,
  /** The spine point is inside the box; normal comes from the shallowest axis. */
  Inside = 3,
}

export interface Contact {
  part: PartId;
  /** Unit normal in world space, pointing from the part toward the capsule. */
  nx: number; ny: number; nz: number;
  /** Overlap along the normal. Positive means penetrating. */
  depth: number;
  /** Closest point on the capsule spine, world space. */
  px: number; py: number; pz: number;
  /** Closest point on the box surface, world space. */
  qx: number; qy: number; qz: number;
  feature: Feature;
  /** Bit k set means box axis k was clamped when finding the closest point. */
  clampedAxes: number;
  /** Parameter along the capsule spine, in [0,1], where the contact occurred. */
  t: number;
}

export function makeContact(): Contact {
  return {
    part: NO_PART,
    nx: 0, ny: 1, nz: 0,
    depth: 0,
    px: 0, py: 0, pz: 0,
    qx: 0, qy: 0, qz: 0,
    feature: Feature.Face,
    clampedAxes: 0,
    t: 0,
  };
}
