import { describe, it, expect, vi } from 'vitest';
import { Tuning, clampTo, type KnobSpec } from './tuning.ts';

const spec = (over: Partial<KnobSpec> = {}): KnobSpec => ({
  key: 'jump.height', label: 'Jump height', value: 1.2,
  min: 0.5, max: 3, step: 0.1, home: 'physics/constants.ts', ...over,
});

describe('holding a value inside its own range', () => {
  const range = { min: 0, max: 10, step: 0.5 };

  it('leaves a good one alone', () => {
    expect(clampTo(range, 4.5)).toBe(4.5);
  });

  it('holds it at both ends', () => {
    expect(clampTo(range, -100)).toBe(0);
    expect(clampTo(range, 1e9)).toBe(10);
  });

  it('rounds to the step, because that is what the slider can express', () => {
    expect(clampTo(range, 4.3)).toBe(4.5);
    expect(clampTo(range, 4.2)).toBe(4);
  });

  it('does not leave float dust behind', () => {
    // Rounding at the step reintroduces the error it exists to remove: three
    // tenths is not 0.30000000000000004 to anybody looking at a slider.
    expect(clampTo({ min: 0, max: 1, step: 0.1 }, 0.3)).toBe(0.3);
    expect(String(clampTo({ min: 0, max: 1, step: 0.1 }, 0.7))).toBe('0.7');
  });

  it('takes the low end rather than NaN', () => {
    expect(clampTo(range, Number.NaN)).toBe(0);
    expect(clampTo(range, Number.POSITIVE_INFINITY)).toBe(10);
  });

  it('leaves a value alone when there is no step to round to', () => {
    expect(clampTo({ min: 0, max: 10, step: 0 }, 4.321)).toBe(4.321);
  });
});

describe('registering', () => {
  it('hands back a reader rather than a number', () => {
    // A function because the point is that it changes. A caller that read a
    // number once at module load would have opted out and never noticed.
    const t = new Tuning();
    const read = t.register(spec());
    expect(read()).toBe(1.2);
    t.set('jump.height', 2);
    expect(read()).toBe(2);
  });

  it('clamps what it was registered with, not just what is set later', () => {
    const t = new Tuning();
    expect(t.register(spec({ value: 99 }))()).toBe(3);
  });

  it('refuses two knobs with one name', () => {
    const t = new Tuning();
    t.register(spec());
    expect(() => t.register(spec())).toThrow(/two knobs/);
  });

  it('refuses a range that is not one', () => {
    const t = new Tuning();
    expect(() => t.register(spec({ min: 5, max: 1 }))).toThrow(/range/);
    expect(() => t.register(spec({ key: 'nan', min: Number.NaN }))).toThrow(/range/);
  });

  it('keeps them in the order they were declared', () => {
    const t = new Tuning();
    t.register(spec({ key: 'b' }));
    t.register(spec({ key: 'a' }));
    expect(t.all().map((k) => k.key)).toEqual(['b', 'a']);
  });
});

describe('setting', () => {
  it('clamps, and says what it became', () => {
    const t = new Tuning();
    t.register(spec());
    expect(t.set('jump.height', 100)).toBe(3);
    expect(t.get('jump.height')).toBe(3);
  });

  it('says nothing about a knob that does not exist', () => {
    const t = new Tuning();
    expect(t.set('nope', 1)).toBeUndefined();
    expect(t.get('nope')).toBeUndefined();
  });

  it('tells anybody listening', () => {
    const t = new Tuning();
    t.register(spec());
    const heard = vi.fn();
    t.onChange(heard);
    t.set('jump.height', 2);
    expect(heard).toHaveBeenCalledWith('jump.height', 2);
  });

  it('stays quiet when nothing actually changed', () => {
    // A slider fires on every pixel of drag and most of them land on the value
    // it is already at. A listener that rebuilds a scene has to be told about
    // changes, not about attention.
    const t = new Tuning();
    t.register(spec());
    const heard = vi.fn();
    t.onChange(heard);
    t.set('jump.height', 1.2);
    t.set('jump.height', 1.23);
    expect(heard).not.toHaveBeenCalled();
  });

  it('stops telling somebody who stopped listening', () => {
    const t = new Tuning();
    t.register(spec());
    const heard = vi.fn();
    t.onChange(heard)();
    t.set('jump.height', 2);
    expect(heard).not.toHaveBeenCalled();
  });
});

describe('putting things back', () => {
  it('resets one', () => {
    const t = new Tuning();
    t.register(spec());
    t.register(spec({ key: 'other', value: 1 }));
    t.set('jump.height', 2);
    t.set('other', 2);
    t.reset('jump.height');
    expect(t.get('jump.height')).toBe(1.2);
    expect(t.get('other')).toBe(2);
  });

  it('and all of them', () => {
    const t = new Tuning();
    t.register(spec());
    t.register(spec({ key: 'other', value: 1 }));
    t.set('jump.height', 2);
    t.set('other', 2);
    t.reset();
    expect(t.changed()).toEqual([]);
  });

  it('tells listeners it did', () => {
    const t = new Tuning();
    t.register(spec());
    t.set('jump.height', 2);
    const heard = vi.fn();
    t.onChange(heard);
    t.reset();
    expect(heard).toHaveBeenCalledWith('jump.height', 1.2);
  });

  it('resets to what it was registered with, not to the middle of the range', () => {
    const t = new Tuning();
    t.register(spec({ value: 1.2, min: 0.5, max: 3 }));
    t.set('jump.height', 3);
    t.reset();
    expect(t.get('jump.height')).toBe(1.2);
  });
});

describe('what came out of a session', () => {
  it('lists only what moved', () => {
    const t = new Tuning();
    t.register(spec());
    t.register(spec({ key: 'other', value: 1 }));
    t.set('other', 2);
    expect(t.changed().map((k) => k.key)).toEqual(['other']);
  });

  it('prints them as something to paste, with where it goes', () => {
    // Tuning that lives only in a browser's storage is a game that behaves
    // differently on the machine it was tuned on. It ends in a commit or it did
    // not happen.
    const t = new Tuning();
    t.register(spec());
    t.set('jump.height', 2);
    const source = t.asSource();
    expect(source).toContain('physics/constants.ts');
    expect(source).toContain('jump.height = 2');
    expect(source).toContain('was 1.2');
  });

  it('says so plainly when nothing moved', () => {
    const t = new Tuning();
    t.register(spec());
    expect(t.asSource()).toBe('// nothing changed');
  });

  it('does not claim a knob changed because it was set to what it already was', () => {
    const t = new Tuning();
    t.register(spec());
    t.set('jump.height', 1.2);
    expect(t.asSource()).toBe('// nothing changed');
  });
});
