import { describe, it, expect } from 'vitest';
import { capsuleVsObb, obbFromQuaternion, obbAabb, spineDistanceToObb } from './capsuleObb.ts';
import { Feature, makeContact, type Capsule, type Obb } from './types.ts';
import { Rng } from '../core/rng.ts';
import { DEPEN_ITERS } from './constants.ts';

/** Axis-aligned box, the common case. */
function aabb(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number): Obb {
  return {
    cx, cy, cz,
    ux: 1, uy: 0, uz: 0,
    vx: 0, vy: 1, vz: 0,
    wx: 0, wy: 0, wz: 1,
    hx, hy, hz,
  };
}

function capsule(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  radius: number,
): Capsule {
  return { ax, ay, az, bx, by, bz, radius };
}

/**
 * Brute-force reference: sample the spine densely, and for each sample compute
 * the exact point-to-box distance by clamping in box-local space. Slow, but it
 * has no algorithmic cleverness to be wrong about, so it is the ground truth
 * the bisection is checked against.
 */
function bruteForceSpineDistance(cap: Capsule, box: Obb, samples = 200_000): number {
  let best = Infinity;
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const px = cap.ax + (cap.bx - cap.ax) * t;
    const py = cap.ay + (cap.by - cap.ay) * t;
    const pz = cap.az + (cap.bz - cap.az) * t;

    const dx = px - box.cx;
    const dy = py - box.cy;
    const dz = pz - box.cz;
    const lx = dx * box.ux + dy * box.uy + dz * box.uz;
    const ly = dx * box.vx + dy * box.vy + dz * box.vz;
    const lz = dx * box.wx + dy * box.wy + dz * box.wz;

    const ox = Math.max(Math.abs(lx) - box.hx, 0);
    const oy = Math.max(Math.abs(ly) - box.hy, 0);
    const oz = Math.max(Math.abs(lz) - box.hz, 0);
    const d = Math.hypot(ox, oy, oz);
    if (d < best) best = d;
  }
  return best;
}

/** Random unit quaternion from a seeded generator. */
function randomQuat(rng: Rng): [number, number, number, number] {
  const u1 = rng.next();
  const u2 = rng.next();
  const u3 = rng.next();
  const s1 = Math.sqrt(1 - u1);
  const s2 = Math.sqrt(u1);
  return [
    s1 * Math.sin(2 * Math.PI * u2),
    s1 * Math.cos(2 * Math.PI * u2),
    s2 * Math.sin(2 * Math.PI * u3),
    s2 * Math.cos(2 * Math.PI * u3),
  ];
}

describe('capsuleVsObb — basic separation', () => {
  it('reports no contact when clearly apart', () => {
    const out = makeContact();
    const box = aabb(0, 0, 0, 1, 1, 1);
    const cap = capsule(10, 0, 0, 10, 2, 0, 0.32);
    expect(capsuleVsObb(cap, box, out)).toBe(false);
  });

  it('reports contact when overlapping', () => {
    const out = makeContact();
    const box = aabb(0, 0, 0, 1, 1, 1);
    const cap = capsule(1.2, 0, 0, 1.2, 2, 0, 0.32);
    expect(capsuleVsObb(cap, box, out)).toBe(true);
    expect(out.depth).toBeGreaterThan(0);
  });

  it('honours the speculative margin', () => {
    const box = aabb(0, 0, 0, 1, 1, 1);
    // Surface gap of 0.08 with radius 0.32: spine at x=1.4.
    const cap = capsule(1.4, 0, 0, 1.4, 2, 0, 0.32);
    const out = makeContact();
    expect(capsuleVsObb(cap, box, out, 0)).toBe(false);
    expect(capsuleVsObb(cap, box, out, 0.1)).toBe(true);
    // A speculative contact is not yet penetrating.
    expect(out.depth).toBeLessThan(0);
  });
});

