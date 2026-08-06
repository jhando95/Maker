/**
 * Water War — hottest day of the summer, and three places to get water.
 *
 * The kids from down the street are here to drain them. You are here to stop
 * them. When the sun goes down, whatever water is left is your score; run all
 * three dry and the fight is over and you lost it.
 *
 * ## Why the objective is the water and not the kids
 *
 * The first version of this mode scored kills. It does not work, for a reason
 * that is specific to this codebase rather than to shooters in general: `Bot`
 * walks to a **fixed objective**, and its own source comment says why — "a
 * bot's job is to reach the stash, and stopping short of it to trade shots
 * would mean the player could never actually lose". Point that objective at the
 * player and three things break at once. The flow field re-floods from a moving
 * goal, so it solves your fort every 0.2s and a wall becomes a detour instead
 * of denial. `NavField`'s cache keys on the goal position, so a moving goal
 * pays the full grid scan every rebuild in the one mode where the player may
 * also be building. And a fort acquires no attributable outcome: you build a
 * wall, you score fourteen, and nothing on screen tells you whether you would
 * have scored twelve without it.
 *
 * Making the water the objective fixes all three by putting the goals back
 * where the AI is good: fixed points. A wall across a pool approach is denial.
 * The outcome is legible — the pool you fortified is still full, the one you
 * ignored is dry. And it is a different question from Fort Defense's, which is
 * the only good reason for a third mode to exist: there are three fronts, you
 * cannot stand on all of them, so your forts have to work **while you are
 * somewhere else**.
 *
 * ## Why turtling loses
 *
 * Filling your tank draws on the source you are filling from. Camp one pool
 * with the hose and you are slowly draining the thing you are defending while
 * two others go down unattended. There is no position that wins by standing
 * still, which is what the first draft could not say.
 */

import { Bot, BOT_TIERS, type BotConfig } from './bot.ts';
import { FIRST_BOT_ID, LOCAL_ACTOR_ID, type Actor } from './actor.ts';
import { Fighters, isFighter, type Fighter } from './fighters.ts';
import { SPLASH_RADIUS, type BalloonTarget } from './projectiles.ts';
import type {
  ActorInput, GameMode, Loadout, Marker, ModeContext, ModeHud, ModeInput, ModeSelfHud, ModeSummary,
} from './gameMode.ts';
import { CAP_HEIGHT, CAP_RADIUS } from '../physics/constants.ts';
import { NavField } from './navField.ts';
import { Lumber, STARTING_LUMBER, PHASE_DELIVERY, LUMBER_CAP } from '../build/lumber.ts';
import { WATER_SOURCES, FORT_YARD } from '../world/neighborhood.ts';
import {
  WEAPONS, WEAPON_ORDER, TANK_MAX, SOURCE_RADIUS, REFILL_RATE, REFILL_DRAW,
  streamPower, splashPower, DIRECT_HIT_TAKES_SPLASH, type WeaponId,
} from './waterKit.ts';
import {
  makeWetness, tickWetness, soak, isSoaked, resetWetness, wetStage, type WetnessState,
} from './wetness.ts';

export type WarPhase = 'build' | 'raid' | 'lull' | 'over';

/** Seconds to build before the first raid. */
export const BUILD_TIME = 70;
/** Seconds between raids, to repair whatever failed. */
export const LULL_TIME = 28;
/**
 * Seconds a raid lasts before the kids go home.
 *
 * A raid has to be timed, because soaking everyone cannot end it: a soaked kid
 * walks home and comes back, so "nobody left standing" is a state this mode
 * never reaches. That is deliberate rather than a gap to plug — the kids are
 * not the objective, the water is, and soaking one buys you KID_RESPAWN seconds
 * of them not draining a tap. Holding the taps until the kids get bored is the
 * win; there is no clearing the field.
 */
export const RAID_TIME = 45;
/** How many raids the afternoon lasts. */
export const RAID_COUNT = 4;

/**
 * Each source starts with this much water.
 *
 * Sized against measured demand rather than picked. Over a whole afternoon an
 * unopposed raid schedule spends about 700 kid-seconds standing at a tap, so
 * the pool and the drain rate together decide what fraction of that the player
 * has to stop. At 120L a source it was 84%, which no amount of skill reaches —
 * the mode was unwinnable and nothing said so. These numbers put it near half,
 * and waterWar's tests hold the ratio there.
 */
export const SOURCE_MAX = 250;
/**
 * Water a kid takes per second while standing in a source.
 *
 * Slow enough that one kid alone at a tap is a problem you have time to walk
 * over and solve, fast enough that three of them is not.
 */
export const DRAIN_RATE = 2.4;
/** You have lost when every source is below this. */
export const DRY = 0.01;

