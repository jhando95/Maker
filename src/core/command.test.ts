import { describe, it, expect } from 'vitest';
import {
  BUTTON, commandToIntent, makeCommand, packCommand, pressed, unpackCommand, withButton,
} from './command.ts';

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
