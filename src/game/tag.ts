/**
 * Freeze Tag — the mode that is only about moving.
 *
 * One kid is It. Touch somebody and they freeze on the spot; another runner who
 * stands next to a frozen kid for a moment thaws them out. It wins by having
 * everybody frozen at the same time, and the runners win by lasting the clock.
 *
 * ## Why this one and not ordinary tag
 *
 * Ordinary tag needs the chaser to be faster, and a chaser who is faster is a
 * chaser nobody escapes on open ground — so the answer is always "keep running
 * away", which is not a decision. Freezing is cumulative instead: It never has
 * to catch the fastest runner, only to keep the count climbing. And thawing
 * puts the pressure on the other side, because the moment a friend goes down
 * the map has a place on it that somebody has to visit, and It knows where.
 *
 * That is the whole design. Nobody is faster than anybody, and the tension
 * comes from a decision the runners keep having to make: is that rescue worth
 * the walk. Two people who both run away for two minutes have drawn a boring
 * round on purpose, and it is theirs to draw.
 *
 * ## The field is the whole neighbourhood
 *
 * Every other mode is played inside the fenced lot, because every other mode is
 * balanced around its dimensions — spawns, flag runs, how far a tap is from the
 * next one. This one goes out the front gate and onto the cul-de-sac, which has
 * been scenery since the day it was built and is about eighty metres of road,
 * verge, drive and parked car that nobody has ever had a reason to stand on.
 *
 * It costs nothing to do that here precisely because Tag has no geometry to be
 * balanced against: there is no objective to defend, no distance that has to be
 * fair, and no wall worth building. A larger field only means more places to
 * run to, and the mode's one number — how long the round lasts — is the same
 * whatever the shape of the ground.
 *
 * ## There is no building
 *
 * Deliberate, and the only mode of which that is true. Three modes already ask
 * whether it is fun to fight inside something you made; this one asks a
 * question they cannot, which is whether the movement is good enough to carry a
 * round on its own — the mantle, the trampolines, the slides, the roofs. A
 * plank wall would answer it by changing the subject.
 */

import { Bot, BOT_TIERS } from './bot.ts';
import { FIRST_BOT_ID, LOCAL_ACTOR_ID, type Actor } from './actor.ts';
import type {
  GameMode, Marker, ModeContext, ModeHud, ModeInput, ModeSelfHud, ModeSummary,
} from './gameMode.ts';
import { NavField } from './navField.ts';
import { CAP_HEIGHT } from '../physics/constants.ts';
import { LEFT_SPAWN } from '../world/neighborhood.ts';
import { BULB } from '../world/culDeSac.ts';

export type Phase = 'countdown' | 'chase' | 'over';

/** Seconds of head start before It may tag anybody. */
export const COUNTDOWN_TIME = 8;
/** How long a round lasts once the chase starts. */
export const ROUND_TIME = 150;

/**
 * How close a tag is, in metres.
 *
 * A little over two capsule radii, so it is contact rather than a reach. Tag by
 * proximity and not by a ray: what a player is looking at has nothing to do
 * with whether they bumped into somebody, and a tag that required aim would
 * make being chased a duel.
 */
export const TAG_RADIUS = 1.15;

/**
 * How much of a height difference still counts as touching.
 *
 * The field has roofs on it now, and without this an It standing under the
 * porch tags whoever is on top of it — which would make the one route this
 * update opened the worst place to stand.
 */
export const TAG_HEIGHT = CAP_HEIGHT;

/** How close you stand to thaw somebody, and how long it takes. */
export const THAW_RADIUS = 1.8;
export const THAW_TIME = 1.4;

/**
 * How long It must wait after a tag before making another.
 *
 * Without it one It walking through a huddle freezes all of them in a tick, and
 * a huddle is exactly what a rescue makes. Long enough that the second kid of a
 * pair has a real chance to run.
 */
export const TAG_COOLDOWN = 1.2;

