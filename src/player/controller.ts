/**
 * Kinematic character controller.
 *
 * Runs on the fixed timestep, never on the render frame. Every number here is
 * tuned against the build kit's dimensions rather than chosen in isolation: the
 * step height clears a plank, the jump clears a module-height platform, the
 * climb speed matches the ladder rung pitch. A player who stacks parts on the
 * grid should get a structure that is climbable without being told the rules.
 */

import { CollisionWorld } from '../physics/collisionWorld.ts';
import type { Capsule } from '../physics/types.ts';
import { MIN_GROUND_NORMAL_Y } from '../physics/constants.ts';
import {
  AIR_ACCEL,
  CAP_HALF_SPINE,
  CAP_HALF_SPINE_CROUCH,
  CAP_RADIUS,
  CLIMB_MAX_TILT_DEG,
  CLIMB_REACH,
  CLIMB_SPEED,
  COYOTE_TIME,
  CROUCH_SPEED,
  EYE_HEIGHT,
  EYE_HEIGHT_CROUCH,
  GRAVITY,
  GROUND_ACCEL,
  GROUND_FRICTION,
  GROUND_SNAP_DISTANCE,
  JUMP_BUFFER_TIME,
  JUMP_VELOCITY,
  MAX_FALL_SPEED,
  SKIN,
  SPRINT_SPEED,
  STEP_HEIGHT,
  WALK_SPEED,
} from '../physics/constants.ts';

/**
 * How the face is sampled when looking for something to grab.
 *
 * The spacing is 0.15m against a 0.25m build module on purpose — see
 * hasHandholds. The relief threshold is under one plank thickness (0.05m), so
 * boards nailed flat to a wall count as rungs, which is the cheapest ladder a
 * player can improvise and should work.
 */
const HANDHOLD_SAMPLES = 8;
const HANDHOLD_LOW = 0.45;
const HANDHOLD_SPACING = 0.15;
const HANDHOLD_RELIEF = 0.04;

export interface MoveIntent {
  /** Desired direction in world space, already rotated by the camera yaw. */
  forward: number;
  right: number;
  jump: boolean;
  sprint: boolean;
  crouch: boolean;
  /** Up/down intent while on a ladder. */
  climb: number;
}

/**
 * A whole controller, frozen.
 *
 * Its own type rather than an inline shape so a field added to the controller
 * and forgotten here is a compile error rather than a rewind that quietly loses
 * a timer.
 */
export interface ControllerState {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  onGround: boolean;
  crouching: boolean;
  climbing: boolean;
  eyeHeight: number;
  coyoteTimer: number;
  jumpBuffer: number;
  halfSpine: number;
  prevX: number; prevY: number; prevZ: number;
  prevEyeHeight: number;
}

export interface PlayerState {
  /** Feet position. */
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  onGround: boolean;
  crouching: boolean;
  climbing: boolean;
  /** Eye height above the feet, animated for crouch. */
  eyeHeight: number;
}

export class CharacterController {
  private readonly world: CollisionWorld;
  private readonly capsule: Capsule;

  x = 0;
  y = 0;
  z = 0;
  vx = 0;
  vy = 0;
  vz = 0;

  onGround = false;
  crouching = false;
  climbing = false;

  /** Interpolated for rendering, so crouching is a smooth dip not a snap. */
  eyeHeight = EYE_HEIGHT;

  private coyoteTimer = 0;
  private jumpBuffer = 0;
  private halfSpine = CAP_HALF_SPINE;

  /** Previous tick's position, for render interpolation. */
  prevX = 0;
  prevY = 0;
  prevZ = 0;
  prevEyeHeight = EYE_HEIGHT;

  constructor(world: CollisionWorld, x = 0, y = 0, z = 0) {
    this.world = world;
    this.x = this.prevX = x;
    this.y = this.prevY = y;
    this.z = this.prevZ = z;
    this.capsule = {
      ax: x, ay: y + CAP_RADIUS, az: z,
      bx: x, by: y + CAP_RADIUS + CAP_HALF_SPINE * 2, bz: z,
      radius: CAP_RADIUS,
    };
  }

  /** Rebuild the capsule from the current feet position and stance. */
  private syncCapsule(): void {
    this.capsule.ax = this.x;
    this.capsule.ay = this.y + CAP_RADIUS;
    this.capsule.az = this.z;
    this.capsule.bx = this.x;
    this.capsule.by = this.y + CAP_RADIUS + this.halfSpine * 2;
    this.capsule.bz = this.z;
  }

