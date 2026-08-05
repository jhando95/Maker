/**
 * Controller support.
 *
 * The input layer already turns devices into named actions, so a pad does not
 * need any gameplay code to know about it — it needs to produce the same
 * actions a keyboard does, plus two analog signals a keyboard cannot: a
 * movement vector with magnitude, and a look *rate*.
 *
 * That rate is the part worth being careful about. A mouse reports a delta:
 * how far it moved, already a distance. A stick reports a position, which only
 * becomes a distance once multiplied by elapsed time. Treating stick deflection
 * as a delta — the obvious shortcut — makes the turn speed depend on the tick
 * rate, so the same stick pushed the same distance turns at a different speed
 * on a different machine. Everything here is expressed in radians per second
 * and multiplied by dt at the point of use.
 *
 * The mapping is a pure function of a snapshot so it can be tested without a
 * browser, a pad, or a person holding one.
 */

import type { Action } from './input.ts';

/**
 * One pad's raw state, in the shape the browser reports it.
 *
 * Copied out of the live Gamepad object rather than passed by reference:
 * browsers hand back a fresh snapshot object per poll on some engines and a
 * live one on others, and code that works either way is cheaper than code that
 * has to know which.
 */
export interface PadSnapshot {
  buttons: readonly number[];
  axes: readonly number[];
  /** 'standard' means the W3C button/axis layout; anything else is a guess. */
  mapping: string;
  id: string;
}

export interface PadOptions {
  /** Radial deadzone as a fraction of full deflection. */
  deadzone: number;
  /** Look speed at full stick deflection, in radians per second. */
  lookSpeed: number;
  invertY: boolean;
}

export const DEFAULT_PAD_OPTIONS: PadOptions = {
  // Sticks rest a little off-centre when worn, and 0.16 clears that on a pad
  // well past its first thousand hours without eating usable range.
  deadzone: 0.16,
  // A full second and a bit for a 180° turn: fast enough to spin and face
  // someone, slow enough to place a board on a wall.
  lookSpeed: 2.6,
  invertY: false,
};

/**
 * Standard-mapping button indices, per the W3C Gamepad spec.
 *
 * Named because `buttons[7]` at a call site is unreadable and, worse, unverifiable.
 */
export const PAD = {
  A: 0, B: 1, X: 2, Y: 3,
  LB: 4, RB: 5, LT: 6, RT: 7,
  BACK: 8, START: 9,
  L3: 10, R3: 11,
  DUP: 12, DDOWN: 13, DLEFT: 14, DRIGHT: 15,
} as const;

/**
 * The pad layout.
 *
 * Fixed rather than rebindable, unlike the keyboard. Rebinding a pad means
 * building a second capture UI for a device most players will accept the
 * defaults on, and the shape of the layout — which verbs live under the thumbs
 * — matters far more than which button each one is.
 *
 * Rotation gets the bumpers because it is the single most-used building
 * control, and the bumpers are the only buttons you can press without taking a
 * thumb off a stick. Place is the right trigger and free aim the left, which is
 * where a decade of shooters has trained everyone to look for them.
 *
 * Deliberately not on the pad: undo, the hotbar digits, repeat-place, and the
 * debug overlay. There are nineteen bindable actions and fifteen usable
 * buttons, and a chorded second layer would be worse than reaching for the
 * keyboard on the rare occasions those come up.
 */
export const PAD_BINDINGS: ReadonlyArray<{ button: number; action: Action }> = [
  { button: PAD.A, action: 'jump' },
  { button: PAD.B, action: 'crouch' },
  { button: PAD.X, action: 'removePart' },
  { button: PAD.Y, action: 'cycleSnap' },
  { button: PAD.LB, action: 'rotateCCW' },
  { button: PAD.RB, action: 'rotateCW' },
  { button: PAD.LT, action: 'freeAim' },
  { button: PAD.RT, action: 'placePart' },
  { button: PAD.BACK, action: 'resetRotation' },
  { button: PAD.L3, action: 'sprint' },
  { button: PAD.R3, action: 'toggleCamera' },
  { button: PAD.DUP, action: 'rotatePitch' },
  { button: PAD.DDOWN, action: 'rotateRoll' },
  { button: PAD.DLEFT, action: 'prevPart' },
  { button: PAD.DRIGHT, action: 'nextPart' },
];

