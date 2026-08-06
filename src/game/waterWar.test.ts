import { describe, it, expect, beforeEach } from 'vitest';
import { CollisionWorld } from '../physics/collisionWorld.ts';
import { PartRenderer } from '../render/partRenderer.ts';
import { BuildSystem } from '../build/buildSystem.ts';
import { CharacterController } from '../player/controller.ts';
import { CameraRig } from '../player/cameraRig.ts';
import { ProjectileSystem } from './projectiles.ts';
import {
  WaterWarMode, BUILD_TIME, LULL_TIME, RAID_TIME, RAID_COUNT, SOURCE_MAX, DRAIN_RATE,
  KID_RESPAWN, RESPAWN_TANK,
} from './waterWar.ts';
import { TANK_MAX, SOURCE_RADIUS, WEAPONS } from './waterKit.ts';
import type { GameEvent, ModeContext, ModeInput } from './gameMode.ts';
import { Rng } from '../core/rng.ts';
import { ActorRoster, LOCAL_ACTOR_ID } from './actor.ts';
import { DT } from '../physics/constants.ts';
import { WATER_SOURCES, neighborhoodSlabs, installFixtures } from '../world/neighborhood.ts';

const noInput: ModeInput = { fire: false, firePressed: false, fireReleased: false };
const firing: ModeInput = { fire: true, firePressed: true, fireReleased: false };

function makeContext(): { ctx: ModeContext; events: GameEvent[]; world: CollisionWorld } {
  const world = new CollisionWorld();
  const build = new BuildSystem(world, new PartRenderer());
  const player = new CharacterController(world, 0, 0.5, 0);
  const camera = new CameraRig(world, 1.6);
  const projectiles = new ProjectileSystem(world);
  const events: GameEvent[] = [];
  return {
    world,
    events,
    ctx: {
      world, build, player, camera, projectiles,
      actors: new ActorRoster({ id: LOCAL_ACTOR_ID, kind: 'local', team: 'left', controller: player }),
      rng: new Rng('war-test'),
      emit: (e) => events.push(e),
      worldChanged: () => {},
    },
  };
}

function run(mode: WaterWarMode, ctx: ModeContext, seconds: number, input = noInput): void {
  for (let i = 0; i < Math.round(seconds / DT); i++) mode.fixedUpdate(DT, ctx, input);
}

/** Same, but stops early once the round is decided. */
function run2(mode: WaterWarMode, ctx: ModeContext, seconds: number): void {
  for (let i = 0; i < Math.round(seconds / DT) && !mode.finished; i++) {
    mode.fixedUpdate(DT, ctx, noInput);
  }
}

/** Park the player somewhere with nothing near it. */
function stand(ctx: ModeContext, x: number, z: number): void {
  ctx.player.teleport(x, 0.5, z);
}

const FAR_AWAY = { x: -22, z: -22 };

