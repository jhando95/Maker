import { describe, it, expect } from 'vitest';
import type { PlacementRecord } from './buildSystem.ts';
import { hashPart, hashWorld } from './worldHash.ts';

const part = (over: Partial<PlacementRecord> = {}): PlacementRecord => ({
  kind: 0, colorway: 0, x: 1, y: 0.5, z: 2, qx: 0, qy: 0, qz: 0, qw: 1, ...over,
});

describe('one part', () => {
  it('hashes the same twice', () => {
    expect(hashPart(part())).toBe(hashPart(part()));
  });

  it('notices every field', () => {
    const base = hashPart(part());
    const changes: Array<Partial<PlacementRecord>> = [
      { kind: 1 }, { colorway: 1 },
      { x: 1.001 }, { y: 0.501 }, { z: 2.001 },
      { qx: 0.0001 }, { qy: 0.0001 }, { qz: 0.0001 }, { qw: 0.9999 },
    ];
    for (const change of changes) {
      expect(hashPart(part(change)), JSON.stringify(change)).not.toBe(base);
    }
  });

  it('ignores differences below what serialize keeps', () => {
    // A millimetre and 1e-4, which is what two machines agree to.
    expect(hashPart(part({ x: 1.00001 }))).toBe(hashPart(part()));
    expect(hashPart(part({ qw: 1.000001 }))).toBe(hashPart(part()));
  });
});

describe('a world', () => {
  const a = part({ x: 1 });
  const b = part({ x: 2 });
  const c = part({ x: 3, kind: 2 });

  it('does not care what order the parts came in', () => {
    // The two sides do not agree on part ids or on the order they learned them,
    // so a hash that did would report a desync on every session.
    expect(hashWorld([a, b, c])).toBe(hashWorld([c, a, b]));
    expect(hashWorld([a, b, c])).toBe(hashWorld([b, c, a]));
  });

  it('changes when a part is added, removed or moved', () => {
    const base = hashWorld([a, b, c]);
    expect(hashWorld([a, b])).not.toBe(base);
    expect(hashWorld([a, b, c, part({ x: 4 })])).not.toBe(base);
    expect(hashWorld([a, b, part({ x: 3.001, kind: 2 })])).not.toBe(base);
  });

  it('tells an empty world from a world with something in it', () => {
    expect(hashWorld([])).not.toBe(hashWorld([a]));
  });

  it('gives a different answer for every size of the same plank', () => {
    // The count is in the hash as well as the sum. The case it exists for —
    // parts whose hashes cancel to zero — is one no test here can construct,
    // and that is stated in `worldHash.ts` and in `docs/verification.md` rather
    // than dressed up as covered. What *is* checkable is that adding a part
    // always changes the answer.
    const seen = new Set<number>();
    const world: PlacementRecord[] = [];
    for (let i = 0; i < 200; i++) {
      world.push(part({ x: i * 0.5 }));
      seen.add(hashWorld(world));
    }
    expect(seen.size).toBe(200);
  });

  it('counts duplicates, because two identical planks are two planks', () => {
    expect(hashWorld([a, a])).not.toBe(hashWorld([a]));
  });

  it('separates worlds that differ only in how many of one part they have', () => {
    expect(hashWorld([a, a, b])).not.toBe(hashWorld([a, b, b]));
  });

  it('is stable across a rebuild of the same set', () => {
    const once = hashWorld([a, b, c]);
    const again = hashWorld([part({ x: 1 }), part({ x: 2 }), part({ x: 3, kind: 2 })]);
    expect(again).toBe(once);
  });
});
