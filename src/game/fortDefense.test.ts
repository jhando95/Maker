import { describe, it, expect, beforeEach } from 'vitest';
import { CollisionWorld } from '../physics/collisionWorld.ts';
import { PartRenderer } from '../render/partRenderer.ts';
import { BuildSystem } from '../build/buildSystem.ts';
import { CharacterController } from '../player/controller.ts';
import { CameraRig } from '../player/cameraRig.ts';
import { ProjectileSystem, segmentHitsCapsule } from './projectiles.ts';
import {
  FortDefenseMode, BUILD_TIME, STASH_SUPPLIES, WAVE_COUNT,
  BUCKETS, BUCKET_DISTANCE, BUCKET_RADIUS, PLAYER_AMMO_MAX, REFILL_TIME, STASH_POSITION,
} from './fortDefense.ts';
import { sameForEveryone } from './gameMode.ts';
import type { GameEvent, ModeContext } from './gameMode.ts';
import { Rng } from '../core/rng.ts';
import { ActorRoster, LOCAL_ACTOR_ID } from './actor.ts';
import { DT, CAP_HEIGHT, CAP_RADIUS } from '../physics/constants.ts';

const noInput = sameForEveryone();

function makeContext(): { ctx: ModeContext; events: GameEvent[]; world: CollisionWorld } {
  const world = new CollisionWorld();
  const build = new BuildSystem(world, new PartRenderer());
  const player = new CharacterController(world, 6, 0.5, 6);
  const camera = new CameraRig(world, 1.6);
  const projectiles = new ProjectileSystem(world);
  const events: GameEvent[] = [];
  return {
    world,
    events,
    ctx: {
      world, build, player, camera, projectiles,
      actors: new ActorRoster({ id: LOCAL_ACTOR_ID, kind: 'local', team: 'left', controller: player }),
      rng: new Rng('test-round'),
      emit: (e) => events.push(e),
      worldChanged: () => {},
    },
  };
}

/** Advance the mode by `seconds` of simulation. */
function run(mode: FortDefenseMode, ctx: ModeContext, seconds: number, input = noInput): void {
  for (let i = 0; i < Math.round(seconds / DT); i++) mode.fixedUpdate(DT, ctx, input);
}

describe('segmentHitsCapsule', () => {
  it('hits a capsule dead ahead', () => {
    const t = segmentHitsCapsule(0, 1, 0, 10, 0, 0, 5, 0, 0, 0.4, 1.7);
    expect(t).toBeGreaterThan(0);
    expect(t).toBeLessThan(1);
  });

  it('misses a capsule off to the side', () => {
    expect(segmentHitsCapsule(0, 1, 0, 10, 0, 0, 5, 0, 3, 0.4, 1.7)).toBe(-1);
  });

  it('misses a capsule the segment passes over', () => {
    expect(segmentHitsCapsule(0, 8, 0, 10, 0, 0, 5, 0, 0, 0.4, 1.7)).toBe(-1);
  });

  it('misses when the segment stops short', () => {
    expect(segmentHitsCapsule(0, 1, 0, 1, 0, 0, 5, 0, 0, 0.4, 1.7)).toBe(-1);
  });

  it('handles a purely vertical segment', () => {
    // Straight down through the capsule's axis.
    expect(segmentHitsCapsule(0, 5, 0, 0, -10, 0, 0, 0, 0, 0.4, 1.7)).toBeGreaterThanOrEqual(0);
    // Straight down, well outside it.
    expect(segmentHitsCapsule(9, 5, 0, 0, -10, 0, 0, 0, 0, 0.4, 1.7)).toBe(-1);
  });

  it('hits at every horizontal speed, not only when perfectly vertical', () => {
    // The measured regression: a balloon falling almost straight down starts and
    // ends inside the cylinder's cross-section, so a boundary-crossing solve
    // finds no root in [0,1] and drops the hit. Pure vertical worked; 0.05 m of
    // drift did not, nor did 0.5, 2 or 5 — non-monotone in speed.
    for (const drift of [0, 0.001, 0.05, 0.5, 2, 5]) {
      const t = segmentHitsCapsule(0, 1.2, 0, drift * 0.016, -0.5, 0, 0, 0, 0, 0.46, 1.7);
      expect(t, `drift ${drift}`).toBeGreaterThanOrEqual(0);
      expect(t, `drift ${drift}`).toBeLessThanOrEqual(1);
    }
  });

  it('reports a hit when the segment starts inside the capsule', () => {
    const t = segmentHitsCapsule(0, 1.0, 0, 0.2, 0, 0, 0, 0, 0, 0.5, 1.7);
    expect(t).toBe(0);
  });

  it('returns the nearer of two intersections', () => {
    const t = segmentHitsCapsule(-10, 1, 0, 20, 0, 0, 0, 0, 0, 0.5, 1.7);
    // Enters at x = -0.5, which is 9.5 of the 20 travelled.
    expect(t).toBeCloseTo(9.5 / 20, 3);
  });
});

