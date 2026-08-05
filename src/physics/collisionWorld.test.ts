import { describe, it, expect } from 'vitest';
import { CollisionWorld, rayVsObb } from './collisionWorld.ts';
import { makeObb } from './partStore.ts';
import { CAP_RADIUS, CAP_HALF_SPINE, SKIN } from './constants.ts';
import type { Capsule } from './types.ts';

/** Identity rotation. */
const I = [0, 0, 0, 1] as const;

/** A standing capsule whose feet are at `y`. */
function standing(x: number, y: number, z: number): Capsule {
  return {
    ax: x, ay: y + CAP_RADIUS, az: z,
    bx: x, by: y + CAP_RADIUS + CAP_HALF_SPINE * 2, bz: z,
    radius: CAP_RADIUS,
  };
}

/** Feet height of a capsule. */
const feet = (c: Capsule) => c.ay - CAP_RADIUS;

describe('rayVsObb', () => {
  it('hits a box straight on and reports the entry face normal', () => {
    const box = makeObb();
    box.cx = 5; box.hx = 1; box.hy = 1; box.hz = 1;
    const n = { x: 0, y: 0, z: 0 };
    const t = rayVsObb(0, 0, 0, 1, 0, 0, box, 100, n);
    expect(t).toBeCloseTo(4, 6);
    expect(n.x).toBeCloseTo(-1, 6);
  });

  it('misses a box off to the side', () => {
    const box = makeObb();
    box.cx = 5; box.cy = 10; box.hx = 1; box.hy = 1; box.hz = 1;
    const n = { x: 0, y: 0, z: 0 };
    expect(rayVsObb(0, 0, 0, 1, 0, 0, box, 100, n)).toBe(-1);
  });

  it('misses when the box is beyond maxDistance', () => {
    const box = makeObb();
    box.cx = 50; box.hx = 1; box.hy = 1; box.hz = 1;
    const n = { x: 0, y: 0, z: 0 };
    expect(rayVsObb(0, 0, 0, 1, 0, 0, box, 10, n)).toBe(-1);
  });

  it('reports the top face for a ray coming down', () => {
    const box = makeObb();
    box.hx = 2; box.hy = 0.1; box.hz = 2;
    const n = { x: 0, y: 0, z: 0 };
    const t = rayVsObb(0, 5, 0, 0, -1, 0, box, 100, n);
    expect(t).toBeCloseTo(4.9, 6);
    expect(n.y).toBeCloseTo(1, 6);
  });
});

describe('CollisionWorld raycast', () => {
  it('hits the ground plane', () => {
    const w = new CollisionWorld();
    const hit = w.raycast(0, 5, 0, 0, -1, 0, 100);
    expect(hit).not.toBeNull();
    expect(hit!.isGround).toBe(true);
    expect(hit!.y).toBeCloseTo(0, 6);
    expect(hit!.ny).toBeCloseTo(1, 6);
  });

  it('prefers a part over the ground behind it', () => {
    const w = new CollisionWorld();
    w.addPart(0, 0, 0, 2, 0, ...I, 1, 0.1, 1);
    const hit = w.raycast(0, 5, 0, 0, -1, 0, 100);
    expect(hit!.isGround).toBe(false);
    expect(hit!.y).toBeCloseTo(2.1, 6);
  });

  it('returns the nearest of several parts', () => {
    const w = new CollisionWorld();
    w.addPart(0, 0, 10, 0, 0, ...I, 0.5, 0.5, 0.5);
    const near = w.addPart(0, 0, 3, 0, 0, ...I, 0.5, 0.5, 0.5);
    w.addPart(0, 0, 6, 0, 0, ...I, 0.5, 0.5, 0.5);
    w.hasGround = false;
    const hit = w.raycast(0, 0, 0, 1, 0, 0, 100);
    expect(hit!.part).toBe(near.id);
    expect(hit!.distance).toBeCloseTo(2.5, 6);
  });

  it('does not hit a removed part', () => {
    const w = new CollisionWorld();
    const h = w.addPart(0, 0, 3, 0, 0, ...I, 0.5, 0.5, 0.5);
    w.hasGround = false;
    expect(w.raycast(0, 0, 0, 1, 0, 0, 100)).not.toBeNull();
    w.removePart(h.id);
    expect(w.raycast(0, 0, 0, 1, 0, 0, 100)).toBeNull();
  });

  it('finds a part far down a long ray', () => {
    const w = new CollisionWorld();
    w.hasGround = false;
    w.addPart(0, 0, 40, 0, 0, ...I, 0.5, 0.5, 0.5);
    const hit = w.raycast(0, 0, 0, 1, 0, 0, 60);
    expect(hit).not.toBeNull();
    expect(hit!.distance).toBeCloseTo(39.5, 5);
  });
});

