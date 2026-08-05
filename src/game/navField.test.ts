import { describe, it, expect } from 'vitest';
import { CollisionWorld } from '../physics/collisionWorld.ts';
import { NavField, UNREACHABLE, CELL } from './navField.ts';
import { Bot, BOT_TIERS } from './bot.ts';
import { ProjectileSystem } from './projectiles.ts';
import { Rng } from '../core/rng.ts';
import { DT } from '../physics/constants.ts';

const I = [0, 0, 0, 1] as const;

/** A solid wall from (x0,z0) to (x1,z1), tall enough that nothing steps over it. */
function wall(w: CollisionWorld, x0: number, z0: number, x1: number, z1: number): void {
  const len = Math.hypot(x1 - x0, z1 - z0);
  const segments = Math.ceil(len / 0.25);
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    w.addPart(
      0, 0,
      x0 + (x1 - x0) * t, 1.0, z0 + (z1 - z0) * t,
      ...I,
      0.16, 1.0, 0.16,
    );
  }
}

describe('NavField', () => {
  it('an open yard is fully reachable', () => {
    const world = new CollisionWorld();
    const nav = new NavField(12);
    nav.rebuild(world, 0, 0);
    expect(nav.costAt(0, 0)).toBe(0);
    expect(nav.costAt(8, 8)).toBeLessThan(UNREACHABLE);
    expect(nav.isSealedFrom(8, 8)).toBe(false);
  });

  it('cost rises with distance from the goal', () => {
    const world = new CollisionWorld();
    const nav = new NavField(12);
    nav.rebuild(world, 0, 0);
    expect(nav.costAt(3, 0)).toBeLessThan(nav.costAt(9, 0));
  });

  it('points toward the goal in an open yard', () => {
    const world = new CollisionWorld();
    const nav = new NavField(12);
    nav.rebuild(world, 0, 0);
    const d = nav.direction(8, 0);
    expect(d).not.toBeNull();
    // Heading back toward the origin means a negative x component.
    expect(d!.dx).toBeLessThan(0);
  });

  it('marks cells containing a wall as blocked', () => {
    const world = new CollisionWorld();
    wall(world, -4, 3, 4, 3);
    const nav = new NavField(12);
    nav.rebuild(world, 0, 0);
    expect(nav.isBlocked(0, 3)).toBe(true);
    expect(nav.isBlocked(0, -3)).toBe(false);
  });

  it('does not block cells under a raised platform, so bots can walk beneath', () => {
    const world = new CollisionWorld();
    // A deck at 2.5m — well above head height.
    world.addPart(0, 0, 0, 2.5, 0, ...I, 3, 0.05, 3);
    const nav = new NavField(12);
    nav.rebuild(world, 8, 8);
    expect(nav.isBlocked(0, 0)).toBe(false);
  });

  it('reports a sealed objective as unreachable', () => {
    const world = new CollisionWorld();
    // A closed box around the origin.
    wall(world, -3, -3, 3, -3);
    wall(world, 3, -3, 3, 3);
    wall(world, 3, 3, -3, 3);
    wall(world, -3, 3, -3, -3);

    const nav = new NavField(12);
    nav.rebuild(world, 0, 0);
    expect(nav.isSealedFrom(9, 0)).toBe(true);
    expect(nav.costAt(9, 0)).toBe(UNREACHABLE);
  });

  it('finds a route through a doorway rather than declaring it sealed', () => {
    const world = new CollisionWorld();
    // The same box, but with a gap in the +X wall.
    wall(world, -3, -3, 3, -3);
    wall(world, 3, -3, 3, -1.2);
    wall(world, 3, 1.2, 3, 3);
    wall(world, 3, 3, -3, 3);
    wall(world, -3, 3, -3, -3);

    const nav = new NavField(12);
    nav.rebuild(world, 0, 0);
    expect(nav.isSealedFrom(9, 0)).toBe(false);
    expect(nav.costAt(9, 0)).toBeLessThan(UNREACHABLE);
  });

  it('routes the long way round a U-shaped fort', () => {
    // The measured failure case for pure steering: the opening faces away from
    // the approach, so a local probe finds walls in every direction it can see.
    const world = new CollisionWorld();
    wall(world, -4, -4, 4, -4);   // near side, facing the approach
    wall(world, -4, -4, -4, 4);
    wall(world, 4, -4, 4, 4);
    // +Z side left open.

    const nav = new NavField(14);
    nav.rebuild(world, 0, 0);

    // Approaching from -Z, straight into the closed side.
    const start = { x: 0, z: -10 };
    expect(nav.isSealedFrom(start.x, start.z)).toBe(false);

    const d = nav.direction(start.x, start.z)!;
    expect(d).not.toBeNull();
    // The route must go around, not straight ahead into the wall.
    expect(Math.abs(d.dx)).toBeGreaterThan(0.2);
  });

  it('a rebuild costs little enough to run several times a second', () => {
    const world = new CollisionWorld();
    for (let i = 0; i < 400; i++) {
      world.addPart(0, 0, (i % 20) - 10, 1.0, Math.floor(i / 20) - 10, ...I, 0.16, 1.0, 0.16);
    }
    const nav = new NavField(26);

    for (let i = 0; i < 20; i++) nav.rebuild(world, 0, 0);

    const start = performance.now();
    const iterations = 40;
    for (let i = 0; i < iterations; i++) nav.rebuild(world, 0, 0);
    const msPerRebuild = (performance.now() - start) / iterations;

    // At five rebuilds a second this is a fraction of a millisecond per tick.
    expect(msPerRebuild).toBeLessThan(25);
  });

  it('is stable across rebuilds with an unchanged world', () => {
    const world = new CollisionWorld();
    wall(world, -4, 3, 4, 3);
    const nav = new NavField(12);
    nav.rebuild(world, 0, 0);
    const before = nav.costAt(6, 6);
    nav.rebuild(world, 0, 0);
    expect(nav.costAt(6, 6)).toBe(before);
  });
});