  private readFromCapsule(): void {
    this.x = this.capsule.ax;
    this.y = this.capsule.ay - CAP_RADIUS;
    this.z = this.capsule.az;
  }

  teleport(x: number, y: number, z: number): void {
    this.x = this.prevX = x;
    this.y = this.prevY = y;
    this.z = this.prevZ = z;
    this.vx = this.vy = this.vz = 0;
    this.syncCapsule();
  }

  /**
   * Every bit of state a step depends on, so a step can be taken back.
   *
   * Client-side prediction needs exactly this: when the host says where you
   * really were three ticks ago, the client puts the body back there and replays
   * the inputs it has sent since. Replaying from a *partial* restore is worse
   * than not predicting at all — a missed coyote timer or a stale crouch turns
   * one late packet into a jump that silently does not happen, and the symptom
   * is "the controls are unreliable" rather than anything a log would show.
   *
   * So this deliberately captures the private timers too. `prev*` is included
   * because it is what render interpolation reads, and a rewind that leaves it
   * behind draws a frame of the old position on top of the new one.
   */
  capture(): ControllerState {
    return {
      x: this.x, y: this.y, z: this.z,
      vx: this.vx, vy: this.vy, vz: this.vz,
      onGround: this.onGround,
      crouching: this.crouching,
      climbing: this.climbing,
      eyeHeight: this.eyeHeight,
      coyoteTimer: this.coyoteTimer,
      jumpBuffer: this.jumpBuffer,
      halfSpine: this.halfSpine,
      prevX: this.prevX, prevY: this.prevY, prevZ: this.prevZ,
      prevEyeHeight: this.prevEyeHeight,
    };
  }

  restore(state: ControllerState): void {
    this.x = state.x; this.y = state.y; this.z = state.z;
    this.vx = state.vx; this.vy = state.vy; this.vz = state.vz;
    this.onGround = state.onGround;
    this.crouching = state.crouching;
    this.climbing = state.climbing;
    this.eyeHeight = state.eyeHeight;
    this.coyoteTimer = state.coyoteTimer;
    this.jumpBuffer = state.jumpBuffer;
    this.halfSpine = state.halfSpine;
    this.prevX = state.prevX; this.prevY = state.prevY; this.prevZ = state.prevZ;
    this.prevEyeHeight = state.prevEyeHeight;
    this.syncCapsule();
  }

  step(dt: number, intent: MoveIntent): void {
    this.prevX = this.x;
    this.prevY = this.y;
    this.prevZ = this.z;
    this.prevEyeHeight = this.eyeHeight;

    this.updateStance(intent);
    this.syncCapsule();

    if (this.climbing || this.tryEnterClimb(intent)) {
      this.stepClimbing(dt, intent);
    } else {
      this.stepGrounded(dt, intent);
    }

    // Crouch dip is animated on the render value only; the collision capsule
    // changes instantly so the player never clips through a gap mid-animation.
    const targetEye = this.crouching ? EYE_HEIGHT_CROUCH : EYE_HEIGHT;
    this.eyeHeight += (targetEye - this.eyeHeight) * Math.min(1, dt * 14);
  }

  /**
   * Crouch and stand.
   *
   * Standing is refused when something is overhead, which is what stops a player
   * from popping through a plank floor by releasing crouch underneath it.
   */
  private updateStance(intent: MoveIntent): void {
    if (intent.crouch && !this.crouching) {
      this.crouching = true;
      this.halfSpine = CAP_HALF_SPINE_CROUCH;
    } else if (!intent.crouch && this.crouching) {
      const probe: Capsule = {
        ax: this.x, ay: this.y + CAP_RADIUS, az: this.z,
        bx: this.x, by: this.y + CAP_RADIUS + CAP_HALF_SPINE * 2, bz: this.z,
        radius: CAP_RADIUS,
      };
      if (this.world.hasRoom(probe)) {
        this.crouching = false;
        this.halfSpine = CAP_HALF_SPINE;
      }
    }
  }

  private get maxSpeed(): number {
    if (this.crouching) return CROUCH_SPEED;
    return WALK_SPEED;
  }

