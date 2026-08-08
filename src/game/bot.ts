/**
 * Opponents.
 *
 * Bots drive the same CharacterController the player does, so they step up onto
 * boards, snag on the same seams and fall off the same ledges. Anything that
 * feels wrong for a bot is something that would feel wrong for a player, which
 * is worth more than a bespoke mover that glides over the terrain.
 *
 * There is no navmesh, and there cannot be a baked one: the world is arbitrary
 * boxes placed at runtime and changing every few seconds while the player
 * builds. So navigation is direct steering plus probing — the bot walks at its
 * target, and when something stops it, it looks for a way round.
 *
 * The distinction that matters is between "blocked by a wall the player built"
 * and "wedged in a seam". The first is the entire point of the mode and should
 * read as the bot being thwarted; the second is a bug the bot must recover from
 * on its own. Both look like "not moving", so they are told apart by whether a
 * probe finds open ground nearby.
 */

import { CollisionWorld } from '../physics/collisionWorld.ts';
import { CharacterController, type MoveIntent } from '../player/controller.ts';
import { CAP_RADIUS, CAP_HEIGHT } from '../physics/constants.ts';
import type { Rng } from '../core/rng.ts';
import { ProjectileSystem } from './projectiles.ts';
import type { BalloonTarget } from './projectiles.ts';
import type { NavField } from './navField.ts';
import type { Actor, Team } from './actor.ts';
import { PULL_REACH, pullProgress, pulledFree } from './demolition.ts';

export type BotState = 'approach' | 'divert' | 'attack' | 'stunned' | 'done';

export interface BotConfig {
  speed: number;
  /** How close it wants to get before attacking. */
  attackRange: number;
  /** Seconds between throws. */
  fireInterval: number;
  /** Radians of aim error. Higher is easier for the player. */
  aimSpread: number;
  /** Seconds of being soaked before recovering. */
  stunDuration: number;
  /** Hits it takes before it gives up and leaves. */
  toughness: number;
}

export const BOT_TIERS: Record<string, BotConfig> = {
  easy: { speed: 3.0, attackRange: 7, fireInterval: 3.2, aimSpread: 0.16, stunDuration: 2.2, toughness: 1 },
  normal: { speed: 3.8, attackRange: 8, fireInterval: 2.4, aimSpread: 0.1, stunDuration: 1.8, toughness: 2 },
  tough: { speed: 4.4, attackRange: 9, fireInterval: 1.8, aimSpread: 0.06, stunDuration: 1.4, toughness: 3 },
};

/** Under this speed for this long counts as not making progress. */
const STUCK_SPEED = 0.55;
const STUCK_TIME = 0.7;
/** How long a diversion is committed to before re-evaluating. */
const DIVERT_TIME = 1.1;
/** Headings tried when looking for a way round, in radians off target. */
const DIVERT_ANGLES = [0.6, -0.6, 1.2, -1.2, 2.0, -2.0];
/**
 * How long a kid puts up with getting no closer before it starts pulling.
 *
 * Long enough that walking the length of a fort looking for a door is not
 * mistaken for being thwarted by it, short enough that a sealed fort is a
 * problem the player has to come and deal with rather than a permanent win.
 */
const FRUSTRATION_TIME = 4.5;

/** How much closer counts as getting closer. Below this it is just jostling. */
const PROGRESS_STEP = 0.35;

/**
 * Inside this range the nav grid is too coarse to steer by — a 0.75m cell is
 * larger than the objective — so the bot goes back to aiming straight at it.
 */
const CELL_TRUST_DISTANCE = 2.5;

export class Bot implements Actor {
  readonly id: number;
  /** Intent comes from the behaviour below rather than a keyboard or a socket. */
  readonly kind = 'ai';
  /**
   * Which side this kid is on.
   *
   * Defaults to the side opposite the player because that is what every bot has
   * been so far. It is a field rather than a constant so a mode can put one on
   * your side without inventing a second kind of character to do it.
   */
  team: Team = 'right';
  readonly controller: CharacterController;
  private readonly world: CollisionWorld;
  private readonly config: BotConfig;
  private readonly rng: Rng;

