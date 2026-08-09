/**
 * The path layer decides what to lay from where a body is and how it moves —
 * pure arithmetic, so everything here is exact. The commit side (cost,
 * overlap, support, the wire) belongs to the stamp path and its own tests;
 * what these guard is the *choreography*: one part per cell, the cell under
 * the lead foot, the height that was locked, the lane that does not wander.
 */

import { describe, it, expect } from 'vitest';
import { beginLay, layStep, LAY_MIN_SPEED } from './pathLayer.ts';
import { MODULE, getPartKind } from './partKit.ts';
import type { PlacementRecord } from './buildSystem.ts';

const PLANK = 0;
const LEN = getPartKind(PLANK).length;
const THICK = getPartKind(PLANK).thickness;

/** Walk a straight line, collecting whatever the layer wants placed. */
function walk(
  fromX: number, toX: number, z: number, feetY = 0, kind = PLANK,
): PlacementRecord[] {
  const state = beginLay(feetY);
  const out: PlacementRecord[] = [];
  const steps = 200;
  for (let i = 0; i <= steps; i++) {
    const x = fromX + ((toX - fromX) * i) / steps;
    const r = layStep(state, x, z, Math.sign(toX - fromX) * 4, 0, kind, 0);
    if (r !== null) out.push(r);
  }
  return out;
}

describe('laying along a run', () => {
  it('lays one part per cell, edge to edge, and no doubles', () => {
    const laid = walk(0.1, 4.9, 0);
    // Cells are part-length; five metres of running crosses five of them.
    expect(laid.length).toBeGreaterThanOrEqual(4);
    const centres = laid.map((r) => r.x);
    expect(new Set(centres).size).toBe(centres.length);
    for (let i = 1; i < laid.length; i++) {
      expect(Math.abs(laid[i]!.x - laid[i - 1]!.x)).toBeCloseTo(LEN, 5);
    }
  });

  it('locks the height at the feet that pressed the key', () => {
    // The whole bridge trick: the body walks off an edge and the parts keep
    // coming at the locked height, not at wherever the body is falling to.
    const laid = walk(0.1, 3.9, 0, 1.25);
    expect(laid.length).toBeGreaterThan(2);
    for (const r of laid) expect(r.y).toBeCloseTo(1.25 + THICK / 2, 5);
  });

  it('keeps the lane fixed while the body wobbles across it', () => {
    // A runner does not hold a line to the centimetre. The path must. The
    // wobble here deliberately crosses the module boundary (±0.2 against a
    // 0.25 grid) — the first version wobbled within one grid cell, where even
    // a lane that follows the body snaps to the same value, and a planted
    // per-tick lane passed untouched.
    const state = beginLay(0);
    const zs = [0.04, 0.2, -0.16, 0.14, -0.2];
    const laid: PlacementRecord[] = [];
    for (let i = 0; i <= 200; i++) {
      const r = layStep(state, (4 * i) / 200, zs[i % zs.length]!, 4, 0, PLANK, 0);
      if (r !== null) laid.push(r);
    }
    expect(laid.length).toBeGreaterThan(2);
    const lanes = new Set(laid.map((r) => r.z));
    expect(lanes.size).toBe(1);
    // And on the module grid, so a second run lands shoulder to shoulder.
    const lane = laid[0]!.z;
    expect(Math.abs(lane / MODULE - Math.round(lane / MODULE))).toBeLessThan(1e-9);
  });

  it('does not skip the first cell after a turn whose index collides', () => {
    // The stale-cursor bug makes a *hole*, not a double: the cell index is an
    // axis-local number, and if the old axis's cursor happens to equal the new
    // axis's first cell, that first cell is "already laid" and gets skipped —
    // a gap at every corner that turns at the wrong spot. Engineered here:
    // a short east leg parks the cursor at 0, and the north leg's first cell
    // is also 0.
    const state = beginLay(0);
    for (let i = 0; i <= 40; i++) {
      layStep(state, 0.05 + (0.35 * i) / 40, 0, 4, 0, PLANK, 0);
    }
    const north: PlacementRecord[] = [];
    for (let i = 0; i <= 100; i++) {
      const r = layStep(state, 0.4, (2 * i) / 100, 0, 4, PLANK, 0);
      if (r !== null) north.push(r);
    }
    expect(north.length).toBeGreaterThan(1);
    expect(north[0]!.z).toBeCloseTo(0.5, 5);
  });

  it('lays nothing while the body is standing still', () => {
    const state = beginLay(0);
    for (let i = 0; i < 50; i++) {
      expect(layStep(state, 1, 1, LAY_MIN_SPEED * 0.5, 0, PLANK, 0)).toBeNull();
    }
  });

  it('turns a corner in right angles and re-anchors, without double-laying', () => {
    const state = beginLay(0);
    const laid: PlacementRecord[] = [];
    // East along z=0, then a hard turn north at x=3.
    for (let i = 0; i <= 100; i++) {
      const r = layStep(state, (3 * i) / 100, 0, 4, 0, PLANK, 0);
      if (r !== null) laid.push(r);
    }
    const eastCount = laid.length;
    for (let i = 0; i <= 100; i++) {
      const r = layStep(state, 3, (3 * i) / 100, 0, 4, PLANK, 0);
      if (r !== null) laid.push(r);
    }
    expect(eastCount).toBeGreaterThan(1);
    expect(laid.length).toBeGreaterThan(eastCount + 1);
    // The east leg is unturned; the north leg carries the exact quarter turn
    // on the 1e-4 grid every rotation in this game lives on.
    for (const r of laid.slice(0, eastCount)) expect(r.qy).toBe(0);
    for (const r of laid.slice(eastCount)) {
      expect(r.qy).toBeCloseTo(0.7071, 10);
      expect(r.qw).toBeCloseTo(0.7071, 10);
    }
    const keys = new Set(laid.map((r) => `${r.x},${r.z}`));
    expect(keys.size).toBe(laid.length);
  });

  it('lays backwards exactly as well as forwards', () => {
    // Backing across the gap while facing the balloon is the move this whole
    // feature exists for; heading comes from velocity, and negative velocity
    // is a heading like any other.
    const laid = walk(4.9, 0.1, 0);
    expect(laid.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < laid.length; i++) {
      expect(laid[i]!.x).toBeLessThan(laid[i - 1]!.x);
    }
  });

  it('reaches ahead of the body, not behind it', () => {
    // The next board has to arrive under the lead foot *before* the foot
    // crosses the edge. A body a tenth of a metre short of the cell boundary
    // must get the next cell, not the one it is already standing on — the
    // first version of this test asked for "the far edge is ahead of you",
    // which the standing cell satisfies trivially and a deleted lead passes.
    const state = beginLay(0);
    const first = layStep(state, 0.9, 0, 4, 0, PLANK, 0);
    expect(first).not.toBeNull();
    expect(first!.x).toBeGreaterThan(0.9);
  });
});