  private stepGrounded(dt: number, intent: MoveIntent): void {
    const wasOnGround = this.onGround;

    // Coyote time: a jump pressed just after walking off a ledge still works.
    // Without it, players who build a platform and run off the edge feel the
    // game ate their input.
    if (wasOnGround) this.coyoteTimer = COYOTE_TIME;
    else this.coyoteTimer = Math.max(0, this.coyoteTimer - dt);

    // Jump buffering: pressed just before landing, fires on touchdown.
    if (intent.jump) this.jumpBuffer = JUMP_BUFFER_TIME;
    else this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);

    const target = this.desiredVelocity(intent);
    const accel = this.onGround ? GROUND_ACCEL : AIR_ACCEL;

    // Accelerate toward the target horizontal velocity. Framerate-independent
    // because it is a rate times dt, clamped so a long frame cannot overshoot.
    const blend = Math.min(1, accel * dt / Math.max(this.maxSpeed, 0.001));
    this.vx += (target.x - this.vx) * blend;
    this.vz += (target.z - this.vz) * blend;

    if (this.onGround && target.x === 0 && target.z === 0) {
      const friction = Math.max(0, 1 - GROUND_FRICTION * dt / Math.max(this.maxSpeed, 0.001));
      this.vx *= friction;
      this.vz *= friction;
    }

    if (this.jumpBuffer > 0 && this.coyoteTimer > 0) {
      this.vy = JUMP_VELOCITY;
      this.onGround = false;
      this.jumpBuffer = 0;
      this.coyoteTimer = 0;
    } else {
      this.vy -= GRAVITY * dt;
      if (this.vy < -MAX_FALL_SPEED) this.vy = -MAX_FALL_SPEED;
    }

    const dx = this.vx * dt;
    const dy = this.vy * dt;
    const dz = this.vz * dt;

    const startX = this.capsule.ax;
    const startZ = this.capsule.az;
    // Captured before the move, since sliding along a wall zeroes them.
    const velX = this.vx;
    const velZ = this.vz;

    const result = this.world.moveAndSlide(this.capsule, dx, dy, dz, this.vx, this.vy, this.vz);
    this.readFromCapsule();

    this.vx = result.vx;
    this.vy = result.vy;
    this.vz = result.vz;
    this.onGround = result.onGround;

    // Step-up. Players build stairs out of loose boards, so without this the
    // controller snags on every riser they lay down.
    const movedX = this.capsule.ax - startX;
    const movedZ = this.capsule.az - startZ;
    const wantedDist = Math.hypot(dx, dz);
    const gotDist = Math.hypot(movedX, movedZ);

    if (wasOnGround && wantedDist > 1e-5 && gotDist < wantedDist * 0.9) {
      if (this.tryStepUp(dx, dz)) {
        this.readFromCapsule();
        // Preserve the intended horizontal velocity: sliding along the step's
        // face zeroed it, and keeping it is what makes the climb feel continuous
        // rather than like a stutter at every riser.
        this.vx = velX;
        this.vz = velZ;
      }
    }

    // Ground snap on descent. Walking down a built staircase would otherwise
    // launch the player off every step, turning a smooth descent into bouncing.
    if (wasOnGround && !this.onGround && this.vy <= 0) this.snapToGround();

