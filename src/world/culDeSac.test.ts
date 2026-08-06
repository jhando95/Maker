/**
 * The street, and the promises it makes to the game.
 *
 * Almost none of this is about how it looks — that is what the survey
 * screenshots are for. What is checked here is the set of things that would let
 * some scenery quietly change a game that is balanced around a fenced lot: a
 * house inside the play area, a kerb somebody can trip over during a capture, a
 * neighbourhood standing on ground the lawn does not reach.
 */

import { describe, it, expect } from 'vitest';
import { Rng } from '../core/rng.ts';
import { culDeSacSlabs, BULB, TARMAC } from './culDeSac.ts';
import { neighborhoodSlabs } from './neighborhood.ts';
import { YARD_HALF, LAWN_EXTENT } from './scene.ts';

const street = culDeSacSlabs();

/**
 * A slab's axis-aligned half-extents, with its yaw taken into account.
 *
 * Written as a half-diagonal at first — one number used for both axes — which
 * is only correct for a square. On the forty-six-metre approach road it claimed
 * a twenty-three metre reach in Z as well as in X, and reported the road as
 * poking into the yard from ten metres outside it. Every assertion below rests
 * on this, so it being roughly right was worse than useless.
 */
function halfExtent(s: { w: number; d: number; ry?: number }): { x: number; z: number } {
  const c = Math.abs(Math.cos(s.ry ?? 0));
  const n = Math.abs(Math.sin(s.ry ?? 0));
  return {
    x: (s.w / 2) * c + (s.d / 2) * n,
    z: (s.w / 2) * n + (s.d / 2) * c,
  };
}

/** The furthest any part of a slab reaches, on each axis. */
function bounds(list: ReturnType<typeof culDeSacSlabs>) {
  let minX = Infinity; let maxX = -Infinity; let minZ = Infinity; let maxZ = -Infinity;
  for (const s of list) {
    const half = halfExtent(s);
    minX = Math.min(minX, s.x - half.x);
    maxX = Math.max(maxX, s.x + half.x);
    minZ = Math.min(minZ, s.z - half.z);
    maxZ = Math.max(maxZ, s.z + half.z);
  }
  return { minX, maxX, minZ, maxZ };
}

describe('the street', () => {
  it('stays entirely outside the fence', () => {
    // The constraint the whole layout was shaped around, and the one worth a
    // test: the play area is the fenced lot and three modes are balanced on its
    // dimensions. A neighbour's porch reaching over the line would be a change
    // to Capture the Flag disguised as a change to some scenery.
    for (const s of street) {
      const half = halfExtent(s);
      const insideX = Math.abs(s.x) - half.x < YARD_HALF;
      const insideZ = s.z + half.z > -YARD_HALF && s.z - half.z < YARD_HALF;
      expect(
        insideX && insideZ,
        `a slab at (${s.x}, ${s.z}) reaches into the yard`,
      ).toBe(false);
    }
  });

  it('ends, rather than running off the map in both directions', () => {
    // A road that leaves on both sides says the lot is a sample of somewhere
    // uniform. The point of the whole change is that this one stops.
    //
    // Asked of the tarmac rather than of everything out here, which is the
    // narrower and the true claim: there are roofs off to the sides of the lot
    // as well, level with it, and they are neighbours rather than a through
    // road. Written against every slab this failed on one of them, and would
    // have been "fixed" by deleting a house.
    const b = bounds(street.filter((s) => s.color === TARMAC));
    expect(b.maxZ).toBeLessThan(-YARD_HALF);
    // West, out into the fog. East, it stops dead at the head.
    expect(b.minX).toBeLessThan(-45);
    expect(b.maxX).toBeLessThan(BULB.x + BULB.radius + 1);
  });

  it('stands on ground the lawn actually reaches', () => {
    // Otherwise the far houses sit on the flat plane that fills the horizon,
    // which is a different green from the lawn and has no tone in it at all —
    // and the join runs right under them.
    const b = bounds(street);
    const half = LAWN_EXTENT / 2;
    expect(Math.abs(b.minX)).toBeLessThan(half);
    expect(Math.abs(b.minZ)).toBeLessThan(half);
    expect(b.maxX).toBeLessThan(half);
  });

  it('lays no wedge of the turning head at the same height as another', () => {
    // Every wedge overlaps every other at the centre. Coplanar top faces of one
    // colour z-fight across the whole junction — a shimmering starburst in the
    // middle of the road that moves as you walk — so they are stacked a
    // fraction of a millimetre apart to give the depth buffer an order.
    const wedges = street.filter((s) => s.color === TARMAC && (s.ry ?? 0) !== 0);
    expect(wedges.length).toBeGreaterThan(8);
    const heights = new Set(wedges.map((s) => s.y));
    expect(heights.size).toBe(wedges.length);
    // And close enough together that nobody can see the staircase.
    const ys = [...heights].sort((a, b) => a - b);
    expect(ys[ys.length - 1]! - ys[0]!).toBeLessThan(0.02);
  });

  it('leaves a verge between the kerb and the fence', () => {
    // Tarmac running to the pickets reads as a car park, because what makes a
    // road a road is the green either side of it.
    const kerbEdge = BULB.z + BULB.radius;
    expect(kerbEdge).toBeLessThan(-YARD_HALF - 2);
  });

  it('does not make the road solid, and does make the houses solid', () => {
    // A kerb you can trip over is a kerb that changes how a round plays. A
    // house you walk through is a screenshot nobody wants.
    const groundLevel = street.filter((s) => s.y < 0.2 && s.h < 0.2);
    expect(groundLevel.length).toBeGreaterThan(10);
    for (const s of groundLevel) expect(s.ghost).toBe(true);

    const walls = street.filter((s) => s.h > 3 && s.w > 8);
    expect(walls.length).toBeGreaterThanOrEqual(5);
    expect(walls.some((s) => s.ghost !== true)).toBe(true);
  });

  it('is the same street every time it is built', () => {
    // Placed by hand rather than scattered, so this is really a guard against
    // somebody reaching for an Rng later: two players have to be looking at the
    // same neighbourhood and none of it is sent.
    expect(culDeSacSlabs()).toEqual(culDeSacSlabs());
  });
});

describe('the map that contains it', () => {
  it('carries the street without disturbing the lot', () => {
    const all = neighborhoodSlabs(new Rng('map'));
    const inside = all.filter((s) => Math.abs(s.x) < YARD_HALF && Math.abs(s.z) < YARD_HALF);
    // The lot's own contents are untouched by the neighbourhood being added —
    // this number is a canary rather than a specification, and if it moves the
    // question is which of the two changed.
    expect(inside.length).toBeGreaterThan(300);
    expect(all.length).toBeGreaterThan(inside.length);
  });

  it('never puts a neighbour where a mode puts a player', () => {
    // Spawns, flags and the stash all sit inside the fence, and the test above
    // proves nothing out here reaches in. This says the same thing from the
    // other end, in the terms the modes use.
    const anchors = [
      [-20.5, -7], [20.5, -7], [-17.5, 1.5], [17.5, 1.5], [-12, -13], [-9.5, 9], [16, 9], [2.5, -11],
    ] as const;
    for (const [x, z] of anchors) {
      for (const s of street) {
        const half = halfExtent(s);
        expect(
          Math.abs(s.x - x) < half.x + 1 && Math.abs(s.z - z) < half.z + 1,
          `scenery at (${s.x}, ${s.z}) sits on the anchor at (${x}, ${z})`,
        ).toBe(false);
      }
    }
  });
});
