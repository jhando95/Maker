/**
 * One tick of a player's will, as data.
 *
 * Today main.ts reads the keyboard, folds in the camera basis, and hands a
 * `MoveIntent` straight to the controller. That works for exactly one player on
 * exactly one machine. A command is the same information with the reading and
 * the acting pulled apart, so the thing in between can be a recording, a replay,
 * or a socket.
 *
 * Two decisions worth stating, because both could reasonably have gone the other
 * way:
 *
 * **Movement is stored already rotated into world space**, not as a stick axis
 * plus a yaw. Sending the raw axis would let a server re-derive the direction
 * and so validate it, which is the right call for a game with cheaters in it.
 * But re-deriving means reproducing the camera basis exactly, and a replay that
 * has to reconstruct floating-point state to match is a replay that drifts.
 * Storing the answer rather than the inputs to the answer makes a recording
 * reproduce bit for bit, which is the property this is being built for.
 *
 * **Buttons are a bitfield.** Not for the bytes — a handful of booleans is
 * nothing — but because it makes the set closed. Adding an action means adding a
 * bit here, where the encoder and decoder sit next to each other, rather than
 * discovering in a desync that one side sent a field the other never read.
 */

import type { MoveIntent } from '../player/controller.ts';

export const BUTTON = {
  jump: 1 << 0,
  sprint: 1 << 1,
  crouch: 1 << 2,
  /** Throw, soak, or place — whatever the primary is in the current mode. */
  fire: 1 << 3,
  remove: 1 << 4,
} as const;

export type ButtonName = keyof typeof BUTTON;

export interface Command {
  /** Which simulation tick this is the input for. */
  tick: number;
  /** Desired movement in world space, already rotated by the camera. */
  moveX: number;
  moveZ: number;
  /** Up or down a ladder. */
  climb: number;
  /** Where this actor is looking — for aiming, and for drawing them facing it. */
  yaw: number;
  pitch: number;
  buttons: number;
  /**
   * Which entry of the mode's loadout is held.
   *
   * Here rather than as a separate "I picked the balloon" message, because a
   * held weapon is a *state* and a message is an event: one dropped packet and
   * the two machines disagree about what is in somebody's hands until the next
   * time they touch the wheel. Repeating it every tick costs one number and
   * cannot drift.
   */
  slot: number;
}

export function makeCommand(tick = 0): Command {
  return { tick, moveX: 0, moveZ: 0, climb: 0, yaw: 0, pitch: 0, buttons: 0, slot: 0 };
}

/**
 * The unit vector an actor is looking along.
 *
 * The same expression as `CameraRig.getLookDirection`, restated here because
 * this has to work for somebody whose camera is in another house. The two are
 * held together by a test rather than by a comment.
 */
export function aimOf(command: Command): { x: number; y: number; z: number } {
  const cp = Math.cos(command.pitch);
  return {
    x: -Math.sin(command.yaw) * cp,
    y: Math.sin(command.pitch),
    z: -Math.cos(command.yaw) * cp,
  };
}

export function pressed(command: Command, button: ButtonName): boolean {
  return (command.buttons & BUTTON[button]) !== 0;
}

export function withButton(buttons: number, button: ButtonName, down: boolean): number {
  return down ? buttons | BUTTON[button] : buttons & ~BUTTON[button];
}

/**
 * Turn a command into what the character controller consumes.
 *
 * `MoveIntent.right` and `.forward` are world X and Z despite their names — a
 * contract older than this file, kept rather than renamed so this change cannot
 * quietly alter how anyone moves.
 *
 * `speedScale` is how being soaked slows you down. It scales movement and
 * cancels sprint rather than being folded into the command itself, because it is
 * a rule the mode applies to your intent, not part of the intent: a soaked
 * player is still pushing the stick just as hard.
 */
export function commandToIntent(command: Command, speedScale = 1): MoveIntent {
  const scaled = speedScale < 1;
  return {
    right: command.moveX * speedScale,
    forward: command.moveZ * speedScale,
    jump: pressed(command, 'jump'),
    sprint: pressed(command, 'sprint') && !scaled,
    crouch: pressed(command, 'crouch'),
    climb: command.climb,
  };
}

/**
 * A command as a flat tuple, for recording and for the wire.
 *
 * A tuple rather than an object because a recorded round is thousands of these
 * and the field names would be most of the file.
 */
export type PackedCommand = [
  tick: number,
  moveX: number,
  moveZ: number,
  climb: number,
  yaw: number,
  pitch: number,
  buttons: number,
  slot: number,
];

export function packCommand(c: Command): PackedCommand {
  return [c.tick, c.moveX, c.moveZ, c.climb, c.yaw, c.pitch, c.buttons, c.slot];
}

export function unpackCommand(p: PackedCommand): Command {
  return {
    tick: p[0], moveX: p[1], moveZ: p[2], climb: p[3],
    yaw: p[4], pitch: p[5], buttons: p[6], slot: p[7] ?? 0,
  };
}
