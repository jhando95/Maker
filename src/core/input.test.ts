/**
 * The binding model.
 *
 * `Input` had no unit test at all, which was survivable while it was a map
 * lookup and stopped being so the moment an action started owning an ordered
 * pair of keys. Every rule below is one somebody can reach from the controls
 * screen in two clicks, and all of them fail silently: a rebind that quietly
 * drops the alternate, a key claimed by two actions, a slot holding the same
 * code twice. None of them throws, and the symptom is always "that key stopped
 * working" a session later.
 *
 * The device half — pointer lock, wheel, mouse deltas — is still checked by the
 * browser scenarios, because it is made of things that do not exist here.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  Input, ACTIONS, BINDABLE, BINDING_GROUPS, BINDING_SLOTS, DEFAULT_BINDINGS,
  UNBINDABLE, describeKey, labelFor, slotsFromMap, type Action,
} from './input.ts';

/**
 * A stand-in for the three things `Input` attaches listeners to.
 *
 * The tests run under node with no DOM, and the constructor registers handlers
 * on the element, on `window` and on `document`. Nothing here fires an event —
 * the device half is checked by the browser scenarios, where the devices exist
 * — so a listener sink is the whole of what these have to be.
 *
 * Installed and removed around every test rather than left lying about, because
 * a stray global `window` is the kind of thing another suite would pick up and
 * behave differently for.
 */
const listenerSink = {
  addEventListener() { /* nothing to record */ },
  removeEventListener() { /* nothing to record */ },
  pointerLockElement: null,
};

type Globals = { window?: unknown; document?: unknown };
let hadWindow = false;
let hadDocument = false;

beforeEach(() => {
  const globals = globalThis as unknown as Globals;
  hadWindow = 'window' in globals;
  hadDocument = 'document' in globals;
  if (!hadWindow) globals.window = listenerSink;
  if (!hadDocument) globals.document = listenerSink;
});

afterEach(() => {
  const globals = globalThis as unknown as Globals;
  if (!hadWindow) delete globals.window;
  if (!hadDocument) delete globals.document;
});

function makeInput(bindings?: Record<string, Action>): Input {
  return new Input(listenerSink as unknown as HTMLElement, bindings);
}

describe('the default bindings', () => {
  it('fit in the slots each action has', () => {
    // Codes past the last slot are dropped by `slotsFromMap`. That is the right
    // behaviour for a blob out of storage and the wrong thing to discover by
    // adding a third default and watching one vanish.
    const perAction = new Map<string, number>();
    for (const action of Object.values(DEFAULT_BINDINGS)) {
      perAction.set(action, (perAction.get(action) ?? 0) + 1);
    }
    for (const [action, count] of perAction) {
      expect(count, `${action} has more defaults than there are slots`)
        .toBeLessThanOrEqual(BINDING_SLOTS);
    }
  });

  it('takes slot order from the order they are written in', () => {
    // W before the arrow in the literal means W is the main key. Pinned here so
    // that reordering the literal is a decision rather than an accident.
    const input = makeInput();
    expect(input.slotsFor('moveForward')).toEqual(['KeyW', 'ArrowUp']);
    expect(input.slotsFor('sprint')).toEqual(['ShiftLeft', 'ShiftRight']);
    expect(input.slotsFor('crouch')).toEqual(['ControlLeft', null]);
  });

  it('never gives one key to two actions', () => {
    const seen = new Map<string, Action>();
    for (const [code, action] of Object.entries(DEFAULT_BINDINGS)) {
      expect(seen.has(code), `${code} is bound to both ${seen.get(code)} and ${action}`)
        .toBe(false);
      seen.set(code, action);
    }
  });

  it('offers every action on the controls screen except the debug keys', () => {
    // The rule the screen is held to. The list it replaced covered twenty of
    // forty-one, and the twenty-one missing were not a decision — they were
    // whatever had been added since it was written, push-to-talk among them.
    const listed = new Set(BINDABLE.map((entry) => entry.action));
    const exempt = new Set<string>(UNBINDABLE);
    for (const action of ACTIONS) {
      if (exempt.has(action)) {
        expect(listed.has(action), `${action} is both exempt and listed`).toBe(false);
      } else {
        expect(listed.has(action), `${action} cannot be rebound by anybody`).toBe(true);
      }
    }
  });

  it('lists each action exactly once, in exactly one group', () => {
    const counts = new Map<Action, number>();
    for (const group of BINDING_GROUPS) {
      for (const { action } of group.actions) {
        counts.set(action, (counts.get(action) ?? 0) + 1);
      }
    }
    for (const [action, count] of counts) {
      expect(count, `${action} appears ${count} times on the screen`).toBe(1);
    }
  });

  it('gives every listed action a label that is not its own name', () => {
    for (const { action, label } of BINDABLE) {
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toBe(action);
    }
  });
});

