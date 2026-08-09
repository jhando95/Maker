/**
 * The Floor Is Lava.
 *
 * The lawn is out of bounds. Get round the course — the treehouse, the rain
 * barrel, home to the deck — without standing on the grass.
 *
 * ## Why this mode exists
 *
 * The game is called Maker. Its premise, in the first line of its own README,
 * is party modes played *inside the things you build*. And in all four modes it
 * had, building is a support activity: a wall that buys you a second in Water
 * War, a fort to defend, a ladder onto a roof you could have walked round to.
 * Take the build system out of Capture the Flag and you still have Capture the
 * Flag. **No mode was about building**, which is a strange thing to be able to
 * say about this game.
 *
 * This one cannot be played without it. There is no fighting in it, no ammo and
 * nothing to defend; the only verb is getting somewhere, and the only way to
 * get anywhere is to make a floor. A player who has never understood why they
 * would want a ramp finds out in the first thirty seconds.
 *
 * ## What it costs to build, which is almost nothing
 *
 * The route is made entirely of things the yard has had since the day it was
 * modelled. The back deck, the crate leaned against it, the treehouse with
 * rungs nailed up its trunk, the rain barrel with a lid, the divider fence, the
 * hedges, the parked car, the porch roof. Four modes have treated all of that
 * as scenery and the lawn as the floor. Declaring the grass out of bounds
 * inverts it, and the garden becomes a level without a single new prop being
 * modelled — which is the most that has ever been got out of `neighborhood.ts`
 * for the least.
 *
 * The one genuinely new thing is the rule, and it is one raycast:
 * `collisionWorld` already distinguishes the implicit ground plane from every
 * placed part, so "am I standing on the lawn" is a question it can already
 * answer exactly, with nothing approximated. See `lavaRules.onLava`.
 *
 * ## No bots, and why not
 *
 * This is the first mode with nobody else in it when you play alone, and that
 * is a limit stated rather than hidden: a bot cannot build. `Bot` is a nav
 * field and a steering behaviour, and the whole content of this mode is
 * choosing where to put a plank — a bot dropped into it would stand on the deck
 * for five minutes. So solo is a time trial against a par, and the mode is at
 * its best with other people in the yard, which is what the project is for.
 */

import {
  LOCAL_ACTOR_ID, type Actor,
} from './actor.ts';
import type {
  GameMode, ModeContext, ModeHud, ModeInput, ModeSelfHud, ModeSummary, Marker,
} from './gameMode.ts';
import { Lumber } from '../build/lumber.ts';
import { HOUSE, TREEHOUSE, WATER_SOURCES } from '../world/neighborhood.ts';
import type { Bot } from './bot.ts';
import {
  ROUND_TIME, REFILL_AMOUNT, REFILL_INTERVAL, STARTING_LUMBER,
  leaders, onLava, parTime, progressOf, sink, touching, type Checkpoint,
} from './lavaRules.ts';

/**
 * The three landmarks the course is hung on, read off `neighborhood.ts` rather
 * than typed in again — so a map that moves its deck moves the course with it.
 */
const DECK = { x: 1.0, y: 0.68, z: HOUSE.halfDepth + 1.4 } as const;
const BARREL = WATER_SOURCES.find((w) => w.key === 'butt')!;
const PORCH_ROOF = { x: 0, y: HOUSE.porchRoof + 0.13, z: -(HOUSE.halfDepth + 1.7) } as const;

/**
 * The course.
 *
 * Three touchpoints and every one of them a thing that was already there. The
 * order is the design: west to the treehouse, the whole width of the garden
 * east to the barrel, then back past the house and up onto the porch roof out
 * front. About sixty-six metres of it, none of which you may walk.
 *
 * The middle leg is what makes it a *building* game rather than a climbing one.
 * A player whose crossing to the treehouse is a ladder up and a jump down has
 * to solve the same lawn again going the other way; a player who built a bridge
 * walks back across it. Nothing in the mode says that out loud, and everybody
 * works it out on the second leg.
 *
 * **The finish is deliberately not the start.** It was the deck for one draft,
 * and being sent back to the deck for touching the grass would have *awarded*
 * the last checkpoint — falling in the lava would have won you the round. The
 * porch roof is on the other side of the house, which fixes it by being a
 * different place rather than by a rule about respawning, and it is a better
 * finish anyway: you end up on a roof looking out at the street.
 */
