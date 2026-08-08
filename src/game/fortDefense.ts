/**
 * Fort Defense — the first game mode.
 *
 * You get time to build, then waves of kids come for your stash of water
 * balloons. Soak them before they reach it. Between waves you get more time to
 * patch what failed.
 *
 * The mode exists to answer one question: **is it fun to fight inside something
 * you built?** Everything here is shaped by making that question answerable
 * solo, before multiplayer exists. Bots walk toward a fixed point, which means a
 * wall in their way is the player's own decision paying off — and the failure
 * case is legible, because you watch exactly where they got through.
 *
 * What it cannot answer: whether building *against another player* is fun, and
 * whether the build phase feels good when someone is shooting at you. Both need
 * real opponents.
 */

import { Bot, BOT_TIERS, type BotConfig } from './bot.ts';
import { FIRST_BOT_ID, LOCAL_ACTOR_ID, type Actor } from './actor.ts';
import { Fighters, isFighter, type Fighter } from './fighters.ts';
import { ProjectileSystem, type BalloonTarget } from './projectiles.ts';
import type {
  ActorInput, GameMode, Marker, ModeContext, ModeHud, ModeInput, ModeSelfHud, ModeSummary,
} from './gameMode.ts';
import { CAP_HEIGHT, CAP_RADIUS } from '../physics/constants.ts';
import { NavField } from './navField.ts';
import { Lumber, STARTING_LUMBER, PHASE_DELIVERY, LUMBER_CAP } from '../build/lumber.ts';
import { FORT_YARD } from '../world/neighborhood.ts';

export type Phase = 'build' | 'wave' | 'intermission' | 'over';

/** Seconds of the opening build phase. */
export const BUILD_TIME = 75;
/** Seconds between waves. */
export const INTERMISSION_TIME = 25;
/** How many waves must be survived to win. */
export const WAVE_COUNT = 5;
/** The stash starts with this many balloons; losing them all loses the round. */
export const STASH_SUPPLIES = 6;
/** How close a bot must get to steal from the stash. */
export const STASH_RADIUS = 1.6;
/** Seconds between player throws. */
export const THROW_COOLDOWN = 0.42;
/**
 * Player ammo, and where it comes from.
 *
 * Refilling at the stash rewarded standing on the objective — a turret sit, with
 * the fort as scenery you happened to be inside. Buckets placed outside the
 * likely build footprint convert that into a traversal loop *through* your own
 * fort: you have to leave cover, get back in, and find out whether the way you
 * built it is a route or an obstacle. That is the mode's whole question, asked
 * every thirty seconds instead of once.
 */
export const PLAYER_AMMO_MAX = 8;
/** How long you must stand at a bucket to fill up. */
export const REFILL_TIME = 0.6;
/** How close counts as at a bucket. */
export const BUCKET_RADIUS = 1.8;
/** Distance from the stash. Outside where a fort usually ends up. */
export const BUCKET_DISTANCE = 9.5;

/** Where the stash sits: the front lawn, with the house at your back. */
export const STASH_POSITION = { x: FORT_YARD.x, y: FORT_YARD.y, z: FORT_YARD.z };

/**
 * Bucket positions, spread so no single side of a fort covers them all.
 *
 * Relative to the stash, not to the origin. They used to be absolute, which was
 * indistinguishable from relative while the stash sat at the origin — and would
 * have quietly left all three buckets inside the house the moment it moved.
 */
export const BUCKETS: ReadonlyArray<{ x: number; z: number }> = [0, 1, 2].map((i) => {
  const angle = (i / 3) * Math.PI * 2 + Math.PI / 6;
  return {
    x: STASH_POSITION.x + Math.sin(angle) * BUCKET_DISTANCE,
    z: STASH_POSITION.z + Math.cos(angle) * BUCKET_DISTANCE,
  };
});
/** Being soaked costs the player this long of slowed movement. */
export const PLAYER_SOAK_TIME = 1.4;
/** Seconds between nav-field rebuilds during a wave. */
export const NAV_REBUILD_INTERVAL = 0.2;

