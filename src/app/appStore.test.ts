import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SettingsStore, DEFAULT_SETTINGS, ghostColors,
  loadBindings, saveBindings, clearBindings,
} from './settings.ts';
import { BuildStore, MAX_SLOTS } from './buildStore.ts';
import type { PlacementRecord } from '../build/buildSystem.ts';

/** Minimal in-memory localStorage, since these run in plain Node. */
function installStorage(): Map<string, string> {
  const map = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  });
  return map;
}

const part = (i: number): PlacementRecord => ({
  kind: i % 8, colorway: i % 8,
  // Offset so index 0 does not produce -0, which JSON normalizes to 0. That is
  // numerically identical and harmless in the game, but it makes a strict
  // deep-equality round-trip check fail for a reason that is not a bug.
  x: i * 0.25, y: 0.5, z: (i + 1) * -0.25,
  qx: 0, qy: 0, qz: 0, qw: 1,
});

describe('SettingsStore', () => {
  beforeEach(() => installStorage());

  it('starts from defaults', () => {
    expect(new SettingsStore().current).toEqual(DEFAULT_SETTINGS);
  });

  it('persists across instances', () => {
    const a = new SettingsStore();
    a.set('fov', 95);
    expect(new SettingsStore().get('fov')).toBe(95);
  });

  it('clamps values out of range', () => {
    const s = new SettingsStore();
    s.set('fov', 500);
    expect(s.get('fov')).toBe(110);
    s.set('masterVolume', -3);
    expect(s.get('masterVolume')).toBe(0);
  });

  it('notifies subscribers immediately and on change', () => {
    const s = new SettingsStore();
    const seen: number[] = [];
    // Firing on subscribe means callers never need a separate apply step.
    const off = s.subscribe((v) => seen.push(v.fov));
    expect(seen.length).toBe(1);
    s.set('fov', 88);
    expect(seen).toEqual([DEFAULT_SETTINGS.fov, 88]);
    off();
    s.set('fov', 60);
    expect(seen.length).toBe(2);
  });

  it('does not notify when a value is unchanged', () => {
    const s = new SettingsStore();
    let calls = 0;
    s.subscribe(() => calls++);
    s.set('fov', DEFAULT_SETTINGS.fov);
    expect(calls).toBe(1);
  });

  it('survives a corrupt stored blob', () => {
    const map = installStorage();
    map.set('maker.settings.v1', '{not json');
    expect(new SettingsStore().current).toEqual(DEFAULT_SETTINGS);
  });

  it('ignores stored keys of the wrong type', () => {
    const map = installStorage();
    map.set('maker.settings.v1', JSON.stringify({ fov: 'wide', shadows: 'yes', invertY: true }));
    const s = new SettingsStore();
    expect(s.get('fov')).toBe(DEFAULT_SETTINGS.fov);
    expect(s.get('shadows')).toBe(DEFAULT_SETTINGS.shadows);
    // The one well-typed key still applies.
    expect(s.get('invertY')).toBe(true);
  });

  it('clamps values loaded from storage, not just ones set at runtime', () => {
    const map = installStorage();
    map.set('maker.settings.v1', JSON.stringify({ fov: 9000 }));
    expect(new SettingsStore().get('fov')).toBe(110);
  });

  it('works when storage throws, e.g. private browsing', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
      removeItem: () => { throw new Error('denied'); },
    });
    const s = new SettingsStore();
    expect(s.current).toEqual(DEFAULT_SETTINGS);
    expect(() => s.set('fov', 80)).not.toThrow();
    expect(s.get('fov')).toBe(80);
  });

  it('reset restores defaults', () => {
    const s = new SettingsStore();
    s.set('fov', 100);
    s.reset();
    expect(s.current).toEqual(DEFAULT_SETTINGS);
  });
});

describe('ghostColors', () => {
  it('avoids a red-green pair in colourblind mode', () => {
    const normal = ghostColors(false);
    const cb = ghostColors(true);
    expect(cb.valid).not.toBe(normal.valid);
    expect(cb.invalid).not.toBe(normal.invalid);
    // The two must stay clearly distinct from each other.
    expect(cb.valid).not.toBe(cb.invalid);
  });
});

