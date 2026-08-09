import { describe, it, expect } from 'vitest';
import { place, PREFABS } from './prefabs.ts';
import type { Slab } from './neighborhood.ts';

describe('the prefab catalogue', () => {
  it('stamps every prefab where it is told, not where it was authored', () => {
    for (const name of Object.keys(PREFABS) as Array<keyof typeof PREFABS>) {
      const out: Slab[] = [];
      place(out, name, 100, -200);
      // The see-saw's static half is just the tyre: its plank and handles
      // moved into the live `Seesaw` runtime the day it started tilting, and
      // demanding four slabs of it here would demand the frozen copy back.
      expect(out.length, name).toBeGreaterThanOrEqual(name === 'seesaw' ? 1 : 4);
      for (const s of out) {
        expect(Math.abs(s.x - 100), `${name} strayed in x`).toBeLessThan(6);
        expect(Math.abs(s.z - -200), `${name} strayed in z`).toBeLessThan(6);
      }
    }
  });

  it('turns a placement about its own origin, exactly', () => {
    // The coop's hutch sits at local (-1.2, 0). One quarter turn maps
    // (x, z) to (z, -x): the hutch must land at (0, 1.2) relative to the
    // stamp point, with its extents swapped.
    const flat: Slab[] = [];
    const turned: Slab[] = [];
    place(flat, 'coop', 0, 0, 0);
    place(turned, 'coop', 0, 0, 1);
    const hutch = flat.find((s) => s.w === 1.6)!;
    const hutchTurned = turned.find((s) => s.d === 1.6)!;
    expect(hutchTurned.x).toBeCloseTo(hutch.z, 10);
    expect(hutchTurned.z).toBeCloseTo(-hutch.x, 10);
    expect(hutchTurned.w).toBe(hutch.d);
  });
});