describe('ProjectileSystem', () => {
  it('charge maps monotonically to speed', () => {
    const a = ProjectileSystem.speedForCharge(0);
    const b = ProjectileSystem.speedForCharge(0.5);
    const c = ProjectileSystem.speedForCharge(1);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    // Clamped outside 0..1.
    expect(ProjectileSystem.speedForCharge(-1)).toBe(a);
    expect(ProjectileSystem.speedForCharge(5)).toBe(c);
  });

  it('a balloon falls and eventually lands', () => {
    const world = new CollisionWorld();
    const p = new ProjectileSystem(world);
    p.spawn(0, 2, 0, 1, 0, 0, 12, 99);
    expect(p.activeCount).toBe(1);

    let landed = false;
    for (let i = 0; i < 300; i++) {
      p.update(DT, []);
      if (p.hits.length > 0) {
        landed = true;
        expect(p.hits[0]!.y).toBeCloseTo(0, 1);
        break;
      }
    }
    expect(landed).toBe(true);
    expect(p.activeCount).toBe(0);
  });

  it('a balloon is stopped by a wall rather than passing through', () => {
    const world = new CollisionWorld();
    // A tall thin wall at x = 3.
    world.addPart(0, 0, 3, 2, 0, 0, 0, 0, 1, 0.05, 2, 4);
    const p = new ProjectileSystem(world);
    p.spawn(0, 2, 0, 1, 0, 0, 20, 99);

    let hitX = Infinity;
    for (let i = 0; i < 200; i++) {
      p.update(DT, []);
      if (p.hits.length > 0) {
        hitX = p.hits[0]!.x;
        break;
      }
    }
    // Stopped at the wall, not beyond it.
    expect(hitX).toBeGreaterThan(2.8);
    expect(hitX).toBeLessThan(3.2);
  });

  it('does not hit its own thrower', () => {
    const world = new CollisionWorld();
    const p = new ProjectileSystem(world);
    const thrower = {
      x: 0, y: 0, z: 0, radius: CAP_RADIUS, height: CAP_HEIGHT, id: 7, alive: true,
    };
    // Fired from inside the thrower's own capsule.
    p.spawn(0, 1.5, 0, 1, 0, 0, 15, 7);
    for (let i = 0; i < 10; i++) {
      p.update(DT, [thrower]);
      for (const h of p.hits) expect(h.targetIndex).toBe(-1);
    }
  });

  it('recycles the pool rather than growing without bound', () => {
    const world = new CollisionWorld();
    world.hasGround = false;
    const p = new ProjectileSystem(world);
    for (let i = 0; i < 500; i++) p.spawn(0, 100, 0, 1, 0, 0, 5, 99);
    expect(p.activeCount).toBeLessThanOrEqual(64);
  });

  it('solveArc finds a direction that actually reaches the target', () => {
    const world = new CollisionWorld();
    world.hasGround = false;
    const p = new ProjectileSystem(world);

    const from = { x: 0, y: 1.5, z: 0 };
    const to = { x: 9, y: 1.5, z: 0 };
    const speed = 18;
    const arc = ProjectileSystem.solveArc(from.x, from.y, from.z, to.x, to.y, to.z, speed);
    expect(arc).not.toBeNull();

    p.spawn(from.x, from.y, from.z, arc!.dx, arc!.dy, arc!.dz, speed, 99);
    const target = {
      x: to.x, y: to.y - CAP_HEIGHT / 2, z: to.z,
      radius: 0.6, height: CAP_HEIGHT, id: 1, alive: true,
    };

    let hit = false;
    for (let i = 0; i < 400; i++) {
      p.update(DT, [target]);
      if (p.hits.some((h) => h.targetIndex === 0)) {
        hit = true;
        break;
      }
    }
    expect(hit).toBe(true);
  });

  it('solveArc reports out of range instead of guessing', () => {
    // Far beyond what this speed can reach.
    expect(ProjectileSystem.solveArc(0, 0, 0, 500, 0, 0, 10)).toBeNull();
  });

  it('splash catches nearby targets but not the thrower', () => {
    const world = new CollisionWorld();
    const p = new ProjectileSystem(world);
    const targets = [
      { x: 0, y: 0, z: 0, radius: 0.32, height: 1.7, id: 0, alive: true },
      { x: 1.0, y: 0, z: 0, radius: 0.32, height: 1.7, id: 1, alive: true },
      { x: 20, y: 0, z: 0, radius: 0.32, height: 1.7, id: 2, alive: true },
    ];
    const caught = p.splashTargets(
      { x: 0.5, y: 0.85, z: 0, nx: 0, ny: 1, nz: 0, part: -1, targetIndex: -1, ownerId: 0 },
      targets,
    );
    expect(caught).toContain(1);
    expect(caught).not.toContain(0);
    expect(caught).not.toContain(2);
  });
});

