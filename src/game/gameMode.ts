/**
 * The seam between the engine and the rules.
 *
 * main.ts owns the loop, the world and the player, and knows nothing about what
 * is being played. A mode owns rules, timers and score, and reaches the engine
 * only through this context. Without that split every new mode would add another
 * branch to the tick function until it became unreadable.
 *
 * Modes never render. They publish state, and the presentation layer reads it.
 * That is also what will let a server run a mode headlessly.
 */

import type { CollisionWorld } from '../physics/collisionWorld.ts';
import type { BuildSystem } from '../build/buildSystem.ts';
import type { CharacterController } from '../player/controller.ts';
import type { CameraRig } from '../player/cameraRig.ts';
import type { ProjectileSystem } from './projectiles.ts';
import type { Rng } from '../core/rng.ts';

/** Everything a mode is allowed to touch. */
export interface ModeContext {
  world: CollisionWorld;
  build: BuildSystem;
  player: CharacterController;
  camera: CameraRig;
  projectiles: ProjectileSystem;
  rng: Rng;
  /** Raise a presentation event. Modes must not play sounds or draw directly. */
  emit(event: GameEvent): void;
  /** Tell the renderer the world changed, so static shadows refresh. */
  worldChanged(): void;
}

/**
 * Something worth reacting to, raised by simulation and drained by presentation.
 *
 * A queue rather than direct calls keeps the simulation free of audio and
 * rendering concerns, and means a replay or a remote client can produce the same
 * feedback from the same events.
 */
export type GameEvent =
  | { type: 'splash'; x: number; y: number; z: number }
  | { type: 'throw'; x: number; y: number; z: number }
  | { type: 'botSoaked'; x: number; y: number; z: number }
  | { type: 'playerSoaked' }
  | { type: 'stashHit'; remaining: number }
  | { type: 'phaseChange'; phase: string }
  | { type: 'roundWon' }
  | { type: 'roundLost' };

/** What the HUD needs from whatever mode is running. */
export interface ModeHud {
  /** Short label for the current phase, e.g. "BUILD" or "WAVE 3". */
  phase: string;
  /** Seconds left in the phase, or null when it is not timed. */
  timer: number | null;
  /** Primary counter, e.g. supplies remaining. */
  primary: { label: string; value: string } | null;
  secondary: { label: string; value: string } | null;
  /** A line of guidance, shown large when it changes. */
  message: string | null;
  /** 0..1 charge on the throw, or null when not aiming. */
  charge: number | null;
  ammo: { current: number; max: number } | null;
}

export interface ModeInput {
  /** Held this tick. */
  fire: boolean;
  firePressed: boolean;
  fireReleased: boolean;
}

export interface GameMode {
  readonly id: string;
  readonly name: string;
  /** True once the round has been decided; the shell shows a result screen. */
  readonly finished: boolean;
  /** Set when finished. */
  readonly won: boolean;

  start(ctx: ModeContext): void;
  fixedUpdate(dt: number, ctx: ModeContext, input: ModeInput): void;
  end(ctx: ModeContext): void;
  hud(): ModeHud;
  /** Extra things to draw, e.g. bot avatars. Owned by the mode, added to the scene. */
  readonly attachments?: unknown;
}

/**
 * Free build, no rules. The behaviour the game had before modes existed.
 *
 * Kept as a real mode rather than a null case so the shell has exactly one code
 * path and sandbox cannot silently diverge from how modes are driven.
 */
export class SandboxMode implements GameMode {
  readonly id = 'sandbox';
  readonly name = 'Sandbox';
  readonly finished = false;
  readonly won = false;

  start(): void {}
  fixedUpdate(): void {}
  end(): void {}

  hud(): ModeHud {
    return {
      phase: 'SANDBOX',
      timer: null,
      primary: null,
      secondary: null,
      message: null,
      charge: null,
      ammo: null,
    };
  }
}
