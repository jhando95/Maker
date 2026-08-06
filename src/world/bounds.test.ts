import { describe, it, expect } from 'vitest';
import { CollisionWorld } from '../physics/collisionWorld.ts';
import { CharacterController } from '../player/controller.ts';
import { BuildSystem } from '../build/buildSystem.ts';
import { PartRenderer } from '../render/partRenderer.ts';
import { Rng } from '../core/rng.ts';
import {
  PLAY_AREA, PLAY_HALF, FLOOR, BUILD_CEILING,
  barrierBoxes, boxInBounds, enforceBounds, inBounds, installBarrier,
} from './bounds.ts';
import { neighborhoodSlabs, installFixtures, WATER_SOURCES, LEFT_SPAWN, RIGHT_SPAWN } from './neighborhood.ts';
import { ITEMS } from './items.ts';
import { CAP_RADIUS, DT, SPRINT_SPEED } from '../physics/constants.ts';
import { STARTER_ORIGIN } from './starter.ts';

/** The map, its barrier, and a body standing in the middle of it. */
function world(): CollisionWorld {
  const w = new CollisionWorld();
  installFixtures(w, neighborhoodSlabs(new Rng('map')));
  installBarrier(w);
  return w;
}

function body(w: CollisionWorld, x = 0, y = 0.5, z = 0): CharacterController {
  return new CharacterController(w, x, y, z);
}

const STILL = { forward: 0, right: 0, jump: false, sprint: false, crouch: false, climb: 0 };