/** Seconds a soaked kid spends walking home before coming back. */
export const KID_RESPAWN = 7;
/** Seconds the player is out of it after being soaked. */
export const PLAYER_SOAKED_TIME = 3.5;
/** Tank you come back with. Half, so soaking yourself is not a free refill. */
export const RESPAWN_TANK = TANK_MAX * 0.5;

export const NAV_REBUILD_INTERVAL = 0.25;
/** Seconds between splashes while a stream is landing on something. */
export const SPLASH_INTERVAL = 0.125;
/** How far a stream reaches out from the eye before the world stops it. */
const EYE_HEIGHT = CAP_HEIGHT * 0.8;

export interface SourceState {
  readonly key: string;
  readonly name: string;
  readonly x: number;
  readonly z: number;
  water: number;
}

/**
 * How close to a tap counts as being at it, whatever is in the way.
 *
 * Every source is a solid prop, so a sight line aimed at one ends on the prop.
 * This is where the check stops looking — big enough to clear the pool rim and
 * the barrel, small enough that a wall built round a tap is still outside it.
 */
const SOURCE_EDGE = 1.5;

export class WaterWarMode implements GameMode {
  readonly id = 'waterWar';
  readonly name = 'Water War';

  phase: WarPhase = 'build';
  raid = 0;
  finished = false;
  won = false;

  readonly sources: SourceState[] = WATER_SOURCES.map((s) => ({ ...s, water: SOURCE_MAX }));
  readonly bots: Bot[] = [];

  /** Which source each kid is walking to, by bot id. */
  private readonly assignments = new Map<number, number>();
  private readonly respawns = new Map<number, number>();
  /** Wetness for every kid, by bot id. */
  private readonly botWet = new Map<number, WetnessState>();
  /**
   * Tank, wetness and soaked-timer for every *person* in the yard.
   *
   * One entry, not one set of fields — which is the entire difference between a
   * guest watching this mode and a guest playing it. There used to be a `tank`,
   * and a tank is a thing exactly one person can drink from.
   */
  private readonly fighters = new Fighters(TANK_MAX);

  private timer = BUILD_TIME;
  private message: string | null = null;
  private messageTimer = 0;

  /** What the person at this keyboard is holding. */
  weapon: WeaponId = 'soaker';
  /** And what everybody else is, taken from the slot in their command. */
  private readonly held = new Map<number, WeaponId>();
  /**
   * Where each person's stream currently ends, for the renderer.
   *
   * A map because a hose is not the local player's alone any more, and the one
   * that matters most is a guest's — the host computes their stream, so without
   * an entry of their own a guest would hold down the trigger and see no water.
   */
  private readonly streams = new Map<number, { x: number; y: number; z: number }>();
  private streamHitSomething = false;
  private splashTimer = 0;

  private nextBotId = FIRST_BOT_ID;
  /**
   * One field per source, because each is a fixed goal and a flow field is
   * defined by its goal. Fixed goals are also why the nav cache actually works
   * here — it keys on goal position, and these never move.
   */
  private readonly nav: NavField[] = WATER_SOURCES.map(() => new NavField(26));
  private navTimer = 0;
  /** The pile in the corner of the yard, topped up before each build phase. */
  readonly lumber = new Lumber(STARTING_LUMBER);
  private readonly targets: BalloonTarget[] = [];
  private readonly markerList: Marker[] = [];

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  start(ctx: ModeContext): void {
    this.phase = 'build';
    this.raid = 0;
    this.timer = BUILD_TIME;
    this.finished = false;
    this.won = false;
    this.weapon = 'soaker';
    this.held.clear();
    this.streams.clear();
    for (const s of this.sources) s.water = SOURCE_MAX;
    this.bots.length = 0;
    this.assignments.clear();
    this.respawns.clear();
    this.botWet.clear();
    // Reset rather than clear: everybody who is in the yard is still in it, and
    // dropping the map would give each of them a fresh entry the first time
    // they were asked about — which is the same numbers, one tick later, and a
    // guest's HUD blank for that tick.
    this.fighters.reset();
    this.lumber.set(STARTING_LUMBER);
    this.setMessage('Three taps, one afternoon. Fortify what you can reach.', 7);
    ctx.emit({ type: 'phaseChange', phase: 'build' });
  }

  end(ctx: ModeContext): void {
    this.bots.length = 0;
    this.respawns.clear();
    this.streams.clear();
    ctx.projectiles.clear();
  }

