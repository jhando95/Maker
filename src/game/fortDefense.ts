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
import { ProjectileSystem, type BalloonTarget } from './projectiles.ts';
import type { GameMode, ModeContext, ModeHud, ModeInput } from './gameMode.ts';
import { CAP_HEIGHT, CAP_RADIUS } from '../physics/constants.ts';

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
/** Player ammo, refilled by standing near the stash. */
export const PLAYER_AMMO_MAX = 12;
export const RELOAD_INTERVAL = 0.35;
/** Being soaked costs the player this long of slowed movement. */
export const PLAYER_SOAK_TIME = 1.4;

export interface StashState {
  x: number; y: number; z: number;
  supplies: number;
}

/** Where the stash sits, and where waves come from. */
const STASH_POSITION = { x: 0, y: 0, z: 0 };
const SPAWN_RADIUS = 21;

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

  private throwCooldown = 0;
  private charge = 0;
  private charging = false;
  private ammo = PLAYER_AMMO_MAX;
  private reloadTimer = 0;
  private playerSoakedFor = 0;

  private nextBotId = 1;
  /** Reused so the per-tick target list does not allocate. */
  private readonly targets: BalloonTarget[] = [];

  start(ctx: ModeContext): void {
    this.phase = 'build';
    this.timer = BUILD_TIME;
    this.wave = 0;
    this.stash.supplies = STASH_SUPPLIES;
    this.bots.length = 0;
    this.ammo = PLAYER_AMMO_MAX;
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
    if (this.finished) return;

    this.messageTimer -= dt;
    if (this.messageTimer <= 0) this.message = null;
    this.throwCooldown -= dt;
    this.playerSoakedFor = Math.max(0, this.playerSoakedFor - dt);

    this.updateAmmo(dt, ctx);
    this.updateThrow(dt, ctx, input);

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
      const x = Math.sin(angle) * SPAWN_RADIUS;
      const z = Math.cos(angle) * SPAWN_RADIUS;

      this.bots.push(new Bot(this.nextBotId++, ctx.world, ctx.rng.fork(), tier, x, 0.5, z));
    }
  }

  private updateWave(dt: number, ctx: ModeContext): void {
    let anyAlive = false;

    for (const bot of this.bots) {
      if (!bot.alive) continue;
      anyAlive = true;

      // Bots walk at the stash, not at the player. That is what makes the fort
      // the thing under test: hiding does not save you, because nothing is
      // chasing you — and a wall in the way is your own decision paying off.
      bot.targetX = this.stash.x;
      bot.targetY = this.stash.y;
      bot.targetZ = this.stash.z;

      // They throw at the player, opportunistically, while still advancing.
      bot.aimX = ctx.player.x;
      bot.aimY = ctx.player.y;
      bot.aimZ = ctx.player.z;
      bot.hasAim = true;

      const canSee = this.hasLineOfSightTo(ctx, bot, ctx.player.x, ctx.player.y + 0.9, ctx.player.z);
      bot.update(dt, ctx.projectiles, canSee);

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

  /** Ammo refills near the stash, which is what pulls the player back to it. */
  private updateAmmo(dt: number, ctx: ModeContext): void {
    const near = Math.hypot(
      ctx.player.x - this.stash.x,
      ctx.player.z - this.stash.z,
    ) < 4.0;

    if (near && this.ammo < PLAYER_AMMO_MAX) {
      this.reloadTimer -= dt;
      if (this.reloadTimer <= 0) {
        this.reloadTimer = RELOAD_INTERVAL;
        this.ammo++;
      }
    } else {
      this.reloadTimer = RELOAD_INTERVAL;
    }
  }

  private updateThrow(dt: number, ctx: ModeContext, input: ModeInput): void {
    // Building and throwing share the mouse button, so throwing is only live
    // once the fighting starts. During the build phase the button builds.
    if (this.phase === 'build' || this.phase === 'over') {
      this.charging = false;
      this.charge = 0;
      return;
    }

    if (input.firePressed && this.ammo > 0 && this.throwCooldown <= 0) {
      this.charging = true;
      this.charge = 0;
    }

    if (this.charging && input.fire) {
      this.charge = Math.min(1, this.charge + dt / 0.55);
    }

    if (this.charging && (input.fireReleased || !input.fire)) {
      this.charging = false;
      this.release(ctx);
    }
  }

  private release(ctx: ModeContext): void {
    if (this.ammo <= 0 || this.throwCooldown > 0) return;
    this.ammo--;
    this.throwCooldown = THROW_COOLDOWN;

    const eyeY = ctx.player.y + 1.5;
    const dir = ctx.camera.getLookDirection();
    const speed = ProjectileSystem.speedForCharge(this.charge);

    // Spawn slightly ahead of the eye so the balloon is not born inside the
    // player's own capsule, which would make it hit them immediately.
    const ox = ctx.player.x + dir.x * (CAP_RADIUS + 0.2);
    const oy = eyeY + dir.y * 0.2;
    const oz = ctx.player.z + dir.z * (CAP_RADIUS + 0.2);

    ctx.projectiles.spawn(ox, oy, oz, dir.x, dir.y, dir.z, speed, 0, 5);
    ctx.emit({ type: 'throw', x: ox, y: oy, z: oz });
    this.charge = 0;
  }

  private updateProjectiles(dt: number, ctx: ModeContext): void {
    // Rebuild the target list: the player plus every live bot.
    this.targets.length = 0;
    this.targets.push({
      x: ctx.player.x, y: ctx.player.y, z: ctx.player.z,
      radius: CAP_RADIUS, height: CAP_HEIGHT,
      id: 0,
      alive: true,
    });
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
        if (target.id === 0) {
          this.playerSoakedFor = PLAYER_SOAK_TIME;
          ctx.emit({ type: 'playerSoaked' });
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
    return this.playerSoakedFor > 0 ? 0.55 : 1;
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
      charge: this.charging ? this.charge : null,
      ammo: this.buildingAllowed ? null : { current: this.ammo, max: PLAYER_AMMO_MAX },
    };
  }
}