describe('the edge of the world', () => {
  describe('the box itself', () => {
    it('is well inside the lawn it is drawn on', () => {
      // The lawn's detailed square is 132m across, and outside it the ground is
      // an untextured plane meeting it in a straight line. A boundary at or past
      // that line would put a player against the wall looking at the seam.
      expect(PLAY_HALF).toBeLessThan(132 / 2 - 5);
    });

    it('contains everything any mode sends anybody to', () => {
      // The check that stops the box being tightened into a mode. Every spawn,
      // objective and item has to be inside it with room to stand.
      const spots: Array<[string, number, number]> = [
        ['left spawn', LEFT_SPAWN.x, LEFT_SPAWN.z],
        ['right spawn', RIGHT_SPAWN.x, RIGHT_SPAWN.z],
        ...WATER_SOURCES.map((s) => [s.name, s.x, s.z] as [string, number, number]),
        ...ITEMS.map((i) => [i.kind, i.x, i.z] as [string, number, number]),
        ['the starter shed', STARTER_ORIGIN.x, STARTER_ORIGIN.z],
        // The far end of the cul-de-sac, which is Tag's field.
        ['the turning head', 0, -37],
        ['the far neighbour', 0.5, -51.5],
      ];
      for (const [name, x, z] of spots) {
        expect(inBounds(x, z, 2), `${name} at (${x}, ${z}) is outside the world`).toBe(true);
      }
    });

    it('puts the floor below anything a body can stand on', () => {
      // Above the wedge a body settles into under the world, and far below the
      // deepest a legitimate landing reaches — measured at 0.004m from forty
      // metres up, so there is three orders of magnitude between the two.
      expect(FLOOR).toBeLessThan(-0.2);
      expect(FLOOR).toBeGreaterThan(-1.19);
    });
  });

  describe('the wall', () => {
    it('stops a sprint at the edge', () => {
      // The layer a player actually meets. Started well inside so this is the
      // wall doing the work rather than the clamp catching a body that began
      // out of bounds.
      const w = world();
      const who = body(w, PLAY_HALF - 6, 0.5, 0);
      for (let i = 0; i < 300; i++) {
        who.step(DT, { ...STILL, right: 1, sprint: true });
      }
      expect(who.x).toBeLessThan(PLAY_HALF);
      // And it is the wall, not the clamp: stopped short of where the clamp
      // would have put it, by the wall's own thickness against the capsule.
      expect(who.x).toBeGreaterThan(PLAY_HALF - 3);
    });

    it('stops one on every side', () => {
      const w = world();
      for (const [name, rx, fz] of [
        ['+X', 1, 0], ['-X', -1, 0], ['+Z', 0, 1], ['-Z', 0, -1],
      ] as Array<[string, number, number]>) {
        const who = body(w, rx * (PLAY_HALF - 6), 0.5, fz * (PLAY_HALF - 6));
        for (let i = 0; i < 300; i++) {
          who.step(DT, { ...STILL, right: rx, forward: fz, sprint: true });
        }
        expect(Math.abs(who.x), `${name} let a body past on x`).toBeLessThanOrEqual(PLAY_HALF);
        expect(Math.abs(who.z), `${name} let a body past on z`).toBeLessThanOrEqual(PLAY_HALF);
      }
    });

    it('has no seam at the corners', () => {
      // Two walls that merely met would leave a gap a capsule fits into, and a
      // corner is exactly where somebody running along one wall arrives.
      const w = world();
      const who = body(w, PLAY_HALF - 6, 0.5, PLAY_HALF - 6);
      for (let i = 0; i < 400; i++) {
        who.step(DT, { ...STILL, right: 1, forward: 1, sprint: true });
      }
      expect(who.x).toBeLessThanOrEqual(PLAY_HALF);
      expect(who.z).toBeLessThanOrEqual(PLAY_HALF);
    });

    it('is thicker than a body moves in a tick', () => {
      // Collision here is discrete, so thickness is the whole of the answer to
      // tunnelling. Measured against the fastest thing in the game, which is a
      // slip-n-slide rather than a sprint.
      const perTick = 17 * DT;
      const boxes = barrierBoxes();
      for (const box of boxes) {
        expect(Math.min(box.w, box.d)).toBeGreaterThan(perTick * 4);
      }
    });

    it('is taller than anywhere a body can walk, climb or bounce to', () => {
      // The house ridge is the highest thing in the world you can stand on
      // without building, and a trampoline adds three metres to whatever you
      // are standing on. Twice the ridge covers all of it.
      for (const box of barrierBoxes()) {
        expect(box.y + box.h / 2).toBeGreaterThan(7.1 * 2 - 0.5);
      }
    });

    it('is deliberately shorter than a tower could be', () => {
      // Not an oversight. A wall tall enough to beat the build ceiling costs
      // four times the broadphase to cover a case nobody meets — and the clamp
      // covers it anyway, which the next test shows.
      const top = Math.max(...barrierBoxes().map((b) => b.y + b.h / 2));
      expect(top).toBeLessThan(BUILD_CEILING);
    });

    it('hands the tower case to the clamp, which does not care how high it is', () => {
      // Somebody who builds forty metres of scaffolding against the edge and
      // jumps off the top is over the wall and outside the box — for exactly
      // one tick.
      const w = world();
      const who = body(w, PLAY_HALF + 8, BUILD_CEILING, 0);
      expect(enforceBounds(who)).toBe('wall');
      expect(who.x).toBeCloseTo(PLAY_HALF - CAP_RADIUS, 5);
      // And its height is untouched, so it falls back into the world rather
      // than being dropped on the lawn like somebody who fell out of it.
      expect(who.y).toBeCloseTo(BUILD_CEILING, 5);
    });

    it('does not cost more of the broadphase than it is worth', () => {
      // The cost that does not show up in a frame time. These are four enormous
      // boxes and the broadphase is a uniform grid of one-metre cells, so each
      // is inserted into every cell it touches — the map alone occupies about
      // fifteen thousand and the barrier multiplies that several times over.
      //
      // It is memory rather than time (the benchmark is unchanged), which is
      // exactly the sort of cost that grows unnoticed: make the wall a little
      // thicker or a little taller and this doubles with nothing to show for it.
      const bare = new CollisionWorld();
      installFixtures(bare, neighborhoodSlabs(new Rng('map')));
      const before = bare.hash.stats().cells;

      const walled = world();
      const after = walled.hash.stats().cells;
      expect(after).toBeGreaterThan(before);
      expect(
        after - before,
        `the barrier occupies ${after - before} broadphase cells`,
      ).toBeLessThan(25_000);
    });
  });

  describe('the clamp', () => {
    it('says nothing about a body in the middle of the lawn', () => {
      const w = world();
      const who = body(w, 4, 0.5, 4);
      expect(enforceBounds(who)).toBe('none');
      expect(who.x).toBe(4);
      expect(who.z).toBe(4);
    });

    it('puts a body that is somehow outside back on the face', () => {
      // The layer that cannot be beaten, because it is not a collision test.
      // This is what catches a teleport, a spawn placed wrong, and whatever
      // launcher somebody adds next.
      const w = world();
      const who = body(w, PLAY_HALF + 40, 0.5, 0);
      expect(enforceBounds(who)).toBe('wall');
      expect(who.x).toBeCloseTo(PLAY_HALF - CAP_RADIUS, 5);
    });

    it('kills the outward velocity as well as the position', () => {
      // Position alone leaves a body pressed against the face at full speed, so
      // the next tick moves it out and the one after clamps it back: a player
      // standing still, vibrating, with the walk cycle running.
      const w = world();
      const who = body(w, PLAY_HALF + 5, 0.5, 0);
      who.vx = 9;
      enforceBounds(who);
      expect(who.vx).toBe(0);
    });

    it('leaves velocity that points back inside alone', () => {
      // The other half. A body bounced off the wall is on its way home, and
      // zeroing that too would pin it there.
      const w = world();
      const who = body(w, PLAY_HALF + 5, 0.5, 0);
      who.vx = -9;
      enforceBounds(who);
      expect(who.vx).toBe(-9);
    });

    it('clamps each axis on its own', () => {
      const w = world();
      const who = body(w, PLAY_HALF + 20, 0.5, 3);
      enforceBounds(who);
      expect(who.x).toBeCloseTo(PLAY_HALF - CAP_RADIUS, 5);
      expect(who.z).toBeCloseTo(3, 5);
    });

    it('keeps the whole capsule inside, not just its middle', () => {
      const w = world();
      const who = body(w, PLAY_HALF + 1, 0.5, 0);
      enforceBounds(who);
      expect(who.x + CAP_RADIUS).toBeLessThanOrEqual(PLAY_HALF);
    });
  });

  describe('the floor', () => {
    it('puts a body that fell out of the world back on the lawn', () => {
      // Not reachable in the game today, and that is the point of having it: a
      // body below the ground plane settles wedged inside the house's collision
      // box, reports itself grounded, and cannot move in any direction. The day
      // anything can fall, the recovery has to already be here.
      const w = world();
      const who = body(w, 0, FLOOR - 30, 0);
      expect(enforceBounds(who)).toBe('fell');
      expect(who.y).toBeCloseTo(PLAY_AREA.recover.y, 5);
      expect(who.x).toBeCloseTo(PLAY_AREA.recover.x, 5);
      expect(who.z).toBeCloseTo(PLAY_AREA.recover.z, 5);
    });

    it('drops all the speed it fell with', () => {
      const w = world();
      const who = body(w, 0, FLOOR - 30, 0);
      who.vy = -60;
      who.vx = 7;
      enforceBounds(who);
      expect(who.vy).toBe(0);
      expect(who.vx).toBe(0);
    });

    it('is not tripped by standing on the lawn', () => {
      // A capsule at rest dips a fraction into the ground during depenetration,
      // and a floor at ground level would teleport somebody standing still.
      const w = world();
      const who = body(w, 3, 0.5, 3);
      for (let i = 0; i < 120; i++) {
        who.step(DT, STILL);
        expect(enforceBounds(who)).toBe('none');
      }
    });

    it('recovers onto open ground, not into the house', () => {
      const w = world();
      const who = body(w, 0, FLOOR - 5, 0);
      enforceBounds(who);
      // Somewhere it can actually stand: a step or two settles it on the lawn
      // rather than leaving it stuck in geometry.
      const from = { x: who.x, z: who.z };
      for (let i = 0; i < 60; i++) who.step(DT, { ...STILL, forward: 1 });
      expect(Math.hypot(who.x - from.x, who.z - from.z)).toBeGreaterThan(1);
    });
  });

  describe('what can be built', () => {
    /**
     * The map, with no barrier in it.
     *
     * Deliberately not the world the game runs, and the reason is worth the
     * line. The barrier is four solid boxes sitting just outside the edge, so a
     * plank straddling the boundary overlaps one — which means every test down
     * here would pass whether or not `canPlaceAt` checks bounds at all. Removing
     * the check entirely left "refuses one that merely hangs over the edge"
     * green, which is a test that cannot fail.
     *
     * The wall and the rule are two different layers and they are tested
     * separately, which is the whole point of having both.
     */
    function builder(): BuildSystem {
      const w = new CollisionWorld();
      installFixtures(w, neighborhoodSlabs(new Rng('map')));
      return new BuildSystem(w, new PartRenderer());
    }

    const plank = (x: number, y: number, z: number) => ({
      kind: 0, colorway: 0, x, y, z, qx: 0, qy: 0, qz: 0, qw: 1,
    });

    it('allows a plank on open lawn', () => {
      expect(builder().applyPlaceIfClear(plank(6, 0.125, 12))).toBe(true);
    });

    it('refuses one outside the world', () => {
      // The exploit this closes is not a player wandering off. It is a guest
      // naming coordinates in a message: the host used to place whatever it was
      // told to, four hundred metres away or in somebody else's yard.
      const b = builder();
      expect(b.applyPlaceIfClear(plank(400, 0.125, 400))).toBe(false);
      expect(b.applyPlaceIfClear(plank(PLAY_HALF + 3, 0.125, 0))).toBe(false);
      expect(b.applyPlaceIfClear(plank(0, 0.125, -(PLAY_HALF + 3)))).toBe(false);
    });

    it('refuses one that merely hangs over the edge', () => {
      // Measured against the part's own box rather than its centre, so a plank
      // straddling the line is out. Centre-only would leave half a metre of
      // legal overhang all the way round, which is a ledge.
      const b = builder();
      expect(b.applyPlaceIfClear(plank(PLAY_HALF - 0.05, 0.125, 0))).toBe(false);
    });

    it('refuses a tower past the ceiling', () => {
      const b = builder();
      expect(b.applyPlaceIfClear(plank(6, BUILD_CEILING - 1, 12))).toBe(true);
      expect(b.applyPlaceIfClear(plank(9, BUILD_CEILING + 1, 9))).toBe(false);
      expect(b.applyPlaceIfClear(plank(12, 9999, 12))).toBe(false);
    });

    it('still refuses one below the ground', () => {
      // The rule that was already here, checked so that adding the box did not
      // quietly replace it.
      expect(builder().applyPlaceIfClear(plank(6, -1, 12))).toBe(false);
    });
  });

  describe('boxInBounds', () => {
    const at = (minX: number, maxX: number, minZ = -1, maxZ = 1, minY = 0, maxY = 1) =>
      ({ minX, maxX, minY, maxY, minZ, maxZ });

    it('is true for a box well inside', () => {
      expect(boxInBounds(at(-1, 1))).toBe(true);
    });

    it('is false for one with a corner out', () => {
      expect(boxInBounds(at(PLAY_HALF - 1, PLAY_HALF + 1))).toBe(false);
    });

    it('is false above the ceiling', () => {
      expect(boxInBounds(at(-1, 1, -1, 1, 0, BUILD_CEILING + 0.01))).toBe(false);
    });

    it('is true flush against the edge', () => {
      // Flush is legal. A boundary that rejected the placement exactly on it
      // would be a boundary half a plank inside where it says it is.
      expect(boxInBounds(at(PLAY_HALF - 2, PLAY_HALF))).toBe(true);
    });
  });

  describe('the three layers together', () => {
    it('cannot be beaten by the fastest thing in the game', () => {
      // A slide states 17 m/s along its axis, which is the largest velocity
      // anything in this world hands out. Aimed at the wall from close in, with
      // the clamp running the way the game runs it.
      const w = world();
      const who = body(w, PLAY_HALF - 4, 0.5, 0);
      for (let i = 0; i < 240; i++) {
        who.vx = 17;
        who.step(DT, { ...STILL, right: 1, sprint: true });
        enforceBounds(who);
      }
      expect(who.x).toBeLessThanOrEqual(PLAY_HALF - CAP_RADIUS + 1e-6);
    });

    it('cannot be beaten by a body that starts outside it', () => {
      const w = world();
      const who = body(w, 4000, 0.5, 4000);
      enforceBounds(who);
      for (let i = 0; i < 120; i++) {
        who.step(DT, { ...STILL, right: 1, forward: 1, sprint: SPRINT_SPEED > 0 });
        enforceBounds(who);
      }
      expect(inBounds(who.x, who.z)).toBe(true);
    });
  });
});