  fixedUpdate(dt: number, ctx: ModeContext, input: ModeInput): void {
    // The mode owns its bots, so the mode keeps the roster honest — before the
    // early return, so a finished round still draws the right people.
    ctx.actors.refresh(this.bots);
    if (this.finished) return;

    this.messageTimer -= dt;
    if (this.messageTimer <= 0) this.message = null;
    this.streams.clear();

    this.fighters.tick(dt, (f) => this.revive(ctx, f));
    for (const w of this.botWet.values()) tickWetness(w, dt);

    // Everybody who is not a bot, in one pass. Written as a loop over the
    // roster rather than as a line about the player, because the roster is the
    // only thing that knows how many people are in the yard.
    for (const who of ctx.actors.all) {
      if (!isFighter(who)) continue;
      const fighter = this.fighters.of(who.id);
      this.updateTank(dt, ctx, who, fighter);
      this.updateFiring(dt, ctx, who, fighter, input.of(who.id));
    }

    switch (this.phase) {
      case 'build':
      case 'lull':
        this.timer -= dt;
        if (this.timer <= 0) this.startRaid(ctx);
        break;
      case 'raid':
        this.updateRaid(dt, ctx);
        break;
      case 'over':
        break;
    }

    this.updateProjectiles(dt, ctx);
    this.checkDefeat(ctx);
  }

  // ── Phases ─────────────────────────────────────────────────────────────────

  private startRaid(ctx: ModeContext): void {
    this.raid++;
    this.phase = 'raid';
    this.timer = RAID_TIME;
    this.rebuildNav(ctx);
    this.spawnRaid(ctx);
    this.setMessage(`Raid ${this.raid} of ${RAID_COUNT}`, 3);
    ctx.emit({ type: 'phaseChange', phase: `raid ${this.raid}` });
  }

  private updateRaid(dt: number, ctx: ModeContext): void {
    this.navTimer -= dt;
    if (this.navTimer <= 0) {
      this.rebuildNav(ctx);
      this.navTimer = NAV_REBUILD_INTERVAL;
    }

    this.updateRespawns(dt, ctx);
    this.updateKids(dt, ctx);

    this.timer -= dt;
    if (this.timer <= 0) this.endRaid(ctx);
  }

  private endRaid(ctx: ModeContext): void {
    this.bots.length = 0;
    this.assignments.clear();
    ctx.projectiles.clear();

    if (this.raid >= RAID_COUNT) {
      this.finish(ctx, true);
      return;
    }
    this.phase = 'lull';
    this.timer = LULL_TIME;
    // A delivery for the repair phase: enough to patch what broke, not enough
    // to rebuild somewhere else, or every phase would reset the decision.
    this.lumber.deliver(PHASE_DELIVERY, LUMBER_CAP);
    this.setMessage(`${Math.round(this.totalWater)} litres left. Patch what they got through.`, 6);
    ctx.emit({ type: 'phaseChange', phase: 'lull' });
  }

  private checkDefeat(ctx: ModeContext): void {
    if (this.finished) return;
    if (this.sources.every((s) => s.water <= DRY)) this.finish(ctx, false);
  }

  private finish(ctx: ModeContext, won: boolean): void {
    this.phase = 'over';
    this.finished = true;
    this.won = won;
    this.streams.clear();
    this.setMessage(won ? 'Sun down. You kept the water.' : 'Every tap dry.', 8);
    ctx.emit({ type: won ? 'roundWon' : 'roundLost' });
  }

  // ── The kids ───────────────────────────────────────────────────────────────

  /**
   * Send a raid at the sources with the most water left.
   *
   * Sorting by level rather than picking at random means ignoring a source is
   * punished specifically: the full one is exactly where they go next, so the
   * player's attention is drawn around the map instead of parking.
   */
  private spawnRaid(ctx: ModeContext): void {
    const count = 3 + this.raid;
    const order = this.sources
      .map((s, i) => ({ i, water: s.water }))
      .sort((a, b) => b.water - a.water);

    for (let n = 0; n < count; n++) {
      const tier: BotConfig =
        this.raid >= 3 && ctx.rng.chance(0.35) ? BOT_TIERS.tough!
          : this.raid >= 2 ? BOT_TIERS.normal! : BOT_TIERS.easy!;
      const target = order[n % order.length]!.i;
      this.spawnKid(ctx, tier, target, n);
    }
  }

  private spawnKid(ctx: ModeContext, tier: BotConfig, sourceIndex: number, n: number): Bot {
    // In over the fence line, spread so a raid does not arrive stacked.
    const angle = (n / 7) * Math.PI * 2 + ctx.rng.signed(0.4);
    const bound = 22;
    const scale = bound / Math.max(Math.abs(Math.sin(angle)), Math.abs(Math.cos(angle)));
    let x = Math.sin(angle) * scale;
    // Clear of the divider fence that runs the length of the lot at x = 0.
    if (Math.abs(x) < 1.6) x = x < 0 ? -1.6 : 1.6;

    const bot = new Bot(this.nextBotId++, ctx.world, ctx.rng.fork(), tier, x, 0.6, Math.cos(angle) * scale);
    this.bots.push(bot);
    this.assignments.set(bot.id, sourceIndex);
    this.botWet.set(bot.id, makeWetness());
    return bot;
  }

