import { describe, it, expect } from 'vitest';
import {
  mapPad, mergePads, applyDeadzone, IDLE_INTENT, PAD, PAD_BINDINGS,
  DEFAULT_PAD_OPTIONS, type PadSnapshot, type PadOptions,
} from './gamepad.ts';
import { GamepadManager, type ActionSink } from './gamepadManager.ts';
import { ACTIONS, type Action } from './input.ts';

const OPTS: PadOptions = { ...DEFAULT_PAD_OPTIONS };

/** A pad at rest, with every button up and both sticks centred. */
function pad(overrides: { buttons?: Record<number, number>; axes?: number[] } = {}): PadSnapshot {
  const buttons = new Array<number>(17).fill(0);
  for (const [i, v] of Object.entries(overrides.buttons ?? {})) buttons[Number(i)] = v;
  return {
    buttons,
    axes: overrides.axes ?? [0, 0, 0, 0],
    mapping: 'standard',
    id: 'Test Pad (Vendor: 0000 Product: 0000)',
  };
}

describe('applyDeadzone', () => {
  it('ignores a stick inside the zone', () => {
    expect(applyDeadzone(0.1, 0.05, 0.16).magnitude).toBe(0);
  });

  it('rescales so leaving the zone is continuous, not a jump', () => {
    // Just outside the deadzone must be nearly zero. Without rescaling it would
    // be 0.16 — a visible twitch every time the stick is nudged.
    const just = applyDeadzone(0.17, 0, 0.16);
    expect(just.magnitude).toBeLessThan(0.02);
    expect(just.magnitude).toBeGreaterThan(0);
  });

  it('reaches full magnitude at full deflection', () => {
    expect(applyDeadzone(1, 0, 0.16).magnitude).toBeCloseTo(1, 6);
  });

  it('is radial, not per-axis', () => {
    // The failure a per-axis deadzone produces: a stick pushed diagonally sits
    // inside the square hole on both axes and reports nothing, so the character
    // drifts toward the cardinal directions. At 45° with each axis at 0.14 the
    // magnitude is 0.198, comfortably outside a 0.16 radial zone.
    const diag = applyDeadzone(0.14, 0.14, 0.16);
    expect(diag.magnitude).toBeGreaterThan(0);
  });

  it('does not let a diagonal exceed full speed', () => {
    // Sticks are physically round but report a square range on some pads, so
    // (1,1) is reachable and must not walk 41% faster than (1,0).
    expect(applyDeadzone(1, 1, 0.16).magnitude).toBeCloseTo(1, 6);
  });

  it('preserves direction', () => {
    const d = applyDeadzone(0.6, -0.8, 0.16);
    // 0.6/-0.8 is a 3-4-5 triangle: the ratio must survive rescaling.
    expect(d.x / d.y).toBeCloseTo(0.6 / -0.8, 6);
  });

  it('a zero deadzone still works', () => {
    expect(applyDeadzone(0.5, 0, 0).magnitude).toBeCloseTo(0.5, 6);
    expect(applyDeadzone(0, 0, 0).magnitude).toBe(0);
  });
});

describe('mapPad movement', () => {
  it('pushing the stick up walks forward', () => {
    // The browser reports stick-up as -Y, and forward is +z.
    const intent = mapPad(pad({ axes: [0, -1, 0, 0] }), OPTS);
    expect(intent.moveZ).toBeCloseTo(1, 6);
    expect(intent.moveX).toBeCloseTo(0, 6);
  });

  it('pushing the stick right strafes right', () => {
    const intent = mapPad(pad({ axes: [1, 0, 0, 0] }), OPTS);
    expect(intent.moveX).toBeCloseTo(1, 6);
    expect(intent.moveZ).toBeCloseTo(0, 6);
  });

  it('a half-pushed stick walks rather than runs', () => {
    const half = mapPad(pad({ axes: [0, -0.5, 0, 0] }), OPTS);
    const full = mapPad(pad({ axes: [0, -1, 0, 0] }), OPTS);
    expect(half.moveZ).toBeGreaterThan(0);
    expect(half.moveZ).toBeLessThan(full.moveZ * 0.8);
  });

  it('a resting stick is exactly still', () => {
    // Worn sticks rest off-centre; drifting forward while nobody is touching
    // the pad is the classic symptom of a missing deadzone.
    const intent = mapPad(pad({ axes: [0.09, -0.11, 0.1, 0.05] }), OPTS);
    expect(intent.moveX).toBe(0);
    expect(intent.moveZ).toBe(0);
    expect(intent.lookYawRate).toBe(0);
    expect(intent.active).toBe(false);
  });

  it('reports a plain zero, never -0', () => {
    // -0 is arithmetically identical and unequal under Object.is, and survives
    // JSON as "0". An idle stick must not report a value that behaves
    // differently depending on who looks at it.
    const idle = mapPad(pad(), OPTS);
    for (const v of [idle.moveX, idle.moveZ, idle.lookYawRate, idle.lookPitchRate]) {
      expect(Object.is(v, -0)).toBe(false);
    }
  });
});

