/**
 * Small math helpers shared across simulation and rendering.
 *
 * Kept dependency-free of Three.js so the collision and snapping math stays
 * unit-testable in plain Node without spinning up a WebGL context.
 */

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;
export const EPSILON = 1e-6;

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function inverseLerp(a: number, b: number, v: number): number {
  return Math.abs(b - a) < EPSILON ? 0 : (v - a) / (b - a);
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01(inverseLerp(edge0, edge1, x));
  return t * t * (3 - 2 * t);
}

/**
 * Frame-rate independent exponential smoothing.
 *
 * The naive `current += (target - current) * 0.1` per frame silently changes
 * speed with frame rate — smoothing tuned at 60fps snaps at 144fps. `halfLife`
 * is the time in seconds for the remaining distance to halve, which stays
 * consistent whatever dt is.
 */
export function damp(current: number, target: number, halfLife: number, dt: number): number {
  if (halfLife <= 0) return target;
  return target + (current - target) * Math.pow(2, -dt / halfLife);
}

/** Move toward a target by at most `maxDelta` — linear, no overshoot. */
export function moveToward(current: number, target: number, maxDelta: number): number {
  const diff = target - current;
  if (Math.abs(diff) <= maxDelta) return target;
  return current + Math.sign(diff) * maxDelta;
}

/** Wrap an angle in radians to (-PI, PI]. */
export function wrapAngle(a: number): number {
  const twoPi = Math.PI * 2;
  let r = a % twoPi;
  if (r > Math.PI) r -= twoPi;
  else if (r <= -Math.PI) r += twoPi;
  return r;
}

/** Shortest signed angular difference from `a` to `b`, in radians. */
export function angleDelta(a: number, b: number): number {
  return wrapAngle(b - a);
}

/** Round to the nearest multiple of `step`. A step of 0 passes the value through. */
export function snapTo(value: number, step: number): number {
  return step <= 0 ? value : Math.round(value / step) * step;
}

/**
 * Round toward the nearest multiple, but only when already within `tolerance`
 * of one. Outside that band the value is untouched — this is the "soft snap"
 * behavior the build system wants, where nudging near an alignment locks on but
 * deliberate off-grid placement is preserved.
 */
export function snapToWithin(value: number, step: number, tolerance: number): number {
  if (step <= 0) return value;
  const snapped = Math.round(value / step) * step;
  return Math.abs(snapped - value) <= tolerance ? snapped : value;
}

/** Squared distance in 3D — avoids a sqrt in hot comparison loops. */
export function dist2(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
): number {
  const dx = ax - bx;
  const dy = ay - by;
  const dz = az - bz;
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Hysteresis gate for a "best candidate" selection that runs every frame.
 *
 * Snapping ranks candidates by score each frame; when two are nearly tied the
 * winner flips back and forth and the ghost preview visibly strobes. Requiring
 * a challenger to beat the incumbent by a margin makes the choice sticky.
 */
export function beatsIncumbent(
  challengerScore: number,
  incumbentScore: number,
  margin: number,
): boolean {
  return challengerScore > incumbentScore + margin;
}
