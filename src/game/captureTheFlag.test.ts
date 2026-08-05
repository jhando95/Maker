import { describe, it, expect, beforeEach } from 'vitest';
import { CollisionWorld } from '../physics/collisionWorld.ts';
import { PartRenderer } from '../render/partRenderer.ts';
import { BuildSystem } from '../build/buildSystem.ts';
import { CharacterController } from '../player/controller.ts';
import { CameraRig } from '../player/cameraRig.ts';
import { ProjectileSystem } from './projectiles.ts';
import {
  CaptureTheFlagMode, FIRST_SETUP_TIME, SETUP_TIME, CAPTURES_TO_WIN,
  FLAG_RETURN_TIME, PLAYER_AMMO_MAX, ENEMY_COUNT, ALLY_COUNT, BOT_RESPAWN_TIME,
} from './captureTheFlag.ts';
import type { GameEvent, ModeContext, ModeInput } from './gameMode.ts';
import { Rng } from '../core/rng.ts';
import { ActorRoster, LOCAL_ACTOR_ID } from './actor.ts';
import { DT } from '../physics/constants.ts';
import { LEFT_FLAG, RIGHT_FLAG, LEFT_SPAWN } from '../world/neighborhood.ts';

const noInput: ModeInput = { fire: false, firePressed: false, fireReleased: false };

function makeContext(): { ctx: ModeContext; events: GameEvent[]; world: CollisionWorld } {
  // A bare world: the real map's fixtures would make bots walk real routes,
  // which is what the map's own tests are for. Here the rules are the subject.
  const world = new CollisionWorld();
  const build = new BuildSystem(world, new PartRenderer());
  const player = new CharacterController(world, LEFT_SPAWN.x, 0.5, LEFT_SPAWN.z);
  const camera = new CameraRig(world, 1.6);
  const projectiles = new ProjectileSystem(world);
  const events: GameEvent[] = [];
  return {
    world,
    events,
    ctx: {
      world, build, player, camera, projectiles,
      actors: new ActorRoster({ id: LOCAL_ACTOR_ID, kind: 'local', team: 'left', controller: player }),
      rng: new Rng('ctf-test'),
      emit: (e) => events.push(e),
      worldChanged: () => {},
    },
  };
}

function run(mode: CaptureTheFlagMode, ctx: ModeContext, seconds: number, input = noInput): void {
  for (let i = 0; i < Math.round(seconds / DT); i++) mode.fixedUpdate(DT, ctx, input);
}

/** Put the player on a spot without going through the character controller. */
function stand(ctx: ModeContext, x: number, z: number): void {
  ctx.player.teleport(x, 0.5, z);
}