  state: BotState = 'approach';
  hits = 0;

  /**
   * Where the bot is walking. This is the objective, not the enemy — a bot's
   * job is to reach the stash, and stopping short of it to trade shots would
   * mean the player could never actually lose.
   */
  targetX = 0;
  targetY = 0;
  targetZ = 0;

  /** Who to throw at, if anyone is worth throwing at. Set each tick. */
  aimX = 0;
  aimY = 0;
  aimZ = 0;
  hasAim = false;

  private stateTimer = 0;
  private stuckTimer = 0;
  private fireTimer = 0;
  private divertX = 0;
  private divertZ = 0;
  /** Facing, smoothed so bots do not spin on the spot. */
  private headingX = 0;
  private headingZ = -1;

  constructor(
    id: number,
    world: CollisionWorld,
    rng: Rng,
    config: BotConfig,
    x: number, y: number, z: number,
  ) {
    this.id = id;
    this.world = world;
    this.rng = rng;
    this.config = config;
    this.controller = new CharacterController(world, x, y, z);
    // Stagger the first shot so a wave does not fire in unison.
    this.fireTimer = rng.range(0.4, config.fireInterval);
  }

  get x(): number { return this.controller.x; }
  get y(): number { return this.controller.y; }
  get z(): number { return this.controller.z; }
  get alive(): boolean { return this.state !== 'done'; }
  /** Washed out by the renderer, so it reads at a glance who is still a threat. */
  get stunned(): boolean { return this.state === 'stunned'; }

  /** Shape the projectile system tests against. */
  asTarget(): BalloonTarget {
    return {
      x: this.controller.x,
      y: this.controller.y,
      z: this.controller.z,
      radius: CAP_RADIUS,
      height: CAP_HEIGHT,
      id: this.id,
      alive: this.alive && this.state !== 'stunned',
    };
  }

  /** Soaked by a balloon. Returns true if this finished it off. */
  soak(): boolean {
    if (this.state === 'done') return false;
    this.hits++;
    if (this.hits >= this.config.toughness) {
      this.state = 'done';
      return true;
    }
    this.state = 'stunned';
    this.stateTimer = this.config.stunDuration;
    return false;
  }

