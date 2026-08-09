import { describe, it, expect } from 'vitest';
import { FREE_CONTACTS, FULLY_ENCLOSED, MAX_DARKEN, shadeFor } from './occlusion.ts';
import { CollisionWorld } from '../physics/collisionWorld.ts';
import { BuildSystem } from '../build/buildSystem.ts';
import { PartRenderer } from './partRenderer.ts';

describe('the curve', () => {
  it('leaves a part in the open alone', () => {
    // A plank on the lawn touches the ground and nothing else, and must not
    // dim: darkening the default state is not shading, it is a colour change.
    expect(shadeFor(0)).toBe(1);
    expect(shadeFor(FREE_CONTACTS)).toBe(1);
  });

  it('darkens from the second contact', () => {
    expect(shadeFor(FREE_CONTACTS + 1)).toBeLessThan(1);
  });

  it('gets monotonically darker as a part is boxed in', () => {
    for (let n = 0; n < FULLY_ENCLOSED + 3; n++) {
      expect(shadeFor(n + 1)).toBeLessThanOrEqual(shadeFor(n));
    }
  });

  it('stops at the floor rather than falling to black', () => {
    // A cue, not a cave: a cartoon fort with a black interior reads as a
    // rendering bug rather than as shade.
    expect(shadeFor(FULLY_ENCLOSED)).toBeCloseTo(1 - MAX_DARKEN, 10);
    expect(shadeFor(FULLY_ENCLOSED + 10)).toBe(shadeFor(FULLY_ENCLOSED));
    expect(shadeFor(1000)).toBeGreaterThan(0.5);
  });

  it('never brightens, whatever it is asked', () => {
    for (const n of [0, 1, 3, 50]) expect(shadeFor(n)).toBeLessThanOrEqual(1);
  });
});

describe('the strength knob', () => {
  it('is off at zero', () => {
    expect(shadeFor(FULLY_ENCLOSED, 0)).toBe(1);
  });

  it('scales the darkening, not the thresholds', () => {
    // Half strength is half the darkening at every count — the free zone and
    // the floor stay where they are, or turning the knob changes which parts
    // are affected rather than how much.
    expect(shadeFor(FREE_CONTACTS, 0.5)).toBe(1);
    const full = 1 - shadeFor(FULLY_ENCLOSED, 1);
    const half = 1 - shadeFor(FULLY_ENCLOSED, 0.5);
    expect(half).toBeCloseTo(full / 2, 10);
  });

  it('is clamped, because a slider is not a validator', () => {
    expect(shadeFor(FULLY_ENCLOSED, 5)).toBe(shadeFor(FULLY_ENCLOSED, 1));
    expect(shadeFor(FULLY_ENCLOSED, -3)).toBe(1);
    expect(shadeFor(FULLY_ENCLOSED, Number.NaN)).toBe(1);
  });
});

describe('lit from the support graph', () => {
  /** A world, a renderer, and a row of planks laid flat on the lawn. */
  function rowOf(count: number) {
    const world = new CollisionWorld();
    const renderer = new PartRenderer();
    const build = new BuildSystem(world, renderer);
    const ids: number[] = [];
    for (let i = 0; i < count; i++) {
      // Plank kind 0 is 1m along +x; 0.9m apart overlaps the joint tolerance.
      build.applyPlace({ kind: 0, colorway: 0, x: i * 0.9, y: 0.025, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 });
      ids.push(build.lastPlacedId!);
    }
    return { world, renderer, build, ids };
  }

  it('darkens the middle of a row more than its ends', () => {
    // The end of a row touches one plank and the ground; the middle touches
    // two and the ground. The graph knows, so the light should.
    const { renderer, build, ids } = rowOf(3);
    build.shadeByEnclosure();
    const [left, mid, right] = ids.map((id) => renderer.shadeOf(id));
    expect(mid).toBeLessThan(left!);
    expect(left).toBe(right);
    expect(left).toBeLessThan(1);
  });

  it('leaves a lone plank on the lawn alone', () => {
    // One contact — the ground — is the free one. Darkening the default state
    // is a colour change, not shading.
    const { renderer, build, ids } = rowOf(1);
    build.shadeByEnclosure();
    expect(renderer.shadeOf(ids[0]!)).toBe(1);
  });

  it('re-lights what is left after a removal', () => {
    // Taking the middle out turns the ends into lone planks. A pass that only
    // ran on placement would leave them wearing the row's shade.
    const { renderer, build, ids } = rowOf(3);
    build.shadeByEnclosure();
    expect(renderer.shadeOf(ids[0]!)).toBeLessThan(1);
    build.applyRemove(ids[1]!);
    build.shadeByEnclosure();
    expect(renderer.shadeOf(ids[0]!)).toBe(1);
    expect(renderer.shadeOf(ids[2]!)).toBe(1);
  });

  it('turns off at strength zero without forgetting how to turn on', () => {
    const { renderer, build, ids } = rowOf(3);
    build.shadeByEnclosure(0);
    expect(renderer.shadeOf(ids[1]!)).toBe(1);
    build.shadeByEnclosure(1);
    expect(renderer.shadeOf(ids[1]!)).toBeLessThan(1);
  });

  it('reaches the colour buffer, not just the bookkeeping', () => {
    // `shadeOf` reports what the renderer believes; the buffer is what the GPU
    // sees. The two disagree under exactly one bug — a shade recorded and
    // never written — and only this can catch it.
    const { renderer, build, ids } = rowOf(3);
    const before = renderer.colorOf(ids[1]!)!;
    build.shadeByEnclosure();
    const after = renderer.colorOf(ids[1]!)!;
    expect(after.r).toBeLessThan(before.r);
  });
});