describe('rebinding', () => {
  let input: Input;
  beforeEach(() => { input = makeInput(); });


  it('changes one key and leaves the other alone', () => {
    // The bug this whole model exists for. Rebinding used to delete every code
    // an action had, so somebody moving forward onto another letter silently
    // lost the arrow key too — and the only clue was that the arrows stopped.
    input.setBinding('moveForward', 'KeyI', 0);
    expect(input.slotsFor('moveForward')).toEqual(['KeyI', 'ArrowUp']);
    expect(input.getBindings()['ArrowUp']).toBe('moveForward');
    expect(input.getBindings()['KeyW']).toBeUndefined();
  });

  it('changes the alternate without touching the main key', () => {
    input.setBinding('moveForward', 'KeyI', 1);
    expect(input.slotsFor('moveForward')).toEqual(['KeyW', 'KeyI']);
  });

  it('takes a key from whoever had it, and says who', () => {
    // A code can only mean one thing: two actions on one key means pressing it
    // does both. So the theft is correct and the report is the point.
    const took = input.setBinding('jump', 'KeyW', 1);
    expect(took).toBe('moveForward');
    expect(input.slotsFor('moveForward')).toEqual([null, 'ArrowUp']);
    expect(input.slotsFor('jump')).toEqual(['Space', 'KeyW']);
    expect(input.getBindings()['KeyW']).toBe('jump');
  });

  it('says nothing was taken when the key was free', () => {
    expect(input.setBinding('jump', 'KeyI', 1)).toBeNull();
  });

  it('swaps rather than duplicating when a key moves within one action', () => {
    // Otherwise the pair holds the same code twice, which is an action with one
    // key drawn as though it had two.
    input.setBinding('moveForward', 'ArrowUp', 0);
    expect(input.slotsFor('moveForward')).toEqual(['ArrowUp', 'KeyW']);
    expect(input.codesFor('moveForward')).toEqual(['ArrowUp', 'KeyW']);
  });

  it('does nothing when a key is rebound to the slot it is already in', () => {
    expect(input.setBinding('moveForward', 'KeyW', 0)).toBeNull();
    expect(input.slotsFor('moveForward')).toEqual(['KeyW', 'ArrowUp']);
  });

  it('ignores a slot that does not exist rather than growing the pair', () => {
    input.setBinding('jump', 'KeyI', BINDING_SLOTS);
    input.setBinding('jump', 'KeyO', -1);
    expect(input.slotsFor('jump')).toEqual(['Space', null]);
    expect(input.getBindings()['KeyI']).toBeUndefined();
  });

  it('empties a slot on demand, which is the only route to one key', () => {
    input.clearBinding('moveForward', 1);
    expect(input.slotsFor('moveForward')).toEqual(['KeyW', null]);
    expect(input.codesFor('moveForward')).toEqual(['KeyW']);
    expect(input.getBindings()['ArrowUp']).toBeUndefined();
  });

  it('lets an action end up with no keys at all', () => {
    // Deliberate. "Reset controls" is the way back, and refusing the last
    // unbind would mean a player cannot retire a control they never use.
    input.clearBinding('crouch', 0);
    expect(input.codesFor('crouch')).toEqual([]);
    expect(input.slotsFor('crouch')).toEqual([null, null]);
  });

  it('keeps the lookup and the slots saying the same thing', () => {
    // The lookup is derived rather than maintained precisely so this cannot
    // drift, and this is the check that the derivation actually runs.
    input.setBinding('jump', 'KeyW', 1);
    input.clearBinding('sprint', 0);
    input.setBinding('crouch', 'KeyH', 1);

    const lookup = input.getBindings();
    const fromSlots: Record<string, Action> = {};
    for (const action of ACTIONS) {
      for (const code of input.codesFor(action)) fromSlots[code] = action;
    }
    expect(lookup).toEqual(fromSlots);
  });

  it('puts everything back, including keys taken from other actions', () => {
    input.setBinding('jump', 'KeyW', 0);
    input.clearBinding('moveForward', 1);
    input.resetBindings();
    expect(input.slotsFor('moveForward')).toEqual(['KeyW', 'ArrowUp']);
    expect(input.slotsFor('jump')).toEqual(['Space', null]);
  });
});

