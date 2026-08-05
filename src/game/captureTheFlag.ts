/**
 * Capture the Flag — the second mode, and the one the map was built for.
 *
 * Your flag is in the left yard, theirs is in the right, and the house is in
 * between. Take theirs, get it home, do it three times.
 *
 * The reason this mode belongs in *this* game rather than in any game is the
 * phase loop. Play does not run continuously: it alternates between a short
 * build phase and a capture phase, and a capture ends the round rather than
 * scoring a point in an ongoing one. So the sequence a player actually
 * experiences is: lose the flag, watch exactly how they got in, and then get
 * forty-five seconds to fix that. Without the build phase between captures this
 * would be a capture-the-flag mode that happens to contain building; with it,
 * the building is the reply.
 *
 * Two bot roles, because one is not enough. Runners go for your flag, which is
 * what the build phase exists to stop. Guards stay near theirs and never chase,
 * which is what stops the other direction from being a walk. A mode with only
 * runners is a tower defence; with only guards, a foot race.
 */

import { Bot, BOT_TIERS, type BotConfig } from './bot.ts';
import { type BalloonTarget } from './projectiles.ts';
import type { GameMode, Marker, ModeContext, ModeHud, ModeInput, ModeSummary } from './gameMode.ts';
import { CAP_HEIGHT, CAP_RADIUS } from '../physics/constants.ts';
import { NavField } from './navField.ts';
import { LEFT_FLAG, RIGHT_FLAG, LEFT_SPAWN, RIGHT_SPAWN } from '../world/neighborhood.ts';
import type { Team } from './actor.ts';

export type CtfPhase = 'setup' | 'capture' | 'over';

/** Seconds of build time before each capture phase. */
export const SETUP_TIME = 45;
/** Seconds of the first setup, which is also the only time to learn the map. */
export const FIRST_SETUP_TIME = 70;
/** Captures needed to win. */
export const CAPTURES_TO_WIN = 3;

/** How close you must get to a flag to pick it up or return it. */
export const FLAG_RADIUS = 1.5;
/**
 * How long a dropped flag lies where it fell.
 *
 * Long enough that dropping one near their base is a real threat the defenders
 * have to answer, short enough that a flag lost in a corner does not stall the
 * round.
 */
export const FLAG_RETURN_TIME = 12;

export const PLAYER_AMMO_MAX = 6;
/** Seconds between throws. */
export const THROW_COOLDOWN = 0.45;
/** How long being soaked keeps you slowed after respawning. */
export const SOAK_PENALTY = 1.6;
/** Seconds before a soaked bot is back on the field. */
export const BOT_RESPAWN_TIME = 6;
/** Bots on the field at once. */
export const ENEMY_COUNT = 5;
/** Seconds between nav-field rebuilds. */
export const NAV_REBUILD_INTERVAL = 0.25;

export type { Team } from './actor.ts';
export type FlagStatus = 'home' | 'carried' | 'dropped';

export interface FlagState {
  readonly team: Team;
  readonly homeX: number;
  readonly homeZ: number;
  x: number;
  y: number;
  z: number;
  status: FlagStatus;
  /** 0 for the player, a bot id otherwise, null when nobody has it. */
  carrier: number | null;
  /** Counts down while dropped. */
  returnTimer: number;
}

function makeFlag(team: Team, home: { x: number; z: number }): FlagState {
  return {
    team,
    homeX: home.x,
    homeZ: home.z,
    x: home.x, y: 0, z: home.z,
    status: 'home',
    carrier: null,
    returnTimer: 0,
  };
}

const PLAYER_CARRIER = 0;

/** The player's team. Bots are the other one. */
const PLAYER_TEAM: Team = 'left';

export class CaptureTheFlagMode implements GameMode {
  readonly id = 'captureTheFlag';
  readonly name = 'Capture the Flag';

  phase: CtfPhase = 'setup';
  finished = false;
  won = false;

  /** Round number, counting from one. */
  round = 1;
  scoreLeft = 0;
  scoreRight = 0;

  readonly flags: Record<Team, FlagState> = {
    left: makeFlag('left', LEFT_FLAG),
    right: makeFlag('right', RIGHT_FLAG),
  };

  readonly bots: Bot[] = [];

