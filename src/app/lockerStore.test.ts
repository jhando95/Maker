/**
 * The locker's storage.
 *
 * Two things are worth checking here and they are not the obvious ones. The
 * round-trip is easy and would pass with no validation at all; what matters is
 * that a blob somebody edited by hand, or that an older build wrote, comes back
 * as something the renderer can draw — and that nothing handed out shares a
 * reference with anything kept, because a preset that edits itself when you
 * change your current outfit is a bug you only notice a session later.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LockerStore, MAX_PRESETS, MAX_PRESET_NAME, cleanPresetName } from './lockerStore.ts';
import { clampAppearance, defaultAppearance, headScaleOf, HEAD_MAX } from '../game/appearance.ts';

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

describe('cleanPresetName', () => {
  it('takes a name and gives it back', () => {
    expect(cleanPresetName('  Stripes ')).toBe('Stripes');
  });

  it('refuses nothing, and refuses whitespace, which is nothing', () => {
    expect(cleanPresetName('')).toBeNull();
    expect(cleanPresetName('   ')).toBeNull();
    expect(cleanPresetName(42)).toBeNull();
    expect(cleanPresetName(null)).toBeNull();
  });

  it('strips control characters rather than drawing them', () => {
    // Filtered by codepoint rather than by a character class containing literal
    // control characters — writing one of those makes the file binary to `grep`
    // and silently defeats an automated edit, which this project has done twice.
    expect(cleanPresetName('Str\u0007ipes\u001b')).toBe('Stripes');
  });

  it('will not let a name run off the end of a row', () => {
    expect(cleanPresetName('x'.repeat(80))!.length).toBe(MAX_PRESET_NAME);
  });
});

describe('LockerStore', () => {
  beforeEach(() => installStorage());

  it('starts with nobody having chosen anything', () => {
    // Null rather than a default, and the distinction is load-bearing: a player
    // who has never opened the locker looks like the seeded kid their id
    // produces, which varies. A fixed default here would make every first-time
    // player identical.
    const store = new LockerStore();
    expect(store.worn()).toBeNull();
    expect(store.list()).toEqual([]);
  });

  it('remembers what you put on, across a reload', () => {
    const store = new LockerStore();
    const outfit = clampAppearance({ ...defaultAppearance(3), skin: 4, hairStyle: 5 });
    store.wear(outfit);
    const reopened = new LockerStore();
    expect(reopened.worn()).toEqual(outfit);
  });

  it('forgets on demand, back to the seeded look', () => {
    const store = new LockerStore();
    store.wear(defaultAppearance(3));
    store.undress();
    expect(store.worn()).toBeNull();
    expect(new LockerStore().worn()).toBeNull();
  });

  it('keeps outfits by name and puts them back', () => {
    const store = new LockerStore();
    const a = clampAppearance({ ...defaultAppearance(1), skin: 0 });
    const b = clampAppearance({ ...defaultAppearance(1), skin: 4 });
    expect(store.keep('Pale', a)).toBe(true);
    expect(store.keep('Deep', b)).toBe(true);
    expect(store.get('Pale')).toEqual(a);
    expect(store.get('Deep')).toEqual(b);
    expect(store.get('Nothing')).toBeNull();
  });

  it('overwrites a name rather than listing it twice', () => {
    // Two rows reading "Stripes" is a list nobody can use, and overwriting is
    // what somebody typing the same name again meant.
    const store = new LockerStore();
    store.keep('Kit', clampAppearance({ skin: 0 }));
    store.keep('Kit', clampAppearance({ skin: 3 }));
    expect(store.count).toBe(1);
    expect(store.get('Kit')!.skin).toBe(3);
  });

  it('says no when the locker is full rather than dropping the oldest', () => {
    const store = new LockerStore();
    for (let i = 0; i < MAX_PRESETS; i++) {
      expect(store.keep(`kit ${i}`, defaultAppearance(i))).toBe(true);
    }
    expect(store.keep('one too many', defaultAppearance(99))).toBe(false);
    expect(store.count).toBe(MAX_PRESETS);
    // But a name already in there still works, because that is a replacement
    // and not a new row.
    expect(store.keep('kit 0', defaultAppearance(50))).toBe(true);
  });

  it('refuses a name it cannot use', () => {
    const store = new LockerStore();
    expect(store.keep('   ', defaultAppearance(1))).toBe(false);
    expect(store.count).toBe(0);
  });

  it('removes one, and says whether there was one', () => {
    const store = new LockerStore();
    store.keep('Kit', defaultAppearance(1));
    expect(store.remove('Kit')).toBe(true);
    expect(store.remove('Kit')).toBe(false);
    expect(store.list()).toEqual([]);
  });

  it('never hands out a reference into what it is holding', () => {
    // A preset that changes when you edit your current outfit is a bug that
    // only shows up a session later, when somebody puts one back on and it is
    // not what they saved.
    const store = new LockerStore();
    const outfit = defaultAppearance(1);
    store.keep('Kit', outfit);
    outfit.skin = 4;
    expect(store.get('Kit')!.skin).not.toBe(4);

    const taken = store.get('Kit')!;
    taken.marks.chest.shape = 9;
    expect(store.get('Kit')!.marks.chest.shape).toBe(0);

    const worn = store.wear(defaultAppearance(2));
    worn.headSize = 1;
    expect(store.worn()!.headSize).not.toBe(1);
  });

  it('clamps everything it hands back, however the blob got there', () => {
    // localStorage is a file on somebody's disk. This is the same rule the wire
    // follows, and for the same reason: a head four times the size does not
    // throw, it just makes a bigger target that everybody else has to look at.
    const map = installStorage();
    map.set('maker.locker.v1', JSON.stringify({
      worn: { headSize: 900, build: -900, skin: 99 },
      presets: [{ name: 'Giant', appearance: { headSize: 1e9 } }],
    }));
    const store = new LockerStore();
    expect(headScaleOf(store.worn()!)).toBeLessThanOrEqual(HEAD_MAX);
    expect(headScaleOf(store.get('Giant')!)).toBeLessThanOrEqual(HEAD_MAX);
  });

  it('survives a blob that is not what it expects', () => {
    for (const junk of ['not json', '[]', '7', '{"presets":"lots"}', 'null']) {
      const map = installStorage();
      map.set('maker.locker.v1', junk);
      const store = new LockerStore();
      expect(store.worn()).toBeNull();
      expect(store.list()).toEqual([]);
    }
  });

  it('drops a preset with no usable name instead of listing a blank row', () => {
    const map = installStorage();
    map.set('maker.locker.v1', JSON.stringify({
      worn: null,
      presets: [
        { name: '', appearance: {} },
        { name: 'Real', appearance: {} },
        { appearance: {} },
      ],
    }));
    expect(new LockerStore().list().map((p) => p.name)).toEqual(['Real']);
  });

  it('will not read back more presets than it would let you save', () => {
    const map = installStorage();
    map.set('maker.locker.v1', JSON.stringify({
      worn: null,
      presets: Array.from({ length: 40 }, (_, i) => ({ name: `kit ${i}`, appearance: {} })),
    }));
    expect(new LockerStore().count).toBe(MAX_PRESETS);
  });

  it('starts the locker from the seeded kid when nobody has chosen', () => {
    const store = new LockerStore();
    expect(store.startingPoint(7)).toEqual(defaultAppearance(7));
    const chosen = clampAppearance({ skin: 2, hairStyle: 3 });
    store.wear(chosen);
    expect(store.startingPoint(7)).toEqual(chosen);
  });
});
