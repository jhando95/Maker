/**
 * Water balloons.
 *
 * Simulated on the fixed timestep like everything else, in a fixed-size pool.
 * Allocating a mesh per balloon at eight shots a second would stutter within a
 * minute, so both the simulation slots and the instanced visuals are preallocated
 * and recycled.
 *
 * Collision is a segment raycast along each tick's path rather than a swept
 * sphere. The existing CollisionWorld already answers rays against exactly the
 * same broadphase the character uses, and a balloon is small enough that
 * treating it as a point is honest. Tunnelling is impossible by construction:
 * the fastest balloon covers 0.33m per tick against 0.05m lumber, and the ray is
 * continuous over that span.
 */

import { CollisionWorld } from '../physics/collisionWorld.ts';
import type { PartId } from '../physics/types.ts';
import type { Rng } from '../core/rng.ts';

/** Peak launch speed at full charge, m/s. */
export const THROW_SPEED_MAX = 20;
export const THROW_SPEED_MIN = 9;
/** Seconds of held button to reach full power. */
export const CHARGE_TIME = 0.55;
/**
 * Projectile gravity, deliberately heavier than the player's 23.
 *
 * A balloon on player gravity flies a flat, rifle-like line that reads as a
 * bullet. Exaggerating the arc is what makes it read as a lobbed water balloon,
 * and it forces the player to think about firing position and elevation — which
 * is the entire reason to build a tower.
 */
export const PROJECTILE_GRAVITY = 32;
/** Visual radius, and the radius used for hit tests against characters. */
export const BALLOON_RADIUS = 0.14;
/** Anything within this of an impact is caught in the splash. */
export const SPLASH_RADIUS = 1.6;
/** Balloons vanish after this long, in case one escapes the yard. */
export const MAX_LIFETIME = 6;
/** Pool size. Beyond this the oldest live balloon is recycled. */
export const MAX_BALLOONS = 64;

export interface BalloonHit {
  x: number; y: number; z: number;
  nx: number; ny: number; nz: number;
  /** The part struck, or -1 for ground or a character. */
  part: PartId;
  /** Index into the target list, or -1 if nothing was hit directly. */
  targetIndex: number;
  /** Who threw it. */
  ownerId: number;
}

/** Anything a balloon can hit. Players and bots both present this shape. */
export interface BalloonTarget {
  x: number; y: number; z: number;
  /** Capsule radius, for the direct-hit test. */
  radius: number;
  /** Total height, for the direct-hit test. */
  height: number;
  /** Owner id, so a thrower is not hit by their own balloon. */
  id: number;
  alive: boolean;
}

interface Balloon {
  active: boolean;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  age: number;
  ownerId: number;
  /** Slot in the visual pool, so rendering can follow without a lookup. */
  colorway: number;
}

export class ProjectileSystem {
  private readonly world: CollisionWorld;
  private readonly balloons: Balloon[] = [];
  /** Round-robin cursor, so a full pool recycles the oldest rather than failing. */
  private cursor = 0;

  /** Impacts from the most recent tick, for the mode and audio to react to. */
  readonly hits: BalloonHit[] = [];

  constructor(world: CollisionWorld) {
    this.world = world;
    for (let i = 0; i < MAX_BALLOONS; i++) {
      this.balloons.push({
        active: false,
        x: 0, y: 0, z: 0,
        vx: 0, vy: 0, vz: 0,
        age: 0,
        ownerId: -1,
        colorway: 0,
      });
    }
  }

  /** Launch speed for a given charge fraction, 0..1. */
  static speedForCharge(charge: number): number {
    const t = Math.max(0, Math.min(1, charge));
    // Eased rather than linear: most of the useful range sits in the first
    // half-second, so a quick tap still throws usefully far.
    return THROW_SPEED_MIN + (THROW_SPEED_MAX - THROW_SPEED_MIN) * (t * (2 - t));
  }

