import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { CollisionWorld } from '../physics/collisionWorld.ts';
import { BuildSystem } from '../build/buildSystem.ts';
import { PartRenderer } from '../render/partRenderer.ts';
import { Rng } from '../core/rng.ts';
import {
  neighborhoodSlabs, installFixtures, HOUSE, LEFT_FLAG, RIGHT_FLAG,
  LEFT_SPAWN, RIGHT_SPAWN, FORT_YARD, TREEHOUSE, type Slab,
} from './neighborhood.ts';
import { CAP_RADIUS, DT, JUMP_HEIGHT, STEP_HEIGHT } from '../physics/constants.ts';
import { CharacterController, type MoveIntent } from '../player/controller.ts';

const slabs = neighborhoodSlabs(new Rng('test-lot'));

/** World-axis bounds of a slab, for the overlap and clearance checks. */
function bounds(s: Slab) {
  const q = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(s.rx ?? 0, s.ry ?? 0, s.rz ?? 0, 'YXZ'),
  );
  const e = new THREE.Matrix4().makeRotationFromQuaternion(q).elements;
  const h = { x: s.w / 2, y: s.h / 2, z: s.d / 2 };
  const ex = Math.abs(e[0]!) * h.x + Math.abs(e[4]!) * h.y + Math.abs(e[8]!) * h.z;
  const ey = Math.abs(e[1]!) * h.x + Math.abs(e[5]!) * h.y + Math.abs(e[9]!) * h.z;
  const ez = Math.abs(e[2]!) * h.x + Math.abs(e[6]!) * h.y + Math.abs(e[10]!) * h.z;
  return {
    minX: s.x - ex, maxX: s.x + ex,
    minY: s.y - ey, maxY: s.y + ey,
    minZ: s.z - ez, maxZ: s.z + ez,
  };
}

const solid = slabs.filter((s) => s.ghost !== true);

describe('the lot', () => {
  it('is described entirely in finite numbers', () => {
    // A single NaN here becomes a collision box that swallows the whole world,
    // and the symptom is the player unable to move rather than anything visibly
    // wrong with the map.
    for (const s of slabs) {
      for (const v of [s.w, s.h, s.d, s.x, s.y, s.z, s.rx ?? 0, s.ry ?? 0, s.rz ?? 0]) {
        expect(Number.isFinite(v)).toBe(true);
      }
      expect(s.w).toBeGreaterThan(0);
      expect(s.h).toBeGreaterThan(0);
      expect(s.d).toBeGreaterThan(0);
    }
  });

  it('keeps everything inside the fenced lot', () => {
    // The fence is at ±24 and the nav field only covers ±26. Anything outside is
    // scenery nobody can reach and bots cannot route around.
    for (const s of slabs) {
      const b = bounds(s);
      expect(Math.max(Math.abs(b.minX), Math.abs(b.maxX))).toBeLessThan(24);
      expect(Math.max(Math.abs(b.minZ), Math.abs(b.maxZ))).toBeLessThan(24);
      expect(b.minY).toBeGreaterThan(-0.2);
    }
  });

  it('stays under the shadow camera, which only covers ±26 and 160 deep', () => {
    for (const s of slabs) {
      expect(bounds(s).maxY).toBeLessThan(12);
    }
  });

  it('is stable for a given seed', () => {
    const a = neighborhoodSlabs(new Rng('same'));
    const b = neighborhoodSlabs(new Rng('same'));
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      expect(a[i]!.x).toBeCloseTo(b[i]!.x, 9);
      expect(a[i]!.y).toBeCloseTo(b[i]!.y, 9);
      expect(a[i]!.z).toBeCloseTo(b[i]!.z, 9);
    }
  });

  it('does not hand out its own array', () => {
    // The builder reuses a module-level list; returning it directly would let a
    // caller's edits show up in the next map, or worse, in the collision copy.
    const first = neighborhoodSlabs(new Rng('a'));
    const before = first[0]!.x;
    neighborhoodSlabs(new Rng('b'));
    expect(first[0]!.x).toBe(before);
  });
});

