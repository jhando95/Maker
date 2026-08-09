/**
 * The first moving platform, measured where it matters: the tilt the riders
 * produce, and the collision surface actually being where the tilt says.
 *
 * The renderer is deliberately absent — the view follows `pose()`, and a
 * pose test that never asks the collision world would pass with the plank
 * drawn in one place and solid in another, which is the exact drift the
 * runtime exists to prevent. So the load-bearing assertions here are
 * raycasts: the plank is wherever a ray says a body would land.
 */

import { describe, it, expect } from 'vitest';
import { CollisionWorld } from '../physics/collisionWorld.ts';
import { CharacterController } from '../player/controller.ts';
import { Seesaw, PIVOT_Y, SEESAW_MAX_ANGLE } from './seesaw.ts';

const DT = 1 / 60;

function run(seesaw: Seesaw, seconds: number, riders: { x: number; y: number; z: number }[] = []): void {
  for (let i = 0; i < Math.round(seconds / DT); i++) seesaw.tick(DT, riders);
}

/**
 * Height of the first thing under (x, z). The ground plane always answers,
 * so "not on the plank" reads as a height of zero rather than a miss.
 */
function surfaceAt(world: CollisionWorld, x: number, z: number): number {
  const hit = world.raycast(x, 5, z, 0, -1, 0, 10);
  return hit === null ? 0 : 5 - hit.distance;
}

describe('the see-saw', () => {
  it('rests on one end rather than balancing on the tyre', () => {
    // A balanced empty see-saw is a coin standing on its edge. Pushed to
    // level, it has to fall back onto an end on its own.
    const seesaw = new Seesaw(new CollisionWorld(), 0, 0, 0);
    seesaw.angle = 0;
    run(seesaw, 4);
    expect(Math.abs(seesaw.angle)).toBeCloseTo(SEESAW_MAX_ANGLE, 2);
  });

  it('comes down under a kid standing beneath the raised end', () => {
    // Fresh from the constructor the +X end is up. A kid on the ground under
    // it counts as riding — that is how kids operate a see-saw for each
    // other — and their weight has to bring that end DOWN. The first version
    // of the torque had this sign backwards: a see-saw that lifts whoever
    // steps on it, caught by this test before anything rendered.
    const seesaw = new Seesaw(new CollisionWorld(), 0, 0, 0);
    expect(seesaw.angle).toBeCloseTo(SEESAW_MAX_ANGLE, 5);
    run(seesaw, 4, [{ x: 1.7, y: 0.5, z: 0 }]);
    expect(seesaw.angle).toBeCloseTo(-SEESAW_MAX_ANGLE, 1);
  });

  it('lets the kid on the tip out-lever the kid near the middle', () => {
    const seesaw = new Seesaw(new CollisionWorld(), 0, 0, 0);
    seesaw.angle = 0;
    // Tip beats middle even against the returning end's gravity bias.
    run(seesaw, 4, [
      { x: 1.8, y: 0.62, z: 0 },
      { x: -0.5, y: 0.62, z: 0 },
    ]);
    expect(seesaw.angle).toBeLessThan(-SEESAW_MAX_ANGLE * 0.5);
  });

  it('ignores everybody who is not actually on it', () => {
    const seesaw = new Seesaw(new CollisionWorld(), 0, 0, 0);
    const start = seesaw.angle;
    run(seesaw, 2, [
      { x: 1.7, y: 0.5, z: 3.0 },   // beside the plank
      { x: 4.0, y: 0.5, z: 0 },     // past the end
      { x: -1.7, y: 3.5, z: 0 },    // flying overhead
    ]);
    expect(seesaw.angle).toBeCloseTo(start, 5);
  });

  it('keeps the collision surface under the tilt, both ways', () => {
    // The whole feature: the box a body stands on moves with the pose. Ride
    // the +X end down and a ray over each end has to say so — if updatePart
    // ever stops re-hashing, this is the test that notices the plank going
    // solid where it used to be rather than where it is.
    const world = new CollisionWorld();
    const seesaw = new Seesaw(world, 0, 0, 0);

    expect(surfaceAt(world, 1.6, 0)).toBeGreaterThan(PIVOT_Y + 0.2);

    run(seesaw, 4, [{ x: 1.7, y: 0.5, z: 0 }]);

    const downAfter = surfaceAt(world, 1.6, 0);
    expect(downAfter).toBeGreaterThan(0.1);
    expect(downAfter).toBeLessThan(PIVOT_Y - 0.1);
    // And the other end rose to match.
    expect(surfaceAt(world, -1.6, 0)).toBeGreaterThan(PIVOT_Y + 0.2);
  });

  it('turns with its placement, exactly as the prefab frame does', () => {
    // One quarter turn maps local (x, z) to (z, -x): the long axis lies
    // along world -Z, so the ride happens along z and the sides are along x.
    const world = new CollisionWorld();
    const seesaw = new Seesaw(world, 0, 0, 1);
    expect(surfaceAt(world, 0, -1.6)).toBeGreaterThan(0.1);
    // Where the plank would be if the turn were ignored: bare lawn.
    expect(surfaceAt(world, 1.6, 0)).toBe(0);
    run(seesaw, 4, [{ x: 0, y: 0.5, z: -1.7 }]);
    // The rider stands at local +along; their end comes down.
    const ridden = surfaceAt(world, 0, -1.6);
    expect(ridden).toBeGreaterThan(0.1);
    expect(ridden).toBeLessThan(PIVOT_Y - 0.1);
  });

  it('never tilts past the clamp, however hard it is ridden', () => {
    const seesaw = new Seesaw(new CollisionWorld(), 0, 0, 0);
    run(seesaw, 6, [{ x: 1.9, y: 0.5, z: 0 }, { x: 1.5, y: 0.5, z: 0 }]);
    expect(seesaw.angle).toBeGreaterThanOrEqual(-SEESAW_MAX_ANGLE - 1e-9);
    expect(Math.abs(seesaw.angle)).toBeLessThanOrEqual(SEESAW_MAX_ANGLE + 1e-9);
  });

  it('carries a real body down with the plank', () => {
    // The whole point of a moving platform: not that the box moves, but that
    // the person standing on it goes where it goes. A real controller, real
    // gravity, real depenetration — dropped onto the raised end, ridden to
    // the ground, still on their feet.
    //
    // Ninety ticks, not more: after the ride, a kid left standing on the
    // grounded tip slowly toboggans down the 11° slope and off the end —
    // which is what a kid on a see-saw tip does, and not this test's claim.
    const world = new CollisionWorld();
    const seesaw = new Seesaw(world, 0, 0, 0);
    const kid = new CharacterController(world, 1.6, 1.1, 0);
    const still = {
      forward: 0, right: 0, jump: false, sprint: false, crouch: false, climb: 0, yaw: 0,
    };
    for (let i = 0; i < 90; i++) {
      seesaw.tick(DT, [kid]);
      kid.step(DT, still);
    }
    expect(seesaw.angle).toBeLessThan(-0.15);
    expect(kid.onGround).toBe(true);
    expect(kid.y).toBeLessThan(0.55);
    expect(kid.y).toBeGreaterThan(0.2);
  });

  it('plays the same ride twice, tick for tick', () => {
    // The tick is sim state in, sim state out — no clock, no randomness —
    // which is what lets a replay reproduce a round with a see-saw in it.
    const a = new Seesaw(new CollisionWorld(), 0, 0, 0);
    const b = new Seesaw(new CollisionWorld(), 0, 0, 0);
    const script = (t: number) => [{ x: Math.sin(t * 0.7) * 1.8, y: 0.6, z: 0 }];
    for (let i = 0; i < 300; i++) {
      a.tick(DT, script(i * DT));
      b.tick(DT, script(i * DT));
    }
    expect(a.angle).toBe(b.angle);
  });
});