describe('mapPad look', () => {
  it('the right stick turns right and looks up', () => {
    const intent = mapPad(pad({ axes: [0, 0, 1, -1] }), OPTS);
    expect(intent.lookYawRate).toBeGreaterThan(0);
    // Not inverted: stick up looks up, which is a positive pitch rate.
    expect(intent.lookPitchRate).toBeGreaterThan(0);
  });

  it('invertY flips pitch and leaves yaw alone', () => {
    const normal = mapPad(pad({ axes: [0, 0, 1, -1] }), OPTS);
    const inverted = mapPad(pad({ axes: [0, 0, 1, -1] }), { ...OPTS, invertY: true });
    expect(inverted.lookPitchRate).toBeCloseTo(-normal.lookPitchRate, 6);
    expect(inverted.lookYawRate).toBeCloseTo(normal.lookYawRate, 6);
  });

  it('reaches exactly the configured speed at full deflection', () => {
    const intent = mapPad(pad({ axes: [0, 0, 1, 0] }), { ...OPTS, deadzone: 0, lookSpeed: 3 });
    expect(intent.lookYawRate).toBeCloseTo(3, 6);
  });

  it('gives most of the travel to fine aim', () => {
    // The squared response: half deflection is a quarter speed, not half. This
    // is what makes a stick usable both for spinning round and for lining a
    // board up on a wall.
    const half = mapPad(pad({ axes: [0, 0, 0.5, 0] }), { ...OPTS, deadzone: 0, lookSpeed: 4 });
    expect(half.lookYawRate).toBeCloseTo(1, 6);
  });

  it('is symmetric about centre', () => {
    const right = mapPad(pad({ axes: [0, 0, 0.7, 0] }), { ...OPTS, deadzone: 0 });
    const left = mapPad(pad({ axes: [0, 0, -0.7, 0] }), { ...OPTS, deadzone: 0 });
    expect(left.lookYawRate).toBeCloseTo(-right.lookYawRate, 6);
  });
});

describe('mapPad buttons', () => {
  it('maps every binding to its action', () => {
    for (const { button, action } of PAD_BINDINGS) {
      const intent = mapPad(pad({ buttons: { [button]: 1 } }), OPTS);
      expect(intent.down.has(action), `button ${button} should press ${action}`).toBe(true);
      expect(intent.down.size, `button ${button} should press only ${action}`).toBe(1);
    }
  });

  it('binds no button twice and no action twice', () => {
    const buttons = new Set(PAD_BINDINGS.map((b) => b.button));
    const actions = new Set(PAD_BINDINGS.map((b) => b.action));
    expect(buttons.size).toBe(PAD_BINDINGS.length);
    expect(actions.size).toBe(PAD_BINDINGS.length);
  });

  it('binds only real actions', () => {
    for (const { action } of PAD_BINDINGS) {
      expect(ACTIONS as readonly string[]).toContain(action);
    }
  });

  it('leaves Start out of the action map', () => {
    // Start opens the menu, which is not a gameplay action and must not be
    // reachable through a rebindable path.
    expect(PAD_BINDINGS.some((b) => b.button === PAD.START)).toBe(false);
    const intent = mapPad(pad({ buttons: { [PAD.START]: 1 } }), OPTS);
    expect(intent.start).toBe(true);
    expect(intent.down.size).toBe(0);
  });

  it('survives a pad that reports fewer buttons than standard', () => {
    const short: PadSnapshot = { buttons: [1, 0], axes: [0, 0], mapping: '', id: 'minimal' };
    const intent = mapPad(short, OPTS);
    expect(intent.down.has('jump')).toBe(true);
    expect(intent.moveX).toBe(0);
    expect(intent.lookPitchRate).toBe(0);
  });
});

