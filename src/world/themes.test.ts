import { describe, it, expect } from 'vitest';
import { THEMES, themeOf, themedSeed } from './themes.ts';
import { createScene } from './scene.ts';
import * as THREE from 'three';

describe('the three maps', () => {
  it('parses a theme out of a seed, and defaults every old seed to summer', () => {
    expect(themeOf('backyard-01').id).toBe('backyard');
    expect(themeOf('autumn!1234').id).toBe('autumn');
    expect(themeOf('winter!x').id).toBe('winter');
    expect(themeOf('nonsense!x').id).toBe('backyard');
    expect(themeOf(42).id).toBe('backyard');
    expect(themedSeed('winter', 'abc')).toBe('winter!abc');
    // Summer stays prefix-free so every seed ever shared keeps meaning what
    // it meant.
    expect(themedSeed('backyard', 'abc')).toBe('abc');
  });

  it('offers at least three maps with distinct vegetation', () => {
    expect(THEMES.length).toBeGreaterThanOrEqual(3);
    expect(new Set(THEMES.map((t) => t.canopy[0])).size).toBe(THEMES.length);
    expect(new Set(THEMES.map((t) => t.grass)).size).toBe(THEMES.length);
  });

  it('actually builds a different world per theme', () => {
    // Not just a lookup table: the same yard seed under two themes must
    // produce differently coloured scenery. The lawn mesh is the biggest
    // single readable difference, so it is the witness.
    // The detailed lawn is vertex-coloured and its material is white — the
    // first version of this test read that white twice and compared it to
    // itself. The far ground plane carries the theme's averaged lawn colour
    // in its material, which is exactly the single number to witness.
    const summer = createScene('same-yard').scene.getObjectByName('ground') as THREE.Mesh;
    const winter = createScene('winter!same-yard').scene.getObjectByName('ground') as THREE.Mesh;
    expect(summer).toBeDefined();
    expect(winter).toBeDefined();
    const a = (summer.material as THREE.MeshToonMaterial).color.getHex();
    const b = (winter.material as THREE.MeshToonMaterial).color.getHex();
    expect(a).not.toBe(b);
  });
});
