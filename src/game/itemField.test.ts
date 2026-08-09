import { describe, it, expect } from 'vitest';
import { CollisionWorld } from '../physics/collisionWorld.ts';
import { CharacterController } from '../player/controller.ts';
import { applyItems } from './itemField.ts';
import { SLIDE_SPEED, SLIDE_TRAVEL, TRAMPOLINE_SPEED, type Item } from '../world/items.ts';
import { DT, SPRINT_SPEED, WALK_SPEED } from '../physics/constants.ts';
import type { MoveIntent } from '../player/controller.ts';

const STILL: MoveIntent = {
  forward: 0, right: 0, jump: false, sprint: false, crouch: false, climb: 0,
};

const PAD: Item = { kind: 'trampoline', x: 0, z: 0, halfW: 1.1, halfD: 1.1, y: 0.32, ry: 0 };
const SHEET: Item = { kind: 'slide', x: 0, z: 0, halfW: 1.3, halfD: 3.5, y: 0.06, ry: 0 };

/** A body standing on a floor, placed wherever the test wants it. */
function body(x = 0, y = 0.32, z = 0): CharacterController {
  const world = new CollisionWorld();
  // A wide floor at the item's height, so `onGround` is a real answer rather
  // than a field a test poked.
  world.addFixture(0, 0, 0, y - 0.5, 0, 0, 0, 0, 1, 20, 0.5, 20, null, {});
  const it = new CharacterController(world, x, y, z);
  it.onGround = true;
  return it;
}