describe('capsuleVsObb — normals and depth', () => {
  it('gives an outward +X normal for a capsule to the right of a box', () => {
    const box = aabb(0, 0, 0, 1, 1, 1);
    const cap = capsule(1.2, 0, 0, 1.2, 1, 0, 0.32);
    const out = makeContact();
    expect(capsuleVsObb(cap, box, out)).toBe(true);
    expect(out.nx).toBeCloseTo(1, 5);
    expect(out.ny).toBeCloseTo(0, 5);
    expect(out.nz).toBeCloseTo(0, 5);
    // Spine at 1.2, surface at 1.0, gap 0.2, radius 0.32 -> depth 0.12.
    expect(out.depth).toBeCloseTo(0.12, 5);
    expect(out.feature).toBe(Feature.Face);
  });

  it('gives an outward +Y normal for a capsule resting on top', () => {
    const box = aabb(0, 0, 0, 2, 0.1, 2);
    // Feet-to-head spine sitting just above the slab.
    const cap = capsule(0, 0.35, 0, 0, 1.4, 0, 0.32);
    const out = makeContact();
    expect(capsuleVsObb(cap, box, out)).toBe(true);
    expect(out.ny).toBeCloseTo(1, 5);
    expect(out.depth).toBeCloseTo(0.32 - 0.25, 5);
  });

  it('normal is unit length in every configuration', () => {
    const rng = new Rng('normals');
    const out = makeContact();
    for (let i = 0; i < 3000; i++) {
      const [qx, qy, qz, qw] = randomQuat(rng);
      const box = obbFromQuaternion(
        rng.signed(2), rng.signed(2), rng.signed(2),
        qx, qy, qz, qw,
        rng.range(0.02, 1.2), rng.range(0.02, 1.2), rng.range(0.02, 1.2),
      );
      const cap = capsule(
        rng.signed(3), rng.signed(3), rng.signed(3),
        rng.signed(3), rng.signed(3), rng.signed(3),
        rng.range(0.05, 0.6),
      );
      if (capsuleVsObb(cap, box, out, 0.05)) {
        expect(Math.hypot(out.nx, out.ny, out.nz)).toBeCloseTo(1, 6);
      }
    }
  });

  it('classifies face, edge and vertex contacts', () => {
    const box = aabb(0, 0, 0, 1, 1, 1);
    const out = makeContact();

    // Straight off one face.
    capsuleVsObb(capsule(1.2, 0, 0, 1.2, 0.5, 0, 0.32), box, out);
    expect(out.feature).toBe(Feature.Face);

    // Off an edge: outside on two axes.
    capsuleVsObb(capsule(1.15, 1.15, 0, 1.15, 1.15, 0.5, 0.32), box, out);
    expect(out.feature).toBe(Feature.Edge);

    // Off a corner: outside on all three.
    capsuleVsObb(capsule(1.12, 1.12, 1.12, 1.3, 1.3, 1.3, 0.32), box, out);
    expect(out.feature).toBe(Feature.Vertex);
  });

  it('pushes out along the shallowest axis when the spine is inside', () => {
    // Thin slab; spine threaded through it, nearest escape is straight up.
    const box = aabb(0, 0, 0, 2, 0.05, 2);
    const cap = capsule(-0.5, 0.02, 0, 0.5, 0.02, 0, 0.32);
    const out = makeContact();
    expect(capsuleVsObb(cap, box, out)).toBe(true);
    expect(out.feature).toBe(Feature.Inside);
    expect(out.ny).toBeCloseTo(1, 5);
    expect(out.depth).toBeGreaterThan(0.32);
  });
});