describe('CollisionWorld standing and falling', () => {
  it('lands on the ground plane rather than sinking through', () => {
    const w = new CollisionWorld();
    const cap = standing(0, 5, 0);
    let res = w.moveAndSlide(cap, 0, -5, 0, 0, -10, 0);
    // Repeated ticks must settle, not oscillate.
    for (let i = 0; i < 10; i++) res = w.moveAndSlide(cap, 0, -0.2, 0, 0, -10, 0);
    expect(res.onGround).toBe(true);
    expect(feet(cap)).toBeGreaterThan(-0.01);
    expect(feet(cap)).toBeLessThan(0.05);
  });

  it('stands on a placed platform', () => {
    const w = new CollisionWorld();
    // A 4x4 platform with its top surface at y = 1.
    w.addPart(0, 0, 0, 0.95, 0, ...I, 2, 0.05, 2);
    const cap = standing(0, 3, 0);
    let res = w.moveAndSlide(cap, 0, -3, 0, 0, -10, 0);
    for (let i = 0; i < 10; i++) res = w.moveAndSlide(cap, 0, -0.2, 0, 0, -10, 0);
    expect(res.onGround).toBe(true);
    expect(feet(cap)).toBeGreaterThan(0.99);
    expect(feet(cap)).toBeLessThan(1.05);
  });

  it('does not fall through a thin board', () => {
    const w = new CollisionWorld();
    w.hasGround = false;
    // A single 40mm-thick plank, the thinnest lumber in the kit.
    w.addPart(0, 0, 0, 1, 0, ...I, 3, 0.02, 3);
    const cap = standing(0, 3, 0);
    for (let i = 0; i < 60; i++) w.moveAndSlide(cap, 0, -0.25, 0, 0, -15, 0);
    expect(feet(cap)).toBeGreaterThan(1.0);
  });

  it('is blocked by a wall', () => {
    const w = new CollisionWorld();
    // A wall across the path at x = 2.
    w.addPart(0, 0, 2, 1.5, 0, ...I, 0.05, 1.5, 3);
    const cap = standing(0, 0.01, 0);
    for (let i = 0; i < 40; i++) w.moveAndSlide(cap, 0.15, 0, 0, 5, 0, 0);
    // Stopped just short of the wall face at x = 1.95.
    expect(cap.ax).toBeLessThan(1.95 - CAP_RADIUS + 0.02);
    expect(cap.ax).toBeGreaterThan(1.0);
  });

  it('slides along a wall instead of sticking', () => {
    const w = new CollisionWorld();
    w.addPart(0, 0, 2, 1.5, 0, ...I, 0.05, 1.5, 8);
    const cap = standing(0, 0.01, 0);
    // Push diagonally into the wall; the z component should survive.
    for (let i = 0; i < 40; i++) w.moveAndSlide(cap, 0.15, 0, 0.15, 5, 0, 5);
    expect(cap.az).toBeGreaterThan(3);
  });
});

describe('CollisionWorld — flush boards', () => {
  /**
   * The artefact this whole design exists to avoid: two boards laid edge to edge
   * form a continuous floor, but the seam between them is an internal edge. An
   * unfiltered edge contact there has a diagonal normal that shoves the player
   * sideways as they cross it.
   */
  it('walking across a seam between flush boards does not deflect sideways', () => {
    const w = new CollisionWorld();
    w.hasGround = false;
    // Two 2m boards meeting exactly at x = 0, top surface at y = 1.
    w.addPart(0, 0, -1, 0.95, 0, ...I, 1, 0.05, 3);
    w.addPart(0, 0, 1, 0.95, 0, ...I, 1, 0.05, 3);

    const cap = standing(-0.8, 1.02, 0);
    const startZ = cap.az;

    // Walk straight across the seam.
    for (let i = 0; i < 60; i++) {
      w.moveAndSlide(cap, 0.03, -0.02, 0, 3, -2, 0);
    }

    // Crossed the seam.
    expect(cap.ax).toBeGreaterThan(0.2);
    // And never got kicked off the intended straight line.
    expect(Math.abs(cap.az - startZ)).toBeLessThan(0.02);
    // And stayed on top of the boards.
    expect(feet(cap)).toBeGreaterThan(0.95);
  });

  it('does not snag on the seam and stall', () => {
    const w = new CollisionWorld();
    w.hasGround = false;
    for (let i = 0; i < 6; i++) {
      w.addPart(0, 0, i * 0.5, 0.95, 0, ...I, 0.25, 0.05, 3);
    }
    const cap = standing(-0.4, 1.02, 0);
    const startX = cap.ax;
    for (let i = 0; i < 80; i++) w.moveAndSlide(cap, 0.04, -0.02, 0, 3, -2, 0);
    // Crossed every seam without getting stuck on one.
    expect(cap.ax - startX).toBeGreaterThan(2.0);
  });
});

