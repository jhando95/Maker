import { describe, it, expect, beforeEach } from 'vitest';
import { CollisionWorld } from '../physics/collisionWorld.ts';
import { PartRenderer } from '../render/partRenderer.ts';
import { BuildSystem } from './buildSystem.ts';
import {
  Lumber, costOf, partCost, PART_COSTS,
  STARTING_LUMBER, PHASE_DELIVERY, LUMBER_CAP,
} from './lumber.ts';
import { PART_KINDS } from './partKit.ts';

/** Aim straight ahead from an eye at standing height. */
function aim(build: BuildSystem, from: [number, number, number], dir: [number, number, number]) {
  const len = Math.hypot(...dir);
  return build.update(
    1 / 60,
    from[0], from[1], from[2],
    dir[0] / len, dir[1] / len, dir[2] / len,
    false,
    false,
  );
}

describe('part prices', () => {
  it('prices every part in the kit, and nothing is free', () => {
    expect(PART_COSTS.length).toBe(PART_KINDS.length);
    for (const cost of PART_COSTS) {
      expect(Number.isInteger(cost)).toBe(true);
      expect(cost).toBeGreaterThanOrEqual(1);
    }
  });

  it('a plank is the unit, so the counter reads in planks', () => {
    expect(partCost(PART_KINDS[0]!)).toBe(1);
  });

  it('a bigger part costs more than a smaller one', () => {
    const plank = PART_KINDS[0]!;
    const bigger = PART_KINDS.find(
      (k) => k.length * k.thickness * k.width > plank.length * plank.thickness * plank.width * 2,
    );
    expect(bigger).toBeDefined();
    expect(partCost(bigger!)).toBeGreaterThan(partCost(plank));
  });

  it('a wedge costs half the box it fits inside, so ramps are the cheap way up', () => {
    const wedge = PART_KINDS.find((k) => k.isWedge);
    expect(wedge).toBeDefined();
    // Same dimensions, priced as a solid: the wedge must come out cheaper.
    const asSolid = partCost({ ...wedge!, isWedge: false });
    expect(partCost(wedge!)).toBeLessThan(asSolid);
  });

  it('an unknown kind index falls back to a plank rather than being free', () => {
    expect(costOf(999)).toBe(1);
  });
});

describe('Lumber', () => {
  it('spends what it has and refuses what it does not', () => {
    const wood = new Lumber(10);
    expect(wood.spend(4)).toBe(true);
    expect(wood.available).toBe(6);
    expect(wood.spend(7)).toBe(false);
    // A refused spend changes nothing.
    expect(wood.available).toBe(6);
  });

  it('gives the whole cost back, so remodelling is free', () => {
    const wood = new Lumber(10);
    wood.spend(4);
    wood.refund(4);
    expect(wood.available).toBe(10);
  });

  it('a delivery is capped, so saving up cannot bank a fort', () => {
    const wood = new Lumber(LUMBER_CAP - 5);
    wood.deliver(PHASE_DELIVERY, LUMBER_CAP);
    expect(wood.available).toBe(LUMBER_CAP);
  });

  it('unlimited stays unlimited through spending and delivery', () => {
    const wood = new Lumber(Infinity);
    expect(wood.unlimited).toBe(true);
    expect(wood.spend(50)).toBe(true);
    wood.refund(50);
    wood.deliver(PHASE_DELIVERY, LUMBER_CAP);
    expect(wood.available).toBe(Infinity);
    expect(wood.unlimited).toBe(true);
  });

  it('a top-up cannot outgrow the starting pile by much', () => {
    // The point of the budget is triage. If four repair phases handed out more
    // than the opening pile, the decision would just be a matter of waiting.
    expect(PHASE_DELIVERY).toBeLessThan(STARTING_LUMBER / 2);
    expect(LUMBER_CAP).toBeGreaterThan(STARTING_LUMBER);
  });
});

