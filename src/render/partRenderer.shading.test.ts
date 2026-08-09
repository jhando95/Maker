/**
 * The shading half of the part renderer: base colours, the multiply, and the
 * swap-with-last invariant it adds a third buffer to.
 *
 * Swap-with-last is the invariant this file exists to guard. It has two buffers
 * to keep aligned already — matrices and colours — and shading adds a third,
 * the unshaded base. A remove that swaps two of the three leaves the moved
 * part's next re-shade multiplying from the removed part's paint, which is a
 * bug that only shows after a removal followed by a lighting pass: exactly the
 * order a collapse produces.
 */
import { describe, it, expect } from 'vitest';
import { PartRenderer } from './partRenderer.ts';

const add = (r: PartRenderer, id: number, x = id) =>
  r.add(id, 0, 0, x, 0.5, 0, 0, 0, 0, 1);

describe('shading a part', () => {
  it('multiplies the colour actually in the buffer', () => {
    const r = new PartRenderer();
    add(r, 7);
    const before = r.colorOf(7)!;
    r.shade(7, 0.5);
    const after = r.colorOf(7)!;
    expect(after.r).toBeCloseTo(before.r * 0.5, 5);
    expect(after.g).toBeCloseTo(before.g * 0.5, 5);
    expect(after.b).toBeCloseTo(before.b * 0.5, 5);
    expect(r.shadeOf(7)).toBe(0.5);
  });

  it('shades from the base, not from the last shade', () => {
    // Multiplying the live buffer compounds: two passes at 0.9 make 0.81 and
    // the world ratchets darker every time anything changes.
    const r = new PartRenderer();
    add(r, 7);
    const base = r.colorOf(7)!;
    r.shade(7, 0.9);
    r.shade(7, 0.9009);
    r.shade(7, 0.9);
    // Within the skip epsilon these coalesce; force a real re-apply.
    r.shade(7, 0.6);
    r.shade(7, 0.9);
    expect(r.colorOf(7)!.r).toBeCloseTo(base.r * 0.9, 5);
  });

  it('can put a part back to full brightness', () => {
    const r = new PartRenderer();
    add(r, 7);
    const base = r.colorOf(7)!;
    r.shade(7, 0.7);
    r.shade(7, 1);
    expect(r.colorOf(7)!.r).toBeCloseTo(base.r, 5);
    expect(r.shadeOf(7)).toBe(1);
  });

  it('says nothing happened for a part it does not have', () => {
    const r = new PartRenderer();
    expect(() => r.shade(99, 0.5)).not.toThrow();
    expect(r.shadeOf(99)).toBe(1);
    expect(r.colorOf(99)).toBeNull();
  });
});

describe('the swap-with-last invariant, now with three buffers', () => {
  it('keeps a moved part own base colour across a removal', () => {
    const r = new PartRenderer();
    add(r, 1);
    add(r, 2);
    add(r, 3);                       // 3 sits in the last slot
    const baseOfThree = r.colorOf(3)!;

    r.remove(1);                     // 3 is swapped into 1's slot
    r.shade(3, 0.5);
    const shaded = r.colorOf(3)!;
    expect(shaded.r).toBeCloseTo(baseOfThree.r * 0.5, 5);
    expect(shaded.g).toBeCloseTo(baseOfThree.g * 0.5, 5);
  });

  it('keeps an already-shaded moved part looking shaded', () => {
    const r = new PartRenderer();
    add(r, 1);
    add(r, 2);
    add(r, 3);
    r.shade(3, 0.5);
    const shaded = r.colorOf(3)!;
    r.remove(1);
    expect(r.colorOf(3)!.r).toBeCloseTo(shaded.r, 5);
    expect(r.shadeOf(3)).toBe(0.5);
  });

  it('forgets a removed part shade rather than leaving it for the next id', () => {
    const r = new PartRenderer();
    add(r, 1);
    r.shade(1, 0.5);
    r.remove(1);
    expect(r.shadeOf(1)).toBe(1);
  });

  it('survives growing past the initial capacity', () => {
    // The base-colour array has to be carried across a grow like the other two
    // buffers, or every part placed before the 257th re-shades from black.
    const r = new PartRenderer();
    for (let id = 0; id < 300; id++) add(r, id, id * 0.1);
    const base = r.colorOf(5)!;
    expect(base.r).toBeGreaterThan(0.05);
    r.shade(5, 0.5);
    expect(r.colorOf(5)!.r).toBeCloseTo(base.r * 0.5, 5);
  });

  it('clears its memory with the world', () => {
    const r = new PartRenderer();
    add(r, 1);
    r.shade(1, 0.5);
    r.clear();
    expect(r.shadeOf(1)).toBe(1);
    expect(r.shadeStats()).toEqual({ min: 1, max: 1, shaded: 0 });
  });
});

describe('the spread', () => {
  it('is flat for a world nobody has shaded', () => {
    const r = new PartRenderer();
    add(r, 1);
    expect(r.shadeStats()).toEqual({ min: 1, max: 1, shaded: 0 });
  });

  it('opens up when a part is darkened while another is not', () => {
    const r = new PartRenderer();
    add(r, 1);
    add(r, 2);
    r.shade(1, 0.8);
    const stats = r.shadeStats();
    expect(stats.min).toBeCloseTo(0.8, 6);
    expect(stats.max).toBe(1);
    expect(stats.shaded).toBe(1);
  });
});