describe('the house divides the lot', () => {
  const houseSlab = slabs.find((s) => s.w === HOUSE.halfWidth * 2 && s.h === HOUSE.eaves)!;

  it('exists and spans the middle', () => {
    expect(houseSlab).toBeDefined();
    const b = bounds(houseSlab);
    expect(b.minX).toBeLessThan(0);
    expect(b.maxX).toBeGreaterThan(0);
    expect(b.minY).toBeCloseTo(0, 6);
  });

  it('blocks the straight line between the two flags', () => {
    // The whole premise: you cannot walk from one flag to the other. If this
    // fails the map is a field with a shed in it.
    const b = bounds(houseSlab);
    expect(LEFT_FLAG.x).toBeLessThan(b.minX);
    expect(RIGHT_FLAG.x).toBeGreaterThan(b.maxX);
    expect(LEFT_FLAG.z).toBeGreaterThan(b.minZ);
    expect(LEFT_FLAG.z).toBeLessThan(b.maxZ);
    expect(RIGHT_FLAG.z).toBeGreaterThan(b.minZ);
    expect(RIGHT_FLAG.z).toBeLessThan(b.maxZ);
  });

  it('leaves a way round each end', () => {
    // Blocked is not the same as sealed. There has to be walkable ground past
    // both ends of the house, or the two halves are separate maps.
    //
    // "Walkable" means the player's body, not any geometry at any height: the
    // porch roof crosses the centre line at 2.6m and you stroll underneath it.
    const BODY_LOW = 0.35;
    const BODY_HIGH = 1.5;
    const blocksAt = (z: number) =>
      solid.some((s) => {
        const sb = bounds(s);
        return sb.minZ <= z && sb.maxZ >= z &&
          sb.minX <= 0 && sb.maxX >= 0 &&
          sb.maxY > BODY_LOW && sb.minY < BODY_HIGH;
      });

    const b = bounds(houseSlab);
    const firstClear = (from: number, step: number): number | null => {
      for (let i = 1; i <= 60; i++) {
        const z = from + step * i * 0.25;
        if (!blocksAt(z)) return Math.abs(z - from);
      }
      return null;
    };

    const front = firstClear(b.minZ, -1);
    const back = firstClear(b.maxZ, 1);
    expect(front, 'no way round the front of the house').not.toBeNull();
    expect(back, 'no way round the back of the house').not.toBeNull();
    // And the detour has to be a detour, not a stroll — otherwise the house is
    // scenery and the roof route is pointless.
    expect(front!).toBeGreaterThan(1.5);
    expect(back!).toBeGreaterThan(1.0);
  });

  it('gives both teams the same run to the middle', () => {
    // Fair means equal distances, not identical props.
    expect(Math.abs(LEFT_FLAG.x)).toBeCloseTo(Math.abs(RIGHT_FLAG.x), 6);
    expect(LEFT_FLAG.z).toBeCloseTo(RIGHT_FLAG.z, 6);
    expect(Math.abs(LEFT_SPAWN.x)).toBeCloseTo(Math.abs(RIGHT_SPAWN.x), 6);
    expect(LEFT_SPAWN.z).toBeCloseTo(RIGHT_SPAWN.z, 6);
    expect(Math.sign(LEFT_FLAG.x)).toBe(-Math.sign(RIGHT_FLAG.x));
  });
});

describe('the climb up is deliberately incomplete', () => {
  it('has a porch roof below the eaves', () => {
    expect(HOUSE.porchRoof).toBeLessThan(HOUSE.eaves);
    expect(HOUSE.porchRoof).toBeGreaterThan(2.0);
  });

  it('leaves a gap from the porch roof to the eaves that must be built', () => {
    // Reachable in one step and there is no building to do; unreachable in three
    // and nobody tries. Two-and-a-bit metres is a plank.
    const gap = HOUSE.eaves - HOUSE.porchRoof;
    expect(gap).toBeGreaterThan(1.5);
    expect(gap).toBeLessThan(3.0);
  });

  it('puts the treehouse deck within sight of the roof but not within reach', () => {
    const horizontal = Math.abs(TREEHOUSE.x) - HOUSE.halfWidth;
    expect(horizontal).toBeGreaterThan(5);
    expect(TREEHOUSE.deck).toBeGreaterThan(3.5);
    expect(TREEHOUSE.deck).toBeLessThan(HOUSE.ridge);
  });

  it('has a roof you can actually stand on, not a spike', () => {
    const roofSlabs = slabs.filter((s) => s.rz !== undefined && Math.abs(s.rz) > 0.3 && s.w > 4);
    expect(roofSlabs.length).toBe(2);
    for (const s of roofSlabs) {
      // Past about 35° the character slides off and the roof is decoration.
      expect(Math.abs(s.rz!)).toBeLessThan(0.62);
    }
  });
});