describe('capsuleVsObb — agreement with brute force', () => {
  it('matches the reference on axis-aligned boxes', () => {
    const rng = new Rng('aabb-agreement');
    for (let i = 0; i < 60; i++) {
      const box = aabb(
        rng.signed(1), rng.signed(1), rng.signed(1),
        rng.range(0.05, 1.0), rng.range(0.05, 1.0), rng.range(0.05, 1.0),
      );
      const cap = capsule(
        rng.signed(2.5), rng.signed(2.5), rng.signed(2.5),
        rng.signed(2.5), rng.signed(2.5), rng.signed(2.5),
        0.3,
      );
      const mine = spineDistanceToObb(cap, box);
      const truth = bruteForceSpineDistance(cap, box, 40_000);
      expect(Math.abs(mine - truth)).toBeLessThan(1e-4);
    }
  });

  it('matches the reference on rotated boxes', () => {
    const rng = new Rng('obb-agreement');
    for (let i = 0; i < 60; i++) {
      const [qx, qy, qz, qw] = randomQuat(rng);
      const box = obbFromQuaternion(
        rng.signed(1), rng.signed(1), rng.signed(1),
        qx, qy, qz, qw,
        rng.range(0.05, 1.0), rng.range(0.05, 1.0), rng.range(0.05, 1.0),
      );
      const cap = capsule(
        rng.signed(2.5), rng.signed(2.5), rng.signed(2.5),
        rng.signed(2.5), rng.signed(2.5), rng.signed(2.5),
        0.3,
      );
      const mine = spineDistanceToObb(cap, box);
      const truth = bruteForceSpineDistance(cap, box, 40_000);
      expect(Math.abs(mine - truth)).toBeLessThan(1e-4);
    }
  });

  it('matches the reference on thin lumber, the shape we actually build with', () => {
    // 40mm x 90mm planks at arbitrary angles — the oblique near-degenerate case
    // where clamp-iteration is known to stall short of the true minimum.
    const rng = new Rng('lumber-agreement');
    for (let i = 0; i < 80; i++) {
      const [qx, qy, qz, qw] = randomQuat(rng);
      const box = obbFromQuaternion(
        rng.signed(0.8), rng.signed(0.8), rng.signed(0.8),
        qx, qy, qz, qw,
        0.02, 0.045, rng.range(0.3, 1.2),
      );
      const cap = capsule(
        rng.signed(1.5), rng.signed(1.5), rng.signed(1.5),
        rng.signed(1.5), rng.signed(1.5), rng.signed(1.5),
        0.32,
      );
      const mine = spineDistanceToObb(cap, box);
      const truth = bruteForceSpineDistance(cap, box, 60_000);
      expect(Math.abs(mine - truth)).toBeLessThan(1e-4);
    }
  });

  it('agrees when the closest point is at a spine endpoint', () => {
    const box = aabb(0, 0, 0, 0.5, 0.5, 0.5);
    // Spine pointing away, so the minimum sits at the A endpoint.
    const cap = capsule(2, 0, 0, 6, 0, 0, 0.3);
    expect(spineDistanceToObb(cap, box)).toBeCloseTo(1.5, 6);

    // And the mirror case, at B.
    const cap2 = capsule(6, 0, 0, 2, 0, 0, 0.3);
    expect(spineDistanceToObb(cap2, box)).toBeCloseTo(1.5, 6);
  });
});