  private rebuildNav(ctx: ModeContext): void {
    for (let i = 0; i < this.sources.length; i++) {
      this.nav[i]!.rebuild(ctx.world, this.sources[i]!.x, this.sources[i]!.z);
    }
  }

  private updateKids(dt: number, ctx: ModeContext): void {
    for (const bot of this.bots) {
      if (!bot.alive) continue;

      const index = this.assignments.get(bot.id) ?? 0;
      const source = this.sources[index]!;

      bot.targetX = source.x;
      bot.targetY = 0;
      bot.targetZ = source.z;

      const atSource = Math.hypot(bot.x - source.x, bot.z - source.z) <= SOURCE_RADIUS
        && this.canReach(ctx, bot, source);
      if (atSource && source.water > 0) {
        source.water = Math.max(0, source.water - DRAIN_RATE * dt);
        // Bucket full: they head for the next one worth taking.
        if (source.water <= DRY) this.reassign(bot.id, index);
      }

      // Whoever is nearest and in the open, rather than always the host. A kid
      // that could only ever throw at the player was correct while the player
      // was the only person on the lawn; with a guest in the yard it means one
      // of the two humans is being shot at and the other is a spectator with
      // legs.
      const mark = this.nearestVisible(ctx, bot);
      if (mark !== null) {
        bot.aimX = mark.controller.x;
        bot.aimY = mark.controller.y + CAP_HEIGHT * 0.6;
        bot.aimZ = mark.controller.z;
      }
      bot.hasAim = mark !== null;

      bot.update(dt, ctx.projectiles, mark !== null, this.nav[index]!);
    }
  }

  /** Move a kid onto whichever source still has the most in it. */
  private reassign(botId: number, avoid: number): void {
    let best = -1;
    let bestWater = DRY;
    for (let i = 0; i < this.sources.length; i++) {
      if (i === avoid) continue;
      if (this.sources[i]!.water > bestWater) {
        bestWater = this.sources[i]!.water;
        best = i;
      }
    }
    if (best !== -1) this.assignments.set(botId, best);
  }

  private updateRespawns(dt: number, ctx: ModeContext): void {
    for (const bot of this.bots) {
      if (!bot.alive && !this.respawns.has(bot.id)) this.respawns.set(bot.id, KID_RESPAWN);
    }

    for (const [id, remaining] of [...this.respawns]) {
      const left = remaining - dt;
      if (left > 0) {
        this.respawns.set(id, left);
        continue;
      }
      this.respawns.delete(id);

      const at = this.bots.findIndex((b) => b.id === id);
      if (at === -1) continue;
      const source = this.assignments.get(id) ?? 0;
      this.assignments.delete(id);
      this.botWet.delete(id);
      this.bots.splice(at, 1);
      this.spawnKid(ctx, BOT_TIERS.normal!, source, at);
    }
  }

  /**
   * Can this kid actually get their bucket into the water?
   *
   * Being within `SOURCE_RADIUS` used to be the whole test, and that one line is
   * why the mode's entire fortification economy did not work. A tap is drained
   * from 3.2m away, and a ring of planks a player would naturally build sits
   * *inside* that — so kids stood against the outside of a finished wall and
   * emptied the tap straight through it.
   *
   * The symptoms were strange enough to be worth recording, because they all
   * come from here. Measured over a full afternoon with the player standing
   * still, the water kept went 61% at a 1.6m ring, 51% at 2.0m, 74% at 2.6m,
   * 8.8% at 3.6m and 20% at 4.2m — no curve a player could ever learn, because
   * it was not really measuring the wall. And wall *height* did nothing at all
   * above the first metre: 1.25m and 2.00m rings gave results identical to
   * three significant figures at every radius, so the second hundred planks a
   * player spent going higher bought exactly nothing.
   *
   * A line of sight is the cheapest honest fix. It makes a wall work because it
   * is a wall — something solid between a kid and the tap — rather than because
   * of where the nav grid happened to leave a gap. Raycasts cost 0.0036ms and
   * this is one per kid per tick.
   */
  private canReach(ctx: ModeContext, bot: Bot, source: SourceState): boolean {
    // From the bucket, roughly, to the water. Low on both ends on purpose: a
    // knee-high wall is not a wall, and measuring eye-to-tap would let a kid
    // "reach" over anything they could see across.
    const fromY = bot.y + CAP_HEIGHT * 0.35;
    const dx = source.x - bot.x;
    const dy = 0.35 - fromY;
    const dz = source.z - bot.z;
    const distance = Math.hypot(dx, dy, dz);

    // Stop short of the tap itself, and this is the whole trick rather than a
    // tolerance. Every source *is* a solid prop — a paddling pool has a rim, a
    // rain barrel is a barrel — so a ray aimed at the middle of one always ends
    // by hitting it. The first version of this did exactly that and blocked
    // every kid on the map from ever drinking: an empty lawn with no wall on it
    // kept 66% of its water, which is a better result than any fort, and is the
    // kind of number a control case exists to produce.
    const reach = distance - SOURCE_EDGE;
    if (reach <= 0) return true;
    const hit = ctx.world.raycast(bot.x, fromY, bot.z, dx, dy, dz, reach);
    return hit === null || hit.distance >= reach - CAP_RADIUS;
  }

