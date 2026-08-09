/**
 * The horizon, and the promises it makes to the game.
 *
 * Same two rules as the street, for the same reason: this is scenery, the play
 * area is the fenced lot, and a hedge that reached over the line would be a
 * change to Capture the Flag disguised as a change to some landscaping.
 *
 * The third rule is this file's own, and it is about cost rather than
 * correctness. A horizon is a lot of boxes, scenery is instanced by exact
 * dimensions, and a size used once is a draw call spent on one object. Nothing
 * else in the project has the ratio of objects-to-importance that a treeline
 * does, so it is worth a test rather than a comment.
 */

import { describe, it, expect } from 'vitest';
import { Rng } from '../core/rng.ts';
import { surroundsSlabs, POCKETS, pocketSlabs } from './surrounds.ts';
import { culDeSacSlabs } from './culDeSac.ts';
import { neighborhoodSlabs, LEFT_SPAWN, RIGHT_SPAWN } from './neighborhood.ts';
import { YARD_HALF, LAWN_EXTENT } from './scene.ts';

const around = surroundsSlabs(new Rng('surrounds'));

function halfExtent(s: { w: number; d: number; ry?: number }): { x: number; z: number } {
  const c = Math.abs(Math.cos(s.ry ?? 0));
  const n = Math.abs(Math.sin(s.ry ?? 0));
  return { x: (s.w / 2) * c + (s.d / 2) * n, z: (s.w / 2) * n + (s.d / 2) * c };
}

describe('the horizon', () => {
  it('breaks the skyline in every direction the yard can see', () => {
    // The measurement this whole change came from: the cul-de-sac filled one
    // side and the other three were flat green to the sky. A boundary you can
    // see past to nothing tells the player the world ends at the fence.
    //
    // Counted per compass sector rather than as a total, because a hundred
    // objects all behind the house would pass a count and leave two thirds of
    // the horizon empty — which is exactly the state this started in.
    //
    // And counted only for things tall enough to stand against the sky. Ground
    // detail is not a horizon: a kerb thirty metres out contributes nothing to
    // the question "is there anything over there", and counting it was what let
    // the first version of this test pass with a side missing.
    const sectors = new Array(12).fill(0);
    for (const s of [...around, ...culDeSacSlabs()]) {
      const r = Math.hypot(s.x, s.z);
      if (r < YARD_HALF || s.y + s.h / 2 < 4) continue;
      const bearing = Math.atan2(s.x, s.z) + Math.PI;
      sectors[Math.min(11, Math.floor((bearing / (Math.PI * 2)) * 12))]!++;
    }
    for (let i = 0; i < 12; i++) {
      expect(sectors[i], `nothing on the skyline in the ${i * 30}° sector`).toBeGreaterThan(5);
    }
  });

  it('shows a building in every quarter, not only trees', () => {
    // A treeline alone would satisfy the check above, and a lot ringed by
    // nothing but woods is a clearing rather than a neighbourhood. This is the
    // weaker of the two claims on purpose — it says each quarter has *a*
    // roofline, not how many.
    const quarters = [0, 0, 0, 0];
    for (const s of [...around, ...culDeSacSlabs()]) {
      if (s.h < 3 || s.w < 8) continue;
      const bearing = Math.atan2(s.x, s.z) + Math.PI;
      quarters[Math.min(3, Math.floor((bearing / (Math.PI * 2)) * 4))]!++;
    }
    for (let i = 0; i < 4; i++) {
      expect(quarters[i], `no buildings at all in the ${i * 90}° quarter`).toBeGreaterThan(1);
    }
  });

  it('stays entirely outside the fence', () => {
    for (const s of around) {
      const half = halfExtent(s);
      const insideX = Math.abs(s.x) - half.x < YARD_HALF;
      const insideZ = s.z + half.z > -YARD_HALF && s.z - half.z < YARD_HALF;
      expect(insideX && insideZ, `a slab at (${s.x}, ${s.z}) reaches into the yard`).toBe(false);
    }
  });

  it('stands on ground the lawn actually reaches', () => {
    for (const s of around) {
      const half = halfExtent(s);
      expect(Math.abs(s.x) + half.x).toBeLessThan(LAWN_EXTENT / 2);
      expect(Math.abs(s.z) + half.z).toBeLessThan(LAWN_EXTENT / 2);
    }
  });

  it('grows no tree through a roof', () => {
    // The failure mode a scattered treeline has. The scatter rejects against a
    // list of what is already there rather than being confined to an annulus
    // and hoped for, and this is what says so.
    const trunks = around.filter((s) => s.color === 0x7a5438 && s.w < 1);
    const walls = [...around, ...culDeSacSlabs()].filter((s) => s.h > 3 && s.w > 8);
    expect(trunks.length).toBeGreaterThan(60);
    expect(walls.length).toBeGreaterThan(10);
    for (const t of trunks) {
      for (const w of walls) {
        const half = halfExtent(w);
        expect(
          Math.abs(t.x - w.x) < half.x && Math.abs(t.z - w.z) < half.z,
          `a tree at (${t.x.toFixed(1)}, ${t.z.toFixed(1)}) is inside the building at (${w.x}, ${w.z})`,
        ).toBe(false);
      }
    }
  });

  it('draws a whole wood out of a handful of shapes', () => {
    // Not a style note. Fifty individually proportioned trees are fifty draw
    // calls; fifty picked from three sizes are three, and at forty metres in fog
    // nobody can tell which they are looking at.
    const shapes = new Set(
      around.map((s) => `${s.w.toFixed(3)}:${s.h.toFixed(3)}:${s.d.toFixed(3)}`),
    );
    expect(around.length).toBeGreaterThan(250);
    // Raised from 40 when the pockets went in, with the trade stated: the
    // wood is still three sizes for 170 trees, and what the extra sizes buy
    // is four one-off landmarks — a dozen draws for a dozen objects, not a
    // dozen draws for a horizon. The pockets already share sizes where
    // sharing is invisible (two stone sizes serve both the pond and the
    // firepit; one rail size serves both fence runs).
    expect(shapes.size).toBeLessThan(56);
  });

  it('is the same horizon every time', () => {
    // Two players have to be looking at the same trees and none of it is sent.
    expect(surroundsSlabs(new Rng('surrounds'))).toEqual(surroundsSlabs(new Rng('surrounds')));
  });

  it('does not disturb the yard when it changes', () => {
    // The bug this replaces: `surroundsSlabs` takes an Rng, `rng.fork()`
    // advances the parent, and taking a fork mid-build shifted every random
    // draw the yard made afterwards — so adding trees to a horizon moved a
    // crate onto the left spawn. It gets a stream of its own now, and this is
    // the check that the yard's own contents are still where they were.
    const map = neighborhoodSlabs(new Rng('test-lot'));
    for (const spawn of [LEFT_SPAWN, RIGHT_SPAWN]) {
      const onTop = map.filter((s) =>
        s.ghost !== true &&
        Math.abs(s.x - spawn.x) < s.w / 2 + 0.3 &&
        Math.abs(s.z - spawn.z) < s.d / 2 + 0.3 &&
        s.y - s.h / 2 < 1.5);
      expect(onTop, `something is standing on a spawn at (${spawn.x}, ${spawn.z})`).toHaveLength(0);
    }
  });
});