/** Label for each pad button, for the on-screen hints. */
export const PAD_LABELS: Readonly<Record<number, string>> = {
  [PAD.A]: 'A', [PAD.B]: 'B', [PAD.X]: 'X', [PAD.Y]: 'Y',
  [PAD.LB]: 'LB', [PAD.RB]: 'RB', [PAD.LT]: 'LT', [PAD.RT]: 'RT',
  [PAD.BACK]: 'Back', [PAD.START]: 'Start',
  [PAD.L3]: 'L3', [PAD.R3]: 'R3',
  [PAD.DUP]: 'D↑', [PAD.DDOWN]: 'D↓', [PAD.DLEFT]: 'D←', [PAD.DRIGHT]: 'D→',
};

/**
 * Triggers are analog, so a single threshold chatters when one rests against
 * it — a trigger held at 0.50 would fire place, unplace, place, unplace at the
 * tick rate. Pressing at 0.55 and releasing at 0.35 leaves a band where the
 * state simply does not change.
 */
const PRESS_AT = 0.55;
const RELEASE_AT = 0.35;

export interface PadIntent {
  /** Actions held this poll. */
  down: ReadonlySet<Action>;
  /** Movement in local space, +x right and +z forward, magnitude 0..1. */
  moveX: number;
  moveZ: number;
  /** Look rate in radians per second. Positive x turns right, positive y looks up. */
  lookYawRate: number;
  lookPitchRate: number;
  /** True when the player is touching the pad at all, for device detection. */
  active: boolean;
  /** Start was down this poll; the caller edge-detects it. */
  start: boolean;
}

export const IDLE_INTENT: PadIntent = {
  down: new Set(),
  moveX: 0, moveZ: 0,
  lookYawRate: 0, lookPitchRate: 0,
  active: false,
  start: false,
};

/**
 * Apply a radial deadzone and rescale what remains to the full range.
 *
 * Radial, not per-axis: a per-axis deadzone carves a square hole out of a round
 * stick, so pushing diagonally at 45° needs noticeably more deflection than
 * pushing straight, and the character drifts toward the axes. Rescaling matters
 * too — without it the stick jumps from nothing to 16% the instant it leaves
 * the zone, which reads as a twitch.
 */
export function applyDeadzone(x: number, y: number, deadzone: number): { x: number; y: number; magnitude: number } {
  const mag = Math.hypot(x, y);
  if (mag <= deadzone) return { x: 0, y: 0, magnitude: 0 };

  const scaled = Math.min(1, (mag - deadzone) / (1 - deadzone));
  return { x: (x / mag) * scaled, y: (y / mag) * scaled, magnitude: scaled };
}

/**
 * Stick response for looking: squared, sign preserved.
 *
 * Linear response forces a choice between a stick too slow to turn around with
 * and one too fast to aim with. Squaring gives most of the stick's travel to
 * small, precise adjustments and keeps full speed available at the edge.
 */
function lookCurve(v: number): number {
  return v * Math.abs(v);
}

/**
 * Collapse -0 to 0.
 *
 * Negating or sign-flipping a zero produces -0, which is arithmetically
 * identical to 0 and unequal to it under Object.is, and which JSON.stringify
 * writes as "0" so it survives a round trip as something else. An idle stick
 * should report a plain zero rather than a value that behaves differently
 * depending on who inspects it.
 */
const zeroed = (v: number): number => (v === 0 ? 0 : v);

/** Read a button that may be absent, e.g. a pad with no L3/R3. */
function buttonValue(snapshot: PadSnapshot, index: number): number {
  return snapshot.buttons[index] ?? 0;
}

