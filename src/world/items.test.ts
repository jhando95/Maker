import { describe, it, expect } from 'vitest';
import { CollisionWorld } from '../physics/collisionWorld.ts';
import { Rng } from '../core/rng.ts';
import {
  ITEMS, SOURCE_KEEPOUT, TRAMPOLINE_SPEED, distanceToItem, onItem, type Item,
} from './items.ts';
import {
  WATER_SOURCES, LEFT_FLAG, RIGHT_FLAG, LEFT_SPAWN, RIGHT_SPAWN, HOUSE, TREEHOUSE,
  neighborhoodSlabs, installFixtures,
} from './neighborhood.ts';
import { GRAVITY, STEP_HEIGHT, JUMP_HEIGHT } from '../physics/constants.ts';

/** Middle of the porch roof, which `porch()` centres a little in front of the house. */
const PORCH_Z = -(HOUSE.halfDepth + 1.5) - 0.2;

/** The map as the game builds it, with everything solid in it. */
function builtWorld(): CollisionWorld {
  const world = new CollisionWorld();
  installFixtures(world, neighborhoodSlabs(new Rng('map')));
  return world;
}

/** Height of the first solid thing under a point, or null if there is none. */
function surfaceUnder(world: CollisionWorld, x: number, z: number, from = 3): number | null {
  const hit = world.raycast(x, from, z, 0, -1, 0, from + 1);
  return hit === null ? null : from - hit.distance;
}