/**
 * Project an angle onto the square boundary of the lot.
 *
 * Dividing by the larger of |sin| and |cos| maps the unit circle onto the unit
 * square, so every angle lands on the fence line rather than on a circle that
 * may or may not clear whatever is standing in the middle of the map.
 */
export function spawnOnBoundary(angle: number, bound = SPAWN_BOUND): { x: number; z: number } {
  const sx = Math.sin(angle);
  const sz = Math.cos(angle);
  const scale = bound / Math.max(Math.abs(sx), Math.abs(sz));
  let x = sx * scale;
  const z = sz * scale;
  // The divider fence runs the length of the lot at x = 0, so the two angles
  // that land dead centre would spawn a bot inside it. Nudge clear of the line
  // rather than reject the angle, which would leave a hole in the arrival ring.
  if (Math.abs(x) < DIVIDER_CLEARANCE) {
    x = (x < 0 || Object.is(x, -0) ? -1 : 1) * DIVIDER_CLEARANCE;
  }
  return { x, z };
}

export interface StashState {
  x: number; y: number; z: number;
  supplies: number;
}

/**
 * Waves enter from the edge of the lot rather than from a circle around the
 * objective.
 *
 * A circle put spawns inside the house once the map gained one. Projecting the
 * angle onto the lot boundary instead keeps every spawn on open ground by
 * construction, whatever the objective's position, and reads better anyway —
 * the neighbourhood kids come in over the fence line, not out of thin air
 * around you.
 */
const SPAWN_BOUND = 23.0;
/** How far a spawn must stay from the divider fence that runs down x = 0. */
const DIVIDER_CLEARANCE = 1.6;

export class FortDefenseMode implements GameMode {
  readonly id = 'fortDefense';
  readonly name = 'Fort Defense';

  phase: Phase = 'build';
  wave = 0;
  finished = false;
  won = false;

  readonly stash: StashState = { ...STASH_POSITION, supplies: STASH_SUPPLIES };
  readonly bots: Bot[] = [];

  private timer = BUILD_TIME;
  private message: string | null = 'Build your fort. Protect the stash.';
  private messageTimer = 6;

  /**
   * Balloons, wind-up, cooldown and the soaked timer — one set per person.
   *
   * Singular until a guest could throw. Every field here used to be a bare
   * number on this class, which is the same as saying the mode has room for
   * exactly one pair of hands.
   */
  private readonly fighters = new Fighters(PLAYER_AMMO_MAX);
  /** Which bucket each person is channelling at, by actor id, or -1. */
  private readonly atBuckets = new Map<number, number>();
  private readonly refills = new Map<number, number>();

  private nextBotId = FIRST_BOT_ID;
  /**
   * One field for the whole wave, not one path per bot.
   *
   * Rebuilt a few times a second rather than every tick: the world only changes
   * when someone builds, and a fraction of a second of staleness is invisible
   * next to the cost of flooding the grid sixty times a second.
   */
  private readonly nav = new NavField(26);
  private navTimer = 0;
  /** The pile in the corner of the yard, topped up before each build phase. */
  readonly lumber = new Lumber(STARTING_LUMBER);
  /** Reused so the per-tick target list does not allocate. */
  private readonly targets: BalloonTarget[] = [];

  start(ctx: ModeContext): void {
    this.phase = 'build';
    this.timer = BUILD_TIME;
    this.wave = 0;
    this.lumber.set(STARTING_LUMBER);
    this.stash.supplies = STASH_SUPPLIES;
    this.bots.length = 0;
    this.fighters.reset();
    this.refills.clear();
    this.atBuckets.clear();
    this.finished = false;
    this.won = false;
    this.setMessage('Build your fort. Protect the stash.', 6);
    ctx.emit({ type: 'phaseChange', phase: 'build' });
  }

  end(ctx: ModeContext): void {
    this.bots.length = 0;
    ctx.projectiles.clear();
  }

