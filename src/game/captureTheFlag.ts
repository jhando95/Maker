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
 *
 * Both sides have kids on them, which is newer than the rest of this file and
 * changed how it is written. Every rule here used to be phrased from the
 * player's point of view — "is this the flag PLAYER_TEAM owns" standing in for
 * "is this mine" — and each was implemented twice, once for the player and once
 * for bots. The rules were always symmetric; only the code was not, and two
 * copies of a symmetric rule is how a teammate ends up able to steal its own
 * flag. They are written once now and run for whichever side is asking.
 */

import { Bot, BOT_TIERS, type BotConfig } from './bot.ts';
import { type BalloonTarget } from './projectiles.ts';
import type { GameMode, Marker, ModeContext, ModeHud, ModeInput, ModeSummary } from './gameMode.ts';
import { CAP_HEIGHT, CAP_RADIUS } from '../physics/constants.ts';
import { NavField } from './navField.ts';
import { LEFT_FLAG, RIGHT_FLAG, LEFT_SPAWN, RIGHT_SPAWN } from '../world/neighborhood.ts';
import { LOCAL_ACTOR_ID, opposing, type Actor, type Team } from './actor.ts';

/** Both sides, for rules that are the same whichever one you are on. */
const TEAMS: readonly Team[] = ['left', 'right'];

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
/**
 * Kids on your side.
 *
 * Two rather than none because a capture-the-flag game with one player on a
 * team is not capture the flag — it is a fetch quest with obstacles. Two rather
 * than five because they have to leave you something to do: at parity the round
 * resolves itself while you watch.
 *
 * One runs and one guards, mirroring how the other side splits, so your flag
 * has somebody on it when you are across the map.
 */