describe('Bot routing', () => {
  /**
   * The failure this whole system exists to fix: a bot approaching the closed
   * side of a U-shaped fort must find its way round to the opening.
   */
  it('a bot reaches an objective inside a U-shaped fort', () => {
    const world = new CollisionWorld();
    wall(world, -4, -4, 4, -4);
    wall(world, -4, -4, -4, 4);
    wall(world, 4, -4, 4, 4);
    // Opening on the +Z side.

    const nav = new NavField(16);
    nav.rebuild(world, 0, 0);

    const projectiles = new ProjectileSystem(world);
    const bot = new Bot(1, world, new Rng('route'), BOT_TIERS.normal!, 0, 0.5, -11);
    bot.targetX = 0;
    bot.targetY = 0;
    bot.targetZ = 0;

    let closest = Infinity;
    for (let tick = 0; tick < 60 * 40; tick++) {
      bot.update(DT, projectiles, false, nav);
      const d = Math.hypot(bot.x, bot.z);
      if (d < closest) closest = d;
      if (d < 1.5) break;
    }

    // Pure steering measured a closest approach of 4.35m and never improved.
    expect(closest).toBeLessThan(2.0);
  });

  it('a bot presses against a genuinely sealed fort rather than wandering off', () => {
    const world = new CollisionWorld();
    wall(world, -3, -3, 3, -3);
    wall(world, 3, -3, 3, 3);
    wall(world, 3, 3, -3, 3);
    wall(world, -3, 3, -3, -3);

    const nav = new NavField(14);
    nav.rebuild(world, 0, 0);
    expect(nav.isSealedFrom(0, -9)).toBe(true);

    const projectiles = new ProjectileSystem(world);
    const bot = new Bot(1, world, new Rng('sealed'), BOT_TIERS.normal!, 0, 0.5, -9);
    bot.targetX = 0;
    bot.targetY = 0;
    bot.targetZ = 0;

    for (let tick = 0; tick < 60 * 12; tick++) {
      bot.update(DT, projectiles, false, nav);
    }

    // It should still be near the fort, pressing on it — not lost in the yard.
    expect(Math.hypot(bot.x, bot.z)).toBeLessThan(9.5);
    // And it must never have got inside.
    expect(Math.max(Math.abs(bot.x), Math.abs(bot.z))).toBeGreaterThan(2.5);
  });

  it('routing does not stop a bot crossing open ground', () => {
    const world = new CollisionWorld();
    const nav = new NavField(16);
    nav.rebuild(world, 0, 0);

    const projectiles = new ProjectileSystem(world);
    const bot = new Bot(1, world, new Rng('open'), BOT_TIERS.normal!, 0, 0.5, -12);
    bot.targetX = 0;
    bot.targetY = 0;
    bot.targetZ = 0;

    for (let tick = 0; tick < 60 * 15; tick++) {
      bot.update(DT, projectiles, false, nav);
      if (Math.hypot(bot.x, bot.z) < 1.5) break;
    }
    expect(Math.hypot(bot.x, bot.z)).toBeLessThan(1.6);
  });

  it('cell size lands on the build lattice', () => {
    // A wall built on-grid should fall on a cell boundary rather than straddle
    // two cells, which is why the cell is a whole number of modules.
    expect((CELL / 0.25) % 1).toBeCloseTo(0, 9);
  });
});

