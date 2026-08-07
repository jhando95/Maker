/**
 * What you look like, and the outfits you kept.
 *
 * Two things in one file because they are two views of one record: the outfit
 * you are wearing right now, and up to a dozen you saved and can put back on.
 * Splitting them would mean two keys that have to agree about the shape of an
 * `Appearance`, and the first schema change would break exactly one of them.
 *
 * One blob rather than a key per preset, unlike `buildStore` — and for the
 * opposite reason. A saved fort is a few hundred kilobytes and a corrupt one
 * must not take the others with it; an outfit is about two hundred bytes, so
 * the whole locker is smaller than a single build slot and reading all of it to
 * read one costs nothing.
 *
 * Everything that comes back out has been through `clampAppearance`, which is
 * the only door into this type. A blob in localStorage is editable by hand and
 * was written by a version of the game the player may no longer be running, so
 * it is untrusted in exactly the way a message off a socket is.
 */

import {
  clampAppearance, copyAppearance, defaultAppearance, type Appearance,
} from '../game/appearance.ts';

const KEY = 'maker.locker.v1';

export const MAX_PRESETS = 12;
export const MAX_PRESET_NAME = 18;

export interface Preset {
  name: string;
  appearance: Appearance;
}

interface Stored {
  worn: Appearance | null;
  presets: Preset[];
}

/**
 * Clean a name the way blueprints do, and for the same reason.
 *
 * Filtered by codepoint rather than by a regular expression over literal
 * characters: writing a class like `[\x00-\x1f]` means putting control
 * characters in the source, which makes the file binary to `grep` and silently
 * defeats an automated edit. That mistake has been made twice on this project
 * already.
 */
export function cleanPresetName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let out = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) continue;
    out += ch;
    if (out.length >= MAX_PRESET_NAME) break;
  }
  out = out.trim();
  return out.length > 0 ? out : null;
}

export class LockerStore {
  private data: Stored = { worn: null, presets: [] };

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw === null) return;
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return;
      const blob = parsed as Partial<Stored>;
      this.data.worn = blob.worn === null || blob.worn === undefined
        ? null : clampAppearance(blob.worn);
      this.data.presets = Array.isArray(blob.presets)
        ? blob.presets
          .map((p): Preset | null => {
            const name = cleanPresetName((p as Preset | undefined)?.name);
            if (name === null) return null;
            return { name, appearance: clampAppearance((p as Preset).appearance) };
          })
          .filter((p): p is Preset => p !== null)
          .slice(0, MAX_PRESETS)
        : [];
    } catch {
      // Private browsing, a quota error, or malformed JSON. Nobody has ever
      // customised anything, which is a perfectly good state to be in.
      this.data = { worn: null, presets: [] };
    }
  }

  private persist(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      // Storage unavailable; the outfit lasts this session and no longer.
    }
  }

  /**
   * What to wear, or null if nobody has chosen.
   *
   * Null rather than a default, and the distinction is load-bearing: a player
   * who has never opened the locker should look like the seeded kid their id
   * produces, which varies. Handing back a fixed default here would make every
   * first-time player identical.
   */
  worn(): Appearance | null {
    return this.data.worn === null ? null : copyAppearance(this.data.worn);
  }

  /** Wear this. Copied on the way in, so the caller can keep editing theirs. */
  wear(appearance: Appearance): Appearance {
    this.data.worn = clampAppearance(appearance);
    this.persist();
    return copyAppearance(this.data.worn);
  }

  /** Back to the seeded look for an id — the "I have not chosen" state. */
  undress(): void {
    this.data.worn = null;
    this.persist();
  }

  /** Somewhere to start from when the locker is opened for the first time. */
  startingPoint(id: number): Appearance {
    return this.worn() ?? defaultAppearance(id);
  }

  list(): Preset[] {
    return this.data.presets.map((p) => ({ name: p.name, appearance: copyAppearance(p.appearance) }));
  }

  get count(): number {
    return this.data.presets.length;
  }

  /**
   * Keep an outfit under a name.
   *
   * A name that is already taken is overwritten rather than duplicated, because
   * two rows reading "Stripes" is a list nobody can use — and because
   * overwriting is what somebody typing the same name again meant.
   *
   * @returns false when the name is unusable or the locker is full.
   */
  keep(rawName: string, appearance: Appearance): boolean {
    const name = cleanPresetName(rawName);
    if (name === null) return false;
    const existing = this.data.presets.findIndex((p) => p.name === name);
    const entry: Preset = { name, appearance: clampAppearance(appearance) };
    if (existing >= 0) this.data.presets[existing] = entry;
    else if (this.data.presets.length >= MAX_PRESETS) return false;
    else this.data.presets.unshift(entry);
    this.persist();
    return true;
  }

  get(name: string): Appearance | null {
    const found = this.data.presets.find((p) => p.name === name);
    return found === undefined ? null : copyAppearance(found.appearance);
  }

  remove(name: string): boolean {
    const before = this.data.presets.length;
    this.data.presets = this.data.presets.filter((p) => p.name !== name);
    if (this.data.presets.length === before) return false;
    this.persist();
    return true;
  }
}