  /**
   * Throw a balloon.
   *
   * @returns the index of the balloon spawned.
   */
  spawn(
    x: number, y: number, z: number,
    dx: number, dy: number, dz: number,
    speed: number,
    ownerId: number,
    colorway = 0,
  ): number {
    let index = -1;
    for (let i = 0; i < this.balloons.length; i++) {
      const slot = (this.cursor + i) % this.balloons.length;
      if (!this.balloons[slot]!.active) {
        index = slot;
        break;
      }
    }
    // Pool exhausted: take the round-robin slot, which is the oldest in flight.
    if (index === -1) index = this.cursor;
    this.cursor = (index + 1) % this.balloons.length;

    const len = Math.hypot(dx, dy, dz) || 1;
    const b = this.balloons[index]!;
    b.active = true;
    b.x = x; b.y = y; b.z = z;
    b.vx = (dx / len) * speed;
    b.vy = (dy / len) * speed;
    b.vz = (dz / len) * speed;
    b.age = 0;
    b.ownerId = ownerId;
    b.colorway = colorway;
    return index;
  }

  /**
   * Advance every balloon one tick and resolve impacts.
   *
   * `targets` are tested as upright capsules; the world is tested with one ray
   * per balloon along its path this tick.
   */
  update(dt: number, targets: readonly BalloonTarget[]): void {
    this.hits.length = 0;

    for (const b of this.balloons) {
      if (!b.active) continue;

      b.age += dt;
      if (b.age > MAX_LIFETIME) {
        b.active = false;
        continue;
      }

      b.vy -= PROJECTILE_GRAVITY * dt;

      const sx = b.x;
      const sy = b.y;
      const sz = b.z;
      const dx = b.vx * dt;
      const dy = b.vy * dt;
      const dz = b.vz * dt;
      const travel = Math.hypot(dx, dy, dz);

      if (travel < 1e-6) {
        b.x += dx; b.y += dy; b.z += dz;
        continue;
      }

      // Nearest of: a character along the path, or the world.
      let bestT = 1;
      let hitTarget = -1;

      for (let i = 0; i < targets.length; i++) {
        const t = targets[i]!;
        if (!t.alive || t.id === b.ownerId) continue;
        const tt = segmentHitsCapsule(
          sx, sy, sz, dx, dy, dz,
          t.x, t.y, t.z, t.radius + BALLOON_RADIUS, t.height,
        );
        if (tt >= 0 && tt < bestT) {
          bestT = tt;
          hitTarget = i;
        }
      }

      const ray = this.world.raycast(sx, sy, sz, dx, dy, dz, travel);
      const worldT = ray === null ? Infinity : ray.distance / travel;

      if (hitTarget !== -1 && bestT <= worldT) {
        const t = targets[hitTarget]!;
        this.hits.push({
          x: sx + dx * bestT, y: sy + dy * bestT, z: sz + dz * bestT,
          nx: 0, ny: 1, nz: 0,
          part: -1,
          targetIndex: hitTarget,
          ownerId: b.ownerId,
        });
        void t;
        b.active = false;
        continue;
      }

      if (ray !== null) {
        this.hits.push({
          x: ray.x, y: ray.y, z: ray.z,
          nx: ray.nx, ny: ray.ny, nz: ray.nz,
          part: ray.isGround ? -1 : ray.part,
          targetIndex: -1,
          ownerId: b.ownerId,
        });
        b.active = false;
        continue;
      }

      b.x += dx;
      b.y += dy;
      b.z += dz;
    }
  }