/** How many neighbourhood kids join in. */
export const KID_COUNT = 5;
/** Seconds between nav-field rebuilds. */
const NAV_REBUILD_INTERVAL = 0.25;

/**
 * How far the routing grid reaches, in metres from the origin.
 *
 * Wide enough to cover the lot *and* the turning head at z = -37 with the
 * houses round it, which is what makes the street a real part of the field
 * rather than a corner bots refuse to follow you into. It is four times the
 * area of the grid the other modes use, and affordable for one reason: nobody
 * builds in Tag, so the expensive half of a rebuild — deciding which cells are
 * blocked — is done once and then reused for the whole round.
 */
const NAV_HALF_EXTENT = 52;

/** Colours for the two things worth pinning: the chaser, and a frozen friend. */
const IT_COLOR = 0xd8564f;
const FROZEN_COLOR = 0x6fc6e8;

/** How the mode sees one kid. */
interface Runner {
  readonly id: number;
  /** Stood still until somebody comes and gets them. */
  frozen: boolean;
  /** How far through a thaw somebody has got them, 0..1. */
  thaw: number;
  /** Seconds spent not frozen, which is the score. */
  survived: number;
}

/**
 * Where everybody starts.
 *
 * It starts in the back garden and the runners at the front of the lot, facing
 * the gate — so the countdown is spent running *outward*, and the first thing a
 * new player does in this mode is discover that the street is open.
 */
export const IT_SPAWN = { x: 0, y: 0.5, z: 14 } as const;

export class TagMode implements GameMode {
  readonly id = 'tag';
  readonly name = 'Tag';

  phase: Phase = 'countdown';
  finished = false;
  won = false;

  readonly bots: Bot[] = [];
  /** No planks, no pile, and no build phase. See the header. */
  readonly buildingAllowed = false;
  readonly playerSpeedScale = 1;

  private timer = COUNTDOWN_TIME;
  private message: string | null = null;
  private messageTimer = 0;
  private elapsed = 0;

  /** Who is It. More than one, because a frozen-out round has to escalate. */
  private readonly its = new Set<number>();
  private readonly runners = new Map<number, Runner>();
  /** Per-It seconds left before another tag lands. */
  private readonly tagCooldowns = new Map<number, number>();

  private nextBotId = FIRST_BOT_ID;
  private readonly nav = new NavField(NAV_HALF_EXTENT);
  private navTimer = 0;
  /** Whoever the chase is currently routed at, so the flood is not redone. */
  private navGoal: { x: number; z: number } | null = null;

  private readonly pins: Marker[] = [];

  /**
   * The roster as of the last tick.
   *
   * `markers()` is called by the renderer, which has no context to hand, and a
   * mode is not allowed to keep one — a `ModeContext` held across ticks is a
   * world that outlives the round it belonged to. So the one thing the pins
   * need is kept, and it is the array the roster already reuses rather than a
   * copy of it.
   */
  private currentActors: readonly Actor[] = [];

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  start(ctx: ModeContext): void {
    this.phase = 'countdown';
    this.timer = COUNTDOWN_TIME;
    this.elapsed = 0;
    this.finished = false;
    this.won = false;
    this.bots.length = 0;
    this.its.clear();
    this.runners.clear();
    this.tagCooldowns.clear();
    this.navGoal = null;

    this.spawnKids(ctx);
    // The local player is It. Not drawn from the hat, and that is a decision:
    // being chased by five kids you have never met is a mode you can watch, and
    // doing the chasing is the half that teaches you where the routes are.
    this.its.add(LOCAL_ACTOR_ID);
    ctx.player.teleport(IT_SPAWN.x, IT_SPAWN.y, IT_SPAWN.z);

    this.setMessage('You are It. Freeze them all at once.', 6);
    ctx.emit({ type: 'phaseChange', phase: 'countdown' });
  }

  end(): void {
    this.bots.length = 0;
    this.its.clear();
    this.runners.clear();
  }