    this.readFromCapsule();
  }

  /**
   * Lift the capsule onto a low ledge ahead, as a purely vertical correction.
   *
   * The obvious implementation — raise, retry the horizontal move, settle back
   * down — does not work with a capsule. One tick of walking is about 7cm, far
   * less than the 32cm radius needed to clear a board's edge, so the settle
   * drops the capsule onto the *corner* of the step. A corner gives an edge
   * contact whose normal points diagonally, which does not count as ground and
   * slides the player straight back off. The result is a character that bobs
   * against every step forever.
   *
   * Instead: find the surface height just ahead, and if it is walkable and
   * within reach, raise the capsule to it and let ordinary horizontal movement
   * carry the player forward. Once raised, the step no longer blocks anything.
   *
   * @returns true if the capsule was raised.
   */
  private tryStepUp(dirX: number, dirZ: number): boolean {
    const len = Math.hypot(dirX, dirZ);
    if (len < 1e-6) return false;
    const nx = dirX / len;
    const nz = dirZ / len;

    // Probe past the capsule's own radius so we sample the step's top surface,
    // not the face we are pressed against.
    const probeDist = CAP_RADIUS + 0.12;
    const hit = this.world.raycast(
      this.x + nx * probeDist,
      this.y + STEP_HEIGHT + 0.02,
      this.z + nz * probeDist,
      0, -1, 0,
      STEP_HEIGHT + 0.06,
    );
    if (hit === null) return false;
    // Only step onto something you could stand on.
    if (hit.ny < MIN_GROUND_NORMAL_Y) return false;

    const rise = hit.y - this.y;
    if (rise <= 0.01 || rise > STEP_HEIGHT) return false;

    // Refuse if the raised stance would not fit — stepping up under a low
    // plank ceiling must not jam the capsule into it.
    const probe: Capsule = {
      ax: this.x, ay: this.y + rise + SKIN + CAP_RADIUS, az: this.z,
      bx: this.x, by: this.y + rise + SKIN + CAP_RADIUS + this.halfSpine * 2, bz: this.z,
      radius: CAP_RADIUS,
    };
    if (!this.world.hasRoom(probe)) return false;

    this.capsule.ay += rise + SKIN;
    this.capsule.by += rise + SKIN;

    // Raising alone is not enough. The feet are still a radius behind the step's
    // face, so on anything but the shallowest rise the capsule is left standing
    // over thin air and ground-snapping drops it straight back down — the reason
    // the effective step height was 0.25m against an advertised 0.55m, with
    // every rise from 0.30 upward silently failing.
    //
    // So carry it far enough that its footprint is actually over the new
    // surface. Bounded to a fraction of the radius, which is small enough not to
    // read as a teleport and large enough to clear the lip.
    // Carried as far as it will go, not all or nothing. On a staircase the next
    // riser blocks the carry almost immediately, and that is the correct
    // outcome — the capsule is already standing on this tread. Undoing the raise
    // because the carry was short would put the climb straight back to failing.
    const carry = Math.min(CAP_RADIUS * 0.75, probeDist);
    this.world.moveAndSlide(this.capsule, nx * carry, 0, nz * carry, 0, 0, 0);

    this.onGround = true;
    if (this.vy < 0) this.vy = 0;
    return true;
  }

  /** Pull the capsule down onto ground within reach, so descents stay smooth. */
  private snapToGround(): void {
    const hit = this.world.raycast(
      this.x, this.y + 0.05, this.z,
      0, -1, 0,
      GROUND_SNAP_DISTANCE + 0.05,
    );
    if (hit === null || hit.ny < MIN_GROUND_NORMAL_Y) return;

    const drop = this.y - hit.y;
    if (drop < 0 || drop > GROUND_SNAP_DISTANCE) return;

    this.capsule.ay -= drop - SKIN;
    this.capsule.by -= drop - SKIN;
    this.onGround = true;
    this.vy = 0;
  }

  private desiredVelocity(intent: MoveIntent): { x: number; z: number } {
    let speed = this.maxSpeed;
    if (intent.sprint && !this.crouching) speed = SPRINT_SPEED;

    let x = intent.right;
    let z = intent.forward;
    const len = Math.hypot(x, z);
    if (len > 1) {
      x /= len;
      z /= len;
    }
    return { x: x * speed, z: z * speed };
  }

  /**
   * Look for something climbable directly ahead.
   *
   * Rather than requiring an explicit ladder object, any near-vertical surface
   * within reach counts. That is the whole point: a player who nails rungs
   * between two rails has built a ladder, and the game should recognise it
   * without being told. The tradeoff is that plain walls are climbable too,
   * which for a backyard fort game is a feature rather than a bug.
   */
  private tryEnterClimb(intent: MoveIntent): boolean {
    if (intent.climb <= 0 && !intent.jump) return false;
    if (Math.abs(intent.forward) < 0.1 && Math.abs(intent.right) < 0.1 && intent.climb <= 0) return false;

    const dirLen = Math.hypot(intent.right, intent.forward);
    if (dirLen < 1e-4) return false;
    const dx = intent.right / dirLen;
    const dz = intent.forward / dirLen;

    // Probe at chest height, where a ladder rail would be.
    const hit = this.world.raycast(
      this.x, this.y + 1.0, this.z,
      dx, 0, dz,
      CAP_RADIUS + CLIMB_REACH,
    );
    if (hit === null || hit.isGround) return false;
    // The map is not a ladder. Without this the house wall is a free lift to the
    // roof, and the roof being awkward to reach is the point of the house.
    if (!this.world.isClimbable(hit.part)) return false;

    // Near-vertical surfaces only.
    const maxY = Math.sin((CLIMB_MAX_TILT_DEG * Math.PI) / 180);
    if (Math.abs(hit.ny) > maxY) return false;

    if (!this.hasHandholds(dx, dz)) return false;

    this.climbing = true;
    return true;
  }

  /**
   * Is there anything on this surface to actually hold on to?
   *
   * The rule used to be "any near-vertical thing you built", which made rungs
   * decoration — a flush wall was as climbable as a ladder. That reads as
   * generous and is quietly corrosive: a wall you build never stops *you*, so
   * building tall has no cost, and the moment a second person is in the yard a
   * fort stops working against the only opponent that matters.
   *
   * What separates a ladder from a wall is not how it looks, it is that a ladder
   * has things sticking out of it. So that is what gets measured: sample the
   * face at several heights and see whether its **depth varies**. Rungs give a
   * near/far/near pattern as the ray alternately catches a rung and the board
   * behind it; a flush wall returns the same distance every time.
   *
   * Sampling is deliberately offset from the build grid. At the kit's own 0.25m
   * module, samples 0.25m apart would land on every rung or between every rung,
   * and read a perfect ladder as a flat wall.
   */
  private hasHandholds(dx: number, dz: number): boolean {
    let nearest = Infinity;
    let furthest = -Infinity;
    let found = 0;

    for (let i = 0; i < HANDHOLD_SAMPLES; i++) {
      const probe = this.world.raycast(
        this.x, this.y + HANDHOLD_LOW + i * HANDHOLD_SPACING, this.z,
        dx, 0, dz,
        CAP_RADIUS + CLIMB_REACH,
      );
      if (probe === null || probe.isGround || !this.world.isClimbable(probe.part)) continue;
      found++;
      if (probe.distance < nearest) nearest = probe.distance;
      if (probe.distance > furthest) furthest = probe.distance;
    }

    // One lonely sample is a lip, not a ladder.
    if (found < 2) return false;
    return furthest - nearest > HANDHOLD_RELIEF;
  }

  private stepClimbing(dt: number, intent: MoveIntent): void {
    // Leave the ladder by jumping, or by there being nothing left to hold.
    if (intent.jump) {
      this.climbing = false;
      this.vy = JUMP_VELOCITY * 0.8;
      this.stepGrounded(dt, { ...intent, jump: false });
      return;
    }

    const dirLen = Math.hypot(intent.right, intent.forward);
    const dx = dirLen > 1e-4 ? intent.right / dirLen : 0;
    const dz = dirLen > 1e-4 ? intent.forward / dirLen : 0;

    const still = this.world.raycast(
      this.x, this.y + 1.0, this.z,
      dx !== 0 || dz !== 0 ? dx : 0, 0, dx !== 0 || dz !== 0 ? dz : 1,
      CAP_RADIUS + CLIMB_REACH,
    );
    if (still === null || still.isGround || !this.world.isClimbable(still.part)) {
      this.climbing = false;
      this.stepGrounded(dt, intent);
      return;
    }

    // Climb vertically; forward intent presses into the ladder and holds on.
    const up = intent.climb !== 0 ? intent.climb : intent.forward > 0 ? 1 : 0;
    this.vy = up * CLIMB_SPEED;
    this.vx = 0;
    this.vz = 0;

    const result = this.world.moveAndSlide(
      this.capsule,
      dx * 0.4 * dt, this.vy * dt, dz * 0.4 * dt,
      0, this.vy, 0,
    );
    this.readFromCapsule();
    this.onGround = result.onGround;

    // Reaching the top: step off onto the surface rather than clinging forever.
    if (result.onGround && up <= 0) this.climbing = false;
  }

  /** Snapshot for rendering, interpolated between the last two ticks. */
  sample(alpha: number): PlayerState {
    return {
      x: this.prevX + (this.x - this.prevX) * alpha,
      y: this.prevY + (this.y - this.prevY) * alpha,
      z: this.prevZ + (this.z - this.prevZ) * alpha,
      vx: this.vx, vy: this.vy, vz: this.vz,
      onGround: this.onGround,
      crouching: this.crouching,
      climbing: this.climbing,
      eyeHeight: this.prevEyeHeight + (this.eyeHeight - this.prevEyeHeight) * alpha,
    };
  }

  get speed(): number {
    return Math.hypot(this.vx, this.vz);
  }
}