describe('the kinematic seam itself', () => {
  it('collides a moved part where it is, not where it started', () => {
    // A translation big enough to cross broadphase cells: the part of
    // updatePart most worth a test is the re-hash, because a stale hash
    // fails silently — the box looks moved and rays still hit the old air.
    const world = new CollisionWorld();
    const handle = world.addPart(0, 0, 0, 1, 0, 0, 0, 0, 1, 0.5, 0.1, 0.5);
    expect(world.raycast(0, 3, 0, 0, -1, 0, 5)?.part).toBe(handle.id);

    expect(world.updatePart(handle.id, 10, 1, 0, 0, 0, 0, 1)).toBe(true);
    // The ground plane still answers at the old spot; the box must not.
    expect(world.raycast(0, 3, 0, 0, -1, 0, 5)?.part).toBe(-1);
    expect(world.raycast(10, 3, 0, 0, -1, 0, 5)?.part).toBe(handle.id);
  });

  it('refuses to move the dead, and says so', () => {
    const world = new CollisionWorld();
    const handle = world.addPart(0, 0, 0, 1, 0, 0, 0, 0, 1, 0.5, 0.1, 0.5);
    world.removePart(handle.id);
    expect(world.updatePart(handle.id, 5, 1, 0, 0, 0, 0, 1)).toBe(false);
  });

  it('refuses to move a proxy part as if it were its box', () => {
    // A wedge collides as a slab along its slope, composed at insert.
    // updateTransform writes as if there were no proxy, so moving one this
    // way would silently swap its collision for the drawn box — the exact
    // bug the proxy exists to prevent. Refused instead.
    const world = new CollisionWorld();
    const handle = world.addPart(
      6, 0, 0, 1, 0, 0, 0, 0, 1, 0.5, 0.25, 0.125,
      { ox: 0, oy: 0, oz: 0, qx: 0, qy: 0, qz: 0, qw: 1, hx: 0.5, hy: 0.05, hz: 0.125 },
    );
    expect(world.updatePart(handle.id, 5, 1, 0, 0, 0, 0, 1)).toBe(false);
  });
});