describe('spawns and objectives stand on clear ground', () => {
  const clear = (x: number, z: number, label: string) => {
    for (const s of solid) {
      const b = bounds(s);
      const overlaps =
        x > b.minX - CAP_RADIUS && x < b.maxX + CAP_RADIUS &&
        z > b.minZ - CAP_RADIUS && z < b.maxZ + CAP_RADIUS &&
        b.maxY > 0.35;
      expect(overlaps, `${label} is inside a slab at (${s.x}, ${s.y}, ${s.z})`).toBe(false);
    }
  };

  it('the left spawn is not inside anything', () => clear(LEFT_SPAWN.x, LEFT_SPAWN.z, 'left spawn'));
  it('the right spawn is not inside anything', () => clear(RIGHT_SPAWN.x, RIGHT_SPAWN.z, 'right spawn'));
  it('the left flag is not inside anything', () => clear(LEFT_FLAG.x, LEFT_FLAG.z, 'left flag'));
  it('the right flag is not inside anything', () => clear(RIGHT_FLAG.x, RIGHT_FLAG.z, 'right flag'));
  it('the front lawn objective is not inside anything', () =>
    clear(FORT_YARD.x, FORT_YARD.z, 'front lawn'));
});

describe('fixtures', () => {
  it('installs the solid slabs and skips the decorative ones', () => {
    const world = new CollisionWorld();
    installFixtures(world, slabs);
    expect(world.partCount).toBe(solid.length);
    expect(world.fixtureCount).toBe(solid.length);
    expect(slabs.length).toBeGreaterThan(solid.length);
  });

  it('cannot be removed by a player', () => {
    // A map whose central wall can be deleted is not a map.
    const world = new CollisionWorld();
    installFixtures(world, slabs);
    const before = world.partCount;
    for (const id of [...world.store.live()]) {
      expect(world.isFixture(id)).toBe(true);
    }

    const build = new BuildSystem(world, new PartRenderer());
    for (const id of [...world.store.live()]) {
      expect(build.applyRemove(id)).toBe(false);
    }
    expect(world.partCount).toBe(before);
  });

  it('still lets ordinary parts be removed', () => {
    const world = new CollisionWorld();
    installFixtures(world, slabs);
    const build = new BuildSystem(world, new PartRenderer());
    const id = world.addPart(0, 0, 0, 20, 0, 0, 0, 0, 1, 0.5, 0.125, 0.125).id;
    expect(world.isFixture(id)).toBe(false);
    expect(build.applyRemove(id)).toBe(true);
  });

  it('a removed fixture stops being tracked', () => {
    // The map is never torn down in play, but clearing the world for a new one
    // must not leave stale ids marking future parts as unremovable.
    const world = new CollisionWorld();
    installFixtures(world, slabs);
    const id = [...world.store.live()][0]!;
    world.removePart(id);
    expect(world.isFixture(id)).toBe(false);
    world.clear();
    expect(world.fixtureCount).toBe(0);
  });

  it('leaves the player somewhere they can stand', () => {
    const world = new CollisionWorld();
    installFixtures(world, slabs);
    for (const p of [LEFT_SPAWN, RIGHT_SPAWN]) {
      const cap = {
        ax: p.x, ay: p.y + CAP_RADIUS, az: p.z,
        bx: p.x, by: p.y + 1.4, bz: p.z,
        radius: CAP_RADIUS,
      };
      expect(world.hasRoom(cap), `no room at (${p.x}, ${p.z})`).toBe(true);
    }
  });
});

