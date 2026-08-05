import { describe, it, expect } from 'vitest';
import { CollisionWorld } from '../physics/collisionWorld.ts';
import { PartRenderer } from '../render/partRenderer.ts';
import { BuildSystem } from './buildSystem.ts';
import { CharacterController, type MoveIntent } from '../player/controller.ts';
import { DT } from '../physics/constants.ts';
import { PART_KINDS, collisionProxy, getPartKind } from './partKit.ts';

const RAMP = PART_KINDS.findIndex((k) => k.key === 'ramp');

const idle: MoveIntent = {
  forward: 0, right: 0, jump: false, sprint: false, crouch: false, climb: 0,
};
const intent = (o: Partial<MoveIntent> = {}): MoveIntent => ({ ...idle, ...o });

function run(c: CharacterController, seconds: number, mi: MoveIntent = idle): void {
  for (let i = 0; i < Math.round(seconds / DT); i++) c.step(DT, mi);
}

describe('collisionProxy', () => {
  it('is null for box parts, so they collide as themselves', () => {
    for (const kind of PART_KINDS) {
      if (!kind.isWedge) expect(collisionProxy(kind)).toBeNull();
    }
  });

  it('gives the wedge a slab lying along its slope', () => {
    const ramp = getPartKind(RAMP);
    const proxy = collisionProxy(ramp)!;
    expect(proxy).not.toBeNull();

    const hx = ramp.length / 2;
    const hy = ramp.thickness / 2;
    // The slab spans the full slope, which is the diagonal of the wedge.
    expect(proxy.hx).toBeCloseTo(Math.hypot(hx, hy), 9);
    expect(proxy.hz).toBeCloseTo(ramp.width / 2, 9);
    // Thin, and never thicker than the wedge itself.
    expect(proxy.hy * 2).toBeLessThanOrEqual(ramp.thickness);

    // Rotated about Z only, by the slope angle.
    expect(proxy.qx).toBe(0);
    expect(proxy.qy).toBe(0);
    const theta = -Math.atan2(hy, hx);
    expect(proxy.qz).toBeCloseTo(Math.sin(theta / 2), 9);
    expect(proxy.qw).toBeCloseTo(Math.cos(theta / 2), 9);
  });

  it('sinks the slab so its top face lands on the slope plane', () => {
    const ramp = getPartKind(RAMP);
    const proxy = collisionProxy(ramp)!;
    const hx = ramp.length / 2;
    const hy = ramp.thickness / 2;
    const half = Math.hypot(hx, hy);
    // Slope outward normal.
    const nx = hy / half;
    const ny = hx / half;
    // The offset must be exactly half a thickness along -normal.
    expect(proxy.ox).toBeCloseTo(-nx * proxy.hy, 9);
    expect(proxy.oy).toBeCloseTo(-ny * proxy.hy, 9);
    expect(proxy.oz).toBe(0);
  });
});

describe('ramp collision', () => {
  it('the walkable surface follows the slope, not the bounding box', () => {
    const world = new CollisionWorld();
    const build = new BuildSystem(world, new PartRenderer());
    const ramp = getPartKind(RAMP);

    // A ramp sitting on the ground, tall end at -X.
    build.applyPlace({
      kind: RAMP, colorway: 0,
      x: 0, y: ramp.thickness / 2, z: 0,
      qx: 0, qy: 0, qz: 0, qw: 1,
    });

    // Cast down at several points along the ramp. The surface height must fall
    // from the tall end to the thin end; a bounding box would return the same
    // height everywhere, which is exactly the invisible-wall bug.
    const heights: number[] = [];
    for (const x of [-0.4, -0.2, 0, 0.2, 0.4]) {
      const hit = world.raycast(x, 3, 0, 0, -1, 0, 5);
      expect(hit).not.toBeNull();
      heights.push(hit!.y);
    }

    for (let i = 1; i < heights.length; i++) {
      expect(heights[i]!).toBeLessThan(heights[i - 1]!);
    }
    // The tall end is near full height, the thin end near the ground.
    expect(heights[0]!).toBeGreaterThan(ramp.thickness * 0.7);
    expect(heights[heights.length - 1]!).toBeLessThan(ramp.thickness * 0.35);
  });

  it('a player can walk up a ramp instead of hitting an invisible wall', () => {
    const world = new CollisionWorld();
    const build = new BuildSystem(world, new PartRenderer());
    const ramp = getPartKind(RAMP);

    // Two ramps end to end, so there is a run long enough to measure a climb.
    for (let i = 0; i < 2; i++) {
      build.applyPlace({
        kind: RAMP, colorway: 0,
        // Flipped so the slope rises along +X: rotate 180 degrees about Y.
        x: -1.0 + i * ramp.length, y: ramp.thickness / 2, z: 0,
        qx: 0, qy: 1, qz: 0, qw: 0,
      });
    }

    const c = new CharacterController(world, -1.9, 0.05, 0);
    run(c, 0.4);
    const startY = c.y;
    run(c, 1.4, intent({ right: 1 }));

    // Climbed the slope rather than being stopped at its foot.
    expect(c.y).toBeGreaterThan(startY + ramp.thickness * 0.4);
    expect(c.x).toBeGreaterThan(-1.0);
  });

  it('serialization round-trips a ramp back to where it was placed', () => {
    const world = new CollisionWorld();
    const build = new BuildSystem(world, new PartRenderer());
    const ramp = getPartKind(RAMP);

    const original = {
      kind: RAMP, colorway: 2,
      x: 1.5, y: ramp.thickness / 2, z: -2.25,
      qx: 0, qy: Math.sin(Math.PI / 8), qz: 0, qw: Math.cos(Math.PI / 8),
    };
    build.applyPlace(original);

    const [saved] = build.serialize();
    expect(saved).toBeDefined();
    // The collision proxy is offset and rotated relative to the part; saving the
    // collision basis instead of the part's own would reload the ramp displaced
    // and rotated onto its own slope.
    expect(saved!.x).toBeCloseTo(original.x, 3);
    expect(saved!.y).toBeCloseTo(original.y, 3);
    expect(saved!.z).toBeCloseTo(original.z, 3);
    expect(saved!.qy).toBeCloseTo(original.qy, 3);
    expect(saved!.qw).toBeCloseTo(original.qw, 3);
  });

  it('a reloaded ramp collides the same as the original', () => {
    const world = new CollisionWorld();
    const build = new BuildSystem(world, new PartRenderer());
    const ramp = getPartKind(RAMP);

    build.applyPlace({
      kind: RAMP, colorway: 0,
      x: 0, y: ramp.thickness / 2, z: 0,
      qx: 0, qy: 0, qz: 0, qw: 1,
    });
    const before = world.raycast(-0.3, 3, 0, 0, -1, 0, 5)!.y;

    build.deserialize(build.serialize());
    const after = world.raycast(-0.3, 3, 0, 0, -1, 0, 5)!.y;

    expect(after).toBeCloseTo(before, 3);
  });
});
