import { describe, it, expect, beforeEach } from 'vitest';
import { CollisionWorld } from '../physics/collisionWorld.ts';
import { PartRenderer } from '../render/partRenderer.ts';
import { BuildSystem, REPEAT_MAX_CHAIN, REPEAT_MAX_SPAN, type PlacementRecord } from './buildSystem.ts';
import { MODULE, STAIR_RUN, PART_KINDS } from './partKit.ts';

const PLANK = 0;
const BLOCK = PART_KINDS.findIndex((k) => k.key === 'block');

const rec = (kind: number, x: number, y: number, z: number): PlacementRecord => ({
  kind, colorway: 0, x, y, z, qx: 0, qy: 0, qz: 0, qw: 1,
});

describe('repeat-last-placement', () => {
  let world: CollisionWorld;
  let build: BuildSystem;

  beforeEach(() => {
    world = new CollisionWorld();
    build = new BuildSystem(world, new PartRenderer());
  });

  it('offers nothing until two parts of the same kind exist', () => {
    expect(build.repeatDelta).toBeNull();
    build.applyPlace(rec(BLOCK, 0, MODULE / 2, 0));
    expect(build.repeatDelta).toBeNull();
    build.applyPlace(rec(BLOCK, MODULE, MODULE / 2, 0));
    expect(build.repeatDelta).not.toBeNull();
  });

  it('derives the step from the last two placements', () => {
    build.applyPlace(rec(BLOCK, 0, MODULE / 2, 0));
    build.applyPlace(rec(BLOCK, 0, MODULE * 1.5, 0));
    const d = build.repeatDelta!;
    expect(d.dx).toBeCloseTo(0, 6);
    expect(d.dy).toBeCloseTo(MODULE, 6);
    expect(d.dz).toBeCloseTo(0, 6);
  });

  it('changing part type breaks the chain', () => {
    build.applyPlace(rec(BLOCK, 0, MODULE / 2, 0));
    build.applyPlace(rec(BLOCK, MODULE, MODULE / 2, 0));
    expect(build.repeatDelta).not.toBeNull();
    // A step from a block to a plank describes nothing the player meant.
    build.applyPlace(rec(PLANK, 3, 0.5, 0));
    expect(build.repeatDelta).toBeNull();
  });

  it('two parts in the same place describe no step', () => {
    build.applyPlace(rec(BLOCK, 0, MODULE / 2, 0));
    build.applyPlace(rec(BLOCK, 0, MODULE / 2, 0));
    expect(build.repeatDelta).toBeNull();
  });

  it('repeating builds a ladder from two rungs', () => {
    // Two rungs one module apart, then run the chain.
    build.applyPlace(rec(BLOCK, 0, MODULE / 2, 0));
    build.applyPlace(rec(BLOCK, 0, MODULE * 1.5, 0));

    let placed = 0;
    for (let i = 0; i < 12; i++) {
      if (build.repeatPlace() !== null) placed++;
    }

    expect(placed).toBe(12);
    expect(world.partCount).toBe(14);

    // The whole stack is one module apart, top to bottom.
    const ys = [...world.store.live()]
      .map((id) => world.store.center[id * 3 + 1]!)
      .sort((a, b) => a - b);
    for (let i = 1; i < ys.length; i++) {
      expect(ys[i]! - ys[i - 1]!).toBeCloseTo(MODULE, 3);
    }
  });

  it('repeating builds a staircase from two treads', () => {
    build.applyPlace(rec(BLOCK, 0, MODULE / 2, 0));
    build.applyPlace(rec(BLOCK, STAIR_RUN, MODULE * 1.5, 0));

    for (let i = 0; i < 8; i++) build.repeatPlace();

    expect(world.partCount).toBe(10);
    // Each step advances by the run and rises by the module.
    const parts = [...world.store.live()]
      .map((id) => ({ x: world.store.center[id * 3]!, y: world.store.center[id * 3 + 1]! }))
      .sort((a, b) => a.x - b.x);
    for (let i = 1; i < parts.length; i++) {
      expect(parts[i]!.x - parts[i - 1]!.x).toBeCloseTo(STAIR_RUN, 3);
      expect(parts[i]!.y - parts[i - 1]!.y).toBeCloseTo(MODULE, 3);
    }
  });

  it('the chain stops rather than stacking parts inside each other', () => {
    // The obstacle goes down first: placing it last would make it the head of
    // the chain and shift the next step past itself.
    build.applyPlace(rec(BLOCK, MODULE * 2, MODULE / 2, 0));
    build.applyPlace(rec(BLOCK, 0, MODULE / 2, 0));
    build.applyPlace(rec(BLOCK, MODULE, MODULE / 2, 0));

    const before = world.partCount;
    expect(build.repeatPlace()).toBeNull();
    expect(world.partCount).toBe(before);
  });

  it('a blocked repeat ends the chain instead of retrying forever', () => {
    build.applyPlace(rec(BLOCK, MODULE * 2, MODULE / 2, 0));
    build.applyPlace(rec(BLOCK, 0, MODULE / 2, 0));
    build.applyPlace(rec(BLOCK, MODULE, MODULE / 2, 0));

    expect(build.repeatPlace()).toBeNull();
    expect(build.repeatDelta).toBeNull();
  });

  it('does not run a chain below the ground', () => {
    build.applyPlace(rec(BLOCK, 0, MODULE * 1.5, 0));
    build.applyPlace(rec(BLOCK, 0, MODULE * 0.5, 0));
    // The step is downward; the next would be underground.
    expect(build.repeatPlace()).toBeNull();
  });

  it("repeats beyond arm's reach, which is the point", () => {
    build.applyPlace(rec(BLOCK, 0, MODULE / 2, 0));
    build.applyPlace(rec(BLOCK, 0, MODULE * 1.5, 0));
    for (let i = 0; i < 30; i++) build.repeatPlace();

    // Far above where a player standing on the ground could aim.
    const highest = Math.max(
      ...[...world.store.live()].map((id) => world.store.center[id * 3 + 1]!),
    );
    expect(highest).toBeGreaterThan(6);
  });

  it('loading a build does not leave a repeat step armed', () => {
    build.applyPlace(rec(BLOCK, 0, MODULE / 2, 0));
    build.applyPlace(rec(BLOCK, 0, MODULE * 1.5, 0));
    const saved = build.serialize();

    build.deserialize(saved);
    // Loaded parts are not a step the player just made.
    expect(build.repeatDelta).toBeNull();
  });

  it('clearRepeat drops the chain', () => {
    build.applyPlace(rec(BLOCK, 0, MODULE / 2, 0));
    build.applyPlace(rec(BLOCK, 0, MODULE * 1.5, 0));
    build.clearRepeat();
    expect(build.repeatDelta).toBeNull();
  });

  it('nextRepeat previews without placing', () => {
    build.applyPlace(rec(BLOCK, 0, MODULE / 2, 0));
    build.applyPlace(rec(BLOCK, 0, MODULE * 1.5, 0));
    const before = world.partCount;
    const preview = build.nextRepeat()!;
    expect(preview.y).toBeCloseTo(MODULE * 2.5, 3);
    expect(world.partCount).toBe(before);
  });
});