  /** The closest person this kid can actually see, or null. */
  private nearestVisible(ctx: ModeContext, bot: Bot): Actor | null {
    let best: Actor | null = null;
    let bestDistance = Infinity;
    for (const who of ctx.actors.all) {
      if (!isFighter(who)) continue;
      if (this.fighters.isOut(who.id)) continue;
      const body = who.controller;
      const dx = body.x - bot.x;
      const dy = body.y + CAP_HEIGHT * 0.6 - (bot.y + CAP_HEIGHT * 0.75);
      const dz = body.z - bot.z;
      const distance = Math.hypot(dx, dy, dz);
      if (distance > 18 || distance >= bestDistance) continue;
      const hit = ctx.world.raycast(bot.x, bot.y + CAP_HEIGHT * 0.75, bot.z, dx, dy, dz, distance);
      if (hit !== null && hit.distance < distance - CAP_RADIUS) continue;
      best = who;
      bestDistance = distance;
    }
    return best;
  }

  // ── Water and weapons ──────────────────────────────────────────────────────

  /** The source the local player is standing at, or -1. For the HUD. */
  get atSource(): number {
    return this.sourceUnder(LOCAL_ACTOR_ID);
  }

  /** Where each person was last seen, so `atSource` can answer without a roster. */
  private readonly standing = new Map<number, { x: number; z: number }>();

  private sourceUnder(actorId: number): number {
    const at = this.standing.get(actorId);
    return at === undefined ? -1 : this.nearestSourceTo(at.x, at.z);
  }

  private nearestSourceTo(x: number, z: number): number {
    for (let i = 0; i < this.sources.length; i++) {
      const s = this.sources[i]!;
      if (Math.hypot(x - s.x, z - s.z) <= SOURCE_RADIUS) return i;
    }
    return -1;
  }

  private updateTank(dt: number, ctx: ModeContext, who: Actor, self: Fighter): void {
    void ctx;
    const body = who.controller;
    this.standing.set(who.id, { x: body.x, z: body.z });

    const at = this.sourceUnder(who.id);
    if (at === -1 || self.out > 0) return;
    const source = this.sources[at]!;
    if (source.water <= DRY || self.ammo >= TANK_MAX) return;

    const want = Math.min(REFILL_RATE * dt, TANK_MAX - self.ammo);
    self.ammo += want;
    // Filling costs the source. Not much, but enough that camping one pool is
    // draining the thing you are camping.
    source.water = Math.max(0, source.water - REFILL_DRAW * dt * (want / (REFILL_RATE * dt || 1)));
  }

  /** True when the local player's held weapon can actually be used right now. */
  get weaponReady(): boolean {
    return this.readyFor(LOCAL_ACTOR_ID, this.weapon);
  }

  private readyFor(actorId: number, id: WeaponId): boolean {
    const w = WEAPONS[id];
    if (w.tethered) return this.sourceUnder(actorId) !== -1;
    const tank = this.fighters.of(actorId).ammo;
    return tank >= (w.continuous ? 1 : w.cost);
  }

  selectWeapon(id: WeaponId): void {
    this.weapon = id;
  }

  /**
   * What somebody is holding.
   *
   * The local player's choice comes off the wheel they clicked. Everybody
   * else's rides in their command, because a picker is a per-tick statement of
   * will exactly like a movement axis — and a guest who could only ever hold
   * the starting soaker would be playing a strictly smaller game than the host.
   */
  private weaponOf(actorId: number): WeaponId {
    if (actorId === LOCAL_ACTOR_ID) return this.weapon;
    return this.held.get(actorId) ?? 'soaker';
  }

