import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { CollisionWorld } from '../physics/collisionWorld.ts';
import { PartRenderer } from '../render/partRenderer.ts';
import { BuildSystem } from './buildSystem.ts';
import { MODULE, PART_KINDS, halfExtents, getPartKind } from './partKit.ts';
import { Snapper, MAX_REACH } from './snapping.ts';
import { Lumber } from './lumber.ts';

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

describe('part kit', () => {
  it('has one kind per hotbar slot with unique keys', () => {
    expect(PART_KINDS.length).toBe(8);
    expect(new Set(PART_KINDS.map((k) => k.key)).size).toBe(8);
    PART_KINDS.forEach((k, i) => expect(k.id).toBe(i));
  });

  it('plank width is exactly one module, so planks tile with no gap', () => {
    const plank = getPartKind(0);
    expect(plank.width).toBeCloseTo(MODULE, 9);
    // Four laid side by side span exactly a metre.
    expect(plank.width * 4).toBeCloseTo(1.0, 9);
  });

  it('every length is a whole number of modules, so parts butt without drift', () => {
    for (const kind of PART_KINDS) {
      const inModules = kind.length / MODULE;
      expect(Math.abs(inModules - Math.round(inModules))).toBeLessThan(1e-9);
    }
  });

  it('board thickness divides the module exactly', () => {
    const plank = getPartKind(0);
    const perModule = MODULE / plank.thickness;
    expect(Math.abs(perModule - Math.round(perModule))).toBeLessThan(1e-9);
  });

  it('half-extents are half the dimensions', () => {
    const beam = getPartKind(3);
    const h = halfExtents(beam);
    expect(h.hx).toBeCloseTo(beam.length / 2);
    expect(h.hy).toBeCloseTo(beam.thickness / 2);
    expect(h.hz).toBeCloseTo(beam.width / 2);
  });
});