  private timer = FIRST_SETUP_TIME;
  private message: string | null = null;
  private messageTimer = 0;

  private ammo = PLAYER_AMMO_MAX;
  private throwCooldown = 0;
  private charge = 0;
  private charging = false;
  private playerSoakedFor = 0;

  private nextBotId = 1;
  /** Respawn countdowns, by bot id. */
  private readonly respawns = new Map<number, number>();
  /** Which bots guard rather than run, by id. */
  private readonly guards = new Set<number>();

  /**
   * Two fields, because the two roles walk to different places and a flow field
   * is defined by its goal. Rebuilding one field twice a tick would cost more
   * than keeping two.
   */
  private readonly navAttack = new NavField(26);
  private readonly navHome = new NavField(26);
  private navTimer = 0;

  private readonly targets: BalloonTarget[] = [];
  private readonly markerList: Marker[] = [];

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  start(ctx: ModeContext): void {
    this.phase = 'setup';
    this.round = 1;
    this.scoreLeft = 0;
    this.scoreRight = 0;
    this.timer = FIRST_SETUP_TIME;
    this.finished = false;
    this.won = false;
    this.ammo = PLAYER_AMMO_MAX;
    this.playerSoakedFor = 0;
    this.bots.length = 0;
    this.respawns.clear();
    this.guards.clear();
    this.resetFlag('left');
    this.resetFlag('right');
    this.setMessage('Fortify your yard. Their flag is past the house.', 7);
    ctx.emit({ type: 'phaseChange', phase: 'setup' });
  }

  end(ctx: ModeContext): void {
    this.bots.length = 0;
    this.respawns.clear();
    ctx.projectiles.clear();
  }

  fixedUpdate(dt: number, ctx: ModeContext, input: ModeInput): void {
    if (this.finished) return;

    this.messageTimer -= dt;
    if (this.messageTimer <= 0) this.message = null;
    this.throwCooldown -= dt;
    this.playerSoakedFor = Math.max(0, this.playerSoakedFor - dt);

    this.updateAmmo(ctx);
    this.updateThrow(dt, ctx, input);

    switch (this.phase) {
      case 'setup':
        this.timer -= dt;
        if (this.timer <= 0) this.startCapture(ctx);
        break;
      case 'capture':
        this.updateCapture(dt, ctx);
        break;
      case 'over':
        break;
    }

    this.updateProjectiles(dt, ctx);
  }

  // ── Phases ─────────────────────────────────────────────────────────────────

  private startCapture(ctx: ModeContext): void {
    this.phase = 'capture';
    this.timer = 0;
    this.ammo = PLAYER_AMMO_MAX;

    // Route before the first tick, so nobody spends it walking into a wall.
    this.rebuildNav(ctx);
    this.spawnEnemies(ctx);
    this.setMessage('Go! Bring their flag home.', 4);
    ctx.emit({ type: 'phaseChange', phase: 'capture' });
  }

  private startSetup(ctx: ModeContext, note: string): void {
    this.phase = 'setup';
    this.round++;
    this.timer = SETUP_TIME;
    this.bots.length = 0;
    this.respawns.clear();
    this.guards.clear();
    this.resetFlag('left');
    this.resetFlag('right');
    ctx.projectiles.clear();
    this.ammo = PLAYER_AMMO_MAX;
    this.setMessage(note, 7);
    ctx.emit({ type: 'phaseChange', phase: 'setup' });
  }

  private updateCapture(dt: number, ctx: ModeContext): void {
    this.navTimer -= dt;
    if (this.navTimer <= 0) {
      this.rebuildNav(ctx);
      this.navTimer = NAV_REBUILD_INTERVAL;
    }

    this.updateRespawns(dt, ctx);
    this.updateBots(dt, ctx);
    this.updateFlags(dt, ctx);
  }

  // ── Flags ──────────────────────────────────────────────────────────────────

  private resetFlag(team: Team): void {
    const flag = this.flags[team];
    flag.x = flag.homeX;
    flag.y = 0;
    flag.z = flag.homeZ;
    flag.status = 'home';
    flag.carrier = null;
    flag.returnTimer = 0;
  }