export const ALLY_COUNT = 2;
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
   * A field per role per side.
   *
   * A flow field is defined by its goal, and the two roles walk to different
   * places, so one field cannot serve both — rebuilding it twice a tick would
   * cost more than keeping two. Now that both sides have kids on them it is four,
   * which sounds worse than it is: a rebuild is bounded by the grid, not by how
   * many characters read the result, and the alternative is bots on your team
   * pathing to the enemy's objective.
   */
  private readonly nav: Record<Team, { attack: NavField; home: NavField }> = {
    left: { attack: new NavField(26), home: new NavField(26) },
    right: { attack: new NavField(26), home: new NavField(26) },
  };
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
    // Before the early return, so a finished round still draws the right people.
    ctx.actors.refresh(this.bots);
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
    this.spawnTeams(ctx);
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

  /** A carried flag rides on its carrier, whoever that turned out to be. */
  private followCarrier(flag: FlagState, ctx: ModeContext): void {
    const carrier = flag.carrier === null ? undefined : ctx.actors.get(flag.carrier);
    if (carrier === undefined || carrier.alive === false) {
      // The carrier stopped existing — soaked, or the round reset around it.
      // A soaked *player* drops it in soakPlayer instead, because they also get
      // sent home, and the flag should land where they fell rather than there.
      this.dropFlag(flag, ctx);
      return;
    }
    flag.x = carrier.controller.x;
    flag.y = carrier.controller.y;
    flag.z = carrier.controller.z;
  }

  private dropFlag(flag: FlagState, ctx: ModeContext): void {
    flag.status = 'dropped';
    flag.carrier = null;
    flag.returnTimer = FLAG_RETURN_TIME;
    ctx.emit({ type: 'flagDropped', x: flag.x, y: flag.y + 0.9, z: flag.z });
  }

  /**
   * Anyone standing on a flag either takes it or sends it home.
   *
   * One rule over everyone, which is what the roster bought. This was written
   * twice — once for the player, once for bots — with `flag.team === PLAYER_TEAM`
   * standing in for "is this mine". Two copies of a symmetric rule is how a
   * teammate ends up able to steal their own flag.
   */
  private checkTouches(flag: FlagState, ctx: ModeContext): void {
    for (const who of ctx.actors.all) {
      if (!this.active(who)) continue;
      const body = who.controller;
      if (!near(body.x, body.z, flag.x, flag.z, FLAG_RADIUS)) continue;

      if (who.team === flag.team) {
        // Your own flag: touching it away from home sends it back.
        if (flag.status === 'dropped') {
          this.resetFlag(flag.team);
          ctx.emit({ type: 'flagReturned', x: flag.homeX, y: 0.9, z: flag.homeZ });
        }
        return;
      }

      const mine = who.id === LOCAL_ACTOR_ID;
      flag.status = 'carried';
      flag.carrier = who.id;
      ctx.emit({ type: 'flagTaken', x: flag.x, y: flag.y + 0.9, z: flag.z, byPlayer: mine });
      this.setMessage(
        mine ? 'You have their flag. Get it home.'
          : who.team === PLAYER_TEAM ? 'Your side has their flag!'
            : 'They have your flag!',
        3.5,
      );
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
    for (const team of TEAMS) {
      const base = this.flags[team];
      const stolen = this.flags[opposing(team)];

      if (stolen.status !== 'carried' || base.status !== 'home') continue;
      const carrier = stolen.carrier === null ? undefined : ctx.actors.get(stolen.carrier);
      if (carrier === undefined || carrier.team !== team) continue;
      if (!near(carrier.controller.x, carrier.controller.z, base.homeX, base.homeZ, FLAG_RADIUS + 0.6)) continue;

      // Your team scoring counts whether it was you or the kid next to you —
      // which is the point of having a team, and is why this is keyed off the
      // carrier's side rather than off whether the carrier was the player.
      const forPlayer = team === PLAYER_TEAM;
      if (forPlayer) this.scoreLeft++;
      else this.scoreRight++;
      ctx.emit({ type: 'captured', byPlayer: forPlayer });
      this.finishRound(ctx, forPlayer);
      return;
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

  private spawnTeams(ctx: ModeContext): void {
    const guards = this.guardCount();
    for (let i = 0; i < ENEMY_COUNT; i++) {
      const tier: BotConfig =
        i === 0 ? BOT_TIERS.tough! : i < 3 ? BOT_TIERS.normal! : BOT_TIERS.easy!;
      const bot = this.spawnBot(ctx, tier, i, 'right');
      if (i < guards) this.guards.add(bot.id);
    }

    // Your side: one guard, one runner. Deliberately the middle tier rather than
    // the tough one — an ally who plays better than you do is not a teammate,
    // it is the game finishing without you.
    for (let i = 0; i < ALLY_COUNT; i++) {
      const bot = this.spawnBot(ctx, BOT_TIERS.normal!, i, PLAYER_TEAM);
      if (i === 0) this.guards.add(bot.id);
    }
  }

  private spawnBot(ctx: ModeContext, tier: BotConfig, index: number, team: Team): Bot {
    // Spread along the spawn line so a whole side does not arrive stacked.
    const home = team === 'left' ? LEFT_SPAWN : RIGHT_SPAWN;
    const away = team === 'left' ? 1 : -1;
    const x = home.x + away * (index % 3) * 1.4;
    const z = home.z + (index - 2) * 1.8;
    const bot = new Bot(this.nextBotId++, ctx.world, ctx.rng.fork(), tier, x, 0.6, z);
    bot.team = team;
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
      // Read the side before the bot goes, or the replacement comes back on
      // whichever team the default happens to be.
      const team = this.bots[index]!.team;
      this.guards.delete(id);
      this.bots.splice(index, 1);

      const replacement = this.spawnBot(ctx, BOT_TIERS.normal!, index, team);
      if (wasGuard) this.guards.add(replacement.id);
    }
  }

  /**
   * Where each side is walking, written once and run for both.
   *
   * This used to be one team's worth of routing with the player's flag baked in
   * as "the objective". The rule underneath is symmetric and always was: runners
   * head for the flag they are stealing, or for their own base once they hold
   * it, and guards converge on their own flag wherever it has got to.
   */
  private rebuildNav(ctx: ModeContext): void {
    for (const team of TEAMS) {
      const base = this.flags[team];
      const target = this.flags[opposing(team)];
      const fields = this.nav[team];

      const carriedByUs = target.status === 'carried' && this.teamOf(ctx, target.carrier) === team;
      if (carriedByUs) fields.attack.rebuild(ctx.world, base.homeX, base.homeZ);
      else fields.attack.rebuild(ctx.world, target.x, target.z);

      fields.home.rebuild(ctx.world, base.x, base.z);
    }
  }

  /** Which side an actor is on, or undefined for nobody. */
  private teamOf(ctx: ModeContext, id: number | null): Team | undefined {
    if (id === null) return undefined;
    return ctx.actors.get(id)?.team;
  }

  /**
   * Able to carry a flag or be shot at.
   *
   * The player being soaked and a bot being down are the same state wearing two
   * names, and every rule below wants to ask about it once.
   */
  private active(who: Actor): boolean {
    if (who.id === LOCAL_ACTOR_ID) return this.playerSoakedFor <= 0;
    return who.alive !== false;
  }

  private updateBots(dt: number, ctx: ModeContext): void {
    for (const bot of this.bots) {
      if (!bot.alive) continue;

      // From this kid's point of view rather than the player's: the flag it is
      // stealing, and the one it is defending. The old version read the player's
      // flag as "the objective", which is true for exactly one of the two sides.
      const target = this.flags[opposing(bot.team)];
      const base = this.flags[bot.team];
      const isGuard = this.guards.has(bot.id);
      const carrying = target.carrier === bot.id;

      let goalX: number;
      let goalZ: number;
      if (carrying) {
        goalX = base.homeX;
        goalZ = base.homeZ;
      } else if (isGuard) {
        goalX = base.x;
        goalZ = base.z;
      } else {
        goalX = target.x;
        goalZ = target.z;
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

      const mark = this.nearestVisibleEnemy(ctx, bot);
      if (mark !== null) {
        bot.aimX = mark.x;
        bot.aimY = mark.y + CAP_HEIGHT * 0.6;
        bot.aimZ = mark.z;
      }
      bot.hasAim = mark !== null;

      const fields = this.nav[bot.team];
      bot.update(dt, ctx.projectiles, mark !== null, carrying || isGuard ? fields.home : fields.attack);
    }
  }

  /**
   * The closest person on the other side this bot can actually see.
   *
   * Replaces "can this bot see the player", which was the only question worth
   * asking while the player was the only thing to shoot at. Now that both sides
   * have kids on them, a bot that could only ever aim at the player would walk
   * straight past the enemy carrying its flag.
   */
  private nearestVisibleEnemy(
    ctx: ModeContext,
    bot: Bot,
  ): { x: number; y: number; z: number } | null {
    let best: { x: number; y: number; z: number } | null = null;
    let bestDistance = Infinity;

    for (const who of ctx.actors.all) {
      if (who.team === bot.team || who.id === bot.id) continue;
      if (!this.active(who)) continue;

      const body = who.controller;
      const dx = body.x - bot.x;
      const dy = body.y + CAP_HEIGHT * 0.6 - (bot.y + CAP_HEIGHT * 0.75);
      const dz = body.z - bot.z;
      const distance = Math.hypot(dx, dy, dz);
      if (distance > 18 || distance >= bestDistance) continue;

      const hit = ctx.world.raycast(bot.x, bot.y + CAP_HEIGHT * 0.75, bot.z, dx, dy, dz, distance);
      if (hit !== null && hit.distance < distance - CAP_RADIUS) continue;

      bestDistance = distance;
      best = { x: body.x, y: body.y, z: body.z };
    }
    return best;
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
    ctx.projectiles.spawn(ox, oy, oz, dir.x, dir.y + 0.06, dir.z, speed, LOCAL_ACTOR_ID);
    ctx.emit({ type: 'throw', x: ox, y: oy, z: oz });
  }

  private updateProjectiles(dt: number, ctx: ModeContext): void {
    // Everyone is a target the same way. A stunned character is skipped rather
    // than hit again, which is what Bot.asTarget did for bots and is now simply
    // what the rule says for anyone.
    this.targets.length = 0;
    for (const who of ctx.actors.all) {
      const body = who.controller;
      this.targets.push({
        x: body.x, y: body.y, z: body.z,
        radius: CAP_RADIUS, height: CAP_HEIGHT,
        id: who.id,
        alive: this.active(who) && who.stunned !== true,
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
        // No soaking your own side. The projectile system already refuses to hit
        // whoever threw it, which was the whole of the problem while one of the
        // two sides was a single person — now a teammate's splash could send you
        // home, and being knocked out of a round by your own team is not a
        // mechanic, it is a bug with a story.
        if (ctx.actors.friendly(hit.ownerId, target.id)) continue;

        if (target.id === LOCAL_ACTOR_ID) {
          this.soakPlayer(ctx);
          continue;
        }
        const bot = this.bots.find((b) => b.id === target.id);
        if (bot === undefined || !bot.soak()) continue;

        ctx.emit({ type: 'botSoaked', x: bot.x, y: bot.y + 1, z: bot.z });
        // Whatever it was carrying falls where it fell — the flag it stole,
        // whichever side it was on.
        const stolen = this.flags[opposing(bot.team)];
        if (stolen.carrier === bot.id) this.dropFlag(stolen, ctx);
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
    if (theirs.carrier === LOCAL_ACTOR_ID) this.dropFlag(theirs, ctx);
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
    return this.flags[opposing(PLAYER_TEAM)].carrier === LOCAL_ACTOR_ID;
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