describe('trigger hysteresis', () => {
  const rt = (v: number) => pad({ buttons: { [PAD.RT]: v } });

  it('does not fire from a light pull', () => {
    expect(mapPad(rt(0.4), OPTS).down.has('placePart')).toBe(false);
  });

  it('fires once past the press threshold', () => {
    expect(mapPad(rt(0.7), OPTS).down.has('placePart')).toBe(true);
  });

  it('holds through the band rather than chattering', () => {
    // A trigger resting at 0.45 against a single threshold would place, unplace,
    // place, unplace at the tick rate — a whole wall of parts from one pull.
    let intent = mapPad(rt(0.7), OPTS);
    for (const v of [0.45, 0.5, 0.42, 0.48]) {
      intent = mapPad(rt(v), OPTS, intent);
      expect(intent.down.has('placePart')).toBe(true);
    }
  });

  it('releases below the release threshold', () => {
    const held = mapPad(rt(0.7), OPTS);
    expect(mapPad(rt(0.2), OPTS, held).down.has('placePart')).toBe(false);
  });

  it('a fully released trigger is never held', () => {
    const held = mapPad(rt(1), OPTS);
    expect(mapPad(rt(0), OPTS, held).down.has('placePart')).toBe(false);
  });
});

describe('mergePads', () => {
  it('reports nothing with no pads', () => {
    expect(mergePads([], OPTS)).toBe(IDLE_INTENT);
  });

  it('takes the stick that is actually being pushed', () => {
    // The realistic case: a second pad asleep in a drawer, reporting zeros.
    const asleep = pad();
    const active = pad({ axes: [0, -1, 0, 0] });
    expect(mergePads([asleep, active], OPTS).moveZ).toBeCloseTo(1, 6);
    expect(mergePads([active, asleep], OPTS).moveZ).toBeCloseTo(1, 6);
  });

  it('unions buttons across pads', () => {
    const a = pad({ buttons: { [PAD.A]: 1 } });
    const b = pad({ buttons: { [PAD.X]: 1 } });
    const merged = mergePads([a, b], OPTS);
    expect(merged.down.has('jump')).toBe(true);
    expect(merged.down.has('removePart')).toBe(true);
  });

  it('does not add two sticks into faster-than-full movement', () => {
    const both = mergePads([pad({ axes: [0, -1, 0, 0] }), pad({ axes: [0, -1, 0, 0] })], OPTS);
    expect(Math.hypot(both.moveX, both.moveZ)).toBeLessThanOrEqual(1 + 1e-9);
  });
});

/** Records what the manager pushes, standing in for the real Input. */
class RecordingSink implements ActionSink {
  readonly pressed: Action[] = [];
  readonly released: Action[] = [];
  axes: [number, number, number, number] = [0, 0, 0, 0];

  pressAction(action: Action): void {
    this.pressed.push(action);
  }
  releaseAction(action: Action): void {
    this.released.push(action);
  }
  setPadAxes(a: number, b: number, c: number, d: number): void {
    this.axes = [a, b, c, d];
  }
}