  private updateFlags(dt: number, ctx: ModeContext): void {
    for (const team of ['left', 'right'] as const) {
      const flag = this.flags[team];

      if (flag.status === 'carried') {
        this.followCarrier(flag, ctx);
        continue;
      }

      if (flag.status === 'dropped') {
        flag.returnTimer -= dt;
        if (flag.returnTimer <= 0) {
          this.resetFlag(team);
          ctx.emit({ type: 'flagReturned', x: flag.homeX, y: 0.9, z: flag.homeZ });
          continue;
        }
      }

      this.checkTouches(flag, ctx);
    }

    this.checkCaptures(ctx);
  }

  /** A carried flag rides on its carrier. */
  private followCarrier(flag: FlagState, ctx: ModeContext): void {
    if (flag.carrier === PLAYER_CARRIER) {
      flag.x = ctx.player.x;
      flag.y = ctx.player.y;
      flag.z = ctx.player.z;
      return;
    }
    const bot = this.bots.find((b) => b.id === flag.carrier);
    if (bot === undefined || !bot.alive) {
      // The carrier stopped existing — soaked, or the round reset around it.
      this.dropFlag(flag, ctx);
      return;
    }
    flag.x = bot.x;
    flag.y = bot.y;
    flag.z = bot.z;
  }

  private dropFlag(flag: FlagState, ctx: ModeContext): void {
    flag.status = 'dropped';
    flag.carrier = null;
    flag.returnTimer = FLAG_RETURN_TIME;
    ctx.emit({ type: 'flagDropped', x: flag.x, y: flag.y + 0.9, z: flag.z });
  }

  /** Anyone standing on a flag either takes it or sends it home. */
  private checkTouches(flag: FlagState, ctx: ModeContext): void {
    const playerNear = near(ctx.player.x, ctx.player.z, flag.x, flag.z, FLAG_RADIUS);
    if (playerNear && this.playerSoakedFor <= 0) {
      if (flag.team === PLAYER_TEAM) {
        // Your own flag: touching it away from home sends it back.
        if (flag.status === 'dropped') {
          this.resetFlag(flag.team);
          ctx.emit({ type: 'flagReturned', x: flag.homeX, y: 0.9, z: flag.homeZ });
        }
      } else {
        flag.status = 'carried';
        flag.carrier = PLAYER_CARRIER;
        ctx.emit({ type: 'flagTaken', x: flag.x, y: flag.y + 0.9, z: flag.z, byPlayer: true });
        this.setMessage('You have their flag. Get it home.', 3.5);
      }
      return;
    }

    for (const bot of this.bots) {
      if (!bot.alive) continue;
      if (!near(bot.x, bot.z, flag.x, flag.z, FLAG_RADIUS)) continue;

      if (flag.team === PLAYER_TEAM) {
        flag.status = 'carried';
        flag.carrier = bot.id;
        ctx.emit({ type: 'flagTaken', x: flag.x, y: flag.y + 0.9, z: flag.z, byPlayer: false });
        this.setMessage('They have your flag!', 3.5);
      } else if (flag.status === 'dropped') {
        this.resetFlag(flag.team);
        ctx.emit({ type: 'flagReturned', x: flag.homeX, y: 0.9, z: flag.homeZ });
      }
      return;
    }
  }

  /**
   * A capture needs the enemy flag on your stand *and* your own flag at home.
   *
   * Without the second condition two teams that both grab immediately just swap
   * flags forever and neither can ever score, which is the single most common
   * way a first-pass CTF mode turns out not to be a game.
   */
  private checkCaptures(ctx: ModeContext): void {
    const ours = this.flags[PLAYER_TEAM];
    const theirs = this.flags.right;

    if (
      theirs.status === 'carried' && theirs.carrier === PLAYER_CARRIER &&
      ours.status === 'home' &&
      near(ctx.player.x, ctx.player.z, ours.homeX, ours.homeZ, FLAG_RADIUS + 0.6)
    ) {
      this.scoreLeft++;
      ctx.emit({ type: 'captured', byPlayer: true });
      this.finishRound(ctx, true);
      return;
    }

    if (ours.status === 'carried' && ours.carrier !== PLAYER_CARRIER && theirs.status === 'home') {
      const carrier = this.bots.find((b) => b.id === ours.carrier);
      if (carrier !== undefined &&
          near(carrier.x, carrier.z, theirs.homeX, theirs.homeZ, FLAG_RADIUS + 0.6)) {
        this.scoreRight++;
        ctx.emit({ type: 'captured', byPlayer: false });
        this.finishRound(ctx, false);
      }
    }
  }