  private updateFiring(
    dt: number, ctx: ModeContext, who: Actor, self: Fighter, input: ActorInput,
  ): void {
    if (input.slot !== undefined && who.id !== LOCAL_ACTOR_ID) {
      const picked = WEAPON_ORDER[input.slot];
      if (picked !== undefined) this.held.set(who.id, picked);
    }
    if (this.phase === 'build' || this.phase === 'lull' || this.phase === 'over') return;
    if (self.out > 0) return;

    const id = this.weaponOf(who.id);
    const weapon = WEAPONS[id];
    if (weapon.continuous) {
      if (input.fire && this.readyFor(who.id, id)) this.fireStream(dt, ctx, who, self, input, id);
      return;
    }
    if (input.firePressed && self.cooldown <= 0 && self.ammo >= weapon.cost) {
      this.throwBalloon(ctx, who, self, input);
    }
  }

  /**
   * A stream: a ray from the eye, stopped by the world.
   *
   * Stopped by the world is the whole point — it is what makes a plank worth
   * nailing up, and what the balloon exists to get around.
   */
  private fireStream(
    dt: number, ctx: ModeContext, who: Actor, self: Fighter, input: ActorInput, id: WeaponId,
  ): void {
    const weapon = WEAPONS[id];
    if (weapon.cost > 0) {
      const spend = Math.min(self.ammo, weapon.cost * dt);
      if (spend <= 0) return;
      self.ammo -= spend;
    }

    const dir = { x: input.aimX, y: input.aimY, z: input.aimZ };
    const body = who.controller;
    const ox = body.x;
    const oy = body.y + EYE_HEIGHT;
    const oz = body.z;

    let reach = weapon.range;
    const blocked = ctx.world.raycast(ox, oy, oz, dir.x, dir.y, dir.z, weapon.range);
    if (blocked !== null) reach = blocked.distance;

    const end = { x: ox + dir.x * reach, y: oy + dir.y * reach, z: oz + dir.z * reach };
    this.streams.set(who.id, end);
    this.streamHitSomething = false;

    // Everything the ray passes close to, within its reach.
    for (const bot of this.bots) {
      if (!bot.alive) continue;
      const w = this.botWet.get(bot.id);
      if (w === undefined) continue;

      const along = (bot.x - ox) * dir.x + (bot.y + CAP_HEIGHT * 0.5 - oy) * dir.y + (bot.z - oz) * dir.z;
      if (along <= 0 || along > reach) continue;
      const px = ox + dir.x * along;
      const py = oy + dir.y * along;
      const pz = oz + dir.z * along;
      // Generous, because a jet of water is not a bullet and reading a miss as
      // a hit is far kinder here than the reverse.
      if (Math.hypot(bot.x - px, bot.y + CAP_HEIGHT * 0.5 - py, bot.z - pz) > CAP_RADIUS + 0.45) continue;

      this.streamHitSomething = true;
      const landed = soak(w, streamPower(weapon, along) * dt);
      if (landed > 0 && isSoaked(w)) this.soakKid(ctx, bot);
    }

    // Splashes on a fixed cadence rather than a random chance per tick. Two
    // reasons, and the second is the one that matters: a continuous jet with
    // randomly spaced splashes sounds like it is stuttering, and drawing from
    // ctx.rng here would spend simulation randomness — the same stream that
    // picks bot tiers and spawn angles — on a decision that is purely cosmetic.
    if (this.streamHitSomething) {
      this.splashTimer -= dt;
      if (this.splashTimer <= 0) {
        this.splashTimer = SPLASH_INTERVAL;
        ctx.emit({ type: 'splash', x: end.x, y: end.y, z: end.z });
      }
    } else {
      // Reset, so re-acquiring a target splashes immediately rather than
      // finishing a countdown started on the last one.
      this.splashTimer = 0;
    }
  }

  private throwBalloon(ctx: ModeContext, who: Actor, self: Fighter, input: ActorInput): void {
    const weapon = WEAPONS.balloon;
    self.ammo -= weapon.cost;
    self.cooldown = weapon.cooldown;

    const body = who.controller;
    const ox = body.x + input.aimX * 0.6;
    const oy = body.y + CAP_HEIGHT * 0.8;
    const oz = body.z + input.aimZ * 0.6;
    // Owned by whoever threw it, so it passes through them and not through the
    // person next to them.
    ctx.projectiles.spawn(ox, oy, oz, input.aimX, input.aimY + 0.08, input.aimZ, 19, who.id);
    ctx.emit({ type: 'throw', x: ox, y: oy, z: oz });
  }

  private soakKid(ctx: ModeContext, bot: Bot): void {
    // One call, however wet they got: soak() is the meter, this is the moment
    // it fills. Bot.soak() counts hits, so drive it until it gives way.
    let done = false;
    for (let i = 0; i < 8 && !done; i++) done = bot.soak();
    ctx.emit({ type: 'botSoaked', x: bot.x, y: bot.y + 1, z: bot.z });
  }

