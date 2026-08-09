/**
 * The see-saw, finally moving.
 *
 * The prefab shipped with its tilt authored — a plank frozen mid-ride —
 * because a plank that pivots under live weight is a moving collision
 * platform, and the collision world was static. It is not any more:
 * `CollisionWorld.updatePart` moves a box in place, and this is the first
 * thing built on it. The tyre stays map scenery; the plank is alive.
 *
 * ## How it decides to move
 *
 * Torque, from whoever is standing on it: each rider pushes their end down
 * in proportion to how far out they stand, exactly like the real thing — a
 * kid on the very tip out-levers a kid near the middle. Unloaded, a small
 * gravity bias tips it onto whichever end it already leans toward, because a
 * balanced empty see-saw is a coin on its edge and nobody has ever seen one.
 * The motion is damped and the tilt clamped at the angle the prefab used to
 * be frozen at, so the plank settles onto its end instead of ringing.
 *
 * ## Determinism, and what a guest sees
 *
 * The tick is a pure function of dt and the riders' positions — no wall
 * clock, no randomness — so a replay reproduces every swing. In a session,
 * each machine ticks its own plank from the actors it knows about: the host
 * from the real ones, a guest from its predicted self and interpolated
 * others. The tilts can disagree by a frame's worth of interpolation; the
 * host's snapshots correct any body that difference misplaces, which is the
 * same contract every other collision already has. What is deliberately NOT
 * here is a tilt angle on the wire — twenty bytes a second forever, to
 * correct a disagreement measured in hundredths of a radian.
 *
 * ## Building on it
 *
 * You can nail a plank to the see-saw — it is a fixture like any other —
 * and what you build will not ride the tilt: support reads rest poses.
 * That is a known and accepted silliness; the alternative is structures
 * whose support graph changes sixty times a second.
 */

import type { CollisionWorld } from '../physics/collisionWorld.ts';
import type { PartId } from '../physics/types.ts';

/** The plank the prefab draws, now as the moving half of the pair. */
export const PLANK_HALF = { hx: 1.9, hy: 0.08, hz: 0.25 } as const;
/** Where the plank pivots: the top of the tyre. */
export const PIVOT_Y = 0.62;
/** The clamp — the same 0.2 radians the prefab's authored tilt used. */
export const SEESAW_MAX_ANGLE = 0.2;

/** How hard one rider at the very tip pushes, in rad/s². */
const RIDER_TORQUE = 2.6;
/** The unloaded lean: enough to settle it onto an end, easy to overpower. */
const GRAVITY_BIAS = 0.7;
/** Velocity damping — the plank settles rather than rings. */
const DAMPING = 3.0;
/** How far past the plank's footprint a rider still counts, in metres. */
const RIDE_MARGIN = 0.2;
/** How far above or below the surface a body still counts as riding. */
const RIDE_BAND = 1.2;

export interface SeesawSpot {
  x: number;
  z: number;
  /** Quarter turns, matching the prefab placement's frame rotation. */
  turns: number;
}

/** Somebody with a position; the roster's actors qualify via their bodies. */
export interface RiderBody {
  x: number;
  y: number;
  z: number;
}

export class Seesaw {
  /**
   * Tilt in radians. The surface at a point `along` the plank sits at
   * `PIVOT_Y + sin(angle) * along`, so positive angle *raises* the local +X
   * end — a rider standing at +along therefore drives the angle down.
   */
  angle = SEESAW_MAX_ANGLE;
  private angularVelocity = 0;

  private readonly plankId: PartId;
  /** The plank's long axis in the world, from the prefab's quarter turns. */
  private readonly axisX: number;
  private readonly axisZ: number;

  constructor(
    private readonly world: CollisionWorld,
    readonly x: number,
    readonly z: number,
    turns: number,
  ) {
    // The same frame rotation place() applies to slabs: each quarter turn
    // maps local (x, z) to (z, -x). The long axis starts along +X.
    let ax = 1;
    let az = 0;
    for (let i = 0; i < ((turns % 4) + 4) % 4; i++) {
      const nx = az;
      az = -ax;
      ax = nx;
    }
    this.axisX = ax;
    this.axisZ = az;
    this.plankId = this.world.addFixture(
      0, 0, x, PIVOT_Y, z,
      ...this.quat(),
      PLANK_HALF.hx, PLANK_HALF.hy, PLANK_HALF.hz,
    ).id;
    this.push();
  }

  /**
   * One step of the ride, from whoever is standing on the plank.
   *
   * Riders push their end down by lever arm; standing under a raised end
   * counts too and pushes it down onto you, which is not a bug — it is how
   * kids actually operate a see-saw for each other.
   */
  tick(dt: number, riders: Iterable<RiderBody>): void {
    let torque = this.angle >= 0 ? GRAVITY_BIAS : -GRAVITY_BIAS;

    for (const body of riders) {
      const dx = body.x - this.x;
      const dz = body.z - this.z;
      const along = dx * this.axisX + dz * this.axisZ;
      if (Math.abs(along) > PLANK_HALF.hx + RIDE_MARGIN) continue;
      const across = -dx * this.axisZ + dz * this.axisX;
      if (Math.abs(across) > PLANK_HALF.hz + RIDE_MARGIN) continue;
      const surface = PIVOT_Y + Math.sin(this.angle) * along;
      if (Math.abs(body.y - surface) > RIDE_BAND) continue;
      // Their end goes down: weight at +along has to shrink the surface
      // height there, and the surface rises with the angle — so the push is
      // negative. The first version had this sign backwards, which is a
      // see-saw that lifts whoever steps on it.
      torque -= (along / PLANK_HALF.hx) * RIDER_TORQUE;
    }

    this.angularVelocity += (torque - DAMPING * this.angularVelocity) * dt;
    this.angle += this.angularVelocity * dt;
    if (this.angle >= SEESAW_MAX_ANGLE) {
      this.angle = SEESAW_MAX_ANGLE;
      // The end is on the ground; the swing's energy goes into the dirt.
      if (this.angularVelocity > 0) this.angularVelocity = 0;
    } else if (this.angle <= -SEESAW_MAX_ANGLE) {
      this.angle = -SEESAW_MAX_ANGLE;
      if (this.angularVelocity < 0) this.angularVelocity = 0;
    }

    this.push();
  }

  /** Where the plank is, for the mesh that draws it. */
  pose(): { x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number } {
    const [qx, qy, qz, qw] = this.quat();
    return { x: this.x, y: PIVOT_Y, z: this.z, qx, qy, qz, qw };
  }

  /** Tilt about the plank's local Z, then the placement's yaw about Y. */
  private quat(): [number, number, number, number] {
    const half = this.angle / 2;
    const tz = Math.sin(half);
    const tw = Math.cos(half);
    // Yaw from the axis vector: the quarter-turn frame is exact, so the
    // half-angle trig is too.
    const yaw = Math.atan2(-this.axisZ, this.axisX);
    const yy = Math.sin(yaw / 2);
    const yw = Math.cos(yaw / 2);
    // q = yaw ⊗ tilt, with yaw (0, yy, 0, yw) and tilt (0, 0, tz, tw).
    return [
      yy * tz,
      yy * tw,
      yw * tz,
      yw * tw,
    ];
  }

  private push(): void {
    const [qx, qy, qz, qw] = this.quat();
    this.world.updatePart(this.plankId, this.x, PIVOT_Y, this.z, qx, qy, qz, qw);
  }
}