/**
 * What the map does to a player, rather than what shape it is.
 *
 * These run the real character controller against the real fixtures. The map's
 * design rests entirely on two claims — the house stops you and cannot be
 * climbed, the treehouse ladder can — and both are the kind of thing that is
 * true when written and quietly false three changes later.
 */
describe('moving around the lot', () => {
  const intent = (over: Partial<MoveIntent> = {}): MoveIntent => ({
    forward: 0, right: 0, jump: false, sprint: false, crouch: false, climb: 0, ...over,
  });

  function walk(from: { x: number; z: number }, dir: { x: number; z: number }, seconds: number) {
    const world = new CollisionWorld();
    installFixtures(world, slabs);
    const player = new CharacterController(world, from.x, 0.5, from.z);
    const len = Math.hypot(dir.x, dir.z);
    for (let i = 0; i < Math.round(seconds * 60); i++) {
      player.step(DT, intent({ right: dir.x / len, forward: dir.z / len }));
    }
    return player;
  }

  it('the house stops you walking through it', () => {
    // Straight at the middle of the house from the left yard.
    const p = walk({ x: -14, z: 0 }, { x: 1, z: 0 }, 6);
    expect(p.x).toBeLessThan(-HOUSE.halfWidth);
  });

  it('the divider fence stops you crossing away from a gate', () => {
    const p = walk({ x: -6, z: 18 }, { x: 1, z: 0 }, 6);
    expect(p.x).toBeLessThan(0);
  });

  it('you can walk through a gate', () => {
    // The back gap sits at z 12.5..15.5; aim down the middle of it.
    const p = walk({ x: -6, z: 14 }, { x: 1, z: 0 }, 6);
    expect(p.x).toBeGreaterThan(0.5);
  });

  it('you cannot climb the house wall', () => {
    // The whole design rests on this. Any near-vertical surface is climbable for
    // player-built parts, and if that rule reached the map the roof would be a
    // free ride and the house would divide nothing.
    const world = new CollisionWorld();
    installFixtures(world, slabs);
    const player = new CharacterController(world, -HOUSE.halfWidth - 0.5, 0.5, 0);
    for (let i = 0; i < 60 * 5; i++) {
      player.step(DT, intent({ right: 1, climb: 1 }));
    }
    expect(player.y).toBeLessThan(1.0);
  });

  it('you can climb the treehouse ladder', () => {
    const world = new CollisionWorld();
    installFixtures(world, slabs);
    // Facing the rungs, which are on the -Z face of the trunk.
    const player = new CharacterController(world, TREEHOUSE.x, 0.5, TREEHOUSE.z - 1.4);
    for (let i = 0; i < 60 * 8; i++) {
      player.step(DT, intent({ forward: 1, climb: 1 }));
    }
    expect(player.y).toBeGreaterThan(2.5);
  });

  it('the roof holds you up', () => {
    const world = new CollisionWorld();
    installFixtures(world, slabs);
    // Dropped just above the eaves, on the slope.
    const player = new CharacterController(world, 3.0, HOUSE.eaves + 2.5, 0);
    for (let i = 0; i < 60 * 4; i++) player.step(DT, intent());
    expect(player.onGround).toBe(true);
    expect(player.y).toBeGreaterThan(HOUSE.eaves - 0.5);
  });

  it('the porch roof is a real ledge, not a lip', () => {
    const world = new CollisionWorld();
    installFixtures(world, slabs);
    const player = new CharacterController(world, 0, HOUSE.porchRoof + 2.0, -8.0);
    for (let i = 0; i < 60 * 4; i++) player.step(DT, intent());
    expect(player.onGround).toBe(true);
    expect(player.y).toBeGreaterThan(HOUSE.porchRoof - 0.4);
  });

  it('you cannot simply jump from the porch roof to the eaves', () => {
    // If you could, there would be no reason to build anything.
    expect(HOUSE.eaves - HOUSE.porchRoof).toBeGreaterThan(JUMP_HEIGHT + STEP_HEIGHT);
  });
});