  fixedUpdate(dt: number, ctx: ModeContext, input: ModeInput): void {
    // The mode owns its bots, so the mode keeps the roster honest — before the
    // early return, so a finished round still draws the right people.
    ctx.actors.refresh(this.bots);
    if (this.finished) return;

    this.messageTimer -= dt;
    if (this.messageTimer <= 0) this.message = null;
    this.fighters.tick(dt);

    // Everybody who is not a bot, in one pass. The roster is the only thing
    // that knows how many people are in the yard, so it is what decides how
    // many pairs of hands this loop runs.
    for (const who of ctx.actors.all) {
      if (!isFighter(who)) continue;
      const self = this.fighters.of(who.id);
      this.updateAmmo(dt, ctx, who, self);
      this.updateThrow(dt, ctx, who, self, input.of(who.id));
    }

    switch (this.phase) {
      case 'build':
        this.timer -= dt;
        if (this.timer <= 0) this.startWave(ctx);
        break;

      case 'intermission':
        this.timer -= dt;
        if (this.timer <= 0) this.startWave(ctx);
        break;

      case 'wave':
        this.updateWave(dt, ctx);
        break;

      case 'over':
        break;
    }

    this.updateProjectiles(dt, ctx);
  }

  // ── Phases ──────────────────────────────────────────────────────────────────

  private startWave(ctx: ModeContext): void {
    this.wave++;
    this.phase = 'wave';
    this.timer = 0;
    // Route before the first tick, so bots do not spend it walking into a wall.
    this.nav.rebuild(ctx.world, this.stash.x, this.stash.z);
    this.navTimer = NAV_REBUILD_INTERVAL;
    this.spawnWave(ctx);
    this.setMessage(`Wave ${this.wave}`, 3);
    ctx.emit({ type: 'phaseChange', phase: `wave ${this.wave}` });
  }

  /**
   * Wave composition.
   *
   * Count grows steadily and toughness is introduced gradually, so the player
   * meets one new problem at a time: first "there are more of them", then "that
   * one takes two hits". Escalating both at once makes it impossible to tell
   * which part of the fort failed.
   */
  private spawnWave(ctx: ModeContext): void {
    const count = 2 + this.wave;
    const toughRatio = Math.max(0, (this.wave - 2) / WAVE_COUNT);

    for (let i = 0; i < count; i++) {
      const tier: BotConfig =
        this.wave >= 4 && ctx.rng.chance(toughRatio * 0.5)
          ? BOT_TIERS.tough!
          : this.wave >= 2 && ctx.rng.chance(toughRatio)
            ? BOT_TIERS.normal!
            : BOT_TIERS.easy!;

      // Spread arrivals around the yard edge rather than clustering, so a fort
      // with one strong side is not accidentally a winning fort.
      const angle = (i / count) * Math.PI * 2 + ctx.rng.signed(0.35);
      const { x, z } = spawnOnBoundary(angle);

      this.bots.push(new Bot(this.nextBotId++, ctx.world, ctx.rng.fork(), tier, x, 0.5, z));
    }
  }