  fixedUpdate(dt: number, ctx: ModeContext, _input: ModeInput): void {
    ctx.actors.refresh(this.bots);
    if (this.finished) return;

    this.messageTimer -= dt;
    if (this.messageTimer <= 0) this.message = null;

    this.enrol(ctx);

    for (const [id, left] of this.tagCooldowns) {
      if (left > 0) this.tagCooldowns.set(id, Math.max(0, left - dt));
    }

    if (this.phase === 'countdown') {
      this.timer -= dt;
      if (this.timer <= 0) {
        this.phase = 'chase';
        this.timer = ROUND_TIME;
        this.setMessage('Go!', 2);
        ctx.emit({ type: 'phaseChange', phase: 'chase' });
      }
      this.driveKids(dt, ctx);
      return;
    }

    if (this.phase === 'over') return;

    this.elapsed += dt;
    this.timer -= dt;
    for (const runner of this.runners.values()) {
      if (!runner.frozen) runner.survived += dt;
    }

    this.tagging(ctx);
    this.thawing(dt, ctx);
    this.driveKids(dt, ctx);

    if (this.everyoneFrozen()) {
      this.finish(ctx, true);
      return;
    }
    if (this.timer <= 0) this.finish(ctx, false);
  }

  // ── Who is playing ──────────────────────────────────────────────────────────

  /**
   * Give a runner record to anybody who has turned up without one.
   *
   * Once a tick rather than at the start, because somebody can join a session
   * mid-round and a person with no record is a person It cannot tag — they
   * would be a ghost who wins by not existing.
   */
  private enrol(ctx: ModeContext): void {
    this.currentActors = ctx.actors.all;
    for (const who of ctx.actors.all) {
      if (this.its.has(who.id)) continue;
      if (this.runners.has(who.id)) continue;
      this.runners.set(who.id, { id: who.id, frozen: false, thaw: 0, survived: 0 });
    }
  }

  private spawnKids(ctx: ModeContext): void {
    // Along the front of the lot, spread wide and facing the gate. A line
    // rather than a ring, so the first second of the round is everybody moving
    // the same way and It watching them go.
    for (let i = 0; i < KID_COUNT; i++) {
      const x = -14 + (i / Math.max(1, KID_COUNT - 1)) * 28 + ctx.rng.signed(1.2);
      const z = LEFT_SPAWN.z + ctx.rng.signed(1.5);
      const bot = new Bot(this.nextBotId++, ctx.world, ctx.rng.fork(), BOT_TIERS.normal!, x, 0.5, z);
      bot.team = 'left';
      this.bots.push(bot);
    }
  }

  // ── The chase ───────────────────────────────────────────────────────────────

  private tagging(ctx: ModeContext): void {
    for (const chaser of ctx.actors.all) {
      if (!this.its.has(chaser.id)) continue;
      if ((this.tagCooldowns.get(chaser.id) ?? 0) > 0) continue;

      for (const quarry of ctx.actors.all) {
        const runner = this.runners.get(quarry.id);
        if (runner === undefined || runner.frozen) continue;
        if (!this.touching(chaser, quarry)) continue;

        runner.frozen = true;
        runner.thaw = 0;
        this.tagCooldowns.set(chaser.id, TAG_COOLDOWN);
        ctx.emit({
          type: 'botSoaked',
          x: quarry.controller.x, y: quarry.controller.y + 1, z: quarry.controller.z,
        });
        if (quarry.id === LOCAL_ACTOR_ID) {
          ctx.emit({
            type: 'playerSoaked',
            x: chaser.controller.x, y: chaser.controller.y + 1, z: chaser.controller.z,
          });
          this.setMessage('Frozen. Wait for a friend.', 3);
        }
        break;
      }
    }
  }

