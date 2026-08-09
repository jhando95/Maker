import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { lathe, rock } from './lathe.ts';
import { Rng } from '../core/rng.ts';

const positions = (g: THREE.BufferGeometry) => g.getAttribute('position') as THREE.BufferAttribute;
const normals = (g: THREE.BufferGeometry) => g.getAttribute('normal') as THREE.BufferAttribute;

describe('a turned profile', () => {
  const pot = [
    { r: 0, y: 0 }, { r: 0.16, y: 0 }, { r: 0.2, y: 0.24 }, { r: 0.23, y: 0.26 },
  ];

  it('is round: every vertex sits at its profile radius from the axis', () => {
    const g = lathe(pot, 12);
    const p = positions(g);
    let maxR = 0;
    for (let i = 0; i < p.count; i++) {
      maxR = Math.max(maxR, Math.hypot(p.getX(i), p.getZ(i)));
    }
    expect(maxR).toBeCloseTo(0.23, 6);
  });

  it('spans exactly the profile height, base at zero', () => {
    const g = lathe(pot, 12);
    const p = positions(g);
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < p.count; i++) {
      minY = Math.min(minY, p.getY(i));
      maxY = Math.max(maxY, p.getY(i));
    }
    expect(minY).toBeCloseTo(0, 6);
    expect(maxY).toBeCloseTo(0.26, 6);
  });

  it('is flat-shaded: all three vertices of a face share one normal', () => {
    // The style, stated as an invariant. Smooth-shaded curves under a
    // three-band toon ramp read as a different material from the chamfered
    // boxes beside them; faceting is what makes a turned prop belong.
    const g = lathe(pot, 10);
    const n = normals(g);
    for (let i = 0; i < n.count; i += 3) {
      for (const j of [i + 1, i + 2]) {
        expect(n.getX(j)).toBeCloseTo(n.getX(i), 6);
        expect(n.getY(j)).toBeCloseTo(n.getY(i), 6);
        expect(n.getZ(j)).toBeCloseTo(n.getZ(i), 6);
      }
    }
  });

  it('costs what a prop should: a pot is a few hundred triangles at most', () => {
    const g = lathe(pot, 10);
    expect(positions(g).count / 3).toBeLessThan(200);
  });

  it('never lets a profile point dip behind the axis', () => {
    const g = lathe([{ r: -0.5, y: 0 }, { r: 0.2, y: 0.3 }], 8);
    const p = positions(g);
    for (let i = 0; i < p.count; i++) {
      expect(Math.hypot(p.getX(i), p.getZ(i))).toBeLessThanOrEqual(0.2 + 1e-6);
    }
  });

  it('refuses a profile that is not one', () => {
    expect(() => lathe([{ r: 1, y: 0 }])).toThrow(/two points/);
  });
});

describe('a rock', () => {
  it('sits on the ground with no daylight underneath', () => {
    const rng = new Rng('rocks');
    const g = rock(0.4, () => rng.next());
    const p = positions(g);
    let minY = Infinity;
    for (let i = 0; i < p.count; i++) minY = Math.min(minY, p.getY(i));
    expect(minY).toBeGreaterThanOrEqual(-1e-6);
  });

  it('is lumpy but not torn: the same seed gives the same rock', () => {
    const a = rock(0.4, (() => { const r = new Rng(7); return () => r.next(); })());
    const b = rock(0.4, (() => { const r = new Rng(7); return () => r.next(); })());
    expect([...positions(a).array]).toEqual([...positions(b).array]);
  });

  it('two seeds give two rocks, or the family is one rock', () => {
    const a = rock(0.4, (() => { const r = new Rng(1); return () => r.next(); })());
    const b = rock(0.4, (() => { const r = new Rng(2); return () => r.next(); })());
    expect([...positions(a).array]).not.toEqual([...positions(b).array]);
  });

  it('does not tear at unwelded seams', () => {
    // The unweld copies each shared corner into several triangles; the lump
    // pushes by *location*, so the copies must move together. A torn rock
    // shows as duplicated positions that no longer coincide.
    // Counted rather than compared: an icosahedron at detail 1 has 42 unique
    // corners, and the unweld copies each into every triangle that uses it. A
    // displacement keyed by location moves the copies together, so the count
    // of distinct positions stays at 42; one keyed per copy tears every seam
    // and the count balloons toward 240. The first version of this test had a
    // `torn` counter that nothing incremented — an assertion that could not
    // fail, wearing the name of one.
    const rng = new Rng('seam');
    const g = rock(0.5, () => rng.next(), 0.62, 0.45);
    const p = positions(g);
    const distinct = new Set<string>();
    for (let i = 0; i < p.count; i++) {
      distinct.add(`${p.getX(i).toFixed(4)},${p.getY(i).toFixed(4)},${p.getZ(i).toFixed(4)}`);
    }
    expect(distinct.size).toBeLessThanOrEqual(50);
    // And it stayed rock-sized rather than exploding.
    let maxR = 0;
    for (let i = 0; i < p.count; i++) maxR = Math.max(maxR, Math.hypot(p.getX(i), p.getZ(i)));
    expect(maxR).toBeLessThan(0.5 * 1.5);
  });
});