describe('applyItems', () => {
  describe('a trampoline', () => {
    it('launches a body standing on it', () => {
      const who = body();
      const hit = applyItems(who, [PAD]);
      expect(hit).toBe(PAD);
      expect(who.vy).toBe(TRAMPOLINE_SPEED);
      expect(who.onGround).toBe(false);
    });

    it('leaves a body beside it alone', () => {
      const who = body(3);
      expect(applyItems(who, [PAD])).toBeNull();
      expect(who.vy).toBe(0);
      expect(who.onGround).toBe(true);
    });

    it('does not re-launch on the way up', () => {
      // The bug this exists for: a body is still inside the vertical window for
      // several ticks after it leaves, and setting vy every one of those is not
      // a higher bounce — it is an escape from gravity, and it reads as the
      // player being stuck to the ceiling.
      const who = body();
      applyItems(who, [PAD]);
      who.y += 0.2;
      const again = applyItems(who, [PAD]);
      expect(again).toBeNull();
      expect(who.vy).toBe(TRAMPOLINE_SPEED);
    });

    it('catches a body on the way down', () => {
      // The other side of the same rule, and the one that makes a bounce a
      // bounce. Falling onto a mat has to launch, or the pad only works from
      // standing.
      const who = body();
      who.vy = -6;
      who.onGround = false;
      expect(applyItems(who, [PAD])).toBe(PAD);
      expect(who.vy).toBe(TRAMPOLINE_SPEED);
    });

    it('does not care how the body got there', () => {
      // No state, no cooldown, no ownership: the whole reason an item needs no
      // network message is that the answer depends on position and velocity and
      // nothing else. Two bodies in the same place come out identical.
      const a = body();
      const b = body();
      b.vx = 4;
      applyItems(a, [PAD]);
      applyItems(b, [PAD]);
      expect(b.vy).toBe(a.vy);
    });
  });

  describe('a slide', () => {
    it('shoves along its own length', () => {
      // ry of zero points down -Z, which is the same convention the camera and
      // the placement ghost use.
      const who = body(0, 0.06, 0);
      expect(applyItems(who, [SHEET])).toBe(SHEET);
      expect(who.vz).toBeLessThan(0);
      expect(who.vx).toBeCloseTo(0, 6);
    });

    it('turns with the item', () => {
      const turned: Item = { ...SHEET, ry: Math.PI / 2 };
      const who = body(0, 0.06, 0);
      applyItems(who, [turned]);
      expect(who.vx).toBeLessThan(0);
      expect(who.vz).toBeCloseTo(0, 6);
    });

    it('gives a walk and a sprint the same speed', () => {
      // Why the push is a stated speed rather than an impulse. A shortcut
      // anybody can take is a route; one that pays out in proportion to your
      // entry speed is a reward for already going fast, which is the opposite
      // of the point.
      const slow = body(0, 0.06, 3);
      const fast = body(0, 0.06, 3);
      fast.vz = -8;
      applyItems(slow, [SHEET]);
      applyItems(fast, [SHEET]);
      expect(slow.vz).toBeCloseTo(-SLIDE_SPEED, 5);
      expect(fast.vz).toBeCloseTo(-SLIDE_SPEED, 5);
    });

    it('keeps whatever a faster body brought with it', () => {
      // The one asymmetry: a slide is never a brake. Somebody who arrives
      // faster than it — off a trampoline, or down the next one along — is not
      // slowed to its speed, because an item that could take speed away would
      // be a trap laid by the map rather than a route offered by it.
      const flying = body(0, 0.06, 0);
      flying.vz = -18;
      applyItems(flying, [SHEET]);
      expect(flying.vz).toBe(-18);
    });

    it('turns round a body running the wrong way up it', () => {
      // A commitment rather than a free upgrade. Running against the grain does
      // not merely cost you, it is impossible — which is a rule a player can
      // learn in one attempt, and the thing that makes stepping onto one a
      // decision instead of an upgrade.
      const who = body(0, 0.06, 0);
      who.vz = -SLIDE_SPEED;
      // ry of PI points the other way, so this body is going backwards up it.
      applyItems(who, [{ ...SHEET, ry: Math.PI }]);
      expect(who.vz).toBeCloseTo(SLIDE_SPEED, 5);
    });

    it('actually covers the ground the design is stated in', () => {
      // The one test in this file that runs the real pair, in the real order,
      // and the reason there are two slide constants instead of one.
      //
      // `applyItems` runs after `step`, and `step` is where the movement for
      // the tick happens — sandwiched between a blend toward zero and a dose of
      // friction, both of which apply in full to a body with no input on it.
      // So the velocity the slide stamps on is not the velocity the body moves
      // at, and the first version of this item lost that argument badly enough
      // to move a player at 2.2 m/s. Measuring the travel is the only way to
      // know, and it has to be measured here rather than reasoned about,
      // because the three constants it depends on belong to movement feel and
      // will be tuned by somebody who has never read this file.
      const who = body(0, 0.06, 0);
      const from = who.z;
      const seconds = 1;
      for (let i = 0; i < Math.round(seconds / DT); i++) {
        who.step(DT, STILL);
        applyItems(who, [{ ...SHEET, halfD: 40 }]);
      }
      const travelled = (from - who.z) / seconds;
      expect(travelled).toBeCloseTo(SLIDE_TRAVEL, 0);
      // And the claim that makes the item worth having at all. A shortcut
      // slower than running to the same place is not a shortcut.
      expect(travelled).toBeGreaterThan(SPRINT_SPEED);
      expect(travelled).toBeGreaterThan(WALK_SPEED);
    });

    it('leaves the axis it does not own alone', () => {
      // Only the along-component is stated, so a player can still steer off the
      // side of one. Taken as a whole velocity the slide would be a rail, and a
      // rail you cannot leave is a worse thing to run into than a fence.
      const who = body(0, 0.06, 0);
      who.vx = 3.5;
      applyItems(who, [SHEET]);
      expect(who.vx).toBeCloseTo(3.5, 5);
      expect(who.vz).toBeCloseTo(-SLIDE_SPEED, 5);
    });

    it('ignores a body sailing over it', () => {
      const who = body(0, 0.06, 0);
      who.onGround = false;
      expect(applyItems(who, [SHEET])).toBeNull();
      expect(who.vz).toBe(0);
    });

    it('leaves a body beside it alone', () => {
      const who = body(4, 0.06, 0);
      expect(applyItems(who, [SHEET])).toBeNull();
      expect(who.vz).toBe(0);
    });
  });

  describe('the list', () => {
    it('applies the first item a body is standing on and stops', () => {
      // Two effects on one body would be whichever `applyItems` reached first,
      // so it says so out loud rather than leaving it to argument order. The
      // map is checked separately for the overlap that would make it matter.
      const who = body();
      const hit = applyItems(who, [PAD, { ...SHEET, y: 0.32 }]);
      expect(hit).toBe(PAD);
      expect(who.vz).toBe(0);
    });

    it('does nothing at all when a body is on nothing', () => {
      const who = body(9, 0.32, 9);
      expect(applyItems(who, [PAD, SHEET])).toBeNull();
      expect(who.vx).toBe(0);
      expect(who.vy).toBe(0);
      expect(who.vz).toBe(0);
    });

    it('gives two machines the same answer for the same body', () => {
      // The claim the whole design rests on: a host stepping a guest's body and
      // that guest predicting its own reach the same velocity on the same tick
      // from the same position, so a bounce never produces a correction and
      // nothing about it is ever sent. If this ever stops being true, items
      // have to go through the host and this file stops being the right shape.
      const here = body(0, 0.06, 1.2);
      const there = body(0, 0.06, 1.2);
      for (let i = 0; i < 30; i++) {
        applyItems(here, [SHEET]);
        applyItems(there, [SHEET]);
      }
      expect(there.vx).toBe(here.vx);
      expect(there.vy).toBe(here.vy);
      expect(there.vz).toBe(here.vz);
    });
  });
});