export const COURSE: readonly Checkpoint[] = [
  { name: 'the treehouse', x: TREEHOUSE.x, y: TREEHOUSE.deck + 0.2, z: TREEHOUSE.z },
  { name: 'the rain barrel', x: BARREL.x, y: 2.1, z: BARREL.z },
  { name: 'the porch roof', x: PORCH_ROOF.x, y: PORCH_ROOF.y, z: PORCH_ROOF.z },
];

/**
 * Where you start, and where the lawn sends you back to.
 *
 * The west end of the deck rather than the middle of it, because the divider
 * fence runs down x = 0 and straight through the boards. Spawning east of it
 * puts a 1.7-metre picket fence in the first leg, which is the wrong obstacle
 * at the wrong time — the opening crossing should be nothing but open grass and
 * the treehouse, so the mode's one idea lands before anything complicates it.
 * The fence turns up on the second leg instead, where it is a good problem.
 */
export const LAVA_SPAWN = { x: -1.6, y: DECK.y + 0.15, z: DECK.z } as const;

/**
 * How far the feet-ray looks, and from how far above the feet it starts.
 *
 * Above rather than at, because a ray cast from exactly the surface it is
 * testing is a coin flip: the origin sits on the plane and whether it reports a
 * hit at t=0 depends on the sign of a float. Ten centimetres up and forty down
 * puts the answer in the middle of the range for anything you can stand on,
 * including a plank laid flat on the grass — which is the first move every
 * player makes and had better work.
 */
const FOOT_RAY_UP = 0.1;
const FOOT_RAY_DOWN = 0.4;

const CHECK_COLOR = 0xffb43c;
const DONE_COLOR = 0x6ec6ff;

/** One player's run. */
interface Runner {
  /** Checkpoints already touched, so the next one is `COURSE[cleared]`. */
  cleared: number;
  /** 0 dry, 1 gone under. */
  depth: number;
  /** Never goes down: see `progressOf`. */
  progress: number;
  /** How many times the lawn has had them. Shown at the end, and it stings. */
  dunks: number;
  /** Seconds from the off to their last checkpoint, or null while running. */
  finishedAt: number | null;
}

export class LavaMode implements GameMode {
  readonly id = 'lava';
  readonly name = 'The Floor Is Lava';

  finished = false;
  won = false;

  /** Nobody to fight, so nobody to spawn. See the header. */
  readonly bots: readonly Bot[] = [];
  readonly buildingAllowed = true;
  readonly playerSpeedScale = 1;
  readonly lumber = new Lumber(STARTING_LUMBER);

  private timer = ROUND_TIME;
  private elapsed = 0;
  private refillTimer = REFILL_INTERVAL;
  private message: string | null = null;
  private messageTimer = 0;

  private readonly runners = new Map<number, Runner>();
  private currentActors: readonly Actor[] = [];
  private readonly pins: Marker[] = [];

  /** Reused so the per-tick roster walk allocates nothing. */
  private readonly scratchIds: number[] = [];

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  start(ctx: ModeContext): void {
    this.finished = false;
    this.won = false;
    this.timer = ROUND_TIME;
    this.elapsed = 0;
    this.refillTimer = REFILL_INTERVAL;
    this.runners.clear();
    this.lumber.set(STARTING_LUMBER);

    ctx.player.teleport(LAVA_SPAWN.x, LAVA_SPAWN.y, LAVA_SPAWN.z);
    this.setMessage('The grass is lava. Get to the treehouse.', 7);
    ctx.emit({ type: 'phaseChange', phase: 'lava' });
  }

  end(): void {
    this.runners.clear();
  }

  fixedUpdate(dt: number, ctx: ModeContext, _input: ModeInput): void {
    ctx.actors.refresh(this.bots);
    this.currentActors = ctx.actors.all;
    if (this.finished) return;

    this.messageTimer -= dt;
    if (this.messageTimer <= 0) this.message = null;

    this.elapsed += dt;
    this.timer -= dt;

    // Wood arrives on a clock rather than on a condition, because every
    // condition worth using is one a stuck player cannot meet. Somebody
    // stranded on a crate with no planks has exactly one way out of it and it
    // is waiting, which is a bad minute but is not a dead end.
    this.refillTimer -= dt;
    if (this.refillTimer <= 0) {
      this.refillTimer += REFILL_INTERVAL;
      // Capped at the opening pile, so five minutes of standing still is not a
      // strategy — the delivery is a way out of being stranded, not a bank.
      this.lumber.deliver(REFILL_AMOUNT, STARTING_LUMBER);
    }

    for (const who of this.currentActors) {
      this.stepRunner(dt, ctx, who);
    }

    if (this.timer <= 0) this.callIt(ctx);
  }

