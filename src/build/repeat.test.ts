import { describe, it, expect, beforeEach } from 'vitest';
import { CollisionWorld } from '../physics/collisionWorld.ts';
import { PartRenderer } from '../render/partRenderer.ts';
import {
  BuildSystem, REPEAT_MAX_CHAIN, REPEAT_MAX_SPAN, REPEAT_PREVIEW_LINKS,
  type PlacementRecord,
} from './buildSystem.ts';
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

/**
 * The preview's only job is to be true. A preview that shows a chain running
 * through a wall, or stopping short of one, is worse than no preview: the
 * player commits to a shape they cannot see afterwards either.
 */
describe('repeat chain preview', () => {
  /** Aim at nothing in particular; the chain follows the last placement, not the ray. */
  const tick = (build: BuildSystem) =>
    build.update(1 / 60, 0, 20, 0, 0, 1, 0, false, false);

  it('offers nothing before a chain exists', () => {
    const world = new CollisionWorld();
    const build = new BuildSystem(world, new PartRenderer());
    expect(build.projectRepeatChain()).toEqual([]);

    build.applyPlace(rec(BLOCK, 0, MODULE / 2, 0));
    expect(build.projectRepeatChain()).toEqual([]);
  });

  it('projects along the step the player just made', () => {
    const world = new CollisionWorld();
    world.hasGround = false;
    const build = new BuildSystem(world, new PartRenderer());
    build.applyPlace(rec(BLOCK, 0, 5, 0));
    build.applyPlace(rec(BLOCK, 0, 5 + MODULE, 0));

    const chain = build.projectRepeatChain(4);
    expect(chain.length).toBe(4);
    for (let i = 0; i < chain.length; i++) {
      expect(chain[i]!.y).toBeCloseTo(5 + MODULE * (i + 2), 6);
      expect(chain[i]!.x).toBeCloseTo(0, 6);
    }
  });

  it('shows exactly what holding the key would place', () => {
    // The property the whole feature rests on. Two worlds, same start: one
    // previewed, one actually run.
    const shown = new BuildSystem(new CollisionWorld(), new PartRenderer());
    shown.applyPlace(rec(BLOCK, 0, MODULE / 2, 0));
    shown.applyPlace(rec(BLOCK, MODULE, MODULE / 2, 0));
    const preview = shown.projectRepeatChain(6);

    const run = new BuildSystem(new CollisionWorld(), new PartRenderer());
    run.applyPlace(rec(BLOCK, 0, MODULE / 2, 0));
    run.applyPlace(rec(BLOCK, MODULE, MODULE / 2, 0));
    const actual: PlacementRecord[] = [];
    for (let i = 0; i < 6; i++) {
      const r = run.repeatPlace();
      if (r === null) break;
      actual.push(r);
    }

    expect(preview.length).toBe(actual.length);
    for (let i = 0; i < preview.length; i++) {
      expect(preview[i]!.x).toBeCloseTo(actual[i]!.x, 6);
      expect(preview[i]!.y).toBeCloseTo(actual[i]!.y, 6);
      expect(preview[i]!.z).toBeCloseTo(actual[i]!.z, 6);
      expect(preview[i]!.kind).toBe(actual[i]!.kind);
    }
  });

  it('stops where the chain would hit something', () => {
    const world = new CollisionWorld();
    const build = new BuildSystem(world, new PartRenderer());
    build.applyPlace(rec(BLOCK, 0, MODULE / 2, 0));
    build.applyPlace(rec(BLOCK, MODULE, MODULE / 2, 0));
    // A wall four steps along.
    build.applyPlace(rec(BLOCK, MODULE * 5, MODULE / 2, 0));

    // applyPlace of a third block continues the chain, so re-arm the two-step.
    const b2 = new BuildSystem(new CollisionWorld(), new PartRenderer());
    b2.applyPlace(rec(BLOCK, MODULE * 5, MODULE / 2, 0));
    b2.applyPlace(rec(BLOCK, 0, MODULE / 2, 0));
    b2.applyPlace(rec(BLOCK, MODULE, MODULE / 2, 0));

    const chain = b2.projectRepeatChain(10);
    // Steps land at 2,3,4 modules; the fifth is occupied.
    expect(chain.length).toBe(3);
    expect(chain.at(-1)!.x).toBeCloseTo(MODULE * 4, 6);
  });

  it('treats its own projected links as solid', () => {
    // A step shorter than the part means only the first link can ever exist.
    // Without checking the projection against itself, this would draw ten.
    const world = new CollisionWorld();
    world.hasGround = false;
    const build = new BuildSystem(world, new PartRenderer());
    build.applyPlace(rec(BLOCK, 0, 5, 0));
    build.applyPlace(rec(BLOCK, MODULE * 0.4, 5, 0));
    expect(build.projectRepeatChain(10).length).toBe(0);
  });

  it('never projects more than the preview budget', () => {
    const world = new CollisionWorld();
    world.hasGround = false;
    const build = new BuildSystem(world, new PartRenderer());
    build.applyPlace(rec(BLOCK, 0, 5, 0));
    build.applyPlace(rec(BLOCK, 0, 5 + MODULE, 0));
    expect(build.projectRepeatChain().length).toBeLessThanOrEqual(REPEAT_PREVIEW_LINKS);
  });

  it('respects the span cap the chain itself obeys', () => {
    const world = new CollisionWorld();
    world.hasGround = false;
    const build = new BuildSystem(world, new PartRenderer());
    build.applyPlace(rec(BLOCK, 0, 5, 0));
    build.applyPlace(rec(BLOCK, 8, 5, 0));
    for (const r of build.projectRepeatChain(10)) {
      expect(Math.abs(r.x - 8)).toBeLessThanOrEqual(REPEAT_MAX_SPAN);
    }
  });

  it('draws the links, and clears them when the chain is dropped', () => {
    const world = new CollisionWorld();
    world.hasGround = false;
    const build = new BuildSystem(world, new PartRenderer());
    build.applyPlace(rec(BLOCK, 0, 5, 0));
    build.applyPlace(rec(BLOCK, 0, 5 + MODULE, 0));

    tick(build);
    expect(build.chainPreviewLength).toBeGreaterThan(0);

    build.clearRepeat();
    expect(build.chainPreviewLength).toBe(0);
  });

  it('re-derives when the world changes under it', () => {
    // A cached preview that ignored a new part would keep drawing a chain
    // straight through it.
    const world = new CollisionWorld();
    const build = new BuildSystem(world, new PartRenderer());
    build.applyPlace(rec(BLOCK, 0, MODULE / 2, 0));
    build.applyPlace(rec(BLOCK, MODULE, MODULE / 2, 0));
    tick(build);
    const before = build.chainPreviewLength;
    expect(before).toBeGreaterThan(3);

    // Drop a block into the chain's path, without touching the chain head.
    world.addPart(BLOCK, 0, MODULE * 4, MODULE / 2, 0, 0, 0, 0, 1,
      MODULE / 2, MODULE / 2, MODULE / 2);
    tick(build);
    expect(build.chainPreviewLength).toBeLessThan(before);
  });
});