describe('FortDefenseMode', () => {
  let mode: FortDefenseMode;
  let ctx: ModeContext;
  let events: GameEvent[];

  beforeEach(() => {
    const made = makeContext();
    ctx = made.ctx;
    events = made.events;
    mode = new FortDefenseMode();
    mode.start(ctx);
  });

  it('starts in the build phase with a full stash', () => {
    expect(mode.phase).toBe('build');
    expect(mode.stash.supplies).toBe(STASH_SUPPLIES);
    expect(mode.buildingAllowed).toBe(true);
    expect(mode.hud().phase).toBe('BUILD');
  });

  it('building is allowed during build and repair, not during a wave', () => {
    expect(mode.buildingAllowed).toBe(true);
    run(mode, ctx, BUILD_TIME + 0.2);
    expect(mode.phase).toBe('wave');
    expect(mode.buildingAllowed).toBe(false);
  });

  it('the first wave arrives when the build timer runs out', () => {
    run(mode, ctx, BUILD_TIME + 0.2);
    expect(mode.wave).toBe(1);
    expect(mode.bots.length).toBeGreaterThan(0);
    expect(events.some((e) => e.type === 'phaseChange')).toBe(true);
  });

  it('bots walk toward the stash and drain it when they arrive', () => {
    run(mode, ctx, BUILD_TIME + 0.2);
    const before = mode.stash.supplies;
    // No fort in the way, so they should get through.
    run(mode, ctx, 30);
    expect(mode.stash.supplies).toBeLessThan(before);
  });

  it('losing every supply ends the round as a loss', () => {
    run(mode, ctx, BUILD_TIME + 0.2);
    run(mode, ctx, 200);
    if (mode.finished) {
      expect(mode.won).toBe(false);
      expect(events.some((e) => e.type === 'roundLost')).toBe(true);
    } else {
      // Still fighting is acceptable; what must not happen is a silent win.
      expect(mode.won).toBe(false);
    }
  });

  it('a wall between a bot and the stash blocks its line of sight', () => {
    // Ring the stash with a solid wall, then check bots cannot see through it.
    for (let i = 0; i < 32; i++) {
      const a = (i / 32) * Math.PI * 2;
      // Around the stash, wherever it is — not around the origin, which was the
      // same place only until the map grew a house and the stash moved out.
      ctx.world.addPart(
        0, 0,
        STASH_POSITION.x + Math.sin(a) * 3, 1.0, STASH_POSITION.z + Math.cos(a) * 3,
        0, Math.sin(-a / 2), 0, Math.cos(-a / 2),
        0.35, 1.0, 0.1,
      );
    }
    run(mode, ctx, BUILD_TIME + 0.2);
    // A bot far outside the ring must not have a clear shot at the stash.
    const bot = mode.bots[0]!;
    const dx = mode.stash.x - bot.x;
    const dy = mode.stash.y + 0.6 - (bot.y + CAP_HEIGHT * 0.75);
    const dz = mode.stash.z - bot.z;
    const dist = Math.hypot(dx, dy, dz);
    const hit = ctx.world.raycast(bot.x, bot.y + CAP_HEIGHT * 0.75, bot.z, dx, dy, dz, dist);
    expect(hit).not.toBeNull();
    expect(hit!.distance).toBeLessThan(dist - 0.15);
  });

  it('a soaked bot stops counting as a live target', () => {
    run(mode, ctx, BUILD_TIME + 0.2);
    const bot = mode.bots[0]!;
    const toughness = 3;
    for (let i = 0; i < toughness; i++) bot.soak();
    expect(bot.alive).toBe(false);
    expect(bot.asTarget().alive).toBe(false);
  });

  it('clearing a wave moves to repair, not straight to the next wave', () => {
    run(mode, ctx, BUILD_TIME + 0.2);
    for (const bot of mode.bots) {
      while (bot.alive) bot.soak();
    }
    run(mode, ctx, 0.1);
    expect(mode.phase).toBe('intermission');
    expect(mode.buildingAllowed).toBe(true);
  });

  it('surviving every wave wins the round', () => {
    run(mode, ctx, BUILD_TIME + 0.2);

    // Soak everything the instant it spawns, so no bot ever reaches the stash.
    // Letting waves run even a few seconds lets them drain it, which is the
    // loss condition rather than the win one.
    for (let tick = 0; tick < 60 * 60 * 4 && !mode.finished; tick++) {
      for (const bot of mode.bots) {
        while (bot.alive) bot.soak();
      }
      mode.fixedUpdate(DT, ctx, noInput);
    }

    expect(mode.finished).toBe(true);
    expect(mode.won).toBe(true);
    expect(mode.wave).toBe(WAVE_COUNT);
    expect(mode.stash.supplies).toBe(STASH_SUPPLIES);
    expect(events.some((e) => e.type === 'roundWon')).toBe(true);
  });

  it('places buckets away from the stash, so refilling means leaving cover', () => {
    expect(BUCKETS.length).toBe(3);
    for (const b of BUCKETS) {
      // Measured from the stash, not from the origin. Those were the same
      // number until the map gained a house and the stash moved out of it.
      const d = Math.hypot(b.x - STASH_POSITION.x, b.z - STASH_POSITION.z);
      expect(d).toBeCloseTo(BUCKET_DISTANCE, 6);
    }
    // Spread around the stash, so no single wall of a fort covers them all.
    for (let i = 0; i < BUCKETS.length; i++) {
      for (let j = i + 1; j < BUCKETS.length; j++) {
        const d = Math.hypot(BUCKETS[i]!.x - BUCKETS[j]!.x, BUCKETS[i]!.z - BUCKETS[j]!.z);
        expect(d).toBeGreaterThan(BUCKET_DISTANCE);
      }
    }
  });

  it('standing on the stash no longer refills anything', () => {
    run(mode, ctx, BUILD_TIME + 0.2);
    // Spend the magazine.
    for (let i = 0; i < PLAYER_AMMO_MAX; i++) {
      mode.fixedUpdate(DT, ctx, sameForEveryone({ fire: true, firePressed: true, fireReleased: false }));
      mode.fixedUpdate(DT, ctx, sameForEveryone({ fire: false, firePressed: false, fireReleased: true }));
    }
    expect(mode.ammoCount).toBeLessThan(PLAYER_AMMO_MAX);

    ctx.player.teleport(mode.stash.x, 0.5, mode.stash.z);
    const spent = mode.ammoCount;
    run(mode, ctx, 5);
    expect(mode.ammoCount).toBe(spent);
  });

  it('standing at a bucket refills after the channel completes', () => {
    run(mode, ctx, BUILD_TIME + 0.2);
    for (let i = 0; i < PLAYER_AMMO_MAX; i++) {
      mode.fixedUpdate(DT, ctx, sameForEveryone({ fire: true, firePressed: true, fireReleased: false }));
      mode.fixedUpdate(DT, ctx, sameForEveryone({ fire: false, firePressed: false, fireReleased: true }));
    }
    const spent = mode.ammoCount;
    expect(spent).toBeLessThan(PLAYER_AMMO_MAX);

    const b = BUCKETS[0]!;
    ctx.player.teleport(b.x, 0.5, b.z);

    // Partway through the channel: nothing yet.
    run(mode, ctx, REFILL_TIME * 0.5);
    expect(mode.currentBucket).toBe(0);
    expect(mode.refillFraction).toBeGreaterThan(0);
    expect(mode.ammoCount).toBe(spent);

    run(mode, ctx, REFILL_TIME);
    expect(mode.ammoCount).toBe(PLAYER_AMMO_MAX);
    expect(events.some((e) => e.type === 'refilled')).toBe(true);
  });

  it('walking away abandons the channel rather than banking it', () => {
    run(mode, ctx, BUILD_TIME + 0.2);
    for (let i = 0; i < PLAYER_AMMO_MAX; i++) {
      mode.fixedUpdate(DT, ctx, sameForEveryone({ fire: true, firePressed: true, fireReleased: false }));
      mode.fixedUpdate(DT, ctx, sameForEveryone({ fire: false, firePressed: false, fireReleased: true }));
    }

    const b = BUCKETS[0]!;
    ctx.player.teleport(b.x, 0.5, b.z);
    run(mode, ctx, REFILL_TIME * 0.8);
    expect(mode.refillFraction).toBeGreaterThan(0.5);

    // Step out of the ring.
    ctx.player.teleport(b.x + BUCKET_RADIUS * 3, 0.5, b.z);
    run(mode, ctx, 0.1);
    expect(mode.currentBucket).toBe(-1);
    expect(mode.refillFraction).toBe(0);
  });

  it('reports HUD state that matches the phase', () => {
    const build = mode.hud();
    expect(build.timer).not.toBeNull();
    expect(build.ammo).toBeNull();

    run(mode, ctx, BUILD_TIME + 0.2);
    const wave = mode.hud();
    expect(wave.phase).toContain('WAVE');
    expect(wave.ammo).not.toBeNull();
    expect(wave.timer).toBeNull();
  });

  it('is deterministic for a given seed', () => {
    const a = makeContext();
    const b = makeContext();
    const ma = new FortDefenseMode();
    const mb = new FortDefenseMode();
    ma.start(a.ctx);
    mb.start(b.ctx);

    run(ma, a.ctx, BUILD_TIME + 5);
    run(mb, b.ctx, BUILD_TIME + 5);

    expect(ma.bots.length).toBe(mb.bots.length);
    for (let i = 0; i < ma.bots.length; i++) {
      expect(ma.bots[i]!.x).toBeCloseTo(mb.bots[i]!.x, 9);
      expect(ma.bots[i]!.z).toBeCloseTo(mb.bots[i]!.z, 9);
    }
  });
});