describe('BuildStore', () => {
  beforeEach(() => installStorage());

  it('starts empty', () => {
    expect(new BuildStore().list()).toEqual([]);
  });

  it('round-trips a build', () => {
    const store = new BuildStore();
    const parts = Array.from({ length: 20 }, (_, i) => part(i));
    const slot = store.save('My fort', parts, 1000);
    expect(slot).not.toBeNull();
    expect(slot!.partCount).toBe(20);

    const loaded = store.load(slot!.id);
    expect(loaded).toEqual(parts);
  });

  it('normalizes negative zero, which JSON cannot represent', () => {
    const store = new BuildStore();
    const slot = store.save('nz', [{ ...part(0), x: -0, z: -0 }], 1000)!;
    const loaded = store.load(slot.id)!;
    // Not a defect: -0 === 0, and nothing in the game distinguishes them. Pinned
    // so a future strict comparison does not get blamed on the serializer.
    expect(Object.is(loaded[0]!.x, 0)).toBe(true);
    expect(loaded[0]!.x).toBe(0);
  });

  it('lists newest first', () => {
    const store = new BuildStore();
    store.save('old', [part(0)], 1000);
    store.save('new', [part(1)], 2000);
    expect(store.list().map((s) => s.name)).toEqual(['new', 'old']);
  });

  it('deletes a slot and its data', () => {
    const store = new BuildStore();
    const slot = store.save('gone', [part(0)], 1000)!;
    store.remove(slot.id);
    expect(store.list()).toEqual([]);
    expect(store.load(slot.id)).toBeNull();
  });

  it('drops the oldest slot past the cap', () => {
    const store = new BuildStore();
    for (let i = 0; i < MAX_SLOTS + 4; i++) store.save(`fort ${i}`, [part(i)], 1000 + i);
    const list = store.list();
    expect(list.length).toBe(MAX_SLOTS);
    // The very first saves are the ones that went.
    expect(list.some((s) => s.name === 'fort 0')).toBe(false);
    expect(list.some((s) => s.name === `fort ${MAX_SLOTS + 3}`)).toBe(true);
  });

  it('refuses a build too large to store', () => {
    const store = new BuildStore();
    const huge = Array.from({ length: 9000 }, (_, i) => part(i));
    expect(store.save('huge', huge, 1000)).toBeNull();
  });

  it('rejects a malformed saved blob rather than loading NaN transforms', () => {
    const map = installStorage();
    const store = new BuildStore();
    const slot = store.save('ok', [part(0)], 1000)!;
    // A truncated or hand-edited entry must be caught here, not discovered as a
    // broken transform three frames into a round.
    map.set(`maker.build.v1.${slot.id}`, JSON.stringify([{ kind: 0, x: 'nope' }]));
    expect(store.load(slot.id)).toBeNull();

    map.set(`maker.build.v1.${slot.id}`, JSON.stringify([{ ...part(0), y: NaN }]));
    expect(store.load(slot.id)).toBeNull();
  });

  it('returns null for an unknown slot', () => {
    expect(new BuildStore().load('nope')).toBeNull();
  });

  it('survives a corrupt index', () => {
    const map = installStorage();
    map.set('maker.builds.v1.index', 'garbage');
    expect(new BuildStore().list()).toEqual([]);
  });

  it('does not throw when storage is unavailable', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
      removeItem: () => { throw new Error('denied'); },
    });
    const store = new BuildStore();
    expect(store.list()).toEqual([]);
    expect(store.save('x', [part(0)], 1)).toBeNull();
    expect(() => store.remove('x')).not.toThrow();
  });
});

describe('key bindings', () => {
  beforeEach(() => installStorage());

  it('round-trips through storage, slots and all', () => {
    expect(loadBindings()).toBeNull();
    saveBindings({ moveForward: ['KeyK', 'ArrowUp'], placePart: ['Mouse0', null] });
    expect(loadBindings()).toEqual({
      moveForward: ['KeyK', 'ArrowUp'],
      placePart: ['Mouse0', null],
    });
  });

  it('keeps which key is the main one, which is the reason for the format', () => {
    // The old shape was code-to-action, and an object's key order is the only
    // thing that could have carried this. Storing the slots says it outright.
    saveBindings({ jump: ['Space', 'KeyJ'] });
    expect(loadBindings()?.jump).toEqual(['Space', 'KeyJ']);
    saveBindings({ jump: ['KeyJ', 'Space'] });
    expect(loadBindings()?.jump).toEqual(['KeyJ', 'Space']);
  });

  it('survives a corrupt blob', () => {
    const map = installStorage();
    map.set('maker.bindings.v2', 'not json');
    expect(loadBindings()).toBeNull();
  });

  it('rejects a non-object blob rather than handing back nonsense', () => {
    const map = installStorage();
    map.set('maker.bindings.v2', JSON.stringify(['KeyW']));
    expect(loadBindings()).toBeNull();
  });

  it('drops slot entries that are not codes, and actions left with nothing', () => {
    const map = installStorage();
    map.set('maker.bindings.v2', JSON.stringify({
      moveForward: ['KeyK', 42],
      jump: 'Space',        // not an array at all
      crouch: [null, ''],   // nothing in either slot
    }));
    expect(loadBindings()).toEqual({ moveForward: ['KeyK', null] });
  });

  it('reads the pre-slots format, so an upgrade does not reset somebody', () => {
    // Anybody who rebound a key before actions had two slots has this shape in
    // their browser. Dropping it would silently put the defaults back.
    const map = installStorage();
    map.set('maker.bindings.v1', JSON.stringify({
      KeyK: 'moveForward', ArrowUp: 'moveForward', Mouse0: 'placePart',
    }));
    expect(loadBindings()).toEqual({
      moveForward: ['KeyK', 'ArrowUp'],
      placePart: ['Mouse0'],
    });
  });

  it('prefers the current format when both are present', () => {
    const map = installStorage();
    map.set('maker.bindings.v1', JSON.stringify({ KeyK: 'moveForward' }));
    map.set('maker.bindings.v2', JSON.stringify({ moveForward: ['KeyJ', null] }));
    expect(loadBindings()).toEqual({ moveForward: ['KeyJ', null] });
  });

  it('clearing removes both formats, or the old keys come back next launch', () => {
    const map = installStorage();
    map.set('maker.bindings.v1', JSON.stringify({ KeyK: 'moveForward' }));
    saveBindings({ moveForward: ['KeyJ', null] });
    clearBindings();
    expect(loadBindings()).toBeNull();
  });
});