  private thawing(dt: number, ctx: ModeContext): void {
    for (const runner of this.runners.values()) {
      if (!runner.frozen) continue;
      const body = ctx.actors.get(runner.id);
      if (body === undefined) continue;

      let helped = false;
      for (const helper of ctx.actors.all) {
        if (helper.id === runner.id) continue;
        // One rule, one line, and that is worth being deliberate about. These
        // two conditions were written as `its.has(...)` and `runners.get(...)
        // === undefined || .frozen`, which reads as two rules and is one: It
        // has no runner record, so the second condition already excluded them
        // and deleting the first changed nothing a test could see. Whichever
        // rule a reader is checking, this is now the line that enforces it.
        if (this.its.has(helper.id)) continue;
        // A frozen kid cannot thaw another frozen kid, or a pair goes down
        // together and gets up together for free.
        if (this.runners.get(helper.id)?.frozen === true) continue;
        if (!this.within(helper, body, THAW_RADIUS)) continue;
        helped = true;
        break;
      }

      if (!helped) {
        // Bleeds back rather than resetting, so somebody driven off a rescue
        // has not lost all of it — the interesting version of the decision is
        // "can I get back", not "was I interrupted".
        runner.thaw = Math.max(0, runner.thaw - dt / THAW_TIME);
        continue;
      }

      runner.thaw += dt / THAW_TIME;
      if (runner.thaw >= 1) {
        runner.frozen = false;
        runner.thaw = 0;
        ctx.emit({
          type: 'refilled',
          x: body.controller.x, y: body.controller.y + 1, z: body.controller.z,
        });
        if (runner.id === LOCAL_ACTOR_ID) this.setMessage('Thawed. Run.', 2.5);
      }
    }
  }

  /** Close enough to have been touched, in the flat and in height. */
  private touching(a: Actor, b: Actor): boolean {
    if (Math.abs(a.controller.y - b.controller.y) > TAG_HEIGHT) return false;
    return this.within(a, b, TAG_RADIUS);
  }

  private within(a: Actor, b: Actor, radius: number): boolean {
    const dx = a.controller.x - b.controller.x;
    const dz = a.controller.z - b.controller.z;
    return dx * dx + dz * dz <= radius * radius;
  }

  private everyoneFrozen(): boolean {
    let any = false;
    for (const runner of this.runners.values()) {
      any = true;
      if (!runner.frozen) return false;
    }
    // Nobody left to freeze is not a win, it is an empty lawn.
    return any;
  }

  // ── The kids ────────────────────────────────────────────────────────────────

  private driveKids(dt: number, ctx: ModeContext): void {
    const chased = this.nearestQuarry(ctx);

    this.navTimer -= dt;
    if (chased !== null && (this.navTimer <= 0 || this.navGoal === null)) {
      this.navTimer = NAV_REBUILD_INTERVAL;
      this.nav.rebuild(ctx.world, chased.controller.x, chased.controller.z);
      this.navGoal = { x: chased.controller.x, z: chased.controller.z };
    }

    for (const bot of this.bots) {
      const runner = this.runners.get(bot.id);
      const frozen = runner?.frozen === true;

      if (frozen) {
        // Standing still is the whole of being frozen, and it has to be a real
        // stand rather than a skipped update: gravity still applies, so a kid
        // frozen on a roof stays on the roof and one frozen in mid-air lands.
        bot.targetX = bot.x;
        bot.targetZ = bot.z;
        bot.update(dt, ctx.projectiles, false, null);
        continue;
      }

      if (this.its.has(bot.id)) {
        const mark = chased;
        if (mark !== null) {
          bot.targetX = mark.controller.x;
          bot.targetY = mark.controller.y;
          bot.targetZ = mark.controller.z;
        }
        bot.hasAim = false;
        bot.update(dt, ctx.projectiles, false, this.nav);
        continue;
      }

      this.runFrom(bot, ctx);
      bot.hasAim = false;
      bot.update(dt, ctx.projectiles, false, null);
    }
  }