  private updateWave(dt: number, ctx: ModeContext): void {
    let anyAlive = false;

    this.navTimer -= dt;
    if (this.navTimer <= 0) {
      this.navTimer = NAV_REBUILD_INTERVAL;
      this.nav.rebuild(ctx.world, this.stash.x, this.stash.z);
    }

    for (const bot of this.bots) {
      if (!bot.alive) continue;
      anyAlive = true;

      // Bots walk at the stash, not at the player. That is what makes the fort
      // the thing under test: hiding does not save you, because nothing is
      // chasing you — and a wall in the way is your own decision paying off.
      bot.targetX = this.stash.x;
      bot.targetY = this.stash.y;
      bot.targetZ = this.stash.z;

      // They throw at whoever is nearest, opportunistically, while still
      // advancing. Nearest rather than always the host, or with a guest in the
      // yard one of the two humans would be the only one ever shot at.
      const mark = this.nearestDefender(ctx, bot);
      if (mark !== null) {
        bot.aimX = mark.controller.x;
        bot.aimY = mark.controller.y;
        bot.aimZ = mark.controller.z;
      }
      bot.hasAim = mark !== null;

      const canSee = mark !== null && this.hasLineOfSightTo(
        ctx, bot, mark.controller.x, mark.controller.y + 0.9, mark.controller.z,
      );
      bot.update(dt, ctx.projectiles, canSee, this.nav);

      // A kid who has run out of ways round starts hauling on whatever is in
      // the way, and after a couple of seconds it comes off — along with
      // whatever it was holding up. Done here rather than inside the bot
      // because this is the object the host runs: one authority over the shape
      // of the world, and one place the removal is announced from.
      if (bot.pullDone) {
        const pulled = bot.pulling;
        if (pulled !== null) {
          const box = ctx.world.store.readAabb(pulled.part);
          const down = ctx.build.demolish(pulled.part);
          if (down.length > 0) {
            ctx.worldChanged();
            ctx.emit({
              type: 'partPulled',
              x: (box.minX + box.maxX) / 2,
              y: (box.minY + box.maxY) / 2,
              z: (box.minZ + box.maxZ) / 2,
              brought: down.length,
            });
          }
        }
        bot.clearPull();
      }

      // Reached the stash: take a balloon and leave.
      const d = Math.hypot(bot.x - this.stash.x, bot.z - this.stash.z);
      if (d <= STASH_RADIUS) {
        this.stash.supplies--;
        ctx.emit({ type: 'stashHit', remaining: this.stash.supplies });
        bot.state = 'done';
        if (this.stash.supplies <= 0) {
          this.lose(ctx);
          return;
        }
      }
    }

    if (!anyAlive) {
      this.bots.length = 0;
      if (this.wave >= WAVE_COUNT) {
        this.win(ctx);
      } else {
        this.phase = 'intermission';
        this.timer = INTERMISSION_TIME;
        this.lumber.deliver(PHASE_DELIVERY, LUMBER_CAP);
        this.setMessage(`Wave ${this.wave} held. Repair your fort.`, 5);
        ctx.emit({ type: 'phaseChange', phase: 'intermission' });
      }
    }
  }

  /**
   * Can a bot see a point?
   *
   * A single ray from the bot's eye. If a player's wall blocks it the bot cannot
   * throw, which is the reward for building something solid — and the reason a
   * fort with an open firing slit is a real tradeoff rather than free cover.
   */
  private hasLineOfSightTo(
    ctx: ModeContext, bot: Bot,
    tx: number, ty: number, tz: number,
  ): boolean {
    const ox = bot.x;
    const oy = bot.y + CAP_HEIGHT * 0.75;
    const oz = bot.z;
    const dx = tx - ox;
    const dy = ty - oy;
    const dz = tz - oz;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 1e-3) return true;