describe('repeat chain caps', () => {
  it('stops at the chain limit rather than filling the world', () => {
    const world = new CollisionWorld();
    world.hasGround = false;
    const build = new BuildSystem(world, new PartRenderer());
    build.applyPlace(rec(BLOCK, 0, 5, 0));
    build.applyPlace(rec(BLOCK, 0, 5 + MODULE, 0));

    // Open space in every direction: nothing here ever fails validation, so
    // without a cap this runs until the world is full.
    let placed = 0;
    for (let i = 0; i < 500; i++) {
      if (build.repeatPlace() !== null) placed++;
    }
    expect(placed).toBeLessThanOrEqual(REPEAT_MAX_CHAIN);
    expect(placed).toBeGreaterThan(0);
  });

  it('stops once the chain has run past the span limit', () => {
    const world = new CollisionWorld();
    world.hasGround = false;
    const build = new BuildSystem(world, new PartRenderer());
    // A big step, so the span limit bites before the chain-length limit.
    build.applyPlace(rec(BLOCK, 0, 5, 0));
    build.applyPlace(rec(BLOCK, 2, 5, 0));

    let placed = 0;
    for (let i = 0; i < 200; i++) {
      if (build.repeatPlace() !== null) placed++;
    }
    expect(placed).toBeLessThan(REPEAT_MAX_CHAIN);
    const furthest = Math.max(
      ...[...world.store.live()].map((id) => Math.abs(world.store.center[id * 3]!)),
    );
    expect(furthest).toBeLessThanOrEqual(REPEAT_MAX_SPAN + 2.1);
  });

  it('a manual placement starts a fresh chain', () => {
    const world = new CollisionWorld();
    world.hasGround = false;
    const build = new BuildSystem(world, new PartRenderer());
    build.applyPlace(rec(BLOCK, 0, 5, 0));
    build.applyPlace(rec(BLOCK, 0, 5 + MODULE, 0));
    for (let i = 0; i < 500; i++) build.repeatPlace();

    // Placing by hand again re-arms a full-length chain.
    build.applyPlace(rec(BLOCK, 10, 5, 0));
    build.applyPlace(rec(BLOCK, 10, 5 + MODULE, 0));
    let placed = 0;
    for (let i = 0; i < 30; i++) if (build.repeatPlace() !== null) placed++;
    expect(placed).toBe(30);
  });
});