  /**
   * Everything caught in a splash, excluding the thrower.
   *
   * Returns indices into `targets`. Splash is a plain sphere test with no line
   * of sight check — a balloon that bursts on the far side of a wall should not
   * soak you through it, but the cheap fix is that walls stop the balloon in the
   * first place, which they do.
   */
  splashTargets(hit: BalloonHit, targets: readonly BalloonTarget[]): number[] {
    const out: number[] = [];
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i]!;
      if (!t.alive || t.id === hit.ownerId) continue;
      // Measure to the middle of the capsule rather than the feet, or a balloon
      // landing at head height reads as a miss.
      const cy = t.y + t.height * 0.5;
      if (Math.hypot(t.x - hit.x, cy - hit.y, t.z - hit.z) <= SPLASH_RADIUS) out.push(i);
    }
    return out;
  }

  /** Live balloons, for rendering. */
  forEachActive(fn: (index: number, x: number, y: number, z: number, colorway: number) => void): void {
    for (let i = 0; i < this.balloons.length; i++) {
      const b = this.balloons[i]!;
      if (b.active) fn(i, b.x, b.y, b.z, b.colorway);
    }
  }

  get activeCount(): number {
    let n = 0;
    for (const b of this.balloons) if (b.active) n++;
    return n;
  }

  clear(): void {
    for (const b of this.balloons) b.active = false;
    this.hits.length = 0;
  }

  /**
   * A ballistic aim direction that lands on a target, for bots.
   *
   * Solves the low-arc solution of the standard projectile equation. Returns
   * null when the target is out of range at this speed, which is the caller's
   * cue to move closer rather than to fire hopefully into the ground.
   */
  static solveArc(
    fromX: number, fromY: number, fromZ: number,
    toX: number, toY: number, toZ: number,
    speed: number,
    rng?: Rng,
    spread = 0,
  ): { dx: number; dy: number; dz: number } | null {
    const gx = toX - fromX;
    const gz = toZ - fromZ;
    const horizontal = Math.hypot(gx, gz);
    const vertical = toY - fromY;

    const s2 = speed * speed;
    const g = PROJECTILE_GRAVITY;
    // Discriminant of v^4 - g(g*x^2 + 2*y*v^2); negative means out of range.
    const disc = s2 * s2 - g * (g * horizontal * horizontal + 2 * vertical * s2);
    if (disc < 0) return null;

    const angle = Math.atan2(s2 - Math.sqrt(disc), g * horizontal);
    const jitter = rng !== undefined && spread > 0 ? rng.signed(spread) : 0;

    const cos = Math.cos(angle + jitter);
    const sin = Math.sin(angle + jitter);
    const inv = horizontal > 1e-6 ? 1 / horizontal : 0;

    return { dx: gx * inv * cos, dy: sin, dz: gz * inv * cos };
  }
}

/**
 * Earliest fraction of a segment that touches an upright capsule, or -1.
 *
 * The capsule stands from (cx, cy, cz) to (cx, cy + height, cz). Rather than a
 * full capsule-segment solve, this tests the infinite cylinder and then clamps —
 * for a projectile against an upright character the difference only matters
 * within a radius of the very top and bottom, and treating those as hits is the
 * forgiving direction.
 */
export function segmentHitsCapsule(
  sx: number, sy: number, sz: number,
  dx: number, dy: number, dz: number,
  cx: number, cy: number, cz: number,
  radius: number,
  height: number,
): number {
  // Solve in the XZ plane against the cylinder's circular cross-section.
  const ox = sx - cx;
  const oz = sz - cz;
  const a = dx * dx + dz * dz;
  const b = 2 * (ox * dx + oz * dz);
  const c = ox * ox + oz * oz - radius * radius;

  if (a < 1e-12) {
    // Travelling straight up or down. Inside the circle already, so the answer
    // is entirely about whether the segment's vertical span crosses the
    // capsule's — testing only the start point misses a balloon dropped from
    // directly overhead, which is the whole reason to fire straight down.
    if (c > 0) return -1;
    const loY = cy - radius;
    const hiY = cy + height + radius;
    if (Math.abs(dy) < 1e-12) return sy >= loY && sy <= hiY ? 0 : -1;
    const t0 = (loY - sy) / dy;
    const t1 = (hiY - sy) / dy;
    const enter = Math.max(0, Math.min(t0, t1));
    const exit = Math.min(1, Math.max(t0, t1));
    return enter <= exit ? enter : -1;
  }

  const disc = b * b - 4 * a * c;
  if (disc < 0) return -1;
  const root = Math.sqrt(disc);

  for (const t of [(-b - root) / (2 * a), (-b + root) / (2 * a)]) {
    if (t < 0 || t > 1) continue;
    const y = sy + dy * t;
    if (y >= cy - radius && y <= cy + height + radius) return t;
  }
  return -1;
}
