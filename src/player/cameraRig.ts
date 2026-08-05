/**
 * First and third person camera.
 *
 * Both modes must be good to build in, which is the constraint that shapes this.
 * In first person the aim ray leaves the eye along the view direction. In third
 * person the camera sits behind the shoulder, so the same ray would start
 * somewhere the player is not looking; instead the ray starts at the player's
 * head and points at whatever is under the crosshair, found by projecting the
 * screen center out from the camera. Without that, third-person building aims
 * consistently wide.
 */

import * as THREE from 'three';
import { clamp, damp } from '../core/mathUtils.ts';
import type { CollisionWorld } from '../physics/collisionWorld.ts';

export type CameraMode = 'first' | 'third';

const PITCH_LIMIT = Math.PI / 2 - 0.02;

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;

  /** Look angles in radians. Yaw is around +Y, pitch is positive looking up. */
  yaw = 0;
  pitch = 0;

  mode: CameraMode = 'first';
  sensitivity = 0.0022;
  invertY = false;
  /** First-person FOV; third person subtracts from this. */
  baseFov = 72;

  /**
   * Third-person boom length and shoulder offset.
   *
   * The boom pivots around the eye, which already sits 1.55m up, so a short
   * boom frames the character rather than the world. At 4.5m the player reads
   * as a figure in a yard; at 3.2m they fill a third of the screen and you
   * cannot see what you are building.
   */
  boomLength = 4.5;
  shoulder = 0.75;
  /** Lifted slightly so the view clears the player's own head. */
  boomRise = 0.35;
  private currentBoom = 4.5;

  /** Blended 0 (first person) to 1 (third), so toggling is a move not a cut. */
  private modeBlend = 0;

  private fovCurrent = 72;

  private readonly world: CollisionWorld;
  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly eye = new THREE.Vector3();
  private readonly desired = new THREE.Vector3();

  constructor(world: CollisionWorld, aspect = 1) {
    this.world = world;
    this.camera = new THREE.PerspectiveCamera(this.baseFov, aspect, 0.1, 1000);
  }

  /** Apply a mouse delta in pixels. */
  look(dx: number, dy: number): void {
    this.turn(-dx * this.sensitivity, -dy * this.sensitivity * (this.invertY ? -1 : 1));
  }

  /**
   * Rotate by an angle in radians.
   *
   * The mouse arrives as a distance already and a stick arrives as a rate that
   * has been multiplied by dt, so both end up here — with one place that clamps
   * pitch and wraps yaw rather than two that could drift apart.
   */
  turn(dYaw: number, dPitch: number): void {
    this.yaw += dYaw;
    this.pitch = clamp(this.pitch + dPitch, -PITCH_LIMIT, PITCH_LIMIT);
    // Keep yaw bounded so it never loses float precision in a long session.
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
    else if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
  }

  toggleMode(): void {
    this.mode = this.mode === 'first' ? 'third' : 'first';
  }

  /** Unit vector the player is looking along. */
  getLookDirection(out = new THREE.Vector3()): THREE.Vector3 {
    const cp = Math.cos(this.pitch);
    return out.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
  }

  /** Ground-plane forward, for movement. Ignores pitch. */
  getMoveBasis(): { fx: number; fz: number; rx: number; rz: number } {
    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    // Right-hand perpendicular in the XZ plane.
    return { fx, fz, rx: -fz, rz: fx };
  }

  /**
   * Position the camera for this frame.
   *
   * @param eyeX/eyeY/eyeZ the player's eye position
   * @param speedFraction 0..1 of top speed, for the sprint FOV kick
   */
  update(
    dt: number,
    eyeX: number, eyeY: number, eyeZ: number,
    speedFraction: number,
  ): void {
    this.eye.set(eyeX, eyeY, eyeZ);
    this.getLookDirection(this.forward);
    this.right.set(-this.forward.z, 0, this.forward.x).normalize();

    const targetBlend = this.mode === 'third' ? 1 : 0;
    this.modeBlend = damp(this.modeBlend, targetBlend, 0.09, dt);

    // Speed widens the view a little. It is a small effect that does most of
    // the work of making sprinting feel faster than it numerically is.
    const targetFov = this.baseFov - (this.mode === 'third' ? 10 : 0) + speedFraction * 6;
    this.fovCurrent = damp(this.fovCurrent, targetFov, 0.12, dt);
    if (Math.abs(this.camera.fov - this.fovCurrent) > 0.01) {
      this.camera.fov = this.fovCurrent;
      this.camera.updateProjectionMatrix();
    }

    if (this.modeBlend < 0.001) {
      this.camera.position.copy(this.eye);
    } else {
      // Full-extension boom offset from the eye, as a direction and a length.
      this.desired
        .set(0, this.boomRise, 0)
        .addScaledVector(this.forward, -this.boomLength)
        .addScaledVector(this.right, this.shoulder);
      const fullLength = this.desired.length();

      let allowed = fullLength;
      if (fullLength > 1e-4) {
        this.desired.divideScalar(fullLength);
        // Pull the boom in when something is in the way. In a game where
        // players fill the world with boards, an un-collided boom spends most
        // of its time inside something.
        const hit = this.world.raycast(
          this.eye.x, this.eye.y, this.eye.z,
          this.desired.x, this.desired.y, this.desired.z,
          fullLength + 0.2,
        );
        // Margin so the near plane never ends up behind the surface.
        if (hit !== null) allowed = clamp(hit.distance - 0.25, 0.2, fullLength);
      }

      // Snap inward immediately but ease back out: a boom that eases inward
      // spends those frames with the camera inside the wall.
      this.currentBoom =
        allowed < this.currentBoom ? allowed : damp(this.currentBoom, allowed, 0.1, dt);

      const target = this.eye.clone().addScaledVector(this.desired, this.currentBoom);
      this.camera.position.lerpVectors(this.eye, target, this.modeBlend);
    }

    this.camera.quaternion.setFromEuler(
      new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'),
    );
  }

  /**
   * The ray used for building and interaction.
   *
   * First person: straight out of the eye. Third person: from the head toward
   * whatever the crosshair covers, which is what the player believes they are
   * pointing at.
   */
  getAimRay(
    eyeX: number, eyeY: number, eyeZ: number,
    maxDistance: number,
  ): { ox: number; oy: number; oz: number; dx: number; dy: number; dz: number } {
    if (this.modeBlend < 0.5) {
      const d = this.getLookDirection(this.forward);
      return { ox: eyeX, oy: eyeY, oz: eyeZ, dx: d.x, dy: d.y, dz: d.z };
    }

    // Find the point under the crosshair by casting from the camera, then aim
    // the player's ray at it.
    const camDir = this.getLookDirection(this.forward);
    const hit = this.world.raycast(
      this.camera.position.x, this.camera.position.y, this.camera.position.z,
      camDir.x, camDir.y, camDir.z,
      maxDistance + this.boomLength,
    );

    const targetX = hit !== null ? hit.x : this.camera.position.x + camDir.x * (maxDistance + this.boomLength);
    const targetY = hit !== null ? hit.y : this.camera.position.y + camDir.y * (maxDistance + this.boomLength);
    const targetZ = hit !== null ? hit.z : this.camera.position.z + camDir.z * (maxDistance + this.boomLength);

    let dx = targetX - eyeX;
    let dy = targetY - eyeY;
    let dz = targetZ - eyeZ;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) {
      const d = this.getLookDirection(this.forward);
      return { ox: eyeX, oy: eyeY, oz: eyeZ, dx: d.x, dy: d.y, dz: d.z };
    }
    dx /= len;
    dy /= len;
    dz /= len;
    return { ox: eyeX, oy: eyeY, oz: eyeZ, dx, dy, dz };
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** True when the player model should be drawn. */
  get showsPlayer(): boolean {
    return this.modeBlend > 0.2;
  }
}