  /**
   * Where a runner kid is trying to be.
   *
   * Rescue first, when there is somebody frozen and the chase is not standing
   * over them; otherwise straight away from the nearest It, biased toward the
   * street. The bias is what stops five kids piling into the same back corner
   * of the garden — away-from-the-chaser alone is a rule with one answer, and
   * the far end of the road is the only part of the field big enough that
   * spreading out over it looks like a decision.
   */
  private runFrom(bot: Bot, ctx: ModeContext): void {
    const chaser = this.nearestIt(ctx, bot.x, bot.z);

    const rescue = this.worthRescuing(ctx, bot, chaser);
    if (rescue !== null) {
      bot.targetX = rescue.controller.x;
      bot.targetY = rescue.controller.y;
      bot.targetZ = rescue.controller.z;
      return;
    }

    if (chaser === null) {
      bot.targetX = BULB.x;
      bot.targetY = 0;
      bot.targetZ = BULB.z;
      return;
    }

    const dx = bot.x - chaser.controller.x;
    const dz = bot.z - chaser.controller.z;
    const len = Math.hypot(dx, dz) || 1;
    // Twenty metres directly away, then pulled a third of the way toward the
    // turning head. Far enough that a fleeing kid commits to a direction
    // instead of jittering on the spot as the chaser turns.
    const awayX = bot.x + (dx / len) * 20;
    const awayZ = bot.z + (dz / len) * 20;
    bot.targetX = awayX + (BULB.x - awayX) * 0.33;
    bot.targetY = 0;
    bot.targetZ = awayZ + (BULB.z - awayZ) * 0.33;
  }

  /**
   * A frozen friend near enough to be worth the walk, and not being guarded.
   *
   * "Not guarded" is the whole of the AI's judgement here, and it is a crude
   * one on purpose: a kid that would walk into the arms of whoever froze them
   * makes the rescue look like a bug rather than like bravery.
   */
  private worthRescuing(ctx: ModeContext, bot: Bot, chaser: Actor | null): Actor | null {
    let best: Actor | null = null;
    let bestD = 26;
    for (const runner of this.runners.values()) {
      if (!runner.frozen) continue;
      const body = ctx.actors.get(runner.id);
      if (body === undefined) continue;
      const d = Math.hypot(body.controller.x - bot.x, body.controller.z - bot.z);
      if (d >= bestD) continue;
      if (chaser !== null) {
        const guard = Math.hypot(
          body.controller.x - chaser.controller.x,
          body.controller.z - chaser.controller.z,
        );
        if (guard < 8) continue;
      }
      best = body;
      bestD = d;
    }
    return best;
  }

  private nearestIt(ctx: ModeContext, x: number, z: number): Actor | null {
    let best: Actor | null = null;
    let bestD = Infinity;
    for (const who of ctx.actors.all) {
      if (!this.its.has(who.id)) continue;
      const d = Math.hypot(who.controller.x - x, who.controller.z - z);
      if (d < bestD) {
        bestD = d;
        best = who;
      }
    }
    return best;
  }

  /** The unfrozen runner closest to any It, which is who the chase is about. */
  private nearestQuarry(ctx: ModeContext): Actor | null {
    let best: Actor | null = null;
    let bestD = Infinity;
    for (const who of ctx.actors.all) {
      const runner = this.runners.get(who.id);
      if (runner === undefined || runner.frozen) continue;
      const chaser = this.nearestIt(ctx, who.controller.x, who.controller.z);
      if (chaser === null) continue;
      const d = Math.hypot(
        who.controller.x - chaser.controller.x,
        who.controller.z - chaser.controller.z,
      );
      if (d < bestD) {
        bestD = d;
        best = who;
      }
    }
    return best;
  }

  // ── Result ──────────────────────────────────────────────────────────────────

  private finish(ctx: ModeContext, itWon: boolean): void {
    this.phase = 'over';
    this.finished = true;
    // The local player is It, so It winning is the player winning. Stated as
    // its own line rather than assumed, because the day somebody else is It
    // this is the sentence that has to change.
    this.won = itWon === this.its.has(LOCAL_ACTOR_ID);
    this.setMessage(itWon ? 'All frozen!' : 'They lasted it out.', 5);
    ctx.emit({ type: itWon ? 'roundWon' : 'roundLost' });
  }