  private finishRound(ctx: ModeContext, byPlayer: boolean): void {
    if (this.scoreLeft >= CAPTURES_TO_WIN || this.scoreRight >= CAPTURES_TO_WIN) {
      this.phase = 'over';
      this.finished = true;
      this.won = this.scoreLeft >= CAPTURES_TO_WIN;
      this.setMessage(this.won ? 'You win the yard!' : 'They took the yard.', 8);
      ctx.emit({ type: this.won ? 'roundWon' : 'roundLost' });
      return;
    }

    this.startSetup(
      ctx,
      byPlayer
        ? `Captured — ${this.scoreLeft}–${this.scoreRight}. Build up before the next run.`
        : `They scored — ${this.scoreLeft}–${this.scoreRight}. Patch the way they got in.`,
    );
  }

  // ── Bots ───────────────────────────────────────────────────────────────────

  /**
   * The attackers-to-guards split, shifted by the score.
   *
   * Behind, they press; ahead, they sit on their flag. Difficulty that reads as
   * behaviour rather than as bots that got faster for no visible reason.
   */
  private guardCount(): number {
    const behind = this.scoreLeft - this.scoreRight;
    if (behind > 0) return 1;
    if (behind < 0) return 3;
    return 2;
  }

  private spawnEnemies(ctx: ModeContext): void {
    const guards = this.guardCount();
    for (let i = 0; i < ENEMY_COUNT; i++) {
      const tier: BotConfig =
        i === 0 ? BOT_TIERS.tough! : i < 3 ? BOT_TIERS.normal! : BOT_TIERS.easy!;
      const bot = this.spawnBot(ctx, tier, i);
      if (i < guards) this.guards.add(bot.id);
    }
  }

  private spawnBot(ctx: ModeContext, tier: BotConfig, index: number): Bot {
    // Spread along their spawn line so five bots do not arrive stacked.
    const x = RIGHT_SPAWN.x - (index % 3) * 1.4;
    const z = RIGHT_SPAWN.z + (index - 2) * 1.8;
    const bot = new Bot(this.nextBotId++, ctx.world, ctx.rng.fork(), tier, x, 0.6, z);
    this.bots.push(bot);
    return bot;
  }

  private updateRespawns(dt: number, ctx: ModeContext): void {
    // Schedule from the bot's own state rather than from the hit that caused
    // it. Scheduling at the point of impact worked only for balloons, so a bot
    // that went down any other way stayed down and the field quietly thinned.
    for (const bot of this.bots) {
      if (!bot.alive && !this.respawns.has(bot.id)) this.respawns.set(bot.id, BOT_RESPAWN_TIME);
    }

    for (const [id, remaining] of [...this.respawns]) {
      const left = remaining - dt;
      if (left > 0) {
        this.respawns.set(id, left);
        continue;
      }
      this.respawns.delete(id);

      const index = this.bots.findIndex((b) => b.id === id);
      if (index === -1) continue;
      const wasGuard = this.guards.has(id);
      this.guards.delete(id);
      this.bots.splice(index, 1);

      const replacement = this.spawnBot(ctx, BOT_TIERS.normal!, index);
      if (wasGuard) this.guards.add(replacement.id);
    }
  }

  private rebuildNav(ctx: ModeContext): void {
    const ours = this.flags[PLAYER_TEAM];
    // Runners head for your flag, or for their own base once they have it.
    if (ours.status === 'carried' && ours.carrier !== PLAYER_CARRIER) {
      this.navAttack.rebuild(ctx.world, this.flags.right.homeX, this.flags.right.homeZ);
    } else {
      this.navAttack.rebuild(ctx.world, ours.x, ours.z);
    }
    // Guards converge on their own flag, wherever it currently is.
    this.navHome.rebuild(ctx.world, this.flags.right.x, this.flags.right.z);
  }

