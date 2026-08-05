import { describe, it, expect } from 'vitest';
import { SpatialHash, type Aabb } from './spatialHash.ts';

const box = (x: number, y: number, z: number, half = 0.1): Aabb => ({
  minX: x - half, minY: y - half, minZ: z - half,
  maxX: x + half, maxY: y + half, maxZ: z + half,
});

describe('SpatialHash insert/remove', () => {
  it('finds an inserted object', () => {
    const h = new SpatialHash();
    h.insert(1, box(0.5, 0.5, 0.5));
    expect([...h.queryAabb(box(0.5, 0.5, 0.5))]).toEqual([1]);
    expect(h.size).toBe(1);
  });

  it('does not find a removed object', () => {
    const h = new SpatialHash();
    h.insert(1, box(0.5, 0.5, 0.5));
    expect(h.remove(1)).toBe(true);
    expect([...h.queryAabb(box(0.5, 0.5, 0.5))]).toEqual([]);
    expect(h.size).toBe(0);
    expect(h.remove(1)).toBe(false);
  });

  it('re-inserting moves rather than duplicating', () => {
    const h = new SpatialHash();
    h.insert(1, box(0.5, 0.5, 0.5));
    h.insert(1, box(20.5, 0.5, 0.5));
    expect([...h.queryAabb(box(0.5, 0.5, 0.5))]).toEqual([]);
    expect([...h.queryAabb(box(20.5, 0.5, 0.5))]).toEqual([1]);
    expect(h.size).toBe(1);
  });

  it('returns a large object from every cell it spans', () => {
    const h = new SpatialHash(1.0);
    // Spans roughly cells 0..4 on each axis.
    h.insert(7, { minX: 0.1, minY: 0.1, minZ: 0.1, maxX: 4.9, maxY: 4.9, maxZ: 4.9 });
    for (const c of [0.5, 2.5, 4.5]) {
      expect([...h.queryAabb(box(c, c, c))]).toEqual([7]);
    }
    // Removal must clear every one of those cells, not just the first.
    h.remove(7);
    for (const c of [0.5, 2.5, 4.5]) {
      expect([...h.queryAabb(box(c, c, c))]).toEqual([]);
    }
  });

  it('reports each id once even when it spans several queried cells', () => {
    const h = new SpatialHash(1.0);
    h.insert(3, { minX: 0.1, minY: 0.1, minZ: 0.1, maxX: 3.9, maxY: 0.2, maxZ: 3.9 });
    const hits = [...h.queryAabb({ minX: 0, minY: 0, minZ: 0, maxX: 4, maxY: 1, maxZ: 4 })];
    expect(hits).toEqual([3]);
  });

  it('handles negative coordinates', () => {
    const h = new SpatialHash();
    h.insert(1, box(-5.5, -2.5, -30.5));
    expect([...h.queryAabb(box(-5.5, -2.5, -30.5))]).toEqual([1]);
    expect([...h.queryAabb(box(5.5, 2.5, 30.5))]).toEqual([]);
  });

  it('keeps distinct cell keys across the sign boundary', () => {
    // A weak packing scheme collides (-1,0,0) with (0,0,-1) and similar; these
    // eight corners around the origin must stay distinct.
    const h = new SpatialHash(1.0);
    const pts: Array<[number, number, number]> = [
      [-0.5, -0.5, -0.5], [-0.5, -0.5, 0.5], [-0.5, 0.5, -0.5], [-0.5, 0.5, 0.5],
      [0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [0.5, 0.5, -0.5], [0.5, 0.5, 0.5],
    ];
    pts.forEach(([x, y, z], i) => h.insert(i, box(x, y, z, 0.05)));
    pts.forEach(([x, y, z], i) => {
      expect([...h.queryAabb(box(x, y, z, 0.05))]).toEqual([i]);
    });
  });

  it('clear() empties everything', () => {
    const h = new SpatialHash();
    for (let i = 0; i < 50; i++) h.insert(i, box(i, 0, 0));
    h.clear();
    expect(h.size).toBe(0);
    expect(h.stats().cells).toBe(0);
  });
});

describe('SpatialHash querySphere', () => {
  it('finds objects inside the radius and misses distant ones', () => {
    const h = new SpatialHash();
    h.insert(1, box(0, 0, 0));
    h.insert(2, box(10, 0, 0));
    const hits = [...h.querySphere(0, 0, 0, 1.5)];
    expect(hits).toContain(1);
    expect(hits).not.toContain(2);
  });
});

describe('SpatialHash queryRay', () => {
  it('hits an object straight ahead', () => {
    const h = new SpatialHash();
    h.insert(1, box(5.5, 0.5, 0.5));
    const hits = [...h.queryRay(0.5, 0.5, 0.5, 1, 0, 0, 10)];
    expect(hits).toContain(1);
  });

  it('misses an object behind the ray origin', () => {
    const h = new SpatialHash();
    h.insert(1, box(-5.5, 0.5, 0.5));
    expect([...h.queryRay(0.5, 0.5, 0.5, 1, 0, 0, 10)]).not.toContain(1);
  });

  it('misses an object past maxDistance', () => {
    const h = new SpatialHash();
    h.insert(1, box(50.5, 0.5, 0.5));
    expect([...h.queryRay(0.5, 0.5, 0.5, 1, 0, 0, 6)]).not.toContain(1);
  });

  it('walks diagonally through cells', () => {
    const h = new SpatialHash(1.0);
    // Along the x=y=z diagonal.
    for (let i = 1; i <= 5; i++) h.insert(i, box(i + 0.5, i + 0.5, i + 0.5, 0.2));
    const hits = [...h.queryRay(0.5, 0.5, 0.5, 1, 1, 1, 20)];
    for (let i = 1; i <= 5; i++) expect(hits).toContain(i);
  });

  it('returns hits in roughly front-to-back order', () => {
    const h = new SpatialHash(1.0);
    for (let i = 0; i < 6; i++) h.insert(i, box(i + 0.5, 0.5, 0.5, 0.2));
    const hits = [...h.queryRay(0.05, 0.5, 0.5, 1, 0, 0, 20)];
    expect(hits).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('handles axis-parallel rays without dividing by zero', () => {
    const h = new SpatialHash();
    h.insert(1, box(0.5, 5.5, 0.5));
    const hits = [...h.queryRay(0.5, 0.5, 0.5, 0, 1, 0, 10)];
    expect(hits).toContain(1);
    expect(hits.every((v) => Number.isFinite(v))).toBe(true);
  });

  it('handles negative-direction rays', () => {
    const h = new SpatialHash();
    h.insert(1, box(-5.5, 0.5, 0.5));
    expect([...h.queryRay(0.5, 0.5, 0.5, -1, 0, 0, 10)]).toContain(1);
  });

  it('returns nothing for a zero-length direction instead of hanging', () => {
    const h = new SpatialHash();
    h.insert(1, box(0.5, 0.5, 0.5));
    expect([...h.queryRay(0.5, 0.5, 0.5, 0, 0, 0, 10)]).toEqual([]);
  });

  it('accepts an unnormalized direction', () => {
    const h = new SpatialHash();
    h.insert(1, box(5.5, 0.5, 0.5));
    expect([...h.queryRay(0.5, 0.5, 0.5, 7, 0, 0, 10)]).toContain(1);
  });

  it('visits every cell along the ray, leaving no gaps', () => {
    // One marker per cell along x; a DDA that skips a cell drops a marker.
    const h = new SpatialHash(1.0);
    for (let i = 0; i < 12; i++) h.insert(i, box(i + 0.5, 0.5, 0.5, 0.05));
    const hits = new Set(h.queryRay(0.5, 0.5, 0.5, 1, 0, 0, 11.5));
    for (let i = 0; i < 12; i++) expect(hits.has(i)).toBe(true);
  });
});

describe('SpatialHash scale', () => {
  it('query cost tracks local density, not world size', () => {
    const dense = new SpatialHash(1.0);
    // A tight cluster plus 20k parts scattered far away.
    for (let i = 0; i < 20; i++) dense.insert(i, box(0.5 + i * 0.05, 0.5, 0.5, 0.05));
    for (let i = 100; i < 20_100; i++) {
      dense.insert(i, box(500 + (i % 100), 0.5, Math.floor(i / 100), 0.05));
    }
    const hits = dense.queryAabb(box(0.5, 0.5, 0.5, 0.6));
    // Only the local cluster comes back — the 20k distant parts are invisible.
    expect(hits.length).toBeLessThan(30);
    expect(dense.size).toBe(20_020);
  });

  it('reports occupancy stats', () => {
    const h = new SpatialHash(1.0);
    for (let i = 0; i < 10; i++) h.insert(i, box(0.5, 0.5, 0.5, 0.05));
    const s = h.stats();
    expect(s.objects).toBe(10);
    expect(s.cells).toBe(1);
    expect(s.maxPerCell).toBe(10);
    expect(s.avgPerCell).toBe(10);
  });
});

describe('SpatialHash key packing', () => {
  it('gives every cell in a 5x5x5 neighbourhood a distinct key', () => {
    // Exhaustive collision check around the origin, where a naive packing
    // that overflows 2^53 aliases cells together.
    const h = new SpatialHash(1.0);
    let id = 0;
    const expected: Array<{ id: number; x: number; y: number; z: number }> = [];
    for (let x = -2; x <= 2; x++) {
      for (let y = -2; y <= 2; y++) {
        for (let z = -2; z <= 2; z++) {
          const px = x + 0.5;
          const py = y + 0.5;
          const pz = z + 0.5;
          h.insert(id, box(px, py, pz, 0.05));
          expected.push({ id, x: px, y: py, z: pz });
          id++;
        }
      }
    }
    expect(h.stats().cells).toBe(125);
    for (const e of expected) {
      expect([...h.queryAabb(box(e.x, e.y, e.z, 0.05))]).toEqual([e.id]);
    }
  });

  it('throws rather than silently wrapping far-out-of-range bounds', () => {
    const h = new SpatialHash(1.0);
    expect(() => h.insert(1, box(1e9, 0, 0))).toThrow(RangeError);
  });
});