describe('items', () => {
  describe('the list', () => {
    it('keeps every footprint clear of every water source', () => {
      // The invariant that exists because breaking it broke three of Water
      // War's balance tests: a solid prop inside the ring those measurements
      // build is a wall the player did not pay for.
      for (const item of ITEMS) {
        for (const source of WATER_SOURCES) {
          const gap = distanceToItem(item, source.x, source.z);
          expect(
            gap,
            `${item.kind} at (${item.x}, ${item.z}) is ${gap.toFixed(2)}m from ${source.name}`,
          ).toBeGreaterThanOrEqual(SOURCE_KEEPOUT);
        }
      }
    });

    it('measures that gap from the nearest corner, not the centre', () => {
      // The distinction the keepout turns on, stated as a test because a
      // centre-to-centre check would pass the exact placement it exists to
      // reject: a long slide whose middle is far away and whose end is not.
      const sprawling: Item = {
        kind: 'slide', x: 0, z: 0, halfW: 1, halfD: 9, y: 0.06, ry: 0,
      };
      expect(Math.hypot(0 - sprawling.x, 10 - sprawling.z)).toBe(10);
      expect(distanceToItem(sprawling, 0, 10)).toBeCloseTo(1, 6);
    });

    it('turns with the item, so a rotated slide is not measured as a square', () => {
      const across: Item = { kind: 'slide', x: 0, z: 0, halfW: 1, halfD: 5, y: 0.06, ry: Math.PI / 2 };
      // Long axis now runs along X, so a point out on X is close and one out
      // on Z is not. Measured the other way round these two would swap.
      expect(distanceToItem(across, 6, 0)).toBeCloseTo(1, 5);
      expect(distanceToItem(across, 0, 6)).toBeCloseTo(5, 5);
    });

    it('stands nothing on a spawn or a flag', () => {
      // Same reasoning as the keepout and a different objective: a shove or a
      // launch you did not ask for, on the spot a mode puts you or sends you,
      // is the mode being edited by a decoration.
      const sacred = [LEFT_FLAG, RIGHT_FLAG, LEFT_SPAWN, RIGHT_SPAWN];
      for (const item of ITEMS) {
        for (const spot of sacred) {
          expect(distanceToItem(item, spot.x, spot.z)).toBeGreaterThan(1.5);
        }
      }
    });

    it('does not stack two items in the same place', () => {
      // Two effects on one body is not a bigger effect, it is whichever one
      // `applyItems` reaches first — an ordering dependency nobody would guess.
      for (let i = 0; i < ITEMS.length; i++) {
        for (let j = i + 1; j < ITEMS.length; j++) {
          const a = ITEMS[i];
          const b = ITEMS[j];
          expect(
            distanceToItem(a, b.x, b.z),
            `${a.kind} at (${a.x}, ${a.z}) overlaps ${b.kind} at (${b.x}, ${b.z})`,
          ).toBeGreaterThan(0);
        }
      }
    });
  });

  describe('the geometry agrees with the effect', () => {
    it('puts a real surface under every trampoline', () => {
      // The one thing that has to line up between this file and
      // `neighborhood.ts`: the effect keys on `item.y`, and if the mat is not
      // actually there the player walks through a working trampoline. Nothing
      // in the type system connects the two numbers, so this does.
      const world = builtWorld();
      for (const item of ITEMS) {
        if (item.kind !== 'trampoline') continue;
        const top = surfaceUnder(world, item.x, item.z);
        expect(top, `nothing solid under the trampoline at (${item.x}, ${item.z})`).not.toBeNull();
        expect(top as number).toBeCloseTo(item.y, 2);
      }
    });

    it('leaves the slides walkable rather than solid', () => {
      // Ghosted on purpose. Six centimetres of sheet is nothing to a character
      // — the step-up clears nine times it — but the flow field the kids route
      // on marks a cell occupied by anything solid at any height, and solid
      // these two lanes diverted every bot on their side of the house.
      //
      // Asked of the slab list rather than by casting a ray, after two goes at
      // the ray version that both passed with the sheets deliberately made
      // solid. A sheet sits flat on the lawn, so there is no gap between the
      // two to aim a ray at: one that reaches the sheet reaches the ground as
      // well, and the surface it reports is `item.y` either way — off by a
      // float's width, which was enough for a `toBeLessThan` to be true for
      // both answers. The flow field reads solid slabs, so this reads them too.
      //
      // It also covers the thing the ray never would: something *else* solid
      // parked on the lane, which would divert the bots exactly as the sheet
      // did and is a much likelier future mistake than un-ghosting the sheet.
      const slabs = neighborhoodSlabs(new Rng('map'));
      for (const item of ITEMS) {
        if (item.kind !== 'slide') continue;
        const inTheWay = slabs.filter((s) => (
          s.ghost !== true
          && s.y - s.h / 2 < item.y
          && distanceToItem(item, s.x, s.z) < Math.max(s.w, s.d) / 2
        ));
        expect(
          inTheWay.map((s) => `${s.w}x${s.h}x${s.d} at (${s.x}, ${s.y}, ${s.z})`),
          `something solid is standing on the slide at (${item.x}, ${item.z})`,
        ).toEqual([]);
      }
    });

    it('does not bury a trampoline in something that was already there', () => {
      // A mat at 0.32m inside a crate reads as a trampoline that does not work,
      // and the way to find out is normally to stand on one. Head height above
      // the mat has to be clear or there is nowhere to bounce to.
      const world = builtWorld();
      for (const item of ITEMS) {
        if (item.kind !== 'trampoline') continue;
        const up = world.raycast(item.x, item.y + 0.1, item.z, 0, 1, 0, 4);
        expect(up, `something overhangs the trampoline at (${item.x}, ${item.z})`).toBeNull();
      }
    });
  });

  describe('onItem', () => {
    const pad: Item = { kind: 'trampoline', x: 5, z: -3, halfW: 1.1, halfD: 1.1, y: 0.32, ry: 0 };

    it('is true standing on it', () => {
      expect(onItem(pad, 5, 0.32, -3)).toBe(true);
    });

    it('is false stood beside it', () => {
      expect(onItem(pad, 5 + 1.4, 0.32, -3)).toBe(false);
      expect(onItem(pad, 5, 0.32, -3 - 1.4)).toBe(false);
    });

    it('is false sailing over it', () => {
      expect(onItem(pad, 5, 2.5, -3)).toBe(false);
    });

    it('forgives a body a few centimetres into the surface', () => {
      // A body that lands hard is briefly below the mat. Missing the frame it
      // was in contact reads as a trampoline that only works sometimes.
      expect(onItem(pad, 5, pad.y - 0.3, -3)).toBe(true);
    });

    it('follows the item round when it is turned', () => {
      const turned: Item = { ...pad, x: 0, z: 0, halfW: 0.5, halfD: 3, ry: Math.PI / 2 };
      // Long axis along X once turned: a point 2m out on X is on it, and the
      // same distance out on Z is not. Unrotated it would be the other way.
      expect(onItem(turned, 2, turned.y, 0)).toBe(true);
      expect(onItem(turned, 0, turned.y, 2)).toBe(false);
    });
  });

  describe('the bounce is worth taking', () => {
    /** Where the feet get to, launched from a mat at `y`. */
    const apexFrom = (y: number): number => y + (TRAMPOLINE_SPEED ** 2) / (2 * GRAVITY);
    const mat = ITEMS.find((i) => i.kind === 'trampoline') as Item;

    it('lands you on the porch roof, which is the first stage of the climb', () => {
      // The landmark the speed is sized against — measured off the map rather
      // than copied out of it, so moving the porch moves the test with it.
      // Roughly half a metre of headroom, so the arc still has drift to spend
      // on the way over instead of arriving at the gutter with nothing.
      const roof = surfaceUnder(builtWorld(), 0, PORCH_Z, 4) as number;
      expect(roof).toBeCloseTo(HOUSE.porchRoof + 0.13, 2);
      expect(apexFrom(mat.y)).toBeGreaterThan(roof + 0.4);
    });

    it('does not reach the stage the player is supposed to build up to', () => {
      // The ceiling, and the more important half. `neighborhood.ts` opens with
      // the rule that the last stage of the climb is the part you build; a pad
      // that reached the treehouse deck or the eaves would repeal it, and the
      // way that happens is somebody nudging the speed up because the bounce
      // felt weak. This is what stops that being a quiet change.
      const deck = surfaceUnder(builtWorld(), TREEHOUSE.x, TREEHOUSE.z, 5.6) as number;
      expect(deck).toBeGreaterThan(TREEHOUSE.deck);
      expect(apexFrom(mat.y)).toBeLessThan(deck);
      expect(apexFrom(mat.y)).toBeLessThan(HOUSE.eaves);
    });

    it('is worth more than the jump it replaces', () => {
      // The floor. Below this a launch pad is a decoration you can also stand
      // on, and the map has plenty of those.
      expect(apexFrom(mat.y) - mat.y).toBeGreaterThan(JUMP_HEIGHT * 2);
      expect(apexFrom(mat.y) - mat.y).toBeGreaterThan(STEP_HEIGHT);
    });
  });
});