  /**
   * One simulation tick.
   *
   * @param canSeeTarget whether the bot has line of sight, which the mode
   *   computes so it can be shared with other systems.
   */
  update(
    dt: number,
    projectiles: ProjectileSystem,
    canSeeTarget: boolean,
    nav: NavField | null = null,
  ): void {
    if (this.state === 'done') return;

    this.stateTimer -= dt;
    this.fireTimer -= dt;
    // A pull lapses the moment the kid stops being stuck against that plank.
    // Checked here, before the behaviour runs, so a tick that finds a way round
    // drops the effort rather than finishing the pull on its way past.
    if (!this.pullReached) {
      this.pullPart = null;
      this.pullElapsed = 0;
    }
    this.pullReached = false;
    if (this.pullPart !== null) this.pullElapsed += dt;

    if (this.state === 'stunned') {
      // Stand still and drip. Gravity still applies, so a stunned bot on a
      // ledge falls off it, which is a small joy.
      this.controller.step(dt, this.idleIntent());
      if (this.stateTimer <= 0) this.state = 'approach';
      return;
    }

    const dx = this.targetX - this.controller.x;
    const dz = this.targetZ - this.controller.z;
    const distance = Math.hypot(dx, dz);

    // Frustration, measured as distance to the objective rather than as speed.
    //
    // The first version of this hung the pull off the bot's existing "nowhere
    // to go" branch, on the reasoning that a kid only starts pulling when every
    // way round is blocked. Measured against a real ring wall, that branch
    // never fired once in sixty seconds: the diversion probes go out to two
    // radians either side, and from outside a round fort those always find open
    // lawn — so the kid circles it forever, perfectly happy, and the wall is
    // never touched.
    //
    // "Cannot get closer" is the condition that actually means the fort is
    // working. Circling a wall keeps the distance to what is inside it exactly
    // the same; a way in reduces it. So an open fort is still beaten by walking
    // through the gap, which is the design, and a sealed one gets hauled at.
    if (distance < this.closest - PROGRESS_STEP) {
      this.closest = distance;
      this.frustration = 0;
    } else {
      this.frustration += dt;
    }
    if (this.frustration >= FRUSTRATION_TIME) this.aimPull(Math.atan2(dx, dz));

    // The bot keeps advancing whatever else it is doing. Throwing happens on
    // the move, so a fort has to physically stop them rather than merely
    // out-range them.
    let moveX = 0;
    let moveZ = 0;

    if (this.state === 'divert') {
      moveX = this.divertX;
      moveZ = this.divertZ;
      if (this.stateTimer <= 0) this.state = 'approach';
    } else {
      this.state = 'approach';

      // Global routing first. Close to the objective the grid is too coarse to
      // trust, so the last couple of metres are steered directly.
      const routed = nav !== null && distance > CELL_TRUST_DISTANCE
        ? nav.direction(this.controller.x, this.controller.z)
        : null;

      if (routed !== null) {
        moveX = routed.dx;
        moveZ = routed.dz;
      } else {
        const inv = distance > 1e-4 ? 1 / distance : 0;
        moveX = dx * inv;
        moveZ = dz * inv;
      }
    }

    const before = { x: this.controller.x, z: this.controller.z };
    this.controller.step(dt, {
      right: moveX,
      forward: moveZ,
      jump: false,
      sprint: false,
      crouch: false,
      climb: 0,
    });
    const moved = Math.hypot(this.controller.x - before.x, this.controller.z - before.z) / dt;

    // Face what it is throwing at when it has a shot, otherwise where it walks.
    const faceX = this.hasAim ? this.aimX - this.controller.x : moveX;
    const faceZ = this.hasAim ? this.aimZ - this.controller.z : moveZ;
    const faceLen = Math.hypot(faceX, faceZ);
    if (faceLen > 1e-4) {
      const blend = Math.min(1, dt * 8);
      this.headingX += (faceX / faceLen - this.headingX) * blend;
      this.headingZ += (faceZ / faceLen - this.headingZ) * blend;
    }

    // Stuck detection: wanting to move but not moving.
    const wantsToMove = moveX !== 0 || moveZ !== 0;
    if (wantsToMove && moved < STUCK_SPEED) {
      this.stuckTimer += dt;
      if (this.stuckTimer >= STUCK_TIME) {
        this.stuckTimer = 0;
        this.chooseDiversion(dx, dz, distance);
      }
    } else {
      this.stuckTimer = 0;
    }

    // Throwing is opportunistic: only when there is someone in sight and in
    // range. `canSeeTarget` is line of sight to whoever the mode nominated.
    if (this.hasAim && canSeeTarget && this.fireTimer <= 0) {
      const aimDist = Math.hypot(this.aimX - this.controller.x, this.aimZ - this.controller.z);
      if (aimDist <= this.config.attackRange) {
        this.throwAt(projectiles);
        this.fireTimer = this.config.fireInterval;
      }
    }
  }