  private updateBots(dt: number, ctx: ModeContext): void {
    const ours = this.flags[PLAYER_TEAM];
    const theirs = this.flags.right;

    for (const bot of this.bots) {
      if (!bot.alive) continue;

      const isGuard = this.guards.has(bot.id);
      const carrying = ours.carrier === bot.id;

      let goalX: number;
      let goalZ: number;
      if (carrying) {
        goalX = theirs.homeX;
        goalZ = theirs.homeZ;
      } else if (isGuard) {
        goalX = theirs.x;
        goalZ = theirs.z;
      } else {
        goalX = ours.x;
        goalZ = ours.z;
      }

      bot.targetX = goalX;
      bot.targetY = 0;
      bot.targetZ = goalZ;

      // A guard that has arrived stops walking into its own flag and looks for
      // something to throw at instead.
      const arrived = isGuard && !carrying && near(bot.x, bot.z, goalX, goalZ, 3.5);
      if (arrived) {
        bot.targetX = bot.x;
        bot.targetZ = bot.z;
      }

      const canSee = this.canSeePlayer(ctx, bot);
      bot.aimX = ctx.player.x;
      bot.aimY = ctx.player.y + CAP_HEIGHT * 0.6;
      bot.aimZ = ctx.player.z;
      bot.hasAim = canSee && this.playerSoakedFor <= 0;

      bot.update(dt, ctx.projectiles, canSee, carrying || isGuard ? this.navHome : this.navAttack);
    }
  }

  private canSeePlayer(ctx: ModeContext, bot: Bot): boolean {
    const dx = ctx.player.x - bot.x;
    const dy = ctx.player.y + CAP_HEIGHT * 0.6 - (bot.y + CAP_HEIGHT * 0.75);
    const dz = ctx.player.z - bot.z;
    const distance = Math.hypot(dx, dy, dz);
    if (distance > 18) return false;
    const hit = ctx.world.raycast(bot.x, bot.y + CAP_HEIGHT * 0.75, bot.z, dx, dy, dz, distance);
    return hit === null || hit.distance >= distance - CAP_RADIUS;
  }

  // ── The player's balloons ──────────────────────────────────────────────────

  /** Ammo refills at your own flag stand, which ties reloading to going home. */
  private updateAmmo(ctx: ModeContext): void {
    const ours = this.flags[PLAYER_TEAM];
    if (near(ctx.player.x, ctx.player.z, ours.homeX, ours.homeZ, FLAG_RADIUS + 1.5)) {
      this.ammo = PLAYER_AMMO_MAX;
    }
  }

  private updateThrow(dt: number, ctx: ModeContext, input: ModeInput): void {
    if (this.phase !== 'capture') {
      this.charging = false;
      this.charge = 0;
      return;
    }

    if (input.firePressed && this.ammo > 0 && this.throwCooldown <= 0) {
      this.charging = true;
      this.charge = 0;
    }
    if (this.charging) {
      this.charge = Math.min(1, this.charge + dt * 1.7);
      if (input.fireReleased) this.release(ctx);
    }
  }

  private release(ctx: ModeContext): void {
    this.charging = false;
    if (this.ammo <= 0) return;
    this.ammo--;
    this.throwCooldown = THROW_COOLDOWN;

    const dir = ctx.camera.getLookDirection();
    const speed = 13 + this.charge * 11;
    const ox = ctx.player.x + dir.x * 0.6;
    const oy = ctx.player.y + CAP_HEIGHT * 0.8;
    const oz = ctx.player.z + dir.z * 0.6;
    ctx.projectiles.spawn(ox, oy, oz, dir.x, dir.y + 0.06, dir.z, speed, PLAYER_CARRIER);
    ctx.emit({ type: 'throw', x: ox, y: oy, z: oz });
  }