/**
 * Turn one pad snapshot into intent.
 *
 * `previous` carries the trigger latch across polls, which is what makes the
 * hysteresis band above work; pass the intent returned last poll.
 */
export function mapPad(
  snapshot: PadSnapshot,
  options: PadOptions,
  previous: PadIntent = IDLE_INTENT,
): PadIntent {
  const down = new Set<Action>();

  for (const { button, action } of PAD_BINDINGS) {
    const value = buttonValue(snapshot, button);
    const wasDown = previous.down.has(action);
    // Digital buttons report exactly 0 or 1 and land on the same side of both
    // thresholds, so one rule covers the whole pad.
    if (wasDown ? value > RELEASE_AT : value > PRESS_AT) down.add(action);
  }

  const lx = snapshot.axes[0] ?? 0;
  const ly = snapshot.axes[1] ?? 0;
  const rx = snapshot.axes[2] ?? 0;
  const ry = snapshot.axes[3] ?? 0;

  const move = applyDeadzone(lx, ly, options.deadzone);
  const look = applyDeadzone(rx, ry, options.deadzone);

  const pitchSign = options.invertY ? 1 : -1;

  return {
    down,
    moveX: zeroed(move.x),
    // The stick reports +Y as *down*, and forward is +z, so this flips.
    moveZ: zeroed(-move.y),
    lookYawRate: zeroed(lookCurve(look.x) * options.lookSpeed),
    lookPitchRate: zeroed(lookCurve(look.y) * options.lookSpeed * pitchSign),
    active: down.size > 0 || move.magnitude > 0 || look.magnitude > 0,
    start: buttonValue(snapshot, PAD.START) > PRESS_AT,
  };
}

/**
 * Combine every connected pad into one intent.
 *
 * Two pads on one character is not a mode anyone asks for, but a wireless pad
 * that has gone to sleep still appears in the list reporting zeros, and a pad
 * plugged in second should just work. Taking the strongest signal from any of
 * them means the player never has to care which slot theirs landed in.
 */
export function mergePads(
  snapshots: readonly PadSnapshot[],
  options: PadOptions,
  previous: PadIntent = IDLE_INTENT,
): PadIntent {
  if (snapshots.length === 0) return IDLE_INTENT;
  if (snapshots.length === 1) return mapPad(snapshots[0]!, options, previous);

  const merged: PadIntent = {
    down: new Set<Action>(),
    moveX: 0, moveZ: 0,
    lookYawRate: 0, lookPitchRate: 0,
    active: false,
    start: false,
  };
  const down = merged.down as Set<Action>;

  for (const snapshot of snapshots) {
    const intent = mapPad(snapshot, options, previous);
    for (const action of intent.down) down.add(action);
    if (Math.hypot(intent.moveX, intent.moveZ) > Math.hypot(merged.moveX, merged.moveZ)) {
      merged.moveX = intent.moveX;
      merged.moveZ = intent.moveZ;
    }
    if (Math.hypot(intent.lookYawRate, intent.lookPitchRate) >
        Math.hypot(merged.lookYawRate, merged.lookPitchRate)) {
      merged.lookYawRate = intent.lookYawRate;
      merged.lookPitchRate = intent.lookPitchRate;
    }
    merged.active ||= intent.active;
    merged.start ||= intent.start;
  }
  return merged;
}

/** Copy the live browser objects into plain snapshots. */
export function readPads(): PadSnapshot[] {
  const pads = navigator.getGamepads?.() ?? [];
  const out: PadSnapshot[] = [];
  for (const pad of pads) {
    // Disconnected slots come back as null, and a pad that has not been touched
    // since page load comes back with connected false on some browsers.
    if (!pad?.connected) continue;
    out.push({
      buttons: pad.buttons.map((b) => b.value),
      axes: [...pad.axes],
      mapping: pad.mapping,
      id: pad.id,
    });
  }
  return out;
}