describe('capsuleVsObb — degenerate inputs', () => {
  it('handles a zero-length spine as a sphere', () => {
    const box = aabb(0, 0, 0, 1, 1, 1);
    const cap = capsule(1.2, 0, 0, 1.2, 0, 0, 0.32);
    const out = makeContact();
    expect(capsuleVsObb(cap, box, out)).toBe(true);
    expect(out.nx).toBeCloseTo(1, 5);
    expect(out.depth).toBeCloseTo(0.12, 5);
  });

  it('handles a spine exactly on a face without producing NaN', () => {
    const box = aabb(0, 0, 0, 1, 1, 1);
    const cap = capsule(1, 0, 0, 1, 0.5, 0, 0.32);
    const out = makeContact();
    expect(capsuleVsObb(cap, box, out)).toBe(true);
    expect(Number.isFinite(out.nx)).toBe(true);
    expect(Number.isFinite(out.ny)).toBe(true);
    expect(Number.isFinite(out.nz)).toBe(true);
    expect(Math.hypot(out.nx, out.ny, out.nz)).toBeCloseTo(1, 6);
  });

  it('handles a degenerate flat box', () => {
    const box = aabb(0, 0, 0, 1, 0, 1);
    const cap = capsule(0, 0.2, 0, 0, 1.4, 0, 0.32);
    const out = makeContact();
    expect(capsuleVsObb(cap, box, out)).toBe(true);
    expect(Number.isFinite(out.depth)).toBe(true);
  });

  it('never returns NaN across a large random sweep', () => {
    const rng = new Rng('nan-sweep');
    const out = makeContact();
    for (let i = 0; i < 20_000; i++) {
      const [qx, qy, qz, qw] = randomQuat(rng);
      const box = obbFromQuaternion(
        rng.signed(3), rng.signed(3), rng.signed(3),
        qx, qy, qz, qw,
        rng.range(0, 1.5), rng.range(0, 1.5), rng.range(0, 1.5),
      );
      const cap = capsule(
        rng.signed(4), rng.signed(4), rng.signed(4),
        rng.signed(4), rng.signed(4), rng.signed(4),
        rng.range(0, 0.8),
      );
      if (capsuleVsObb(cap, box, out, 0.04)) {
        for (const v of [out.nx, out.ny, out.nz, out.depth, out.px, out.py, out.pz, out.t]) {
          expect(Number.isNaN(v)).toBe(false);
        }
        expect(out.t).toBeGreaterThanOrEqual(0);
        expect(out.t).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('obbFromQuaternion', () => {
  it('produces an orthonormal basis', () => {
    const rng = new Rng('ortho');
    for (let i = 0; i < 500; i++) {
      const [qx, qy, qz, qw] = randomQuat(rng);
      const b = obbFromQuaternion(0, 0, 0, qx, qy, qz, qw, 1, 1, 1);
      expect(Math.hypot(b.ux, b.uy, b.uz)).toBeCloseTo(1, 6);
      expect(Math.hypot(b.vx, b.vy, b.vz)).toBeCloseTo(1, 6);
      expect(Math.hypot(b.wx, b.wy, b.wz)).toBeCloseTo(1, 6);
      expect(b.ux * b.vx + b.uy * b.vy + b.uz * b.vz).toBeCloseTo(0, 6);
      expect(b.ux * b.wx + b.uy * b.wy + b.uz * b.wz).toBeCloseTo(0, 6);
    }
  });

  it('identity rotation gives the world basis', () => {
    const b = obbFromQuaternion(1, 2, 3, 0, 0, 0, 1, 0.5, 0.5, 0.5);
    expect([b.ux, b.uy, b.uz]).toEqual([1, 0, 0]);
    expect([b.vx, b.vy, b.vz]).toEqual([0, 1, 0]);
    expect([b.wx, b.wy, b.wz]).toEqual([0, 0, 1]);
  });

  it('a 90-degree yaw maps local X to world -Z', () => {
    // Quaternion for +90 deg about Y.
    const s = Math.sin(Math.PI / 4);
    const c = Math.cos(Math.PI / 4);
    const b = obbFromQuaternion(0, 0, 0, 0, s, 0, c, 1, 1, 1);
    expect(b.ux).toBeCloseTo(0, 6);
    expect(b.uy).toBeCloseTo(0, 6);
    expect(b.uz).toBeCloseTo(-1, 6);
  });
});

describe('obbAabb', () => {
  it('is exact for an axis-aligned box', () => {
    const b = aabb(1, 2, 3, 0.5, 0.25, 2);
    const box = obbAabb(b);
    expect(box.minX).toBeCloseTo(0.5);
    expect(box.maxX).toBeCloseTo(1.5);
    expect(box.minY).toBeCloseTo(1.75);
    expect(box.maxZ).toBeCloseTo(5);
  });

  it('encloses every corner of a rotated box', () => {
    const rng = new Rng('aabb-enclose');
    for (let i = 0; i < 300; i++) {
      const [qx, qy, qz, qw] = randomQuat(rng);
      const b = obbFromQuaternion(
        rng.signed(2), rng.signed(2), rng.signed(2),
        qx, qy, qz, qw,
        rng.range(0.05, 1), rng.range(0.05, 1), rng.range(0.05, 1),
      );
      const box = obbAabb(b);
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          for (const sz of [-1, 1]) {
            const x = b.cx + sx * b.hx * b.ux + sy * b.hy * b.vx + sz * b.hz * b.wx;
            const y = b.cy + sx * b.hx * b.uy + sy * b.hy * b.vy + sz * b.hz * b.wy;
            const z = b.cz + sx * b.hx * b.uz + sy * b.hy * b.vz + sz * b.hz * b.wz;
            expect(x).toBeGreaterThanOrEqual(box.minX - 1e-9);
            expect(x).toBeLessThanOrEqual(box.maxX + 1e-9);
            expect(y).toBeGreaterThanOrEqual(box.minY - 1e-9);
            expect(y).toBeLessThanOrEqual(box.maxY + 1e-9);
            expect(z).toBeGreaterThanOrEqual(box.minZ - 1e-9);
            expect(z).toBeLessThanOrEqual(box.maxZ + 1e-9);
          }
        }
      }
    }
  });
});

describe('capsuleVsObb — performance', () => {
  it('stays well under budget per test', () => {
    const rng = new Rng('perf');
    const boxes: Obb[] = [];
    for (let i = 0; i < 1000; i++) {
      const [qx, qy, qz, qw] = randomQuat(rng);
      boxes.push(
        obbFromQuaternion(
          rng.signed(5), rng.signed(5), rng.signed(5),
          qx, qy, qz, qw,
          0.02, 0.045, 0.6,
        ),
      );
    }
    const cap = capsule(0, 0.32, 0, 0, 1.38, 0, 0.32);
    const out = makeContact();

    // Warm up so the timing reflects optimized code.
    for (let i = 0; i < 20_000; i++) capsuleVsObb(cap, boxes[i % boxes.length]!, out, 0.04);

    const iterations = 200_000;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      capsuleVsObb(cap, boxes[i % boxes.length]!, out, 0.04);
    }
    const nsPerTest = ((performance.now() - start) * 1e6) / iterations;

    // A gathering pass touches maybe 30 parts; even at 10x this budget that is
    // far below one frame. Generous bound so CI noise does not flake it.
    expect(nsPerTest).toBeLessThan(2000);
  });
});

describe('capsuleVsObb — depenetration invariant', () => {
  /**
   * A single push must always make progress, and a bounded number of pushes
   * must finish the job.
   *
   * One step cannot be guaranteed to separate a *capsule* from a box: the
   * translation moves every point on the spine equally, so a point that was not
   * the closest before can become the closest after, at a distance up to `depth`
   * less than it was. Distance to the box is 1-Lipschitz in the translation, so
   * one step reaches at most the radius and sometimes falls short. That is why
   * the solver runs DEPEN_ITERS passes rather than one.
   */
  it('each push makes progress, and DEPEN_ITERS passes separate', () => {
    const rng = new Rng('depen');
    const out = makeContact();
    let tested = 0;

    for (let i = 0; i < 8000; i++) {
      const [qx, qy, qz, qw] = randomQuat(rng);
      const box = obbFromQuaternion(
        rng.signed(1), rng.signed(1), rng.signed(1),
        qx, qy, qz, qw,
        rng.range(0.02, 0.9), rng.range(0.02, 0.9), rng.range(0.02, 0.9),
      );
      const cap = capsule(
        rng.signed(1.6), rng.signed(1.6), rng.signed(1.6),
        rng.signed(1.6), rng.signed(1.6), rng.signed(1.6),
        rng.range(0.1, 0.5),
      );

      if (!capsuleVsObb(cap, box, out, 0)) continue;
      if (out.depth <= 0) continue; // speculative, not overlapping
      // Deep interior contacts need several iterations by design; the
      // single-shot guarantee is for surface contacts.
      if (out.feature === Feature.Inside) continue;

      tested++;
      const before = spineDistanceToObb(cap, box);

      const push = (c: Capsule): Capsule => ({
        ax: c.ax + out.nx * out.depth,
        ay: c.ay + out.ny * out.depth,
        az: c.az + out.nz * out.depth,
        bx: c.bx + out.nx * out.depth,
        by: c.by + out.ny * out.depth,
        bz: c.bz + out.nz * out.depth,
        radius: c.radius,
      });

      // One push strictly increases separation — the direction is never wrong.
      const once = push(cap);
      expect(spineDistanceToObb(once, box)).toBeGreaterThan(before - 1e-9);

      // And DEPEN_ITERS passes finish the job.
      let current = cap;
      for (let iter = 0; iter < DEPEN_ITERS; iter++) {
        if (!capsuleVsObb(current, box, out, 0) || out.depth <= 1e-9) break;
        current = push(current);
      }
      expect(spineDistanceToObb(current, box)).toBeGreaterThan(cap.radius - 1e-6);
    }

    // Guard against the sweep silently testing nothing.
    expect(tested).toBeGreaterThan(500);
  });

  it('repeated depenetration converges even from deep inside', () => {
    const rng = new Rng('deep-depen');
    const out = makeContact();

    for (let i = 0; i < 400; i++) {
      const [qx, qy, qz, qw] = randomQuat(rng);
      const box = obbFromQuaternion(
        0, 0, 0, qx, qy, qz, qw,
        rng.range(0.1, 0.8), rng.range(0.1, 0.8), rng.range(0.1, 0.8),
      );
      // Start with the spine buried in the middle of the box.
      let cap = capsule(
        rng.signed(0.05), rng.signed(0.05), rng.signed(0.05),
        rng.signed(0.05), rng.signed(0.05) + 0.2, rng.signed(0.05),
        0.32,
      );

      for (let iter = 0; iter < 12; iter++) {
        if (!capsuleVsObb(cap, box, out, 0) || out.depth <= 1e-7) break;
        cap = {
          ax: cap.ax + out.nx * out.depth,
          ay: cap.ay + out.ny * out.depth,
          az: cap.az + out.nz * out.depth,
          bx: cap.bx + out.nx * out.depth,
          by: cap.by + out.ny * out.depth,
          bz: cap.bz + out.nz * out.depth,
          radius: cap.radius,
        };
      }

      expect(spineDistanceToObb(cap, box)).toBeGreaterThan(0.32 - 1e-3);
    }
  });

  it('the reported box point lies on the box surface', () => {
    const rng = new Rng('surface-point');
    const out = makeContact();

    for (let i = 0; i < 4000; i++) {
      const [qx, qy, qz, qw] = randomQuat(rng);
      const box = obbFromQuaternion(
        rng.signed(1), rng.signed(1), rng.signed(1),
        qx, qy, qz, qw,
        rng.range(0.05, 0.9), rng.range(0.05, 0.9), rng.range(0.05, 0.9),
      );
      const cap = capsule(
        rng.signed(1.6), rng.signed(1.6), rng.signed(1.6),
        rng.signed(1.6), rng.signed(1.6), rng.signed(1.6),
        0.32,
      );
      if (!capsuleVsObb(cap, box, out, 0.04)) continue;

      // Back into box-local space: on the surface, at least one coordinate must
      // sit on its half-extent, and none may exceed it.
      const dx = out.qx - box.cx;
      const dy = out.qy - box.cy;
      const dz = out.qz - box.cz;
      const lx = dx * box.ux + dy * box.uy + dz * box.uz;
      const ly = dx * box.vx + dy * box.vy + dz * box.vz;
      const lz = dx * box.wx + dy * box.wy + dz * box.wz;

      expect(Math.abs(lx)).toBeLessThanOrEqual(box.hx + 1e-6);
      expect(Math.abs(ly)).toBeLessThanOrEqual(box.hy + 1e-6);
      expect(Math.abs(lz)).toBeLessThanOrEqual(box.hz + 1e-6);

      const onSurface =
        Math.abs(Math.abs(lx) - box.hx) < 1e-6 ||
        Math.abs(Math.abs(ly) - box.hy) < 1e-6 ||
        Math.abs(Math.abs(lz) - box.hz) < 1e-6;
      expect(onSurface).toBe(true);
    }
  });

  it('depth equals radius minus the true spine distance for surface contacts', () => {
    const rng = new Rng('depth-consistency');
    const out = makeContact();
    let tested = 0;

    for (let i = 0; i < 5000; i++) {
      const [qx, qy, qz, qw] = randomQuat(rng);
      const box = obbFromQuaternion(
        rng.signed(1), rng.signed(1), rng.signed(1),
        qx, qy, qz, qw,
        rng.range(0.05, 0.9), rng.range(0.05, 0.9), rng.range(0.05, 0.9),
      );
      const cap = capsule(
        rng.signed(1.5), rng.signed(1.5), rng.signed(1.5),
        rng.signed(1.5), rng.signed(1.5), rng.signed(1.5),
        0.32,
      );
      if (!capsuleVsObb(cap, box, out, 0.04)) continue;
      if (out.feature === Feature.Inside) continue;
      tested++;
      expect(out.depth).toBeCloseTo(0.32 - spineDistanceToObb(cap, box), 6);
    }
    expect(tested).toBeGreaterThan(300);
  });
});

describe('capsuleVsObb — spine pierced through the box', () => {
  it('reports deep penetration, not a grazing face contact, when the spine crosses', () => {
    // A long spine driven clean through a chunky box. Bisection alone settles
    // on the entry point and reports a Face contact a hair outside the surface,
    // which would push the capsule the wrong way.
    const box = aabb(0, 0, 0, 0.6, 0.86, 0.77);
    const cap = capsule(-2, 0, 0, 2, 0, 0, 0.18);
    const out = makeContact();

    expect(capsuleVsObb(cap, box, out)).toBe(true);
    expect(out.feature).toBe(Feature.Inside);
    expect(spineDistanceToObb(cap, box)).toBe(0);
    // Deeper than the radius, since the spine itself is buried.
    expect(out.depth).toBeGreaterThan(cap.radius);
  });

  it('regression: the seeded case that reported Face while the spine was inside', () => {
    const box = obbFromQuaternion(
      0.7101890034973621, 0.9431859790347517, 0.2369654979556799,
      0, 0, 0, 1,
      0.6014308758080006, 0.860690213777125, 0.7696528268232942,
    );
    // Rebuilt with the original box orientation.
    box.ux = -0.5272381008140177; box.uy = -0.8487392696091214; box.uz = -0.04076318527057263;
    box.vx = 0.7391392777153105; box.vy = -0.48176217844497105; box.vz = 0.4707210761782871;
    box.wx = -0.419157623321486; box.wy = 0.21805241489910415; box.wz = 0.8813399067148566;

    const cap = capsule(
      -0.030398239940404803, 0.780001126229763, 0.8187239728868008,
      1.416218210756779, 0.3404235273599625, -1.1655387334525587,
      0.17993808845058085,
    );
    const out = makeContact();
    expect(capsuleVsObb(cap, box, out)).toBe(true);
    // The spine genuinely passes through, so this must be an interior contact.
    expect(out.feature).toBe(Feature.Inside);
    expect(spineDistanceToObb(cap, box)).toBe(0);
  });

  it('a spine ending just inside still reports interior', () => {
    const box = aabb(0, 0, 0, 1, 1, 1);
    // B lands 0.1 inside the +X face.
    const cap = capsule(5, 0, 0, 0.9, 0, 0, 0.2);
    const out = makeContact();
    expect(capsuleVsObb(cap, box, out)).toBe(true);
    expect(out.feature).toBe(Feature.Inside);
  });

  it('a spine that only grazes the outside stays a face contact', () => {
    const box = aabb(0, 0, 0, 1, 1, 1);
    // Parallel to the +X face, 0.05 clear of it.
    const cap = capsule(1.05, -2, 0, 1.05, 2, 0, 0.2);
    const out = makeContact();
    expect(capsuleVsObb(cap, box, out)).toBe(true);
    expect(out.feature).toBe(Feature.Face);
    expect(out.nx).toBeCloseTo(1, 6);
  });
});