describe('restoring saved bindings', () => {
  it('round-trips through the shape that gets persisted', () => {
    const input = makeInput();
    input.setBinding('jump', 'KeyH', 1);
    input.clearBinding('sprint', 1);
    const saved = input.getBindingSlots();

    const restored = makeInput();
    restored.setBindingSlots(saved);
    expect(restored.getBindingSlots()).toEqual(saved);
    expect(restored.slotsFor('jump')).toEqual(['Space', 'KeyH']);
    expect(restored.slotsFor('sprint')).toEqual(['ShiftLeft', null]);
  });

  it('leaves an action unbound rather than reverting it to the default', () => {
    // The tempting alternative is to fill gaps from `DEFAULT_BINDINGS`, and it
    // is wrong: a player who cleared a key would find it back the next time the
    // shape of this file changed, with nothing to explain it.
    const input = makeInput();
    input.setBindingSlots({ jump: ['KeyH', null] });
    expect(input.slotsFor('jump')).toEqual(['KeyH', null]);
    expect(input.slotsFor('moveForward')).toEqual([null, null]);
  });

  it('drops an action a newer build no longer has', () => {
    const input = makeInput();
    input.setBindingSlots({ jump: ['KeyH', null], summonDragon: ['KeyU', null] });
    expect(input.getBindings()['KeyU']).toBeUndefined();
    expect(input.getBindings()['KeyH']).toBe('jump');
  });

  it('refuses to hand one key to two actions, however the blob was written', () => {
    // Storage is a file on somebody's disk, so this is reachable by hand and by
    // any older build that wrote a different rule.
    const input = makeInput();
    input.setBindingSlots({ jump: ['KeyH', null], crouch: ['KeyH', null] });
    const owners = ACTIONS.filter((action) => input.codesFor(action).includes('KeyH'));
    expect(owners).toHaveLength(1);
  });

  it('ignores junk in a slot without losing the rest of the pair', () => {
    const input = makeInput();
    input.setBindingSlots({
      jump: ['KeyH', 7 as unknown as string],
      crouch: 'KeyC' as unknown as string[],
      sprint: ['', 'KeyL'],
    });
    expect(input.slotsFor('jump')).toEqual(['KeyH', null]);
    expect(input.slotsFor('crouch')).toEqual([null, null]);
    expect(input.slotsFor('sprint')).toEqual([null, 'KeyL']);
  });

  it('takes the flat map shape the defaults are written in', () => {
    const input = makeInput({ KeyH: 'jump', KeyJ: 'jump', KeyK: 'jump' } as Record<string, Action>);
    // Three codes, two slots: the third is dropped rather than silently
    // replacing one, which is why the defaults are checked against the count.
    expect(input.slotsFor('jump')).toEqual(['KeyH', 'KeyJ']);
  });
});

describe('slotsFromMap', () => {
  it('fills slots in the order the map is written', () => {
    expect(slotsFromMap({ KeyW: 'moveForward', ArrowUp: 'moveForward' }))
      .toEqual({ moveForward: ['KeyW', 'ArrowUp'] });
    expect(slotsFromMap({ ArrowUp: 'moveForward', KeyW: 'moveForward' }))
      .toEqual({ moveForward: ['ArrowUp', 'KeyW'] });
  });
});

describe('describeKey', () => {
  it('names the keys a player can now actually reach', () => {
    // Before, somebody could only land on the twenty keys the screen offered.
    // Anything is bindable now, and a button reading `BracketLeft` is a button
    // reading the wrong thing.
    expect(describeKey('KeyW')).toBe('W');
    expect(describeKey('Digit4')).toBe('4');
    expect(describeKey('ArrowUp')).toBe('Up Arrow');
    expect(describeKey('Mouse0')).toBe('Left Mouse');
    expect(describeKey('Mouse1')).toBe('Middle Mouse');
    expect(describeKey('Mouse2')).toBe('Right Mouse');
    expect(describeKey('ShiftLeft')).toBe('L Shift');
    expect(describeKey('BracketLeft')).toBe('[');
    expect(describeKey('Period')).toBe('.');
    expect(describeKey('Numpad5')).toBe('Num 5');
    expect(describeKey('CapsLock')).toBe('Caps');
  });

  it('says something rather than nothing for a key it has never met', () => {
    expect(describeKey('IntlRo')).toBe('IntlRo');
  });

  it('never hands back an empty label, whatever the code', () => {
    for (const code of Object.keys(DEFAULT_BINDINGS)) {
      expect(describeKey(code).length, `${code} draws as an empty button`).toBeGreaterThan(0);
    }
  });
});

describe('labelFor', () => {
  it('gives the name a player would recognise', () => {
    expect(labelFor('rotateCCW')).toBe('Turn left');
  });

  it('falls back to the action for the two that are not on the screen', () => {
    expect(labelFor('debugToggle')).toBe('debugToggle');
  });
});