  /**
   * Pick a heading that actually has room, when the direct route is blocked.
   *
   * Probes a fan of angles either side of the target and takes the first with
   * clear space a couple of metres out. If every angle is blocked, the bot is
   * genuinely walled in — it stays put and attacks, which is the mode working as
   * intended rather than a failure to path.
   */
  private chooseDiversion(dx: number, dz: number, distance: number): void {
    const baseAngle = Math.atan2(dx, dz);
    const eye = this.controller.y + CAP_HEIGHT * 0.5;

    for (const offset of DIVERT_ANGLES) {
      const a = baseAngle + offset;
      const px = Math.sin(a);
      const pz = Math.cos(a);
      // Look a little beyond the capsule so a clear probe means a real gap.
      const probe = this.world.raycast(
        this.controller.x, eye, this.controller.z,
        px, 0, pz,
        CAP_RADIUS + 2.0,
      );
      if (probe === null) {
        this.divertX = px;
        this.divertZ = pz;
        this.state = 'divert';
        this.stateTimer = DIVERT_TIME;
        return;
      }
    }

    // Nowhere to go. A bot bunched against a wall it genuinely cannot pass
    // reads as thwarted, which is the point of having built the wall — and it
    // is also the one honest moment to start pulling the wall apart. Every way
    // round has been tried and blocked, so this cannot trivialise a bad fort:
    // a bad fort is beaten by walking round it and never reaches here.
    //
    // The part is only *named* here. The mode does the demolishing, because
    // the mode is what the host runs, and a bot reaching into the build system
    // itself would be a second authority over the shape of the world.
    this.state = 'approach';
    void distance;
  }

  /**
   * What this kid has both hands on, and how far through it is.
   *
   * Null unless it is stuck against something somebody built. Read by the mode
   * after `update`, which is the only thing allowed to act on it.
   */
  get pulling(): { part: number; progress: number } | null {
    if (this.pullPart === null) return null;
    return { part: this.pullPart, progress: pullProgress(this.pullElapsed) };
  }

  /** True on the tick the part comes away. The mode takes it from there. */
  get pullDone(): boolean {
    return this.pullPart !== null && pulledFree(this.pullElapsed);
  }

  /** Called by the mode once it has acted, so the kid starts on the next one. */
  clearPull(): void {
    this.pullPart = null;
    this.pullElapsed = 0;
  }

  private pullPart: number | null = null;
  private pullElapsed = 0;
  /** Closest this kid has ever got to what it wants, and for how long. */
  private closest = Infinity;
  private frustration = 0;
  /** Set by `aimPull` each tick it runs; cleared at the top of the next. */
  private pullReached = false;

  /**
   * Reach for whatever is directly in the way.
   *
   * Effort is per-plank rather than a stopwatch: a kid who shuffles along a
   * wall trying one board after another must not arrive at the fourth with
   * three seconds of credit, so changing target resets the clock.
   */
  private aimPull(heading: number): void {
    const eye = this.controller.y + CAP_HEIGHT * 0.5;
    const hit = this.world.raycast(
      this.controller.x, eye, this.controller.z,
      Math.sin(heading), 0, Math.cos(heading),
      CAP_RADIUS + PULL_REACH,
    );
    // Fixtures are skipped here for the kid's sake rather than for the map's.
    // `BuildSystem.demolish` refuses map geometry outright and is the authority
    // — this second check exists so a kid does not spend two and a half seconds
    // hauling on the fence, achieve nothing, and immediately start again on the
    // same fence for the rest of the round.
    const part = hit === null || hit.isGround || this.world.isFixture(hit.part)
      ? null
      : hit.part;
    if (part === null) return;
    this.pullReached = true;
    if (part !== this.pullPart) {
      this.pullPart = part;
      this.pullElapsed = 0;
    }
  }

  private throwAt(projectiles: ProjectileSystem): void {
    const fromX = this.controller.x;
    const fromY = this.controller.y + CAP_HEIGHT * 0.75;
    const fromZ = this.controller.z;
    const speed = ProjectileSystem.speedForCharge(0.8);

    const arc = ProjectileSystem.solveArc(
      fromX, fromY, fromZ,
      this.aimX, this.aimY + 0.9, this.aimZ,
      speed,
      this.rng,
      this.config.aimSpread,
    );
    // Out of range: hold fire rather than lob one into the dirt.
    if (arc === null) return;

    projectiles.spawn(fromX, fromY, fromZ, arc.dx, arc.dy, arc.dz, speed, this.id, 5);
  }

  private idleIntent(): MoveIntent {
    return { right: 0, forward: 0, jump: false, sprint: false, crouch: false, climb: 0 };
  }

  /** Facing angle, for rendering. */
  get heading(): number {
    return Math.atan2(this.headingX, this.headingZ);
  }
}