describe('WaterWarMode', () => {
  let mode: WaterWarMode;
  let ctx: ModeContext;
  let events: GameEvent[];

  beforeEach(() => {
    const made = makeContext();
    ctx = made.ctx;
    events = made.events;
    stand(ctx, FAR_AWAY.x, FAR_AWAY.z);
    mode = new WaterWarMode();
    mode.start(ctx);
  });

  describe('shape', () => {
    it('opens in a build phase with every source full', () => {
      expect(mode.phase).toBe('build');
      expect(mode.buildingAllowed).toBe(true);
      expect(mode.sources.length).toBe(WATER_SOURCES.length);
      for (const s of mode.sources) expect(s.water).toBe(SOURCE_MAX);
      expect(mode.waterFraction).toBe(1);
    });

    it('has more than one front, which is the whole premise', () => {
      // One source is Fort Defense with the stash renamed.
      expect(mode.sources.length).toBeGreaterThanOrEqual(3);
    });

    it('spreads the sources far enough apart that one player cannot cover them', () => {
      for (let i = 0; i < mode.sources.length; i++) {
        for (let j = i + 1; j < mode.sources.length; j++) {
          const a = mode.sources[i]!;
          const b = mode.sources[j]!;
          expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(SOURCE_RADIUS * 4);
        }
      }
    });

    it('raids start after the build phase and bring kids', () => {
      run(mode, ctx, BUILD_TIME + 0.2);
      expect(mode.phase).toBe('raid');
      expect(mode.bots.length).toBeGreaterThan(0);
      expect(mode.buildingAllowed).toBe(false);
    });

    it('soaking every kid does not end the raid, because they come back', () => {
      // The rule the mode is built on. Clearing the lawn is not a win state and
      // must not be treated as one: an earlier version ended the raid on "nobody
      // standing", a condition unlimited respawns meant was never reached, so
      // the round could not be won at all.
      run(mode, ctx, BUILD_TIME + 0.2);
      for (let i = 0; i < 3; i++) {
        for (const b of mode.bots) while (!b.soak()) { /* down */ }
        run(mode, ctx, KID_RESPAWN + 1);
      }
      expect(mode.phase).toBe('raid');
      expect(mode.bots.some((b) => b.alive)).toBe(true);
    });

    it('a raid ends on its own clock, and hands back a repair phase', () => {
      run(mode, ctx, BUILD_TIME + 0.2);
      run(mode, ctx, RAID_TIME - 1);
      expect(mode.phase).toBe('raid');
      run(mode, ctx, 2);
      expect(mode.phase).toBe('lull');
      expect(mode.bots.length).toBe(0);
      expect(mode.hud().timer).toBeGreaterThan(LULL_TIME - 3);
    });

    it('holding every raid wins the afternoon', () => {
      // Topping the taps up each tick so this tests the schedule rather than
      // the drain balance — losing on water is its own test.
      const total = BUILD_TIME + RAID_COUNT * RAID_TIME + (RAID_COUNT - 1) * LULL_TIME;
      for (let i = 0; i < Math.round((total + 2) / DT) && !mode.finished; i++) {
        for (const s of mode.sources) s.water = SOURCE_MAX;
        mode.fixedUpdate(DT, ctx, noInput);
      }
      expect(mode.finished).toBe(true);
      expect(mode.won).toBe(true);
      expect(events.some((e) => e.type === 'roundWon')).toBe(true);
    });

    it('an unopposed afternoon demands about twice the pool', () => {
      // The number that decides whether the mode is playable at all, and the
      // one nothing else measures. It is the fraction of draining the player
      // must stop: at 6x, which is where this started, no defence is enough and
      // the round is lost on a schedule. Near 2x, holding half the water is a
      // good afternoon and fortifying is what gets you there.
      //
      // Run on the real map, because walls and fences are exactly what change
      // how long the kids spend walking rather than draining.
      installFixtures(ctx.world, neighborhoodSlabs(new Rng('map')));
      const fresh = new WaterWarMode();
      fresh.start(ctx);

      let drained = 0;
      const total = BUILD_TIME + RAID_COUNT * RAID_TIME + (RAID_COUNT - 1) * LULL_TIME + 2;
      for (let i = 0; i < Math.round(total / DT) && !fresh.finished; i++) {
        fresh.fixedUpdate(DT, ctx, noInput);
        for (const s of fresh.sources) {
          drained += SOURCE_MAX - s.water;
          s.water = SOURCE_MAX;
        }
      }

      const ratio = drained / (SOURCE_MAX * fresh.sources.length);
      expect(ratio).toBeGreaterThan(1.6);
      expect(ratio).toBeLessThan(3);
    });

    it('walls alone turn a lost afternoon into a held one', () => {
      // The claim the whole game rests on: that what you build is worth
      // building. Measured rather than asserted, and measured with the player
      // doing nothing at all, so the difference is the walls and not skill.
      //
      // Same seed, same raids, same idle player — the only variable is whether
      // there is a fence round each tap.
      const run = (walled: boolean): number => {
        const made = makeContext();
        installFixtures(made.world, neighborhoodSlabs(new Rng('map')));
        if (walled) {
          for (const tap of WATER_SOURCES) {
            for (let course = 0; course < 7; course++) {
              for (let i = 0; i < 46; i++) {
                const a = (i / 46) * Math.PI * 2;
                made.ctx.build.applyPlaceIfClear({
                  kind: 0, colorway: 0,
                  x: tap.x + Math.sin(a) * 4.2,
                  y: 0.125 + course * 0.25,
                  z: tap.z + Math.cos(a) * 4.2,
                  qx: 0, qy: Math.sin(-a / 2), qz: 0, qw: Math.cos(-a / 2),
                });
              }
            }
          }
        }
        const fresh = new WaterWarMode();
        fresh.start(made.ctx);
        made.ctx.player.teleport(-22, 0.5, -22);
        run2(fresh, made.ctx, 420);
        return fresh.waterFraction;
      };

      const open = run(false);
      const walled = run(true);
      // Unfortified and unattended, the street drains everything.
      expect(open).toBeLessThan(0.02);
      // Fortified and still unattended, enough survives that the round is not
      // lost. Walls do not merely slow the bleeding, they change the outcome.
      expect(walled).toBeGreaterThan(0.1);
    });

    it('a passive player loses partway in, not on the first raid', () => {
      // Losing before the second raid means never seeing the mode; surviving to
      // the end while ignoring it means there is no mode. It should run out
      // somewhere in the middle, with the reason on screen the whole time.
      run(mode, ctx, BUILD_TIME + RAID_TIME + 1);
      expect(mode.finished).toBe(false);
      run(mode, ctx, LULL_TIME + RAID_TIME * (RAID_COUNT - 1) + LULL_TIME * (RAID_COUNT - 2));
      expect(mode.finished).toBe(true);
      expect(mode.won).toBe(false);
    });

    it('counts down the raid, so you can see how long you have to hold', () => {
      run(mode, ctx, BUILD_TIME + 5);
      const timer = mode.hud().timer;
      expect(timer).not.toBeNull();
      expect(timer!).toBeLessThan(RAID_TIME);
      expect(timer!).toBeGreaterThan(0);
    });
  });

  describe('the kids drain the water', () => {
    beforeEach(() => run(mode, ctx, BUILD_TIME + 0.2));

    it('a kid standing at a source drains it', () => {
      const source = mode.sources[0]!;
      const before = source.water;
      const bot = mode.bots[0]!;
      bot.controller.teleport(source.x, 0.5, source.z);
      // Keep it parked; the mode drains from position, not from bot state.
      for (let i = 0; i < 120; i++) {
        bot.controller.teleport(source.x, 0.5, source.z);
        mode.fixedUpdate(DT, ctx, noInput);
      }
      expect(source.water).toBeLessThan(before);
      expect(before - source.water).toBeCloseTo(DRAIN_RATE * 2, 0);
    });

    it('a kid nowhere near a source drains nothing', () => {
      const before = mode.totalWater;
      const bot = mode.bots[0]!;
      for (let i = 0; i < 60; i++) {
        bot.controller.teleport(0, 0.5, 0);
        mode.fixedUpdate(DT, ctx, noInput);
      }
      expect(mode.totalWater).toBe(before);
    });

    it('doing nothing loses the round', () => {
      // The balance guardrail that matters: if ignoring the raid were survivable
      // there would be no mode. Run it out with the player parked in a corner.
      run(mode, ctx, 60 * 8);
      expect(mode.finished).toBe(true);
      expect(mode.won).toBe(false);
      expect(events.some((e) => e.type === 'roundLost')).toBe(true);
    });

    it('a kid moves on once its source runs dry', () => {
      const first = mode.sources[0]!;
      first.water = 0.5;
      // The first kid of a raid is sent to the fullest source, which is this one.
      const bot = mode.bots[0]!;
      for (let i = 0; i < 60; i++) {
        bot.controller.teleport(first.x, 0.5, first.z);
        mode.fixedUpdate(DT, ctx, noInput);
      }
      // Its walking goal should no longer be the empty one.
      const stillFirst = Math.hypot(bot.targetX - first.x, bot.targetZ - first.z) < 0.1;
      expect(stillFirst).toBe(false);
    });
  });

  describe('the tank', () => {
    it('starts full and empties as you stream', () => {
      run(mode, ctx, BUILD_TIME + 0.2);
      expect(mode.tankLevel).toBe(TANK_MAX);
      run(mode, ctx, 1.0, firing);
      expect(mode.tankLevel).toBeLessThan(TANK_MAX);
      expect(mode.tankLevel).toBeGreaterThan(TANK_MAX - WEAPONS.soaker.cost * 1.6);
    });

    it('refills at a source, and takes some of it', () => {
      run(mode, ctx, BUILD_TIME + 0.2);
      run(mode, ctx, 2.5, firing);
      const low = mode.tankLevel;
      expect(low).toBeLessThan(TANK_MAX * 0.7);

      const source = mode.sources[0]!;
      const sourceBefore = source.water;
      stand(ctx, source.x, source.z);
      run(mode, ctx, 2);

      expect(mode.tankLevel).toBeGreaterThan(low);
      // Not free — camping one pool is slowly draining what you are defending.
      expect(source.water).toBeLessThan(sourceBefore);
    });

    it('cannot refill from a source that is already dry', () => {
      run(mode, ctx, BUILD_TIME + 0.2);
      run(mode, ctx, 3, firing);
      const low = mode.tankLevel;
      const source = mode.sources[0]!;
      source.water = 0;
      stand(ctx, source.x, source.z);
      run(mode, ctx, 2);
      expect(mode.tankLevel).toBeCloseTo(low, 1);
    });

    it('an empty tank stops the stream rather than firing for free', () => {
      run(mode, ctx, BUILD_TIME + 0.2);
      stand(ctx, FAR_AWAY.x, FAR_AWAY.z);
      run(mode, ctx, 20, firing);
      expect(mode.tankLevel).toBeLessThan(1);
      expect(mode.weaponReady).toBe(false);
    });
  });

  describe('the weapons', () => {
    beforeEach(() => run(mode, ctx, BUILD_TIME + 0.2));

    it('offers all three in the picker', () => {
      expect(mode.loadout.entries.length).toBe(3);
      expect(mode.loadout.selected).toBe('soaker');
    });

    it('greys out the hose away from water', () => {
      stand(ctx, FAR_AWAY.x, FAR_AWAY.z);
      run(mode, ctx, DT);
      const hose = mode.loadout.entries.find((e) => e.id === 'hose')!;
      expect(hose.ready).toBe(false);
    });

    it('the hose works at a source, and costs nothing', () => {
      const source = mode.sources[0]!;
      stand(ctx, source.x, source.z);
      run(mode, ctx, DT);
      mode.selectWeapon('hose');
      expect(mode.loadout.entries.find((e) => e.id === 'hose')!.ready).toBe(true);

      // Fill up first so the tank is not the thing being measured.
      run(mode, ctx, 3);
      const full = mode.tankLevel;
      run(mode, ctx, 1.5, firing);
      expect(mode.tankLevel).toBeCloseTo(full, 1);
    });

    it('the balloon spends the tank per throw', () => {
      mode.selectWeapon('balloon');
      const before = mode.tankLevel;
      mode.fixedUpdate(DT, ctx, firing);
      expect(mode.tankLevel).toBeCloseTo(before - WEAPONS.balloon.cost, 3);
    });

    it('the balloon respects its cooldown', () => {
      mode.selectWeapon('balloon');
      const before = mode.tankLevel;
      for (let i = 0; i < 6; i++) mode.fixedUpdate(DT, ctx, firing);
      // Six ticks is a tenth of a second — one throw, not six.
      expect(before - mode.tankLevel).toBeCloseTo(WEAPONS.balloon.cost, 3);
    });

    it('reports where the stream lands so it can be drawn', () => {
      run(mode, ctx, DT, firing);
      expect(mode.stream).not.toBeNull();
      const end = mode.stream!;
      const reach = Math.hypot(end.x - ctx.player.x, end.z - ctx.player.z);
      expect(reach).toBeLessThanOrEqual(WEAPONS.soaker.range + 0.01);
    });

    it('stops drawing the stream the moment you let go', () => {
      run(mode, ctx, DT, firing);
      expect(mode.stream).not.toBeNull();
      run(mode, ctx, DT, noInput);
      expect(mode.stream).toBeNull();
    });
  });

  describe('soaking', () => {
    beforeEach(() => run(mode, ctx, BUILD_TIME + 0.2));

    it('a stream soaks a kid standing in front of you', () => {
      const bot = mode.bots[0]!;
      // Directly ahead: the camera looks along -Z at yaw 0.
      stand(ctx, 0, 0);
      ctx.camera.yaw = 0;
      ctx.camera.pitch = 0;

      let soaked = false;
      for (let i = 0; i < 60 * 6 && !soaked; i++) {
        bot.controller.teleport(0, 0.5, -3);
        mode.fixedUpdate(DT, ctx, firing);
        soaked = !bot.alive;
      }
      expect(soaked).toBe(true);
      expect(events.some((e) => e.type === 'botSoaked')).toBe(true);
    });

    it('publishes how wet each kid is, which is how you choose who to shoot', () => {
      // The renderer tints shirts by this. Without it the meter is invisible and
      // picking the kid you have nearly finished is a guess — which would make
      // the whole meter pointless next to the one-hit rule it replaced.
      const bot = mode.bots[0]!;
      expect(mode.wetnessOf(bot.id)).toBe(0);

      stand(ctx, 0, 0);
      ctx.camera.yaw = 0;
      ctx.camera.pitch = 0;
      for (let i = 0; i < 30; i++) {
        bot.controller.teleport(0, 0.5, -3);
        mode.fixedUpdate(DT, ctx, firing);
      }
      expect(mode.wetnessOf(bot.id)).toBeGreaterThan(0);
      expect(mode.wetnessOf(bot.id)).toBeLessThan(1);
      // A kid nobody has touched stays dry, so the tint distinguishes them.
      const other = mode.bots.find((b) => b.id !== bot.id);
      if (other !== undefined) expect(mode.wetnessOf(other.id)).toBe(0);
    });

    it('splashes on a steady beat while the stream connects, and stops when it does not', () => {
      // Cosmetic, but it is the only feedback saying the jet is landing rather
      // than sailing past — and it must not be a coin flip per tick, or a
      // continuous stream sounds like it is stuttering.
      const bot = mode.bots[0]!;
      stand(ctx, 0, 0);
      ctx.camera.yaw = 0;
      ctx.camera.pitch = 0;

      events.length = 0;
      for (let i = 0; i < 30; i++) {
        bot.controller.teleport(0, 0.5, -3);
        mode.fixedUpdate(DT, ctx, firing);
      }
      const hitting = events.filter((e) => e.type === 'splash').length;
      // Half a second at one per eighth of a second.
      expect(hitting).toBeGreaterThanOrEqual(3);
      expect(hitting).toBeLessThanOrEqual(5);

      // Turn to face nothing: the splashes should stop.
      ctx.camera.yaw = Math.PI;
      events.length = 0;
      for (let i = 0; i < 30; i++) {
        bot.controller.teleport(0, 0.5, -3);
        mode.fixedUpdate(DT, ctx, firing);
      }
      expect(events.filter((e) => e.type === 'splash').length).toBe(0);
    });

    it('a wall stops the stream, which is why a wall is worth building', () => {
      // The one role split the arsenal leans on. If cover did not stop a stream
      // there would be no reason to build anything in a fight.
      const bot = mode.bots[0]!;
      stand(ctx, 0, 0);
      ctx.camera.yaw = 0;
      ctx.camera.pitch = 0;
      // A slab between the two of them.
      ctx.world.addPart(0, 0, 0, 1.0, -1.6, 0, 0, 0, 1, 1.5, 1.2, 0.15);

      for (let i = 0; i < 60 * 6; i++) {
        bot.controller.teleport(0, 0.5, -3);
        mode.fixedUpdate(DT, ctx, firing);
      }
      expect(bot.alive).toBe(true);
    });

    it('a soaked kid comes back rather than thinning the raid', () => {
      const before = mode.bots.length;
      const bot = mode.bots[0]!;
      while (!bot.soak()) { /* down */ }
      run(mode, ctx, DT * 2);
      expect(mode.bots.filter((b) => b.alive).length).toBe(before - 1);
      run(mode, ctx, KID_RESPAWN + 1);
      expect(mode.bots.filter((b) => b.alive).length).toBe(before);
    });

    it('being soaked takes you out and brings you back with half a tank', () => {
      // So dunking yourself is never a shortcut to a full one.
      run(mode, ctx, 5, firing);
      expect(mode.tankLevel).toBeLessThan(RESPAWN_TANK);

      const before = mode.playerWetness;
      expect(before).toBe(0);
      // Balloon straight down onto the player's head, repeatedly.
      for (let i = 0; i < 60 * 4; i++) {
        if (i % 20 === 0) {
          ctx.projectiles.spawn(ctx.player.x, ctx.player.y + 4, ctx.player.z, 0, -1, 0, 14, 99);
        }
        mode.fixedUpdate(DT, ctx, noInput);
      }
      expect(events.some((e) => e.type === 'playerSoaked')).toBe(true);
      run(mode, ctx, 5);
      expect(mode.tankLevel).toBeGreaterThanOrEqual(RESPAWN_TANK - 0.01);
      expect(mode.playerWetness).toBe(0);
    });
  });

  describe('published state', () => {
    it('draws a marker per source', () => {
      expect(mode.markers().length).toBe(mode.sources.length);
    });

    it('colours a marker by how much is left, so the score is on the map', () => {
      const full = mode.markers()[0]!.color;
      mode.sources[0]!.water = 1;
      const empty = mode.markers()[0]!.color;
      expect(empty).not.toBe(full);
    });

    it('the HUD reports water as the score', () => {
      const h = mode.hud();
      expect(h.primary).not.toBeNull();
      expect(h.primary!.label).toBe('water');
      expect(h.primary!.value).toContain('L');
    });

    it('shows the tank once the fighting starts, and not before', () => {
      expect(mode.hud().ammo).toBeNull();
      run(mode, ctx, BUILD_TIME + 0.2);
      expect(mode.hud().ammo).not.toBeNull();
    });

    it('the result names each source, so you can see which one you lost', () => {
      // The legibility the whole design turns on: you should be able to read
      // which fort worked off the result screen.
      run(mode, ctx, 60 * 8);
      const s = mode.summary();
      for (const source of mode.sources) {
        expect(s.lines.some((l) => l.label === source.name)).toBe(true);
      }
    });
  });

  describe('restarting', () => {
    it('start() puts every source back and clears the field', () => {
      run(mode, ctx, BUILD_TIME + 5);
      mode.sources[0]!.water = 3;
      mode.start(ctx);
      expect(mode.phase).toBe('build');
      expect(mode.raid).toBe(0);
      expect(mode.bots.length).toBe(0);
      expect(mode.tankLevel).toBe(TANK_MAX);
      for (const s of mode.sources) expect(s.water).toBe(SOURCE_MAX);
    });
  });
});
