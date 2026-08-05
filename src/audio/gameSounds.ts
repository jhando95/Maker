/**
 * Turns simulation state into sound.
 *
 * Deliberately a separate layer that *observes* the player and build system
 * rather than something they call into. Gameplay code stays free of audio
 * concerns, and when a second player exists this same driver can run against a
 * remote player's state with no changes.
 *
 * Nothing here may affect world state — it reads only, and it is free to use
 * Math.random because presentation does not need to be reproducible.
 */

import type { AudioBus } from './audioBus.ts';
import { AudioBus as Bus } from './audioBus.ts';
import type { CharacterController } from '../player/controller.ts';
import type { CameraRig } from '../player/cameraRig.ts';
import type { CollisionWorld } from '../physics/collisionWorld.ts';

/** Distance walked between footsteps, in metres. */
const STRIDE = 2.1;
/** Stride shortens when sprinting, so the cadence rises with speed. */
const SPRINT_STRIDE = 2.6;

export class GameSounds {
  private readonly bus: AudioBus;
  private readonly world: CollisionWorld;

  private strideAccum = 0;
  private wasOnGround = true;
  /** Peak downward speed during the current fall, for landing weight. */
  private fallSpeed = 0;

  constructor(bus: AudioBus, world: CollisionWorld) {
    this.bus = bus;
    this.world = world;
  }

  /** Call once per simulation tick, after the player has moved. */
  update(dt: number, player: CharacterController, camera: CameraRig): void {
    if (!this.bus.running) return;

    const speed = player.speed;

    // Footsteps are driven by distance travelled, not by a timer. A timer
    // detaches the cadence from the movement and immediately sounds wrong when
    // the player is pushed against a wall and going nowhere.
    if (player.onGround && speed > 0.6) {
      const stride = speed > 5.5 ? SPRINT_STRIDE : STRIDE;
      this.strideAccum += speed * dt;
      if (this.strideAccum >= stride) {
        this.strideAccum -= stride;
        this.step(player);
      }
    } else {
      // Bleed the accumulator so stopping and starting does not fire a step
      // instantly, and so the first step after landing is a full stride away.
      this.strideAccum = Math.min(this.strideAccum, STRIDE * 0.6);
    }

    if (!player.onGround) {
      this.fallSpeed = Math.max(this.fallSpeed, -player.vy);
    }

    // Landing: fired on the ground transition, weighted by how fast we fell.
    if (player.onGround && !this.wasOnGround) {
      const weight = Math.min(1, this.fallSpeed / 12);
      if (this.fallSpeed > 2.0) {
        this.bus.play('land', {
          volume: 0.35 + weight * 0.5,
          pitch: 1.15 - weight * 0.25,
        });
      }
      this.fallSpeed = 0;
    }

    // Jumping: detected as leaving the ground with upward velocity, which
    // distinguishes it from walking off a ledge.
    if (!player.onGround && this.wasOnGround && player.vy > 1.0) {
      this.bus.play('jump', { volume: 0.3, pitch: 0.95 + Math.random() * 0.1 });
    }

    this.wasOnGround = player.onGround;
    void camera;
  }

  /**
   * One footstep, on grass or on wood.
   *
   * The surface is found by casting down from the feet: a hit on a placed part
   * means the player is standing on something they built. It is one short ray
   * per step, not per frame, so the cost is negligible.
   */
  private step(player: CharacterController): void {
    const hit = this.world.raycast(player.x, player.y + 0.15, player.z, 0, -1, 0, 0.5);
    const onWood = hit !== null && !hit.isGround;
    this.bus.play(onWood ? 'stepWood' : 'stepGrass', {
      volume: 0.28 + Math.random() * 0.08,
      // Per-step pitch variation is most of what stops footsteps sounding
      // like a looping sample.
      pitch: 0.9 + Math.random() * 0.22,
      pan: (Math.random() - 0.5) * 0.25,
    });
  }

  /** A part was placed at this world position. */
  placed(x: number, y: number, z: number, camera: CameraRig, player: CharacterController): void {
    this.bus.play('place', {
      ...this.spatial(x, y, z, camera, player),
      pitch: 0.92 + Math.random() * 0.18,
    });
  }

  removed(x: number, y: number, z: number, camera: CameraRig, player: CharacterController): void {
    this.bus.play('remove', {
      ...this.spatial(x, y, z, camera, player),
      pitch: 0.95 + Math.random() * 0.12,
    });
  }

  /** The build ghost latched onto a new snap target. */
  snapped(): void {
    this.bus.play('snap', { volume: 0.5 });
  }

  invalid(): void {
    this.bus.play('invalid', { volume: 0.5 });
  }

  /** A part chosen from the wheel. Quiet — it happens often and means little. */
  pickPart(): void {
    this.bus.play('uiClick', { volume: 0.45, pitch: 1.2 });
  }

  private spatial(
    x: number, y: number, z: number,
    camera: CameraRig,
    player: CharacterController,
  ) {
    // The camera's right vector in the XZ plane, which is all a stereo pan needs.
    const basis = camera.getMoveBasis();
    return Bus.spatial(
      x, y, z,
      player.x, player.y + 1.5, player.z,
      basis.rx, basis.rz,
      24,
    );
  }
}
