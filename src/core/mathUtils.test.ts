import { describe, it, expect } from 'vitest';
import {
  clamp,
  lerp,
  damp,
  moveToward,
  wrapAngle,
  angleDelta,
  snapTo,
  snapToWithin,
  smoothstep,
  beatsIncumbent,
} from './mathUtils.ts';
import { Rng } from './rng.ts';

describe('clamp / lerp / smoothstep', () => {
  it('clamps to bounds', () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(clamp(0.5, 0, 1)).toBe(0.5);
  });

  it('lerps endpoints exactly', () => {
    expect(lerp(10, 20, 0)).toBe(10);
    expect(lerp(10, 20, 1)).toBe(20);
    expect(lerp(10, 20, 0.5)).toBe(15);
  });

  it('smoothstep is flat at the edges and centered at the midpoint', () => {
    expect(smoothstep(0, 1, 0)).toBe(0);
    expect(smoothstep(0, 1, 1)).toBe(1);
    expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5);
    // Clamped outside the range rather than extrapolating.
    expect(smoothstep(0, 1, 2)).toBe(1);
    expect(smoothstep(0, 1, -1)).toBe(0);
  });
});

describe('damp', () => {
  it('halves the remaining distance every half-life', () => {
    const afterOne = damp(0, 100, 0.5, 0.5);
    expect(afterOne).toBeCloseTo(50);
    const afterTwo = damp(afterOne, 100, 0.5, 0.5);
    expect(afterTwo).toBeCloseTo(75);
  });

  it('is frame-rate independent', () => {
    // One 0.1s step must land in the same place as ten 0.01s steps.
    const big = damp(0, 100, 0.25, 0.1);

    let small = 0;
    for (let i = 0; i < 10; i++) small = damp(small, 100, 0.25, 0.01);

    expect(small).toBeCloseTo(big, 6);
  });

  it('jumps straight to target for a non-positive half-life', () => {
    expect(damp(0, 42, 0, 0.016)).toBe(42);
  });
});

describe('moveToward', () => {
  it('does not overshoot', () => {
    expect(moveToward(0, 10, 100)).toBe(10);
    expect(moveToward(0, -10, 100)).toBe(-10);
  });

  it('steps by at most maxDelta', () => {
    expect(moveToward(0, 10, 3)).toBe(3);
    expect(moveToward(0, -10, 3)).toBe(-3);
  });
});

describe('angles', () => {
  it('wraps into (-PI, PI]', () => {
    expect(wrapAngle(0)).toBeCloseTo(0);
    expect(wrapAngle(Math.PI * 2)).toBeCloseTo(0);
    expect(wrapAngle(Math.PI * 3)).toBeCloseTo(Math.PI);
    expect(wrapAngle(-Math.PI * 3)).toBeCloseTo(Math.PI);
    expect(Math.abs(wrapAngle(Math.PI * 1.5))).toBeLessThanOrEqual(Math.PI);
  });

  it('takes the short way around', () => {
    // 350deg -> 10deg is +20deg, not -340deg.
    const a = 350 * (Math.PI / 180);
    const b = 10 * (Math.PI / 180);
    expect(angleDelta(a, b) * (180 / Math.PI)).toBeCloseTo(20);
  });
});

describe('snapping', () => {
  it('snapTo rounds to the nearest multiple', () => {
    expect(snapTo(0.26, 0.25)).toBeCloseTo(0.25);
    expect(snapTo(0.4, 0.25)).toBeCloseTo(0.5);
    expect(snapTo(-0.4, 0.25)).toBeCloseTo(-0.5);
  });

  it('snapTo passes through when step is zero', () => {
    expect(snapTo(0.37, 0)).toBe(0.37);
  });

  it('snapToWithin only pulls values already inside the tolerance band', () => {
    // 0.02 away from 0.25 with a 0.05 tolerance: snaps.
    expect(snapToWithin(0.27, 0.25, 0.05)).toBeCloseTo(0.25);
    // 0.115 away from the nearest multiple, outside tolerance: left alone.
    expect(snapToWithin(0.365, 0.25, 0.05)).toBeCloseTo(0.365);
  });
});

describe('beatsIncumbent', () => {
  it('requires the challenger to clear the margin', () => {
    expect(beatsIncumbent(1.05, 1.0, 0.1)).toBe(false);
    expect(beatsIncumbent(1.15, 1.0, 0.1)).toBe(true);
  });

  it('prevents flip-flop between near-tied candidates', () => {
    // Two candidates trading a hair's-breadth lead each frame must not swap.
    let incumbent = 1.0;
    let swaps = 0;
    for (const challenger of [1.001, 0.999, 1.002, 0.998]) {
      if (beatsIncumbent(challenger, incumbent, 0.05)) {
        incumbent = challenger;
        swaps++;
      }
    }
    expect(swaps).toBe(0);
  });
});

describe('Rng', () => {
  it('is deterministic for a given seed', () => {
    const a = new Rng(12345);
    const b = new Rng(12345);
    for (let i = 0; i < 100; i++) expect(a.next()).toBe(b.next());
  });

  it('produces different streams for different seeds', () => {
    const a = new Rng(1);
    const b = new Rng(2);
    const sameCount = Array.from({ length: 50 }, () => (a.next() === b.next() ? 1 : 0)).reduce(
      (x: number, y: number) => x + y,
      0,
    );
    expect(sameCount).toBe(0);
  });

  it('accepts a string seed deterministically', () => {
    expect(new Rng('backyard-01').next()).toBe(new Rng('backyard-01').next());
    expect(new Rng('backyard-01').next()).not.toBe(new Rng('backyard-02').next());
  });

  it('stays within [0,1)', () => {
    const r = new Rng(7);
    for (let i = 0; i < 10_000; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('int() covers the inclusive range and never exceeds it', () => {
    const r = new Rng(99);
    const seen = new Set<number>();
    for (let i = 0; i < 5000; i++) {
      const v = r.int(3, 7);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(7);
      seen.add(v);
    }
    expect(seen.size).toBe(5);
  });

  it('has a roughly uniform mean', () => {
    const r = new Rng('uniformity');
    let sum = 0;
    const n = 50_000;
    for (let i = 0; i < n; i++) sum += r.next();
    expect(sum / n).toBeCloseTo(0.5, 2);
  });

  it('survives a zero seed', () => {
    const r = new Rng(0);
    const v = r.next();
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(1);
  });

  it('fork() branches without repeating the parent stream', () => {
    const parent = new Rng(42);
    const child = parent.fork();
    expect(child.next()).not.toBe(parent.next());
  });

  it('shuffle is a permutation', () => {
    const r = new Rng(5);
    const items = Array.from({ length: 20 }, (_, i) => i);
    const shuffled = r.shuffle([...items]);
    expect([...shuffled].sort((a, b) => a - b)).toEqual(items);
  });
});