  private soakFighter(
    ctx: ModeContext, self: Fighter, from?: { x: number; y: number; z: number },
  ): void {
    if (self.out > 0) return;
    self.out = PLAYER_SOAKED_TIME;
    this.streams.delete(self.id);
    // Only the person it happened to hears about it. The event drives this
    // machine's screen flash and the arrow pointing at whoever got you, and
    // firing it for a guest being soaked in another garden would flash the
    // host's screen for something that did not happen to them.
    if (self.id === LOCAL_ACTOR_ID) {
      ctx.emit({ type: 'playerSoaked', x: from?.x, y: from?.y, z: from?.z });
      this.setMessage('Drenched! Back in a moment.', 2.5);
    }
  }

  private revive(ctx: ModeContext, self: Fighter): void {
    resetWetness(self.wet);
    // Half a tank, so being soaked is never a shortcut to a full one.
    self.ammo = Math.max(self.ammo, RESPAWN_TANK);
    const who = ctx.actors.get(self.id);
    who?.controller.teleport(FORT_YARD.x, 0.6, FORT_YARD.z - 4);
  }

  private updateProjectiles(dt: number, ctx: ModeContext): void {
    this.targets.length = 0;
    for (const bot of this.bots) {
      if (bot.alive) this.targets.push(bot.asTarget());
    }
    for (const who of ctx.actors.all) {
      if (!isFighter(who) || this.fighters.of(who.id).out > 0) continue;
      const body = who.controller;
      this.targets.push({
        x: body.x, y: body.y, z: body.z,
        radius: CAP_RADIUS, height: CAP_HEIGHT,
        id: who.id, alive: true,
      });
    }

    ctx.projectiles.update(dt, this.targets);

    for (const hit of ctx.projectiles.hits) {
      ctx.emit({ type: 'splash', x: hit.x, y: hit.y, z: hit.z });

      // Direct and splash are kept apart deliberately — see waterKit. A centre
      // hit taking both is the difference between two balloons and three.
      if (hit.targetIndex >= 0) {
        this.applyWet(ctx, this.targets[hit.targetIndex], WEAPONS.balloon.power, hit);
        if (!DIRECT_HIT_TAKES_SPLASH) continue;
      }
      for (const index of ctx.projectiles.splashTargets(hit, this.targets)) {
        if (index === hit.targetIndex) continue;
        const t = this.targets[index];
        if (t === undefined) continue;
        const d = Math.hypot(t.x - hit.x, t.y + t.height * 0.5 - hit.y, t.z - hit.z);
        this.applyWet(ctx, t, splashPower(d, SPLASH_RADIUS), hit);
      }
    }
  }

  private applyWet(
    ctx: ModeContext,
    target: BalloonTarget | undefined,
    amount: number,
    /** Where the water came from, so the HUD can point at it. */
    from?: { x: number; y: number; z: number },
  ): void {
    if (target === undefined || amount <= 0) return;

    // People and kids are told apart by which range the id came out of — see
    // FIRST_BOT_ID. Asking the fighters map rather than comparing against a
    // single player id is what lets a guest be hit at all.
    if (target.id < FIRST_BOT_ID) {
      const self = this.fighters.of(target.id);
      soak(self.wet, amount);
      if (isSoaked(self.wet)) this.soakFighter(ctx, self, from);
      return;
    }
    const bot = this.bots.find((b) => b.id === target.id);
    const w = bot === undefined ? undefined : this.botWet.get(bot.id);
    if (bot === undefined || w === undefined) return;
    soak(w, amount);
    if (isSoaked(w)) this.soakKid(ctx, bot);
  }

  // ── Published state ────────────────────────────────────────────────────────

  get totalWater(): number {
    return this.sources.reduce((sum, s) => sum + s.water, 0);
  }

  get waterFraction(): number {
    return this.totalWater / (SOURCE_MAX * this.sources.length);
  }

  get buildingAllowed(): boolean {
    return this.phase === 'build' || this.phase === 'lull';
  }

  get playerSpeedScale(): number {
    return this.speedScaleFor(LOCAL_ACTOR_ID);
  }

  speedScaleFor(actorId: number): number {
    return this.fighters.isOut(actorId) ? 0 : 1;
  }

  get tankLevel(): number {
    return this.fighters.of(LOCAL_ACTOR_ID).ammo;
  }

  get playerWetness(): number {
    return this.fighters.wetnessOf(LOCAL_ACTOR_ID);
  }

  /** True while the player is soaked and sitting the next few seconds out. */
  get playerIsOut(): boolean {
    return this.fighters.isOut(LOCAL_ACTOR_ID);
  }

  /** Wetness of anybody at all, for the renderer's tint. */
  wetnessOf(actorId: number): number {
    return actorId < FIRST_BOT_ID
      ? this.fighters.wetnessOf(actorId)
      : this.botWet.get(actorId)?.value ?? 0;
  }