describe('the pockets outside the fence', () => {
  const inBox = (p: { x: number; z: number; halfW: number; halfD: number },
    s: { x: number; z: number }): boolean =>
    Math.abs(s.x - p.x) <= p.halfW && Math.abs(s.z - p.z) <= p.halfD;

  it('builds every pocket, solid enough to play on', () => {
    for (const p of POCKETS) {
      const inside = around.filter((s) => inBox(p, s));
      expect(inside.length, p.name).toBeGreaterThanOrEqual(6);
      expect(inside.some((s) => s.ghost !== true), `${p.name} is all backdrop`).toBe(true);
    }
    // The site keeps its climb; the pond keeps its ring of nine stones.
    const site = around.filter((s) => inBox(POCKETS[0], s));
    expect(Math.max(...site.map((s) => s.y + s.h / 2))).toBeGreaterThan(2);
    const stones = around.filter((s) => inBox(POCKETS[1], s) && s.ghost !== true);
    expect(stones.length).toBeGreaterThanOrEqual(9);
  });

  it('shares no pocket footprint with anything else on the map', () => {
    // Swept against the whole solid world — neighbourhood (which folds the
    // surrounds in) and the street — across seeds, because the trees wander
    // per match while the pockets do not. Low and solid only: a ghost canopy
    // metres overhead shades a pocket and blocks nothing. Each pocket's own
    // slabs are recognised by position, from the single fixed seed the module
    // builds them with — they take no randomness, so any low solid slab in a
    // box that is not in that set came from something else.
    // The reference comes from building the pockets ALONE — not from the
    // assembled world, which is the bug the first version had: deriving "own"
    // from the world under test meant an intruder in the box was counted as
    // own, and the sweep compared the world to itself. Planting the pond on
    // a neighbour's house passed. This version fails it.
    const own = new Set(
      pocketSlabs()
        .filter((s) => s.ghost !== true && s.y < 3)
        .map((s) => `${s.x.toFixed(2)},${s.y.toFixed(2)},${s.z.toFixed(2)}`),
    );
    for (const seed of ['surrounds', 'b', 'match-991', 'x7']) {
      const world = [
        ...neighborhoodSlabs(new Rng(seed)),
        ...culDeSacSlabs(),
      ];
      for (const s of world) {
        if (s.ghost === true || s.y >= 3) continue;
        const pocket = POCKETS.find((p) => inBox(p, s));
        if (pocket === undefined) continue;
        expect(
          own.has(`${s.x.toFixed(2)},${s.y.toFixed(2)},${s.z.toFixed(2)}`),
          `seed ${seed}: a foreign slab stands in the ${pocket.name} at `
            + `(${s.x.toFixed(1)}, ${s.z.toFixed(1)})`,
        ).toBe(true);
      }
    }
  });
});