describe('BuildSystem placement', () => {
  let world: CollisionWorld;
  let renderer: PartRenderer;
  let build: BuildSystem;

  beforeEach(() => {
    world = new CollisionWorld();
    renderer = new PartRenderer();
    build = new BuildSystem(world, renderer);
  });

  it('places a part on the ground and it appears in the world', () => {
    aim(build, [0, 1.5, 3], [0, -0.55, -1]);
    expect(build.tryPlace()).toBe(true);
    expect(world.partCount).toBe(1);
    expect(renderer.instanceCount).toBe(1);
  });

  it('a placed part rests on or above the ground plane', () => {
    aim(build, [0, 1.5, 3], [0, -0.55, -1]);
    build.tryPlace();
    const id = [...world.store.live()][0]!;
    const aabb = world.store.readAabb(id);
    expect(aabb.minY).toBeGreaterThan(-0.01);
  });

  it('a second part snaps flush onto the first rather than intersecting it', () => {
    aim(build, [0, 1.5, 3], [0, -0.55, -1]);
    build.tryPlace();
    const first = [...world.store.live()][0]!;
    const firstBox = world.store.readAabb(first);

    // Aim at the top of what was just placed.
    const cx = (firstBox.minX + firstBox.maxX) / 2;
    const cz = (firstBox.minZ + firstBox.maxZ) / 2;
    const result = aim(build, [cx, 1.6, cz + 1.2], [0, -0.35, -1]);
    expect(result.candidate).not.toBeNull();
    expect(build.tryPlace()).toBe(true);
    expect(world.partCount).toBe(2);

    // No two parts may overlap: their AABBs may touch but not interpenetrate.
    const ids = [...world.store.live()];
    const a = world.store.readAabb(ids[0]!);
    const b = world.store.readAabb(ids[1]!);
    const overlapY = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
    const overlapX = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
    const overlapZ = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);
    const interpenetrating = overlapX > 0.01 && overlapY > 0.01 && overlapZ > 0.01;
    expect(interpenetrating).toBe(false);
  });

  it('refuses to place beyond reach', () => {
    // Aim at nothing, far above the world.
    const result = aim(build, [0, 1.5, 0], [0, 1, 0]);
    // Anything chosen must still respect the reach limit.
    if (result.candidate !== null && result.candidate.valid) {
      const d = result.candidate.position.distanceTo(new THREE.Vector3(0, 1.5, 0));
      expect(d).toBeLessThanOrEqual(MAX_REACH + 1e-6);
    }
  });

  it('removes the part under the crosshair', () => {
    aim(build, [0, 1.5, 3], [0, -0.55, -1]);
    build.tryPlace();
    expect(world.partCount).toBe(1);

    const id = [...world.store.live()][0]!;
    const box = world.store.readAabb(id);
    aim(build, [(box.minX + box.maxX) / 2, 2.0, (box.minZ + box.maxZ) / 2], [0, -1, 0]);
    expect(build.removeAimed()).toHaveLength(1);
    expect(world.partCount).toBe(0);
    expect(renderer.instanceCount).toBe(0);
  });

  describe('and everything it was holding up', () => {
    // The rule the title screen has promised since the first commit — *build it
    // yourself, then find out if it holds* — checked against the real
    // collision world rather than against boxes in a fixture, because the
    // interesting half is whether the thing that knows where parts are and the
    // thing that decides what is standing agree about contact.
    const stack = (n: number): number[] => {
      const kind = getPartKind(0);
      const half = kind.thickness / 2;
      const records = [];
      for (let i = 0; i < n; i++) {
        records.push({
          kind: 0, colorway: 0,
          x: 0, y: half + i * kind.thickness, z: 3,
          qx: 0, qy: 0, qz: 0, qw: 1,
        });
      }
      return build.stamp(records);
    };

    it('brings a tower down when its bottom plank goes', () => {
      const ids = stack(5);
      expect(ids).toHaveLength(5);
      expect(build.demolish(ids[0]!)).toEqual(ids.slice().sort((a, b) => a - b));
      expect(world.partCount).toBe(0);
      expect(renderer.instanceCount).toBe(0);
    });

    it('takes only the top off when the top goes', () => {
      const ids = stack(5);
      expect(build.demolish(ids[4]!)).toEqual([ids[4]!]);
      expect(world.partCount).toBe(4);
    });

    it('cuts it in half in the middle', () => {
      const ids = stack(5);
      const down = build.demolish(ids[2]!);
      expect(down).toContain(ids[2]!);
      expect(down).toHaveLength(3);
      expect(world.partCount).toBe(2);
    });

    it('leaves the renderer with exactly what is left standing', () => {
      // The failure this catches is a part removed from physics and not from
      // the picture: a plank you can walk through, still there.
      const ids = stack(4);
      build.demolish(ids[1]!);
      expect(renderer.instanceCount).toBe(world.partCount);
      expect(renderer.instanceCount).toBe(1);
    });

    it('refuses to demolish the map, and brings nothing down trying', () => {
      stack(3);
      const fixture = world.addFixture(0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 1, 1, null, {}).id;
      // Counted after the fixture exists, because `partCount` counts it too.
      const before = world.partCount;
      expect(build.demolish(fixture)).toEqual([]);
      expect(world.partCount).toBe(before);
    });

    it('leaves a part alone that never touched the one that went', () => {
      const ids = stack(2);
      aim(build, [8, 1.5, 8], [0, -1, 0]);
      build.tryPlace();
      const before = world.partCount;
      expect(build.demolish(ids[0]!)).toHaveLength(2);
      expect(world.partCount).toBe(before - 2);
    });

    it('gives back the wood for everything that fell, not just the one aimed at', () => {
      // Two arguments both defensible — you built it badly, you keep the loss —
      // and the refund is the one that matches every other rule in the game:
      // `reclaim` pays back whatever the player paid for a part, and a plank
      // that fell over is still a plank they own.
      build.setLumber(new Lumber(200));
      const spent = build.lumber.available;
      const ids = stack(4);
      const afterBuilding = build.lumber.available;
      expect(afterBuilding).toBeLessThan(spent);
      build.demolish(ids[0]!);
      expect(build.lumber.available).toBe(spent);
    });
  });

  it('undo takes back the most recent placement', () => {
    // Spaced well apart so each is an independent ground placement rather than
    // snapping onto (and being rejected against) the one before it.
    for (let i = 0; i < 3; i++) {
      aim(build, [i * 6, 1.5, 3], [0, -0.55, -1]);
      expect(build.tryPlace()).toBe(true);
    }
    expect(world.partCount).toBe(3);
    expect(build.undo()).toBe(true);
    expect(world.partCount).toBe(2);
    expect(renderer.instanceCount).toBe(2);
  });

  it('selecting a different kind places that kind', () => {
    build.selectKind(3);
    aim(build, [0, 1.5, 3], [0, -0.55, -1]);
    build.tryPlace();
    const id = [...world.store.live()][0]!;
    expect(world.store.kind[id]).toBe(3);
  });
});