describe('a kid who has run out of ways round', () => {
  /**
   * A sealed box round the stash, out of the player's own parts.
   *
   * Tall enough that nobody steps over it and closed on every side, so the
   * diversion search really does fail — which is the only condition under
   * which a bot starts pulling at all. A wall with a gap in it is beaten by
   * walking through the gap and this never fires, which is the design.
   */
  const wallOff = (ctx: ModeContext, radius = 2.2): number[] => {
    const records = [];
    const kind = 4; // Post: 1.5m long, stood on end.
    const upright = { qx: 0, qy: 0, qz: Math.SQRT1_2, qw: Math.SQRT1_2 };
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      for (const level of [0.75, 2.25]) {
        records.push({
          kind, colorway: 0,
          x: STASH_POSITION.x + Math.sin(a) * radius,
          y: level,
          z: STASH_POSITION.z + Math.cos(a) * radius,
          ...upright,
        });
      }
    }
    const ids: number[] = [];
    for (const r of records) {
      if (ctx.build.canStamp([r])) ids.push(...ctx.build.stamp([r]));
    }
    return ids;
  };

  it('pulls the wall apart rather than standing at it forever', () => {
    const { ctx, events } = makeContext();
    const mode = new FortDefenseMode();
    mode.start(ctx);
    const built = wallOff(ctx);
    expect(built.length).toBeGreaterThan(30);

    const before = ctx.world.partCount;
    // Past the build phase and well into the first wave, which is the only
    // time there is anybody outside the wall to pull at it.
    run(mode, ctx, BUILD_TIME + 60);

    const pulled = events.filter((e) => e.type === 'partPulled');
    expect(pulled.length, 'nobody ever laid a hand on the wall').toBeGreaterThan(0);
    expect(ctx.world.partCount).toBeLessThan(before);
  });

  it('says how much came down, because one plank and eleven are different news', () => {
    const { ctx, events } = makeContext();
    const mode = new FortDefenseMode();
    mode.start(ctx);
    wallOff(ctx);
    run(mode, ctx, BUILD_TIME + 60);

    for (const e of events) {
      if (e.type !== 'partPulled') continue;
      expect(e.brought).toBeGreaterThanOrEqual(1);
      expect(Number.isFinite(e.x) && Number.isFinite(e.y) && Number.isFinite(e.z)).toBe(true);
    }
  });

  it('walks through a gap rather than pulling at the wall beside it', () => {
    // The balance claim, and the reason the trigger is "cannot get closer"
    // rather than "cannot move". A fort with a door is beaten by the door: a
    // kid that pulled at a wall it could have walked round would turn every
    // fort into a pile of hit points, and the answer to that is more planks
    // rather than a better shape.
    const { ctx, events } = makeContext();
    const mode = new FortDefenseMode();
    mode.start(ctx);
    const ids = wallOff(ctx);
    // Take a quarter of the ring out, which is a doorway nobody can miss.
    for (const id of ids.slice(0, Math.floor(ids.length / 4))) {
      if (ctx.world.store.isAlive(id)) ctx.build.applyRemove(id);
    }
    const standing = ctx.world.partCount;

    run(mode, ctx, BUILD_TIME + 60);

    expect(events.some((e) => e.type === 'partPulled')).toBe(false);
    expect(ctx.world.partCount).toBe(standing);
  });

  it('leaves the map alone, however long it is stuck against it', () => {
    // The same sealed ring, built out of *map* instead of out of planks. The
    // kids are as thwarted as they were in the first test and have been at it
    // just as long — and a kid who could take the fence apart would eventually
    // take the house apart, and the level would have a hole in it nobody put
    // there.
    //
    // The first version of this test surrounded nothing at all, so the bots
    // walked happily to the stash and never reached for anything: it passed
    // with the fixture guard deleted, which is a check proving that a rule it
    // never reached was being followed.
    const { ctx, events } = makeContext();
    const mode = new FortDefenseMode();
    mode.start(ctx);

    const ids: number[] = [];
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      for (const y of [0.75, 2.25]) {
        ids.push(ctx.world.addFixture(
          STASH_POSITION.x + Math.sin(a) * 2.2, y, STASH_POSITION.z + Math.cos(a) * 2.2,
          1, 0, 0, 0, 0, 1, 0.2, 0.75, 0.2, null, {},
        ).id);
      }
    }
    const standing = ctx.world.partCount;

    run(mode, ctx, BUILD_TIME + 60);

    expect(events.some((e) => e.type === 'partPulled')).toBe(false);
    expect(ctx.world.partCount).toBe(standing);
    for (const id of ids) expect(ctx.world.store.isAlive(id)).toBe(true);
  });
});
