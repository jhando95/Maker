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
import type { Bot } from './bot.ts';

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
  | { type: 'refilled'; x: number; y: number; z: number }
  | { type: 'phaseChange'; phase: string }
  | { type: 'roundWon' }
  | { type: 'roundLost' }
  | { type: 'flagTaken'; x: number; y: number; z: number; byPlayer: boolean }
  | { type: 'flagDropped'; x: number; y: number; z: number }
  | { type: 'flagReturned'; x: number; y: number; z: number }
  | { type: 'captured'; byPlayer: boolean };

/**
 * An objective the renderer should draw.
 *
 * Modes publish a list rather than the renderer knowing about stashes and flags,
 * which is what stops every new mode from adding another branch to the drawing
 * code — and what let Capture the Flag exist without touching the renderer's
 * idea of what a game is.
 */
export interface Marker {
  /** Chooses the shape: a crate, a bucket with a range ring, or a flag. */
  kind: 'stash' | 'bucket' | 'flag';
  x: number; y: number; z: number;
  color: number;
  /** Emphasised — the bucket being channelled, the flag you are carrying. */
  active?: boolean;
  /** Drawn dimmed and half-height: a flag away from home. */
  faded?: boolean;
}

/**
 * Weapons the player can switch between, when a mode has any.
 *
 * Optional because Fort Defense and Capture the Flag each have exactly one
 * thing to throw, and a picker for a choice of one is worse than no picker.
 */
export interface Loadout {
  readonly entries: ReadonlyArray<{
    id: string;
    name: string;
    blurb: string;
    /** False when it is out of water, or out of hose. */
    ready: boolean;
  }>;
  readonly selected: string;
  select(id: string): void;
}

/** The result screen, in the mode's own words. */
export interface ModeSummary {
  /** The headline, e.g. "The fort held!". */
  headline: string;
  lines: ReadonlyArray<{ label: string; value: string }>;
}

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
  /**
   * How wet the player is, 0..1, or null in a mode without a soaking meter.
   *
   * Its own field rather than borrowed space on `charge`: a yellow bar that
   * usually means "your throw is winding up" cannot also mean "you are about to
   * be knocked out of the fight" without teaching the player the wrong thing.
   */
  wetness: number | null;
  /**
   * Rounds left, drawn as pips — or a tank, drawn as a bar.
   *
   * `gauge` exists because the pip renderer is per-unit: a 100 litre tank came
   * out as a hundred pips and a thousand pixels of them. Pips are for things you
   * can count and ration; a gauge is for something continuous.
   */
  ammo: { current: number; max: number; gauge?: boolean } | null;
  /** 0..1 progress on a refill channel, or null when not at a bucket. */
  refill: number | null;
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
  /** Objectives to draw. Called every frame; must not allocate per call. */
  markers(): readonly Marker[];
  /**
   * How the round went, for the result screen.
   *
   * The mode words it, because only the mode knows whether the interesting
   * number is waves held or captures made. The shell used to read `wavesHeld`
   * and `stash.supplies` straight off the mode, which meant a second mode could
   * not finish without inventing waves it does not have.
   */
  summary(): ModeSummary;
  /** Bots the renderer should draw. Empty when the mode has none. */
  readonly bots: readonly Bot[];
  /** Whether the player may place parts right now. */
  readonly buildingAllowed: boolean;
  /** Multiplier on player speed, for being soaked. */
  readonly playerSpeedScale: number;
  /** Weapons to offer in the picker, or undefined when there is one option. */
  readonly loadout?: Loadout;
  /**
   * Where a continuous stream currently ends, or null.
   *
   * The mode owns the ray because the mode owns what stops it; the renderer
   * only needs to know where to draw water to.
   */
  readonly stream?: { x: number; y: number; z: number } | null;
  /**
   * How wet a given bot is, 0..1, for the renderer to tint by.
   *
   * Optional, because a mode without a soaking meter has nothing to say here.
   * Without it the meter is invisible: you cannot tell the kid you have nearly
   * finished from the one who just arrived, so choosing who to shoot — the
   * decision the meter exists to create — is a guess.
   */
  wetnessOf?(botId: number): number;
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
  readonly bots: readonly Bot[] = [];
  readonly buildingAllowed = true;
  readonly playerSpeedScale = 1;

  start(): void {}
  fixedUpdate(): void {}
  end(): void {}
  markers(): readonly Marker[] {
    return [];
  }

  summary(): ModeSummary {
    return { headline: 'Sandbox', lines: [] };
  }

  hud(): ModeHud {
    return {
      phase: 'SANDBOX',
      timer: null,
      primary: null,
      secondary: null,
      message: null,
      charge: null,
      wetness: null,
      ammo: null,
      refill: null,
    };
  }
}