describe('CaptureTheFlagMode', () => {
  let mode: CaptureTheFlagMode;
  let ctx: ModeContext;
  let events: GameEvent[];

  beforeEach(() => {
    const made = makeContext();
    ctx = made.ctx;
    events = made.events;
    mode = new CaptureTheFlagMode();
    mode.start(ctx);
  });

  describe('phases', () => {
    it('opens in setup with both flags home', () => {
      expect(mode.phase).toBe('setup');
      expect(mode.flags.left.status).toBe('home');
      expect(mode.flags.right.status).toBe('home');
      expect(mode.buildingAllowed).toBe(true);
    });

    it('lets you build during setup and not during capture', () => {
      expect(mode.buildingAllowed).toBe(true);
      run(mode, ctx, FIRST_SETUP_TIME + 0.2);
      expect(mode.phase).toBe('capture');
      expect(mode.buildingAllowed).toBe(false);
    });

    it('spawns both sides when capture begins', () => {
      expect(mode.bots.length).toBe(0);
      run(mode, ctx, FIRST_SETUP_TIME + 0.2);
      expect(mode.bots.filter((b) => b.team === 'right').length).toBe(ENEMY_COUNT);
      expect(mode.bots.filter((b) => b.team === 'left').length).toBe(ALLY_COUNT);
    });

    it('leaves you outnumbered, so there is still something to do', () => {
      // Allies exist to make it a team game, not to play it for you. Parity
      // would mean the round resolving itself while you watch.
      run(mode, ctx, FIRST_SETUP_TIME + 0.2);
      expect(ENEMY_COUNT).toBeGreaterThan(ALLY_COUNT + 1);
    });

    it('gives a longer first setup than the ones after it', () => {
      // The first one is also when you learn the map.
      expect(FIRST_SETUP_TIME).toBeGreaterThan(SETUP_TIME);
    });

    it('announces every phase change', () => {
      run(mode, ctx, FIRST_SETUP_TIME + 0.2);
      const phases = events.filter((e) => e.type === 'phaseChange');
      expect(phases.length).toBe(2);
    });
  });

  describe('carrying a flag', () => {
    beforeEach(() => run(mode, ctx, FIRST_SETUP_TIME + 0.2));

    it('picks up the enemy flag by standing on it', () => {
      stand(ctx, RIGHT_FLAG.x, RIGHT_FLAG.z);
      run(mode, ctx, DT * 2);
      expect(mode.flags.right.status).toBe('carried');
      expect(mode.playerHasFlag).toBe(true);
      expect(events.some((e) => e.type === 'flagTaken' && e.byPlayer)).toBe(true);
    });

    it('does not pick up its own flag', () => {
      stand(ctx, LEFT_FLAG.x, LEFT_FLAG.z);
      run(mode, ctx, DT * 4);
      expect(mode.flags.left.status).toBe('home');
    });

    it('the flag follows the carrier', () => {
      stand(ctx, RIGHT_FLAG.x, RIGHT_FLAG.z);
      run(mode, ctx, DT * 2);
      stand(ctx, 4, 9);
      run(mode, ctx, DT * 2);
      expect(mode.flags.right.x).toBeCloseTo(4, 3);
      expect(mode.flags.right.z).toBeCloseTo(9, 3);
    });

    it('scores when the enemy flag reaches your stand', () => {
      stand(ctx, RIGHT_FLAG.x, RIGHT_FLAG.z);
      run(mode, ctx, DT * 2);
      stand(ctx, LEFT_FLAG.x, LEFT_FLAG.z);
      run(mode, ctx, DT * 2);

      expect(mode.scoreLeft).toBe(1);
      expect(events.some((e) => e.type === 'captured' && e.byPlayer)).toBe(true);
      // A capture ends the round and hands back a build phase.
      expect(mode.phase).toBe('setup');
      expect(mode.flags.right.status).toBe('home');
    });

    it('cannot score while your own flag is away from home', () => {
      // The rule that stops two teams swapping flags forever and neither ever
      // scoring, which is how a first-pass CTF turns out not to be a game.
      stand(ctx, RIGHT_FLAG.x, RIGHT_FLAG.z);
      run(mode, ctx, DT * 2);
      expect(mode.playerHasFlag).toBe(true);

      // A bot takes yours.
      const bot = mode.bots[0]!;
      bot.controller.teleport(LEFT_FLAG.x, 0.5, LEFT_FLAG.z);
      run(mode, ctx, DT * 2);
      expect(mode.flags.left.status).toBe('carried');

      stand(ctx, LEFT_FLAG.x, LEFT_FLAG.z);
      run(mode, ctx, DT * 4);
      expect(mode.scoreLeft).toBe(0);
      expect(mode.phase).toBe('capture');
    });
  });

  describe('losing a flag', () => {
    beforeEach(() => run(mode, ctx, FIRST_SETUP_TIME + 0.2));

    it('a dropped flag goes home by itself after a while', () => {
      const flag = mode.flags.left;
      const bot = mode.bots[0]!;
      bot.controller.teleport(LEFT_FLAG.x, 0.5, LEFT_FLAG.z);
      run(mode, ctx, DT * 2);
      expect(flag.status).toBe('carried');

      // Soaking the carrier is what drops it; do it directly. The rest of the
      // team goes down too, or one of them walks over and takes it again
      // mid-test — which is correct behaviour and makes the timer unmeasurable.
      for (const b of mode.bots) while (!b.soak()) { /* down */ }
      run(mode, ctx, DT * 2);
      expect(flag.status).toBe('dropped');

      run(mode, ctx, FLAG_RETURN_TIME - 1);
      expect(flag.status, 'returned early').toBe('dropped');

      run(mode, ctx, 1.5);
      expect(flag.status).toBe('home');
      expect(flag.x).toBeCloseTo(LEFT_FLAG.x, 6);
      expect(events.some((e) => e.type === 'flagReturned')).toBe(true);
    });

    it('touching your own dropped flag sends it home immediately', () => {
      const flag = mode.flags.left;
      const bot = mode.bots[0]!;
      bot.controller.teleport(LEFT_FLAG.x + 6, 0.5, LEFT_FLAG.z);
      flag.status = 'carried';
      flag.carrier = bot.id;
      run(mode, ctx, DT * 2);
      while (!bot.soak()) { /* down it goes */ }
      run(mode, ctx, DT * 2);
      expect(flag.status).toBe('dropped');

      stand(ctx, flag.x, flag.z);
      run(mode, ctx, DT * 2);
      expect(flag.status).toBe('home');
    });

    it('a carrier that stops existing drops what it had', () => {
      const flag = mode.flags.left;
      flag.status = 'carried';
      flag.carrier = 9999;
      run(mode, ctx, DT * 2);
      expect(flag.status).toBe('dropped');
    });
  });

  describe('being soaked', () => {
    beforeEach(() => run(mode, ctx, FIRST_SETUP_TIME + 0.2));

    it('sends the player home and drops the flag', () => {
      stand(ctx, RIGHT_FLAG.x, RIGHT_FLAG.z);
      run(mode, ctx, DT * 2);
      expect(mode.playerHasFlag).toBe(true);

      // A balloon straight down onto the player's head.
      ctx.projectiles.spawn(ctx.player.x, ctx.player.y + 4, ctx.player.z, 0, -1, 0, 14, 1);
      run(mode, ctx, 0.8);

      expect(mode.playerHasFlag).toBe(false);
      expect(mode.flags.right.status).toBe('dropped');
      expect(ctx.player.x).toBeCloseTo(LEFT_SPAWN.x, 3);
      expect(mode.playerSpeedScale).toBeLessThan(1);
      expect(events.some((e) => e.type === 'playerSoaked')).toBe(true);
    });

    it('the drop happens where you fell, not at your spawn', () => {
      // Otherwise a defender gets no reward for stopping a run at the fence.
      stand(ctx, RIGHT_FLAG.x, RIGHT_FLAG.z);
      run(mode, ctx, DT * 2);
      stand(ctx, 6, 3);
      run(mode, ctx, DT * 2);

      ctx.projectiles.spawn(6, 5, 3, 0, -1, 0, 14, 1);
      run(mode, ctx, 0.8);
      expect(Math.hypot(mode.flags.right.x - 6, mode.flags.right.z - 3)).toBeLessThan(2);
    });

    it('speed comes back after the penalty', () => {
      ctx.projectiles.spawn(ctx.player.x, ctx.player.y + 4, ctx.player.z, 0, -1, 0, 14, 1);
      run(mode, ctx, 0.8);
      expect(mode.playerSpeedScale).toBeLessThan(1);
      run(mode, ctx, 3);
      expect(mode.playerSpeedScale).toBe(1);
    });
  });

  describe('the enemy team', () => {
    beforeEach(() => run(mode, ctx, FIRST_SETUP_TIME + 0.2));

    it('sends some at your flag and keeps some on theirs', () => {
      // One role is not enough: all runners is a tower defence, all guards is a
      // foot race. Both goals should be represented on the first tick.
      run(mode, ctx, DT * 2);
      const goals = mode.bots.map((b) => Math.sign(b.targetX));
      expect(goals).toContain(Math.sign(LEFT_FLAG.x));
      expect(goals).toContain(Math.sign(RIGHT_FLAG.x));
    });

    it('presses harder when behind and sits back when ahead', () => {
      const guardsAt = (left: number, right: number) => {
        const m = new CaptureTheFlagMode();
        const made = makeContext();
        m.start(made.ctx);
        m.scoreLeft = left;
        m.scoreRight = right;
        run(m, made.ctx, FIRST_SETUP_TIME + 0.2);
        run(m, made.ctx, DT * 2);
        return m.bots.filter((b) => Math.sign(b.targetX) === Math.sign(RIGHT_FLAG.x)).length;
      };
      // Behind on captures, more of them come at you.
      expect(guardsAt(2, 0)).toBeLessThan(guardsAt(0, 2));
    });

    it('a bot carrying your flag heads for its own base', () => {
      const bot = mode.bots[0]!;
      bot.controller.teleport(LEFT_FLAG.x, 0.5, LEFT_FLAG.z);
      run(mode, ctx, DT * 2);
      expect(mode.flags.left.carrier).toBe(bot.id);
      run(mode, ctx, DT * 2);
      expect(bot.targetX).toBeCloseTo(RIGHT_FLAG.x, 6);
    });

    it('scores for them when their carrier gets home', () => {
      const bot = mode.bots[0]!;
      bot.controller.teleport(LEFT_FLAG.x, 0.5, LEFT_FLAG.z);
      run(mode, ctx, DT * 2);
      bot.controller.teleport(RIGHT_FLAG.x, 0.5, RIGHT_FLAG.z);
      run(mode, ctx, DT * 2);
      expect(mode.scoreRight).toBe(1);
      expect(events.some((e) => e.type === 'captured' && !e.byPlayer)).toBe(true);
    });
  });

  describe('your side', () => {
    beforeEach(() => run(mode, ctx, FIRST_SETUP_TIME + 0.2));

    const ally = () => mode.bots.find((b) => b.team === 'left')!;

    it('takes their flag, not its own', () => {
      // The rule used to be written from the player's point of view — "is this
      // the flag PLAYER_TEAM owns" — which is the right question for exactly one
      // of the two sides. A teammate reading it got to steal its own flag.
      const mate = ally();
      mate.controller.teleport(LEFT_FLAG.x, 0.5, LEFT_FLAG.z);
      run(mode, ctx, DT * 2);
      expect(mode.flags.left.status).toBe('home');

      mate.controller.teleport(RIGHT_FLAG.x, 0.5, RIGHT_FLAG.z);
      run(mode, ctx, DT * 2);
      expect(mode.flags.right.carrier).toBe(mate.id);
    });

    it('scores for you when it gets their flag home', () => {
      // The point of having a side. Keyed off the carrier's team rather than
      // off whether the carrier was the player, or a teammate could run the
      // flag onto your stand and nothing at all would happen.
      const mate = ally();
      mate.controller.teleport(RIGHT_FLAG.x, 0.5, RIGHT_FLAG.z);
      run(mode, ctx, DT * 2);
      mate.controller.teleport(LEFT_FLAG.x, 0.5, LEFT_FLAG.z);
      run(mode, ctx, DT * 2);
      expect(mode.scoreLeft).toBe(1);
      expect(events.some((e) => e.type === 'captured' && e.byPlayer)).toBe(true);
    });

    it('sends your own dropped flag home when it walks over it', () => {
      const enemy = mode.bots.find((b) => b.team === 'right')!;
      enemy.controller.teleport(LEFT_FLAG.x, 0.5, LEFT_FLAG.z);
      run(mode, ctx, DT * 2);
      expect(mode.flags.left.status).toBe('carried');

      // Enemy goes down mid-field; the flag lies where it fell.
      enemy.controller.teleport(0, 0.5, 8);
      run(mode, ctx, DT * 2);
      while (!enemy.soak()) { /* down */ }
      run(mode, ctx, DT * 4);
      expect(mode.flags.left.status).toBe('dropped');

      const mate = ally();
      mate.controller.teleport(mode.flags.left.x, 0.5, mode.flags.left.z);
      run(mode, ctx, DT * 2);
      expect(mode.flags.left.status).toBe('home');
    });

    it('cannot soak you, because being knocked out by your own team is not a mechanic', () => {
      const mate = ally();
      mate.controller.teleport(ctx.player.x + 0.5, 0.5, ctx.player.z);
      // A balloon of theirs landing right on top of the two of you.
      ctx.projectiles.spawn(ctx.player.x, ctx.player.y + 4, ctx.player.z, 0, -1, 0, 14, mate.id);
      run(mode, ctx, DT * 30);
      expect(events.some((e) => e.type === 'playerSoaked')).toBe(false);
    });

    it('is still hittable by the other side', () => {
      // The friendly-fire rule has to be about sides, not about being a bot: if
      // it read "skip bots" the enemy could never be stopped either. Counted in
      // hits rather than waiting for a soak, because a normal-tier kid takes two
      // and the test would then be measuring toughness instead of the rule.
      const mate = ally();
      const enemy = mode.bots.find((b) => b.team === 'right')!;
      const before = mate.hits;
      ctx.projectiles.spawn(mate.x, mate.y + 4, mate.z, 0, -1, 0, 14, enemy.id);
      for (let i = 0; i < 40; i++) {
        mate.controller.teleport(mate.x, 0.5, mate.z);
        mode.fixedUpdate(DT, ctx, noInput);
      }
      expect(mate.hits).toBeGreaterThan(before);
    });

    it('is not hit by its own side either', () => {
      // The mirror of the rule above, from the bot's side rather than yours.
      const mate = ally();
      const other = mode.bots.filter((b) => b.team === 'left')[1] ?? mate;
      const before = mate.hits;
      ctx.projectiles.spawn(mate.x, mate.y + 4, mate.z, 0, -1, 0, 14, other.id);
      for (let i = 0; i < 40; i++) {
        mate.controller.teleport(mate.x, 0.5, mate.z);
        mode.fixedUpdate(DT, ctx, noInput);
      }
      expect(mate.hits).toBe(before);
    });

    it('replaces a soaked bot rather than thinning the field', () => {
      // Permanent deaths would make the second half of every round a walk.
      const enemies = () => mode.bots.filter((b) => b.alive && b.team === 'right').length;
      const bot = mode.bots.find((b) => b.team === 'right')!;
      while (!bot.soak()) { /* down */ }
      run(mode, ctx, DT * 2);
      expect(enemies()).toBe(ENEMY_COUNT - 1);

      run(mode, ctx, BOT_RESPAWN_TIME + 0.5);
      expect(enemies()).toBe(ENEMY_COUNT);
    });

    it('brings a soaked ally back on your side, not theirs', () => {
      // The replacement reads the side off the bot it is replacing. Reading it
      // after the splice, or not at all, quietly hands your teammate to them.
      const ally = mode.bots.find((b) => b.team === 'left')!;
      while (!ally.soak()) { /* down */ }
      run(mode, ctx, BOT_RESPAWN_TIME + 0.5);
      expect(mode.bots.filter((b) => b.alive && b.team === 'left').length).toBe(ALLY_COUNT);
    });
  });

  describe('winning', () => {
    beforeEach(() => run(mode, ctx, FIRST_SETUP_TIME + 0.2));

    const capture = () => {
      stand(ctx, RIGHT_FLAG.x, RIGHT_FLAG.z);
      run(mode, ctx, DT * 2);
      stand(ctx, LEFT_FLAG.x, LEFT_FLAG.z);
      run(mode, ctx, DT * 2);
      if (mode.phase === 'setup') run(mode, ctx, SETUP_TIME + 0.2);
    };

    it('ends after enough captures', () => {
      for (let i = 0; i < CAPTURES_TO_WIN; i++) capture();
      expect(mode.scoreLeft).toBe(CAPTURES_TO_WIN);
      expect(mode.finished).toBe(true);
      expect(mode.won).toBe(true);
      expect(events.some((e) => e.type === 'roundWon')).toBe(true);
    });

    it('counts the rounds up as it goes', () => {
      expect(mode.round).toBe(1);
      capture();
      expect(mode.round).toBe(2);
    });

    it('stops simulating once finished', () => {
      for (let i = 0; i < CAPTURES_TO_WIN; i++) capture();
      const before = mode.scoreLeft;
      run(mode, ctx, 5);
      expect(mode.scoreLeft).toBe(before);
    });

    it('reports a result the shell can show without knowing the rules', () => {
      for (let i = 0; i < CAPTURES_TO_WIN; i++) capture();
      const s = mode.summary();
      expect(s.headline.length).toBeGreaterThan(0);
      expect(s.lines.length).toBeGreaterThan(0);
      expect(s.lines.some((l) => l.value.includes(String(CAPTURES_TO_WIN)))).toBe(true);
    });
  });

  describe('ammo', () => {
    it('refills at your own flag stand', () => {
      run(mode, ctx, FIRST_SETUP_TIME + 0.2);
      stand(ctx, 6, 6);
      run(mode, ctx, DT);
      // Spend it.
      for (let i = 0; i < PLAYER_AMMO_MAX; i++) {
        mode.fixedUpdate(DT, ctx, { fire: true, firePressed: true, fireReleased: false });
        mode.fixedUpdate(DT, ctx, { fire: false, firePressed: false, fireReleased: true });
        run(mode, ctx, 0.5);
      }
      expect(mode.ammoCount).toBeLessThan(PLAYER_AMMO_MAX);

      stand(ctx, LEFT_FLAG.x, LEFT_FLAG.z);
      run(mode, ctx, DT * 2);
      expect(mode.ammoCount).toBe(PLAYER_AMMO_MAX);
    });
  });

  describe('published state', () => {
    it('draws a stand and a flag for each team', () => {
      const markers = mode.markers();
      expect(markers.filter((m) => m.kind === 'flag').length).toBe(2);
      expect(markers.filter((m) => m.kind === 'stash').length).toBe(2);
    });

    it('marks a carried flag active and an away flag faded', () => {
      run(mode, ctx, FIRST_SETUP_TIME + 0.2);
      stand(ctx, RIGHT_FLAG.x, RIGHT_FLAG.z);
      run(mode, ctx, DT * 2);
      const theirs = mode.markers().filter((m) => m.kind === 'flag')[1]!;
      expect(theirs.active).toBe(true);
      expect(theirs.faded).toBe(true);
    });

    it('the HUD reports a score and never a null phase', () => {
      const h = mode.hud();
      expect(h.phase.length).toBeGreaterThan(0);
      expect(h.primary).not.toBeNull();
      expect(h.primary!.value).toContain('0');
    });

    it('shows a countdown in setup and none in capture', () => {
      expect(mode.hud().timer).not.toBeNull();
      run(mode, ctx, FIRST_SETUP_TIME + 0.2);
      expect(mode.hud().timer).toBeNull();
    });

    it('hides the hotbar during capture by reporting ammo', () => {
      // The HUD swaps between building and fighting on this one field.
      expect(mode.hud().ammo).toBeNull();
      run(mode, ctx, FIRST_SETUP_TIME + 0.2);
      expect(mode.hud().ammo).not.toBeNull();
    });
  });

  describe('restarting', () => {
    it('start() clears everything a previous round left behind', () => {
      run(mode, ctx, FIRST_SETUP_TIME + 0.2);
      stand(ctx, RIGHT_FLAG.x, RIGHT_FLAG.z);
      run(mode, ctx, DT * 2);
      mode.scoreLeft = 2;

      mode.start(ctx);
      expect(mode.scoreLeft).toBe(0);
      expect(mode.scoreRight).toBe(0);
      expect(mode.round).toBe(1);
      expect(mode.phase).toBe('setup');
      expect(mode.bots.length).toBe(0);
      expect(mode.flags.right.status).toBe('home');
      expect(mode.flags.right.x).toBeCloseTo(RIGHT_FLAG.x, 6);
    });
  });
});