describe('CollisionWorld — player-built structures', () => {
  it('a staircase of stacked boards can be walked up', () => {
    const w = new CollisionWorld();
    // Ten steps: 0.25 rise, 0.5 run — the kit's comfortable stair.
    for (let i = 0; i < 10; i++) {
      const y = 0.25 * (i + 1);
      const x = 0.5 * i + 0.25;
      w.addPart(0, 0, x, y - 0.025, 0, ...I, 0.25, 0.025, 1.5);
      // Filled-in riser below each tread, as a player would build it.
      w.addPart(0, 0, x, y / 2, 0, ...I, 0.25, y / 2, 1.5);
    }

    const cap = standing(-0.5, 0.01, 0);
    // Walk forward with gravity, letting the step-up logic in the controller be
    // exercised later; here we only require that the geometry is climbable by
    // the solver when pushed up a slope-like sequence.
    for (let i = 0; i < 200; i++) {
      w.moveAndSlide(cap, 0.03, 0.02, 0, 3, 2, 0);
    }
    expect(cap.ax).toBeGreaterThan(1.0);
  });

  it('a capsule spawned inside geometry is pushed out, not trapped', () => {
    const w = new CollisionWorld();
    w.hasGround = false;
    w.addPart(0, 0, 0, 0, 0, ...I, 1, 1, 1);
    const cap = standing(0, -0.5, 0);
    const moved = w.depenetrate(cap);
    expect(moved).toBe(true);
    // Fully clear of the box afterwards.
    const contacts = w.gatherContacts(cap, 0);
    for (const c of contacts) expect(c.depth).toBeLessThan(SKIN + 1e-6);
  });

  it('hasRoom reports blocked when a ceiling is too low', () => {
    const w = new CollisionWorld();
    w.addPart(0, 0, 0, 1.2, 0, ...I, 2, 0.05, 2);
    // A standing capsule needs 1.7m; the ceiling underside is at 1.15.
    expect(w.hasRoom(standing(0, 0, 0))).toBe(false);
    // A crouched one fits.
    const crouched: Capsule = {
      ax: 0, ay: CAP_RADIUS, az: 0,
      bx: 0, by: 1.1 - CAP_RADIUS, bz: 0,
      radius: CAP_RADIUS,
    };
    expect(w.hasRoom(crouched)).toBe(true);
  });
});

describe('CollisionWorld — scale', () => {
  it('gathering stays cheap with thousands of parts in the world', () => {
    const w = new CollisionWorld();
    // A dense fort near the origin plus a large sprawl far away.
    for (let i = 0; i < 200; i++) {
      w.addPart(0, 0, (i % 10) * 0.3, Math.floor(i / 10) * 0.3, 0, ...I, 0.15, 0.02, 0.5);
    }
    for (let i = 0; i < 3000; i++) {
      w.addPart(0, 0, 50 + (i % 60), (i % 7) * 0.4, Math.floor(i / 60), ...I, 0.15, 0.02, 0.5);
    }
    expect(w.partCount).toBe(3200);

    const cap = standing(1.5, 1.0, 0);
    // Warm up.
    for (let i = 0; i < 2000; i++) w.gatherContacts(cap, 0.04);

    const iterations = 20_000;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) w.gatherContacts(cap, 0.04);
    const usPerGather = ((performance.now() - start) * 1000) / iterations;

    // A tick does a handful of gathers; even 50us each leaves the frame budget
    // untouched. Generous bound so CI noise does not flake this.
    expect(usPerGather).toBeLessThan(200);
  });

  it('adding and removing parts keeps the broadphase consistent', () => {
    const w = new CollisionWorld();
    w.hasGround = false;
    const handles = [];
    for (let i = 0; i < 500; i++) {
      handles.push(w.addPart(0, 0, i * 0.5, 0, 0, ...I, 0.2, 0.2, 0.2));
    }
    // Remove every other one.
    for (let i = 0; i < handles.length; i += 2) w.removePart(handles[i]!.id);
    expect(w.partCount).toBe(250);

    // Survivors are still hittable; removed ones are not.
    for (let i = 1; i < 20; i += 2) {
      const hit = w.raycast(i * 0.5, 5, 0, 0, -1, 0, 10);
      expect(hit).not.toBeNull();
      expect(hit!.part).toBe(handles[i]!.id);
    }
    for (let i = 0; i < 20; i += 2) {
      expect(w.raycast(i * 0.5, 5, 0, 0, -1, 0, 10)).toBeNull();
    }
  });
});