  private updateProjectiles(dt: number, ctx: ModeContext): void {
    this.targets.length = 0;
    for (const bot of this.bots) {
      if (bot.alive) this.targets.push(bot.asTarget());
    }
    if (this.playerSoakedFor <= 0) {
      this.targets.push({
        x: ctx.player.x, y: ctx.player.y, z: ctx.player.z,
        radius: CAP_RADIUS, height: CAP_HEIGHT,
        id: PLAYER_CARRIER, alive: true,
      });
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

        if (target.id === PLAYER_CARRIER) {
          this.soakPlayer(ctx);
          continue;
        }
        const bot = this.bots.find((b) => b.id === target.id);
        if (bot === undefined || !bot.soak()) continue;

        ctx.emit({ type: 'botSoaked', x: bot.x, y: bot.y + 1, z: bot.z });
        // Anything it was carrying falls where it fell.
        const ours = this.flags[PLAYER_TEAM];
        if (ours.carrier === bot.id) this.dropFlag(ours, ctx);
      }
    }
  }

  /**
   * Soaked: drop what you are carrying and walk back from your own spawn.
   *
   * Sending the player home rather than only slowing them is what makes
   * defending worth doing. A carrier who can absorb a hit and keep running
   * turns every defender into scenery.
   */
  private soakPlayer(ctx: ModeContext): void {
    if (this.playerSoakedFor > 0) return;
    this.playerSoakedFor = SOAK_PENALTY;
    const theirs = this.flags.right;
    if (theirs.carrier === PLAYER_CARRIER) this.dropFlag(theirs, ctx);
    ctx.player.teleport(LEFT_SPAWN.x, LEFT_SPAWN.y, LEFT_SPAWN.z);
    ctx.emit({ type: 'playerSoaked' });
    this.setMessage('Soaked! Back to your yard.', 2.5);
  }

  // ── Published state ────────────────────────────────────────────────────────

  get buildingAllowed(): boolean {
    return this.phase === 'setup';
  }

  get playerSpeedScale(): number {
    return this.playerSoakedFor > 0 ? 0.55 : 1;
  }

  get ammoCount(): number {
    return this.ammo;
  }

  /** True when the player is carrying the enemy flag. */
  get playerHasFlag(): boolean {
    return this.flags.right.carrier === PLAYER_CARRIER;
  }

  private setMessage(text: string, seconds: number): void {
    this.message = text;
    this.messageTimer = seconds;
  }

  hud(): ModeHud {
    const label =
      this.phase === 'setup' ? `BUILD ${this.round}`
        : this.phase === 'capture' ? `ROUND ${this.round}`
          : this.won ? 'WON' : 'LOST';

    const ours = this.flags[PLAYER_TEAM];
    const theirs = this.flags.right;
    const flagWord = (f: FlagState) =>
      f.status === 'home' ? 'home' : f.status === 'carried' ? 'taken' : 'loose';

    return {
      phase: label,
      timer: this.phase === 'setup' ? Math.max(0, this.timer) : null,
      primary: { label: 'score', value: `${this.scoreLeft} – ${this.scoreRight}` },
      secondary: this.phase === 'capture'
        ? { label: 'flags', value: `${flagWord(ours)} / ${flagWord(theirs)}` }
        : null,
      message: this.message,
      charge: this.charging ? this.charge : null,
      wetness: null,
      ammo: this.buildingAllowed ? null : { current: this.ammo, max: PLAYER_AMMO_MAX },
      refill: null,
    };
  }

  summary(): ModeSummary {
    return {
      headline: this.won ? 'You win the yard!' : 'They took the yard',
      lines: [
        { label: 'final score', value: `${this.scoreLeft} – ${this.scoreRight}` },
        { label: 'rounds played', value: String(this.round) },
      ],
    };
  }

  markers(): readonly Marker[] {
    this.markerList.length = 0;
    for (const team of ['left', 'right'] as const) {
      const flag = this.flags[team];
      // The stand stays where home is, always, so you can find your own base.
      this.markerList.push({
        kind: 'stash',
        x: flag.homeX, y: 0, z: flag.homeZ,
        color: team === PLAYER_TEAM ? 0x4f8fd8 : 0xd8564f,
        active: flag.status === 'home',
      });
      this.markerList.push({
        kind: 'flag',
        x: flag.x, y: flag.y, z: flag.z,
        color: team === PLAYER_TEAM ? 0x6ec6ff : 0xff8a6a,
        active: flag.status === 'carried',
        faded: flag.status !== 'home',
      });
    }
    return this.markerList;
  }
}

function near(ax: number, az: number, bx: number, bz: number, radius: number): boolean {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz <= radius * radius;
}