describe('BuildSystem serialization', () => {
  it('round-trips the world through plain records', () => {
    const world = new CollisionWorld();
    const build = new BuildSystem(world, new PartRenderer());

    for (let i = 0; i < 12; i++) {
      build.applyPlace({
        kind: i % PART_KINDS.length,
        colorway: i % 8,
        x: i * 0.5, y: 0.4 + (i % 3) * MODULE, z: -i * 0.25,
        qx: 0, qy: Math.sin(i * 0.2), qz: 0, qw: Math.cos(i * 0.2),
      });
    }

    const saved = build.serialize();
    expect(saved.length).toBe(12);

    const world2 = new CollisionWorld();
    const build2 = new BuildSystem(world2, new PartRenderer());
    build2.deserialize(saved);

    expect(world2.partCount).toBe(12);
    const resaved = build2.serialize();
    expect(resaved.length).toBe(saved.length);

    // Quantization is applied on the way in, so a second round trip is exact.
    for (let i = 0; i < saved.length; i++) {
      expect(resaved[i]!.kind).toBe(saved[i]!.kind);
      expect(resaved[i]!.colorway).toBe(saved[i]!.colorway);
      expect(resaved[i]!.x).toBeCloseTo(saved[i]!.x, 6);
      expect(resaved[i]!.y).toBeCloseTo(saved[i]!.y, 6);
      expect(resaved[i]!.z).toBeCloseTo(saved[i]!.z, 6);
    }
  });

  it('records are JSON-safe, which is what makes them a wire format', () => {
    const world = new CollisionWorld();
    const build = new BuildSystem(world, new PartRenderer());
    build.applyPlace({ kind: 0, colorway: 1, x: 1, y: 2, z: 3, qx: 0, qy: 0, qz: 0, qw: 1 });
    const json = JSON.stringify(build.serialize());
    const parsed = JSON.parse(json);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].kind).toBe(0);
    expect(typeof parsed[0].x).toBe('number');
  });

  it('quantizes to a millimetre, so two clients agree on what was placed', () => {
    const world = new CollisionWorld();
    const build = new BuildSystem(world, new PartRenderer());
    build.applyPlace({
      kind: 0, colorway: 0,
      x: 1.23456789, y: 0.5, z: -2.7182818,
      qx: 0, qy: 0, qz: 0, qw: 1,
    });
    const [rec] = build.serialize();
    expect(rec!.x).toBeCloseTo(1.235, 9);
    expect(rec!.z).toBeCloseTo(-2.718, 9);
  });
});

describe('Snapper stability', () => {
  it('holds the same candidate across tiny aim jitter', () => {
    const world = new CollisionWorld();
    const build = new BuildSystem(world, new PartRenderer());
    build.applyPlace({ kind: 1, colorway: 0, x: 0, y: 0.5, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 });

    const first = aim(build, [0, 1.6, 2.5], [0, -0.42, -1]);
    expect(first.candidate).not.toBeNull();
    const kind0 = first.candidate!.kind;
    const pos0 = first.candidate!.position.clone();

    // Jitter the aim by a fraction of a degree, as a hand would.
    let changes = 0;
    for (let i = 0; i < 40; i++) {
      const wobble = (i % 2 === 0 ? 1 : -1) * 0.0015;
      const r = aim(build, [wobble, 1.6, 2.5], [wobble, -0.42, -1]);
      if (r.candidate === null) continue;
      if (r.candidate.kind !== kind0 || r.candidate.position.distanceTo(pos0) > 0.02) changes++;
    }
    // The ghost must not strobe between near-tied candidates.
    expect(changes).toBe(0);
  });

  it('generates candidates without allocating unbounded memory', () => {
    const world = new CollisionWorld();
    const build = new BuildSystem(world, new PartRenderer());
    for (let i = 0; i < 60; i++) {
      build.applyPlace({
        kind: 0, colorway: 0,
        x: (i % 10) * MODULE, y: 0.5 + Math.floor(i / 10) * MODULE, z: 0,
        qx: 0, qy: 0, qz: 0, qw: 1,
      });
    }
    const r = aim(build, [0.5, 1.6, 2.0], [0, -0.3, -1]);
    expect(r.count).toBeGreaterThan(0);
    // One candidate per face of each nearby part, plus ground and free.
    expect(r.count).toBeLessThan(60 * 6 + 10);
  });

  it('a fresh Snapper picks something for an empty world', () => {
    const world = new CollisionWorld();
    const snapper = new Snapper(world);
    const result = snapper.solve({
      ox: 0, oy: 1.6, oz: 0,
      dx: 0, dy: -0.5, dz: -1,
      kind: getPartKind(0),
      yawSteps: 0, pitchSteps: 0, rollSteps: 0,
      freeAim: false, fine: false, cycleIndex: 0,
    });
    // Ground and free are always available, even with nothing built.
    expect(result.candidate).not.toBeNull();
    expect(result.count).toBeGreaterThanOrEqual(2);
  });
});
