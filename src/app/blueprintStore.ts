/**
 * Blueprints a player has kept.
 *
 * Deliberately not `BuildStore`, which sits next to it and looks like the same
 * thing. A saved build is a *world* — the whole yard, restored over whatever is
 * there. A blueprint is a *part* — a piece you carry between yards and put down
 * where you like. They have different lifetimes (a build belongs to a session, a
 * blueprint to a player), different sizes by two orders of magnitude, and
 * different failure modes. Merging them would mean one list where half the rows
 * cannot be used the way the other half can.
 *
 * One blob rather than a key each, which is the opposite of `BuildStore` and for
 * a reason: a blueprint is a few dozen parts, the whole set is a few kilobytes,
 * and the picker reads all of them every time it opens. The argument for
 * separate keys — that one corrupt slot must not take the rest — is worth a lot
 * for a 200KB fort and nothing for a list you re-read on every keypress.
 */

import {
  MAX_BLUEPRINTS, MAX_BLUEPRINT_PARTS, builtInBlueprints, cleanBlueprintName,
  type Blueprint,
} from '../build/blueprint.ts';
import type { PlacementRecord } from '../build/buildSystem.ts';

const KEY = 'maker.blueprints.v1';

/**
 * Everything a player can stamp: the built-ins, then their own.
 *
 * Built-ins first and always present. A player who has saved nothing still has
 * something to press the key on, which is the difference between discovering a
 * feature and concluding it is broken.
 */
/**
 * One blueprint, as the picker screen needs to show it.
 *
 * A flattened view rather than the `Blueprint` itself, for the reason the whole
 * menu is written this way: a screen that held the real record would be holding
 * a list of `PlacementRecord`s it has no use for, and `held` is a fact about
 * the game rather than about the blueprint.
 */
export interface BlueprintSlot {
  id: string;
  name: string;
  parts: number;
  /** What stamping it would cost, so the choice can be made before the wood is. */
  wood: number;
  /** Ships with the game: cannot be renamed or deleted. */
  builtIn: boolean;
  /** Currently in hand. */
  held: boolean;
}

export class BlueprintStore {
  private mine: Blueprint[] = [];

  constructor() {
    this.mine = this.read();
  }

  /** Built-ins followed by saved ones, in the order they will be cycled. */
  all(): Blueprint[] {
    return [...builtInBlueprints(), ...this.mine];
  }

  /** Only the ones this player made, for a list that offers deletion. */
  saved(): Blueprint[] {
    return [...this.mine];
  }

  get(id: string): Blueprint | undefined {
    return this.all().find((b) => b.id === id);
  }

  /**
   * Keep one.
   *
   * @returns the stored blueprint, or null with a reason nobody has to guess at.
   *   Refusing silently is the failure this returns a value to avoid: a player
   *   who presses save and sees nothing happen has no way to tell a full list
   *   from a broken feature.
   */
  save(name: string, parts: readonly PlacementRecord[], id?: string): Blueprint | null {
    const clean = cleanBlueprintName(name);
    if (clean === null) return null;
    if (parts.length === 0 || parts.length > MAX_BLUEPRINT_PARTS) return null;

    const existing = id === undefined ? -1 : this.mine.findIndex((b) => b.id === id);
    if (existing === -1 && this.mine.length >= MAX_BLUEPRINTS) return null;

    const blueprint: Blueprint = {
      id: id ?? `bp:${nextId()}`,
      name: clean,
      parts: parts.map((p) => ({ ...p })),
    };
    if (existing === -1) this.mine.push(blueprint);
    else this.mine[existing] = blueprint;

    if (!this.write()) {
      // Put the list back rather than leaving memory and storage disagreeing.
      // A quota error is the common case here and the one where a player would
      // otherwise see a blueprint that vanishes when they reload.
      this.mine = this.read();
      return null;
    }
    return blueprint;
  }

  /** Forget one. Built-ins are not the player's to remove. */
  remove(id: string): boolean {
    const i = this.mine.findIndex((b) => b.id === id);
    if (i === -1) return false;
    this.mine.splice(i, 1);
    this.write();
    return true;
  }

  clear(): void {
    this.mine = [];
    this.write();
  }

  get count(): number {
    return this.mine.length;
  }

  get full(): boolean {
    return this.mine.length >= MAX_BLUEPRINTS;
  }

  private read(): Blueprint[] {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw === null) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      // Validated field by field rather than cast. This is the one input to the
      // game that a player can edit by hand, and a blueprint with a missing
      // `parts` array would throw on the frame somebody pressed the key.
      return parsed.filter(isBlueprint).slice(0, MAX_BLUEPRINTS);
    } catch {
      return [];
    }
  }

  private write(): boolean {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.mine));
      return true;
    } catch {
      return false;
    }
  }
}

function isBlueprint(v: unknown): v is Blueprint {
  if (typeof v !== 'object' || v === null) return false;
  const b = v as Partial<Blueprint>;
  if (typeof b.id !== 'string' || typeof b.name !== 'string') return false;
  if (!Array.isArray(b.parts) || b.parts.length === 0) return false;
  if (b.parts.length > MAX_BLUEPRINT_PARTS) return false;
  return b.parts.every(isRecord);
}

function isRecord(v: unknown): v is PlacementRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Partial<PlacementRecord>;
  for (const k of ['kind', 'colorway', 'x', 'y', 'z', 'qx', 'qy', 'qz', 'qw'] as const) {
    if (typeof r[k] !== 'number' || !Number.isFinite(r[k])) return false;
  }
  return true;
}

/**
 * A short unique-enough id.
 *
 * `crypto.randomUUID` where it exists, because the alternative — a counter — is
 * only unique within one tab, and two tabs saving a blueprint each would end up
 * with two different things claiming the same id in one player's storage.
 */
function nextId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID !== undefined) return c.randomUUID().slice(0, 8);
  // Deliberately Math.random: this is an id, not world state, and the fallback
  // only runs on a browser old enough not to have the good one.
  return Math.random().toString(36).slice(2, 10);
}