describe('NavField rebuild caching', () => {
  it('re-derives when a part is added', () => {
    const world = new CollisionWorld();
    const nav = new NavField(12);
    nav.rebuild(world, 0, 0);
    expect(nav.isBlocked(0, 3)).toBe(false);

    wall(world, -4, 3, 4, 3);
    nav.rebuild(world, 0, 0);
    // A cache that ignored the new wall would still report this open.
    expect(nav.isBlocked(0, 3)).toBe(true);
  });

  it('re-derives when a part is removed', () => {
    const world = new CollisionWorld();
    wall(world, -4, 3, 4, 3);
    const nav = new NavField(12);
    nav.rebuild(world, 0, 0);
    expect(nav.isBlocked(0, 3)).toBe(true);

    for (const id of [...world.store.live()]) world.removePart(id);
    nav.rebuild(world, 0, 0);
    expect(nav.isBlocked(0, 3)).toBe(false);
  });

  it('re-floods when the objective moves', () => {
    const world = new CollisionWorld();
    const nav = new NavField(14);
    nav.rebuild(world, 0, 0);
    expect(nav.costAt(0, 0)).toBe(0);

    nav.rebuild(world, 8, 8);
    expect(nav.costAt(8, 8)).toBe(0);
    expect(nav.costAt(0, 0)).toBeGreaterThan(0);
  });

  it('a redundant rebuild is nearly free', () => {
    const world = new CollisionWorld();
    for (let i = 0; i < 600; i++) {
      world.addPart(0, 0, (i % 25) - 12, 1.0, Math.floor(i / 25) - 12, ...I, 0.16, 1.0, 0.16);
    }
    const nav = new NavField(26);
    nav.rebuild(world, 0, 0);

    // The first rebuild scans every cell; repeats with an unchanged world and a
    // fixed objective must not, or the field spikes a quarter of a tick every
    // time it refreshes.
    const start = performance.now();
    for (let i = 0; i < 200; i++) nav.rebuild(world, 0, 0);
    const msEach = (performance.now() - start) / 200;
    expect(msEach).toBeLessThan(0.05);
  });

  it('invalidate forces a full re-derive', () => {
    const world = new CollisionWorld();
    const nav = new NavField(12);
    nav.rebuild(world, 0, 0);
    nav.invalidate();
    // Must not throw, and must produce the same answer.
    nav.rebuild(world, 0, 0);
    expect(nav.costAt(0, 0)).toBe(0);
  });
});
