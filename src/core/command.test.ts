import { describe, it, expect } from 'vitest';
import {
  aimOf, BUTTON, commandToIntent, makeCommand, packCommand, pressed, unpackCommand, withButton,
} from './command.ts';
import { CollisionWorld } from '../physics/collisionWorld.ts';
import { CameraRig } from '../player/cameraRig.ts';

describe('buttons', () => {
  it('sets and clears without touching its neighbours', () => {
    let bits = 0;
    bits = withButton(bits, 'jump', true);
    bits = withButton(bits, 'crouch', true);
    bits = withButton(bits, 'jump', false);

    const c = makeCommand();
    c.buttons = bits;
    expect(pressed(c, 'jump')).toBe(false);
    expect(pressed(c, 'crouch')).toBe(true);
  });

  it('gives every action its own bit', () => {
    // A duplicated bit would make two actions the same key, and the symptom
    // would be one of them firing at random depending on the other.
    const bits = Object.values(BUTTON);
    expect(new Set(bits).size).toBe(bits.length);
    for (const bit of bits) expect(Number.isInteger(Math.log2(bit))).toBe(true);
  });
});

describe('commandToIntent', () => {
  it('passes movement through as world-space direction', () => {
    // MoveIntent.right and .forward are world X and Z despite the names — a
    // contract older than commands, pinned here so it cannot drift silently.
    const c = makeCommand();
    c.moveX = 0.5;
    c.moveZ = -1;
    const intent = commandToIntent(c);
    expect(intent.right).toBe(0.5);
    expect(intent.forward).toBe(-1);
  });

  it('carries the buttons across', () => {
    const c = makeCommand();
    c.buttons = BUTTON.jump | BUTTON.crouch;
    const intent = commandToIntent(c);
    expect(intent.jump).toBe(true);
    expect(intent.crouch).toBe(true);
    expect(intent.sprint).toBe(false);
  });

  it('scales movement when the mode says you are slowed', () => {
    const c = makeCommand();
    c.moveX = 1;
    c.moveZ = 1;
    const intent = commandToIntent(c, 0.5);
    expect(intent.right).toBe(0.5);
    expect(intent.forward).toBe(0.5);
  });

  it('cancels sprint when slowed, so being soaked cannot be sprinted off', () => {
    const c = makeCommand();
    c.buttons = BUTTON.sprint;
    expect(commandToIntent(c, 1).sprint).toBe(true);
    expect(commandToIntent(c, 0.6).sprint).toBe(false);
  });

  it('leaves the command alone, since the same one drives prediction and replay', () => {
    const c = makeCommand();
    c.moveX = 1;
    c.buttons = BUTTON.sprint;
    commandToIntent(c, 0.5);
    expect(c.moveX).toBe(1);
    expect(c.buttons).toBe(BUTTON.sprint);
  });
});

describe('packing', () => {
  it('round-trips exactly', () => {
    // Exactly, not approximately: a recorded round is replayed against a hash of
    // the resulting world, so a command that comes back a bit different is a
    // replay that diverges.
    const c = makeCommand(42);
    c.moveX = -0.37281;
    c.moveZ = 0.918273;
    c.climb = -1;
    c.yaw = 2.7182818;
    c.pitch = -0.41;
    c.buttons = BUTTON.jump | BUTTON.fire;

    expect(unpackCommand(packCommand(c))).toEqual(c);
  });

  it('survives a trip through JSON, which is what a socket will do to it', () => {
    const c = makeCommand(7);
    c.moveX = 0.1 + 0.2;
    c.yaw = Math.PI;
    const there = JSON.parse(JSON.stringify(packCommand(c)));
    expect(unpackCommand(there)).toEqual(c);
  });
});

describe('aim', () => {
  it('points exactly where the camera points', () => {
    // Two expressions for one thing, and they must not drift. The camera's is
    // read for the person at this keyboard; this one is read by a host firing
    // on behalf of somebody in another house. If they disagreed, a guest would
    // aim at one thing and hit another — and only a guest, so it would look
    // like lag rather than like a maths error.
    const world = new CollisionWorld();
    const camera = new CameraRig(world, 1.6);

    for (const [yaw, pitch] of [
      [0, 0], [Math.PI / 2, 0], [-1.3, 0.4], [2.7, -0.9], [Math.PI, 1.2],
    ]) {
      camera.yaw = yaw!;
      camera.pitch = pitch!;
      const look = camera.getLookDirection();
      const command = makeCommand(0);
      command.yaw = yaw!;
      command.pitch = pitch!;
      const aim = aimOf(command);

      expect(aim.x, `x at yaw ${yaw} pitch ${pitch}`).toBeCloseTo(look.x, 10);
      expect(aim.y, `y at yaw ${yaw} pitch ${pitch}`).toBeCloseTo(look.y, 10);
      expect(aim.z, `z at yaw ${yaw} pitch ${pitch}`).toBeCloseTo(look.z, 10);
    }
  });

  it('survives the round trip a command takes to get to a host', () => {
    // The slot rides along with it. A weapon choice that did not survive
    // packing would leave every guest holding the starting soaker.
    const command = makeCommand(9);
    command.yaw = 1.1;
    command.pitch = -0.3;
    command.slot = 2;
    const there = unpackCommand(packCommand(command));
    expect(there).toEqual(command);
    expect(aimOf(there)).toEqual(aimOf(command));
  });
});