describe('GamepadManager', () => {
  it('presses once on the frame a button goes down, not every frame', () => {
    const sink = new RecordingSink();
    const mgr = new GamepadManager(sink);
    const held = pad({ buttons: { [PAD.A]: 1 } });

    for (let i = 0; i < 10; i++) mgr.poll([held]);

    // Ten frames of a held button is one press. Repeating it would make
    // wasPressed() true on every tick — one jump input becomes ten.
    expect(sink.pressed).toEqual(['jump']);
    expect(sink.released).toEqual([]);
  });

  it('releases on the frame a button comes up', () => {
    const sink = new RecordingSink();
    const mgr = new GamepadManager(sink);
    mgr.poll([pad({ buttons: { [PAD.A]: 1 } })]);
    mgr.poll([pad()]);
    mgr.poll([pad()]);
    expect(sink.released).toEqual(['jump']);
  });

  it('releases everything when the pad is unplugged', () => {
    const sink = new RecordingSink();
    const mgr = new GamepadManager(sink);
    mgr.poll([pad({ buttons: { [PAD.L3]: 1 }, axes: [0, -1, 0, 0] })]);
    expect(sink.pressed).toEqual(['sprint']);

    // A controller pulled out mid-sprint would otherwise sprint forever.
    mgr.poll([]);
    expect(sink.released).toEqual(['sprint']);
    expect(sink.axes).toEqual([0, 0, 0, 0]);
  });

  it('zeroes the sticks when a pad is unplugged with no button held', () => {
    // Measured in a browser: a pad pulled out mid-push left its last axes
    // applied, and the player kept walking with nothing connected. A guard that
    // only looked for held buttons never fired, because there were none.
    const sink = new RecordingSink();
    const mgr = new GamepadManager(sink);
    mgr.poll([pad({ axes: [0, -1, 0, 0] })]);
    expect(sink.axes[1]).toBeCloseTo(1, 6);

    mgr.poll([]);
    expect(sink.axes).toEqual([0, 0, 0, 0]);
  });

  it('does not thrash the sink once idle', () => {
    // The release path must be one-shot, or every frame with no pad connected
    // would push another set of zeros for the life of the session.
    const sink = new RecordingSink();
    const mgr = new GamepadManager(sink);
    mgr.poll([pad({ axes: [0, -1, 0, 0] })]);
    mgr.poll([]);
    sink.axes = [9, 9, 9, 9];
    for (let i = 0; i < 5; i++) mgr.poll([]);
    expect(sink.axes).toEqual([9, 9, 9, 9]);
  });

  it('releases everything when the pad is turned off in settings', () => {
    const sink = new RecordingSink();
    const mgr = new GamepadManager(sink);
    mgr.poll([pad({ buttons: { [PAD.A]: 1 } })]);
    mgr.enabled = false;
    mgr.poll([pad({ buttons: { [PAD.A]: 1 } })]);
    expect(sink.released).toEqual(['jump']);
  });

  it('fires Start once per press', () => {
    const sink = new RecordingSink();
    const mgr = new GamepadManager(sink);
    let starts = 0;
    mgr.onStart = () => { starts++; };

    const down = pad({ buttons: { [PAD.START]: 1 } });
    for (let i = 0; i < 5; i++) mgr.poll([down]);
    // Holding Start must not open and close the menu five times.
    expect(starts).toBe(1);

    mgr.poll([pad()]);
    mgr.poll([down]);
    expect(starts).toBe(2);
  });

  it('does not fire Start while disabled', () => {
    const sink = new RecordingSink();
    const mgr = new GamepadManager(sink);
    let starts = 0;
    mgr.onStart = () => { starts++; };
    mgr.enabled = false;
    mgr.poll([pad({ buttons: { [PAD.START]: 1 } })]);
    expect(starts).toBe(0);
  });

  it('passes stick axes through to the sink', () => {
    const sink = new RecordingSink();
    const mgr = new GamepadManager(sink);
    mgr.setOptions({ deadzone: 0, lookSpeed: 2 });
    mgr.poll([pad({ axes: [0, -1, 1, 0] })]);
    expect(sink.axes[1]).toBeCloseTo(1, 6);  // forward
    expect(sink.axes[2]).toBeCloseTo(2, 6);  // full-speed yaw
  });

  it('applies changed options on the next poll', () => {
    const sink = new RecordingSink();
    const mgr = new GamepadManager(sink);
    mgr.setOptions({ deadzone: 0, lookSpeed: 1 });
    mgr.poll([pad({ axes: [0, 0, 1, 0] })]);
    expect(sink.axes[2]).toBeCloseTo(1, 6);

    mgr.setOptions({ lookSpeed: 5 });
    mgr.poll([pad({ axes: [0, 0, 1, 0] })]);
    expect(sink.axes[2]).toBeCloseTo(5, 6);
  });

  it('carries trigger hysteresis across polls', () => {
    const sink = new RecordingSink();
    const mgr = new GamepadManager(sink);
    mgr.poll([pad({ buttons: { [PAD.RT]: 0.8 } })]);
    for (const v of [0.45, 0.5, 0.4]) mgr.poll([pad({ buttons: { [PAD.RT]: v } })]);
    // One pull is one place, however unsteadily the trigger is held.
    expect(sink.pressed).toEqual(['placePart']);
    expect(sink.released).toEqual([]);
  });
});