  // ── One person's run ────────────────────────────────────────────────────────

  private stepRunner(dt: number, ctx: ModeContext, who: Actor): void {
    let run = this.runners.get(who.id);
    if (run === undefined) {
      run = { cleared: 0, depth: 0, progress: 0, dunks: 0, finishedAt: null };
      this.runners.set(who.id, run);
    }
    if (run.finishedAt !== null) return;

    const body = who.controller;

    // ── The rule ──────────────────────────────────────────────────────────────
    const airborne = body.onGround === false;
    const hit = ctx.world.raycast(
      body.x, body.y + FOOT_RAY_UP, body.z,
      0, -1, 0,
      FOOT_RAY_UP + FOOT_RAY_DOWN,
    );
    const standingOnLava = onLava(hit?.isGround === true, airborne);
    const wasUnder = run.depth >= 1;
    run.depth = sink(run.depth, dt, standingOnLava);
    if (run.depth >= 1 && !wasUnder) this.dunk(ctx, who, run);

    // ── The course ────────────────────────────────────────────────────────────
    const next = COURSE[run.cleared];
    if (next !== undefined && touching(body.x, body.y, body.z, next)) {
      run.cleared++;
      run.progress = Math.max(run.progress, run.cleared);
      if (run.cleared >= COURSE.length) this.completeRun(ctx, who, run);
      else if (who.id === LOCAL_ACTOR_ID) {
        this.setMessage(`${capitalise(next.name)}. Now ${COURSE[run.cleared]!.name}.`, 4);
      }
      return;
    }

    if (next !== undefined) {
      const from = run.cleared === 0 ? LAVA_SPAWN : COURSE[run.cleared - 1]!;
      const leg = Math.hypot(next.x - from.x, next.y - from.y, next.z - from.z);
      const left = Math.hypot(body.x - next.x, body.y - next.y, body.z - next.z);
      run.progress = Math.max(run.progress, progressOf(run.cleared, left, leg));
    }
  }

  /**
   * The lawn got them.
   *
   * Back to the start rather than to the last checkpoint, and that is the
   * mode's one piece of real severity. A respawn at the last checkpoint makes
   * every leg independent and the whole thing a series of short puzzles; going
   * back to the deck means the route you built *is* your progress, and the
   * player who spent their first minute making the crossing repeatable is
   * rewarded for it every single time somebody slips. That is the lesson the
   * mode is for.
   *
   * Checkpoints already touched are kept. Losing those as well is a punishment
   * for a mistake you have already paid for in time, and time is what this is
   * scored on.
   */
  private dunk(ctx: ModeContext, who: Actor, run: Runner): void {
    run.dunks++;
    run.depth = 0;
    who.controller.teleport(LAVA_SPAWN.x, LAVA_SPAWN.y, LAVA_SPAWN.z);
    ctx.emit({
      type: 'splash', x: who.controller.x, y: who.controller.y + 0.2, z: who.controller.z,
    });
    if (who.id === LOCAL_ACTOR_ID) {
      this.setMessage('The grass got you. Back to the deck.', 3);
      ctx.emit({ type: 'playerSoaked' });
    }
  }

  private completeRun(ctx: ModeContext, who: Actor, run: Runner): void {
    run.finishedAt = this.elapsed;
    run.progress = COURSE.length;
    const first = this.finishers() === 1;
    if (who.id === LOCAL_ACTOR_ID) {
      this.finished = true;
      this.won = true;
      ctx.emit({ type: 'roundWon' });
    } else if (first) {
      // Somebody else got round first. The round ends for everybody, because a
      // race whose loser keeps running is a race nobody is watching.
      this.finished = true;
      this.won = false;
      ctx.emit({ type: 'roundLost' });
    }
    this.setMessage(
      who.id === LOCAL_ACTOR_ID ? 'On the roof, and never touched the grass.' : 'Somebody got up there first.',
      6,
    );
  }