  private setMessage(text: string, seconds: number): void {
    this.message = text;
    this.messageTimer = seconds;
  }

  hud(): ModeHud {
    const label =
      this.phase === 'build' ? 'BUILD'
        : this.phase === 'lull' ? 'REPAIR'
          : this.phase === 'raid' ? `RAID ${this.raid}/${RAID_COUNT}`
            : this.won ? 'HELD' : 'DRY';

    const weapon = WEAPONS[this.weapon];
    const standing = this.bots.filter((b) => b.alive).length;

    return {
      phase: label,
      // Shown during a raid too: how long you still have to hold is the number
      // the player is actually playing against once the kids are on the lawn.
      timer: this.phase === 'over' ? null : Math.max(0, this.timer),
      primary: { label: 'water', value: `${Math.round(this.totalWater)}L` },
      secondary: this.phase === 'raid'
        ? { label: 'kids', value: String(standing) }
        : { label: 'kit', value: weapon.name },
      message: this.message,
      ...this.selfHud(LOCAL_ACTOR_ID),
      lumber: this.buildingAllowed ? this.lumber.available : null,
    };
  }

  /**
   * The four personal numbers, about whoever is asked for.
   *
   * The local player's HUD is built from this too rather than from a second
   * copy of the same expressions. That is the point: a guest's tank gauge and
   * the host's come out of one function, so there is no version of this where
   * one of them is right and the other has quietly drifted.
   */
  selfHud(actorId: number): ModeSelfHud {
    const self = this.fighters.of(actorId);
    const at = this.sourceUnder(actorId);
    return {
      charge: null,
      wetness: self.wet.value,
      ammo: this.buildingAllowed
        ? null
        : { current: self.ammo, max: TANK_MAX, gauge: true },
      refill: at !== -1 && self.ammo < TANK_MAX ? self.ammo / TANK_MAX : null,
    };
  }

  summary(): ModeSummary {
    const kept = Math.round(this.waterFraction * 100);
    return {
      headline: this.won ? 'Sun down. You kept the water.' : 'They drained every tap',
      lines: [
        { label: 'water kept', value: `${kept}%` },
        { label: 'raids held', value: `${this.won ? RAID_COUNT : Math.max(0, this.raid - 1)}` },
        ...this.sources.map((s) => ({
          label: s.name,
          value: `${Math.round((s.water / SOURCE_MAX) * 100)}%`,
        })),
      ],
    };
  }

  /**
   * The weapon picker, reusing the same radial wheel the build parts use.
   *
   * Two wheels would be two things to learn for one gesture. The wheel shows
   * parts while you can build and weapons while you cannot, which is exactly
   * when each is the only one that makes sense.
   */
  get loadout(): Loadout {
    return {
      entries: WEAPON_ORDER.map((id) => {
        const w = WEAPONS[id];
        return {
          id,
          name: w.name,
          blurb: w.blurb,
          ready: this.readyFor(LOCAL_ACTOR_ID, id),
        };
      }),
      selected: this.weapon,
      select: (id: string) => {
        if ((WEAPON_ORDER as readonly string[]).includes(id)) this.weapon = id as WeaponId;
      },
    };
  }

  get stream(): { x: number; y: number; z: number } | null {
    return this.streamFor(LOCAL_ACTOR_ID);
  }

  /**
   * Where somebody's hose is landing, or null.
   *
   * Other people's streams are computed and published but not yet drawn — the
   * renderer takes one stream, the local player's. Worth stating rather than
   * hiding: it means a guest can see their own water and cannot see the host's.
   * The state to fix it is here; what is missing is a second draw call.
   */
  streamFor(actorId: number): { x: number; y: number; z: number } | null {
    return this.streams.get(actorId) ?? null;
  }

  markers(): readonly Marker[] {
    this.markerList.length = 0;
    for (const s of this.sources) {
      const share = s.water / SOURCE_MAX;
      this.markerList.push({
        kind: 'bucket',
        x: s.x, y: 0, z: s.z,
        // Full reads blue, empty reads dust. The colour is the score, so it has
        // to be readable from across the yard without a number.
        color: share > 0.6 ? 0x4fc3e8 : share > 0.25 ? 0xe8c86a : 0xb05a48,
        active: this.atSource !== -1 && this.sources[this.atSource] === s,
        faded: share <= DRY,
      });
    }
    return this.markerList;
  }
}

/** Weapons in picker order, for the HUD. */
export const WEAPON_PICKER = WEAPON_ORDER.map((id) => WEAPONS[id]);

/** Stage names, re-exported so the HUD does not reach into the wetness module. */
export { wetStage };
