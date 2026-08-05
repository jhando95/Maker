/**
 * Saved builds.
 *
 * The build system already serializes the world to plain `PlacementRecord`s —
 * the same shape a server would replicate — so a save slot is that array plus a
 * name and a timestamp. Nothing here knows what a part is.
 *
 * Slots live in localStorage, one key each rather than one blob. A single blob
 * means loading any slot deserializes all of them, and one corrupt slot takes
 * the rest with it.
 */

import type { PlacementRecord } from '../build/buildSystem.ts';

const PREFIX = 'maker.build.v1.';
const INDEX_KEY = 'maker.builds.v1.index';

/** localStorage is small; a fort of a few thousand parts is already ~200KB. */
export const MAX_PARTS_PER_SAVE = 8000;
export const MAX_SLOTS = 12;

export interface BuildSlot {
  id: string;
  name: string;
  /** Epoch milliseconds. */
  savedAt: number;
  partCount: number;
}

export interface SavedBuild extends BuildSlot {
  parts: PlacementRecord[];
}

export class BuildStore {
  /** Slot metadata, newest first. */
  list(): BuildSlot[] {
    try {
      const raw = localStorage.getItem(INDEX_KEY);
      if (raw === null) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((s): s is BuildSlot =>
          typeof s === 'object' && s !== null &&
          typeof (s as BuildSlot).id === 'string' &&
          typeof (s as BuildSlot).name === 'string')
        .sort((a, b) => b.savedAt - a.savedAt);
    } catch {
      return [];
    }
  }

  /**
   * Write a build.
   *
   * @returns the slot, or null if it could not be stored. Quota errors are the
   *   common case and must not throw into the game loop.
   */
  save(name: string, parts: PlacementRecord[], now: number): BuildSlot | null {
    if (parts.length > MAX_PARTS_PER_SAVE) return null;

    const slot: BuildSlot = {
      // Timestamp plus a counter rather than a random id: ids must be stable
      // and ordered, and simulation-adjacent code has no business calling
      // Math.random.
      id: `${now.toString(36)}-${this.list().length}`,
      name: name.slice(0, 40) || 'Untitled',
      savedAt: now,
      partCount: parts.length,
    };

    try {
      localStorage.setItem(PREFIX + slot.id, JSON.stringify(parts));
    } catch {
      return null;
    }

    const index = this.list();
    index.unshift(slot);
    // Oldest slots fall off the end rather than filling the quota silently.
    const trimmed = index.slice(0, MAX_SLOTS);
    for (const dropped of index.slice(MAX_SLOTS)) {
      try {
        localStorage.removeItem(PREFIX + dropped.id);
      } catch {
        /* nothing useful to do */
      }
    }

    try {
      localStorage.setItem(INDEX_KEY, JSON.stringify(trimmed));
    } catch {
      return null;
    }
    return slot;
  }

  load(id: string): PlacementRecord[] | null {
    try {
      const raw = localStorage.getItem(PREFIX + id);
      if (raw === null) return null;
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return null;

      // Validate before handing these to the world. A hand-edited or truncated
      // blob must be rejected here, not discovered as a NaN transform three
      // frames into the round.
      const out: PlacementRecord[] = [];
      for (const item of parsed) {
        if (typeof item !== 'object' || item === null) return null;
        const r = item as Record<string, unknown>;
        const keys = ['kind', 'colorway', 'x', 'y', 'z', 'qx', 'qy', 'qz', 'qw'] as const;
        for (const k of keys) {
          if (typeof r[k] !== 'number' || !Number.isFinite(r[k])) return null;
        }
        out.push(item as PlacementRecord);
      }
      return out;
    } catch {
      return null;
    }
  }

  remove(id: string): void {
    try {
      localStorage.removeItem(PREFIX + id);
      localStorage.setItem(INDEX_KEY, JSON.stringify(this.list().filter((s) => s.id !== id)));
    } catch {
      /* nothing useful to do */
    }
  }
}