  private setMessage(text: string, seconds: number): void {
    this.message = text;
    this.messageTimer = seconds;
  }

  // ── What everybody else reads ───────────────────────────────────────────────

  /**
   * Frozen kids are pinned, and so is whoever is It.
   *
   * The two things a player in this mode has to know and cannot work out by
   * looking: where the danger is, and where somebody is waiting to be let go.
   * Both are people rather than places, so the pins move — which is the first
   * time the compass has had to follow anything.
   */
  markers(): readonly Marker[] {
    this.pins.length = 0;
    for (const who of this.currentActors) {
      if (!this.its.has(who.id)) continue;
      this.pins.push({
        kind: 'flag',
        x: who.controller.x, y: who.controller.y + 1.4, z: who.controller.z,
        color: IT_COLOR,
        active: true,
      });
    }
    for (const who of this.currentActors) {
      const runner = this.runners.get(who.id);
      if (runner === undefined || !runner.frozen) continue;
      this.pins.push({
        kind: 'bucket',
        x: who.controller.x, y: who.controller.y, z: who.controller.z,
        color: FROZEN_COLOR,
        active: runner.thaw > 0,
      });
    }
    return this.pins;
  }

  hud(): ModeHud {
    const running = this.runningCount();
    return {
      phase: this.phase === 'countdown' ? 'READY' : this.phase === 'chase' ? 'TAG' : 'OVER',
      timer: this.phase === 'over' ? null : Math.max(0, this.timer),
      primary: { label: 'Running', value: `${running} / ${this.runners.size}` },
      secondary: null,
      message: this.message,
      ...this.selfHud(LOCAL_ACTOR_ID),
    };
  }

  /**
   * What one person's own corner of the HUD says.
   *
   * A frozen runner gets their thaw on the refill meter, which is exactly what
   * that meter is: a bar that fills while you stand somewhere and empties when
   * you leave. It is somebody else standing there this time.
   */
  selfHud(actorId: number): ModeSelfHud {
    const runner = this.runners.get(actorId);
    return {
      charge: null,
      wetness: runner?.frozen === true ? 1 : null,
      ammo: null,
      refill: runner?.frozen === true ? runner.thaw : null,
    };
  }

  /** Frozen is a full stop, and it is the only thing in this mode that is. */
  speedScaleFor(actorId: number): number {
    return this.runners.get(actorId)?.frozen === true ? 0 : 1;
  }

  /** So the renderer can wash out a kid who is out of the game for now. */
  wetnessOf(botId: number): number {
    return this.runners.get(botId)?.frozen === true ? 1 : 0;
  }

  summary(): ModeSummary {
    const running = this.runningCount();
    return {
      headline: this.won ? 'All of them, at once!' : 'They lasted it out.',
      lines: [
        { label: 'Still running', value: `${running}` },
        { label: 'Round lasted', value: `${Math.round(this.elapsed)}s` },
        { label: 'Longest run', value: `${Math.round(this.longestRun())}s` },
      ],
    };
  }

  private runningCount(): number {
    let n = 0;
    for (const runner of this.runners.values()) if (!runner.frozen) n++;
    return n;
  }

  private longestRun(): number {
    let best = 0;
    for (const runner of this.runners.values()) best = Math.max(best, runner.survived);
    return best;
  }

  /** True while this actor is frozen. Read by tests and by the scenario. */
  isFrozen(actorId: number): boolean {
    return this.runners.get(actorId)?.frozen === true;
  }

  /** True while this actor is the one doing the chasing. */
  isIt(actorId: number): boolean {
    return this.its.has(actorId);
  }

  /**
   * Put somebody else on the chasing side.
   *
   * Nothing calls this yet. It exists because the version of this mode with
   * more than one It is a real one — five kids and a single chaser across
   * eighty metres of street is a long round — and the state it would need is
   * already a set rather than a field, so the day that happens is a scheduling
   * change and not a rewrite.
   */
  makeIt(actorId: number): void {
    this.its.add(actorId);
    this.runners.delete(actorId);
  }
}