    const hit = ctx.world.raycast(ox, oy, oz, dx, dy, dz, dist);
    // A hit short of the target means something is in the way. The ground plane
    // counts too: a bot at the bottom of a slope genuinely cannot see over it.
    return hit === null || hit.distance >= dist - 0.15;
  }

  private win(ctx: ModeContext): void {
    this.phase = 'over';
    this.finished = true;
    this.won = true;
    this.setMessage('The fort held!', 999);
    ctx.emit({ type: 'roundWon' });
  }

  private lose(ctx: ModeContext): void {
    this.phase = 'over';
    this.finished = true;
    this.won = false;
    this.setMessage('They took the stash.', 999);
    ctx.emit({ type: 'roundLost' });
  }

  // ── Player actions ──────────────────────────────────────────────────────────

  /**
   * Ammo refills only at the buckets, and only by standing there.
   *
   * A channel rather than an instant pickup: the pause is what makes leaving
   * the fort a decision with a cost, and it is the moment bots get a clear shot
   * at you.
   */
  private updateAmmo(dt: number, ctx: ModeContext, who: Actor, self: Fighter): void {
    const body = who.controller;
    let at = -1;
    for (let i = 0; i < BUCKETS.length; i++) {
      const b = BUCKETS[i]!;
      if (Math.hypot(body.x - b.x, body.z - b.z) <= BUCKET_RADIUS) {
        at = i;
        break;
      }
    }
    this.atBuckets.set(who.id, at);

    if (at === -1 || self.ammo >= PLAYER_AMMO_MAX) {
      // Walking away abandons the channel; it does not bank progress.
      this.refills.set(who.id, 0);
      return;
    }

    const progress = (this.refills.get(who.id) ?? 0) + dt / REFILL_TIME;
    if (progress < 1) {
      this.refills.set(who.id, progress);
      return;
    }
    this.refills.set(who.id, 0);
    self.ammo = PLAYER_AMMO_MAX;
    // Only the person who filled up hears it: the sound and the flash belong to
    // a bucket somebody is standing at, not to every bucket on the lawn.
    if (who.id === LOCAL_ACTOR_ID) {
      ctx.emit({ type: 'refilled', x: body.x, y: body.y, z: body.z });
    }
  }

  /** Balloons in hand. Exposed directly because the HUD hides it between waves. */
  get ammoCount(): number {
    return this.fighters.of(LOCAL_ACTOR_ID).ammo;
  }

  /** Which bucket the player is standing at, or -1. For the HUD and renderer. */
  get currentBucket(): number {
    return this.atBuckets.get(LOCAL_ACTOR_ID) ?? -1;
  }

  get refillFraction(): number {
    return this.refills.get(LOCAL_ACTOR_ID) ?? 0;
  }

  /** The nearest person a kid could throw at, or null when nobody is about. */
  private nearestDefender(ctx: ModeContext, bot: Bot): Actor | null {
    let best: Actor | null = null;
    let bestDistance = Infinity;
    for (const who of ctx.actors.all) {
      if (!isFighter(who)) continue;
      const d = Math.hypot(who.controller.x - bot.x, who.controller.z - bot.z);
      if (d >= bestDistance) continue;
      best = who;
      bestDistance = d;
    }
    return best;
  }

  private updateThrow(
    dt: number, ctx: ModeContext, who: Actor, self: Fighter, input: ActorInput,
  ): void {
    // Building and throwing share the mouse button, so throwing is only live
    // once the fighting starts. During the build phase the button builds.
    if (this.phase === 'build' || this.phase === 'over') {
      self.charging = false;
      self.charge = 0;
      return;
    }

    if (input.firePressed && self.ammo > 0 && self.cooldown <= 0) {
      self.charging = true;
      self.charge = 0;
    }

    if (self.charging && input.fire) {
      self.charge = Math.min(1, self.charge + dt / 0.55);
    }

    if (self.charging && (input.fireReleased || !input.fire)) {
      self.charging = false;
      this.release(ctx, who, self, input);
    }
  }

  private release(ctx: ModeContext, who: Actor, self: Fighter, input: ActorInput): void {
    if (self.ammo <= 0 || self.cooldown > 0) return;
    self.ammo--;
    self.cooldown = THROW_COOLDOWN;

    const body = who.controller;
    const eyeY = body.y + 1.5;
    const speed = ProjectileSystem.speedForCharge(self.charge);

    // Spawn slightly ahead of the eye so the balloon is not born inside the
    // thrower's own capsule, which would make it hit them immediately.
    const ox = body.x + input.aimX * (CAP_RADIUS + 0.2);
    const oy = eyeY + input.aimY * 0.2;
    const oz = body.z + input.aimZ * (CAP_RADIUS + 0.2);

    ctx.projectiles.spawn(ox, oy, oz, input.aimX, input.aimY, input.aimZ, speed, who.id, 5);
    ctx.emit({ type: 'throw', x: ox, y: oy, z: oz });
    self.charge = 0;
  }

  private updateProjectiles(dt: number, ctx: ModeContext): void {
    // Rebuild the target list: everybody defending, plus every live bot.
    this.targets.length = 0;
    for (const who of ctx.actors.all) {
      if (!isFighter(who)) continue;
      this.targets.push({
        x: who.controller.x, y: who.controller.y, z: who.controller.z,
        radius: CAP_RADIUS, height: CAP_HEIGHT,
        id: who.id,
        alive: true,
      });
    }
    for (const bot of this.bots) {
      if (bot.alive) this.targets.push(bot.asTarget());
    }

    ctx.projectiles.update(dt, this.targets);

    for (const hit of ctx.projectiles.hits) {
      ctx.emit({ type: 'splash', x: hit.x, y: hit.y, z: hit.z });

      // A direct hit soaks its target; the splash catches anyone close.
      const caught = new Set<number>(ctx.projectiles.splashTargets(hit, this.targets));
      if (hit.targetIndex >= 0) caught.add(hit.targetIndex);

      for (const index of caught) {
        const target = this.targets[index];
        if (target === undefined) continue;
        if (target.id < FIRST_BOT_ID) {
          this.fighters.of(target.id).out = PLAYER_SOAK_TIME;
          // Only the person it happened to, or the host's screen would flash
          // for a soaking in somebody else's half of the garden.
          if (target.id === LOCAL_ACTOR_ID) ctx.emit({ type: 'playerSoaked' });
        } else {
          const bot = this.bots.find((b) => b.id === target.id);
          if (bot !== undefined && bot.soak()) {
            ctx.emit({ type: 'botSoaked', x: bot.x, y: bot.y, z: bot.z });
          }
        }
      }
    }
  }

  private setMessage(text: string, seconds: number): void {
    this.message = text;
    this.messageTimer = seconds;
  }

  /** Movement multiplier, so being soaked actually costs something. */
  get playerSpeedScale(): number {
    return this.speedScaleFor(LOCAL_ACTOR_ID);
  }

  speedScaleFor(actorId: number): number {
    return this.fighters.isOut(actorId) ? 0.55 : 1;
  }

  /** The routing grid, for debug visualisation. */
  get navField(): NavField {
    return this.nav;
  }

  /** True while the build controls should be live. */
  get buildingAllowed(): boolean {
    return this.phase === 'build' || this.phase === 'intermission';
  }

  hud(): ModeHud {
    const label =
      this.phase === 'build' ? 'BUILD'
        : this.phase === 'intermission' ? 'REPAIR'
          : this.phase === 'wave' ? `WAVE ${this.wave}/${WAVE_COUNT}`
            : this.won ? 'HELD' : 'LOST';

    const aliveBots = this.bots.filter((b) => b.alive).length;

    return {
      phase: label,
      timer: this.phase === 'build' || this.phase === 'intermission' ? Math.max(0, this.timer) : null,
      primary: { label: 'stash', value: '●'.repeat(Math.max(0, this.stash.supplies)) },
      secondary: this.phase === 'wave' ? { label: 'left', value: String(aliveBots) } : null,
      message: this.message,
      ...this.selfHud(LOCAL_ACTOR_ID),
      lumber: this.buildingAllowed ? this.lumber.available : null,
    };
  }

  /**
   * Balloons, wind-up and the refill channel, about whoever is asked for.
   *
   * The local HUD is built from this too, so a guest's pips and the host's come
   * out of one expression rather than two that have to be kept in step.
   */
  selfHud(actorId: number): ModeSelfHud {
    const self = this.fighters.of(actorId);
    const at = this.atBuckets.get(actorId) ?? -1;
    const progress = this.refills.get(actorId) ?? 0;
    return {
      charge: self.charging ? self.charge : null,
      // No soaking meter in this mode: a balloon takes you out of it for a few
      // seconds outright, so there is nothing continuous to draw.
      wetness: null,
      ammo: this.buildingAllowed ? null : { current: self.ammo, max: PLAYER_AMMO_MAX },
      refill: at >= 0 && self.ammo < PLAYER_AMMO_MAX ? progress : null,
    };
  }

  /**
   * Reused rather than rebuilt, because this runs every frame and the contents
   * only change when the active bucket does.
   */
  private readonly markerList: Marker[] = [
    { kind: 'stash', x: STASH_POSITION.x, y: STASH_POSITION.y, z: STASH_POSITION.z, color: 0xd8564f },
    ...BUCKETS.map((b): Marker => ({ kind: 'bucket', x: b.x, y: 0, z: b.z, color: 0x4f8fd8 })),
  ];

  summary(): ModeSummary {
    const held = this.won ? this.wave : Math.max(0, this.wave - 1);
    return {
      headline: this.won ? 'The fort held!' : 'They got the stash',
      lines: [
        { label: 'waves held', value: String(held) },
        { label: 'supplies left', value: String(this.stash.supplies) },
      ],
    };
  }

  markers(): readonly Marker[] {
    for (let i = 0; i < BUCKETS.length; i++) {
      this.markerList[i + 1]!.active = this.currentBucket === i;
    }
    return this.markerList;
  }
}