describe('building against a budget', () => {
  let world: CollisionWorld;
  let renderer: PartRenderer;
  let build: BuildSystem;

  beforeEach(() => {
    world = new CollisionWorld();
    renderer = new PartRenderer();
    build = new BuildSystem(world, renderer);
  });

  it('is unlimited until a mode lends it a stack', () => {
    expect(build.lumber.unlimited).toBe(true);
    expect(build.canAffordSelected).toBe(true);
  });

  it('charges the held part price on placement', () => {
    build.setLumber(new Lumber(10));
    aim(build, [0, 1.5, 3], [0, -0.55, -1]);
    expect(build.tryPlace()).toBe(true);
    expect(build.lumber.available).toBe(10 - build.selectedCost);
  });

  it('refuses to place with an empty stack, and the world is untouched', () => {
    build.setLumber(new Lumber(0));
    aim(build, [0, 1.5, 3], [0, -0.55, -1]);
    expect(build.canAffordSelected).toBe(false);
    expect(build.tryPlace()).toBe(false);
    expect(world.partCount).toBe(0);
    expect(renderer.instanceCount).toBe(0);
  });

  it('taking your own part down gives the wood back in full', () => {
    build.setLumber(new Lumber(10));
    aim(build, [0, 1.5, 3], [0, -0.55, -1]);
    build.tryPlace();

    const id = [...world.store.live()][0]!;
    const box = world.store.readAabb(id);
    aim(build, [(box.minX + box.maxX) / 2, 2.0, (box.minZ + box.maxZ) / 2], [0, -1, 0]);
    expect(build.removeAimed()).toBe(true);
    expect(build.lumber.available).toBe(10);
  });

  it('undo gives the wood back too', () => {
    build.setLumber(new Lumber(20));
    aim(build, [0, 1.5, 3], [0, -0.55, -1]);
    expect(build.tryPlace()).toBe(true);
    const spent = 20 - build.lumber.available;
    expect(spent).toBeGreaterThan(0);
    expect(build.undo()).toBe(true);
    expect(build.lumber.available).toBe(20);
  });

  it('demolishing what you did not buy is not a wood supply', () => {
    // The starter shed, a seeded map and a loaded save all reach the world
    // through applyPlace without being charged. Refunding them would hand out a
    // pile the budget never authorised.
    build.applyPlace({ kind: 0, colorway: 0, x: 0, y: 0.5, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 });
    build.setLumber(new Lumber(10));
    const id = [...world.store.live()][0]!;
    expect(build.applyRemove(id)).toBe(true);
    expect(build.lumber.available).toBe(10);
  });

  it('a reload clears the ledger, so the old world cannot be sold twice', () => {
    build.setLumber(new Lumber(50));
    aim(build, [0, 1.5, 3], [0, -0.55, -1]);
    build.tryPlace();
    const saved = build.serialize();

    build.deserialize(saved);
    const after = build.lumber.available;
    const id = [...world.store.live()][0]!;
    build.applyRemove(id);
    expect(build.lumber.available).toBe(after);
  });

  it('a repeat chain stops when the wood runs out rather than clicking forever', () => {
    build.setLumber(new Lumber(Infinity));
    // Two placements make a step the chain can repeat.
    aim(build, [0, 1.5, 3], [0, -0.55, -1]);
    expect(build.tryPlace()).toBe(true);
    const first = [...world.store.live()][0]!;
    const box = world.store.readAabb(first);
    const cx = (box.minX + box.maxX) / 2;
    const cz = (box.minZ + box.maxZ) / 2;
    aim(build, [cx, 1.6, cz + 1.2], [0, -0.35, -1]);
    expect(build.tryPlace()).toBe(true);
    expect(build.repeatDelta).not.toBeNull();

    const before = world.partCount;
    build.setLumber(new Lumber(0));
    expect(build.repeatPlace()).toBeNull();
    expect(world.partCount).toBe(before);
  });

  it('putting the stack back restores free building', () => {
    build.setLumber(new Lumber(0));
    expect(build.canAffordSelected).toBe(false);
    build.setLumber();
    expect(build.canAffordSelected).toBe(true);
    aim(build, [0, 1.5, 3], [0, -0.55, -1]);
    expect(build.tryPlace()).toBe(true);
  });
});