  /** The clock ran out: furthest round the course takes it. */
  private callIt(ctx: ModeContext): void {
    this.finished = true;
    const ids = this.scratchIds;
    ids.length = 0;
    const standings = new Map<number, number>();
    for (const [id, run] of this.runners) standings.set(id, run.progress);
    const front = leaders(standings);
    this.won = front.includes(LOCAL_ACTOR_ID);
    ctx.emit({ type: this.won ? 'roundWon' : 'roundLost' });
  }

  private finishers(): number {
    let n = 0;
    for (const run of this.runners.values()) if (run.finishedAt !== null) n++;
    return n;
  }

  private setMessage(text: string, seconds: number): void {
    this.message = text;
    this.messageTimer = seconds;
  }

  // ── What the screen says ────────────────────────────────────────────────────

  hud(): ModeHud {
    const run = this.runners.get(LOCAL_ACTOR_ID);
    const cleared = run?.cleared ?? 0;
    const next = COURSE[cleared];
    return {
      phase: 'LAVA',
      timer: Math.max(0, this.timer),
      primary: {
        label: next === undefined ? 'Done' : 'Next',
        value: next === undefined ? 'done' : capitalise(next.name),
      },
      secondary: { label: 'Touched grass', value: `${run?.dunks ?? 0}` },
      message: this.message,
      lumber: this.lumber.unlimited ? null : this.lumber.available,
      ...this.selfHud(LOCAL_ACTOR_ID),
    };
  }

  /**
   * Sinking rides the wetness bar.
   *
   * That bar already means "how close are you to being out of this", which is
   * exactly what this is; a second meter with the same job in a different place
   * would be one more thing for a player to learn for no gain. The mode has no
   * tank and nothing to charge, so the other three fields are honestly empty.
   */
  selfHud(actorId: number): ModeSelfHud {
    const run = this.runners.get(actorId);
    return {
      charge: null,
      wetness: run !== undefined && run.depth > 0 ? run.depth : null,
      ammo: null,
      refill: null,
    };
  }

  markers(): readonly Marker[] {
    this.pins.length = 0;
    const run = this.runners.get(LOCAL_ACTOR_ID);
    const cleared = run?.cleared ?? 0;
    for (let i = 0; i < COURSE.length; i++) {
      const at = COURSE[i]!;
      // Everything ahead of you is pinned, not just the next one: a course you
      // can only see one step of is a corridor, and the whole game is choosing
      // a line. Seeing that the barrel is the far side of the garden is what
      // makes somebody build a bridge instead of a ladder.
      this.pins.push({
        kind: 'flag',
        x: at.x, y: at.y + 1.2, z: at.z,
        color: i < cleared ? DONE_COLOR : CHECK_COLOR,
        active: i === cleared,
        faded: i < cleared,
      });
    }
    return this.pins;
  }

  summary(): ModeSummary {
    const run = this.runners.get(LOCAL_ACTOR_ID);
    const time = run?.finishedAt ?? this.elapsed;
    const par = parTime(COURSE.length);
    return {
      headline: this.won
        ? run !== undefined && run.finishedAt !== null
          ? 'Round the whole garden, feet dry.'
          : 'Furthest round when the clock went.'
        : 'The grass won.',
      lines: [
        { label: 'Time', value: `${Math.round(time)}s` },
        { label: 'Par', value: `${par}s` },
        { label: 'Checkpoints', value: `${run?.cleared ?? 0} / ${COURSE.length}` },
        { label: 'Touched grass', value: `${run?.dunks ?? 0}` },
      ],
    };
  }

  // ── For tests and the debug surface ─────────────────────────────────────────

  /** How far round somebody is, in checkpoints-and-a-fraction. */
  progressFor(actorId: number): number {
    return this.runners.get(actorId)?.progress ?? 0;
  }

  /** How many checkpoints somebody has touched. */
  clearedFor(actorId: number): number {
    return this.runners.get(actorId)?.cleared ?? 0;
  }

  /** How close somebody is to going under, 0..1. */
  depthFor(actorId: number): number {
    return this.runners.get(actorId)?.depth ?? 0;
  }

  dunksFor(actorId: number): number {
    return this.runners.get(actorId)?.dunks ?? 0;
  }
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
