/**
 * Things you built once, saved, and can put down again.
 *
 * A staircase is nine planks placed one at a time, and placing them one at a
 * time is a thing you do once for fun and twice out of obligation. Every round
 * of Water War starts with the same ninety seconds of rebuilding what you built
 * last round, and that is the part of building this game has never had an answer
 * to — the fort is the point, but re-typing the fort is not.
 *
 * ## What a blueprint is
 *
 * A list of `PlacementRecord`s expressed **relative to an anchor**, which is the
 * same shape the save format and the wire format already use. That is not a
 * coincidence worth glossing over: it means a blueprint needs no new
 * serialization, no new validation, and no new apply path. A stamp is N ordinary
 * placements with the offsets added in.
 *
 * ## The anchor is the bottom, not the middle
 *
 * Centred horizontally, and at the *lowest* point vertically. Stamping should
 * feel like setting the thing down where you are aiming, and a blueprint
 * anchored at its centre floats half of itself into the ground — which reads as
 * the preview being broken rather than as a convention you have not learned.
 *
 * ## Rotation is quarter turns only
 *
 * Everything in this game snaps to a 0.25m module and every part's long axis is
 * local +X. A blueprint free to rotate by arbitrary angles would produce parts
 * off the grid, which is the one thing the whole build system is arranged to
 * prevent. Quarter turns also keep the arithmetic exact — `cos` and `sin` are
 * 0 and ±1 — so a blueprint stamped, saved, reloaded and stamped again lands on
 * exactly the same coordinates rather than drifting a micrometre per rotation.
 */

import { MODULE, STAIR_RUN, getPartKind, worldAabb } from './partKit.ts';
import { costOf } from './lumber.ts';
import type { PlacementRecord } from './buildSystem.ts';

/**
 * Parts in one blueprint.
 *
 * Sized against what this is for rather than what is possible: a staircase is
 * nine, a ladder to a treehouse deck is a dozen, a room is thirty. Past that it
 * stops being a piece you place and becomes a save file, and it is worth being
 * honest that saving a whole fort is a different feature — one about a *world*,
 * where this is about a *part*.
 */
export const MAX_BLUEPRINT_PARTS = 48;

/** How many a player may keep. A picker longer than this is a menu. */
export const MAX_BLUEPRINTS = 12;

export const MAX_BLUEPRINT_NAME = 24;

export interface Blueprint {
  /** Stable across renames, so a hotbar slot keeps pointing at the same thing. */
  readonly id: string;
  readonly name: string;
  /** Relative to the anchor. See the header for where the anchor is. */
  readonly parts: readonly PlacementRecord[];
  /** True for the ones that ship with the game and cannot be deleted. */
  readonly builtIn?: boolean;
}

/** Axis-aligned box, in the shape `CollisionWorld` already hands out. */
export interface Box {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
}

/** Quantized the same way a placement is, so a stamp and a click agree exactly. */
function q(v: number, step = 0.001): number {
  return Math.round(v / step) * step;
}

/**
 * Re-express a set of world-space parts around their own anchor.
 *
 * Measured from the parts' **boxes**, not their centres, and the vertical case
 * is the one that matters. Anchoring on the lowest centre buries half of the
 * lowest part in whatever you set the blueprint down on: a 5cm plank sinks
 * 25mm, which nobody notices, and a 25cm block sinks 125mm, which the placement
 * check refuses outright. Every stamp of the block staircase was rejected for
 * exactly this, six parts at a time, before this used the box.
 *
 * Returns a fresh array; the input is untouched.
 */
export function normalize(parts: readonly PlacementRecord[]): PlacementRecord[] {
  if (parts.length === 0) return [];
  let minX = Infinity; let maxX = -Infinity;
  let minY = Infinity;
  let minZ = Infinity; let maxZ = -Infinity;
  for (const p of parts) {
    const b = worldAabb(p);
    if (b.minX < minX) minX = b.minX;
    if (b.maxX > maxX) maxX = b.maxX;
    if (b.minY < minY) minY = b.minY;
    if (b.minZ < minZ) minZ = b.minZ;
    if (b.maxZ > maxZ) maxZ = b.maxZ;
  }
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  return parts.map((p) => ({
    ...p,
    x: q(p.x - cx),
    y: q(p.y - minY),
    z: q(p.z - cz),
  }));
}

/** cos and sin of n quarter turns, exactly. */
const COS = [1, 0, -1, 0];
const SIN = [0, 1, 0, -1];

/**
 * Turn a blueprint about its own anchor, n quarter turns.
 *
 * A lookup table rather than `Math.cos(n * Math.PI / 2)`, which is 6.1e-17 at a
 * quarter turn rather than zero. **That is a readability choice, not the thing
 * that makes rotation exact** — and the distinction is worth writing down
 * because the first draft of this comment claimed otherwise and a planted bug
 * proved it wrong. Every coordinate goes through `q()` on the way out, the same
 * millimetre quantizer every placement in the game uses, and 6.1e-17 rounds to
 * zero there whichever way it was produced. The exactness comes from the
 * quantizer; the table just means you can read the intent off the page.
 */
export function rotated(parts: readonly PlacementRecord[], turns: number): PlacementRecord[] {
  const n = ((turns % 4) + 4) % 4;
  if (n === 0) return parts.map((p) => ({ ...p }));
  const c = COS[n]!;
  const s = SIN[n]!;
  // Half-angle, for the quaternion. Also exact at quarter turns.
  const hc = Math.cos((n * Math.PI) / 4);
  const hs = Math.sin((n * Math.PI) / 4);
  return parts.map((p) => ({
    kind: p.kind,
    colorway: p.colorway,
    x: q(p.x * c + p.z * s),
    y: p.y,
    z: q(-p.x * s + p.z * c),
    // (0, hs, 0, hc) * p, worked out by hand rather than through a library so
    // this file stays free of the renderer.
    qx: q(hc * p.qx + hs * p.qz, 1e-4),
    qy: q(hc * p.qy + hs * p.qw, 1e-4),
    qz: q(hc * p.qz - hs * p.qx, 1e-4),
    qw: q(hc * p.qw - hs * p.qy, 1e-4),
  }));
}

/** Where every part of a blueprint would go, if it were stamped here. */
export function stampAt(
  parts: readonly PlacementRecord[],
  x: number, y: number, z: number,
  turns = 0,
): PlacementRecord[] {
  return rotated(parts, turns).map((p) => ({
    ...p,
    x: q(p.x + x),
    y: q(p.y + y),
    z: q(p.z + z),
  }));
}

/** What the whole thing costs, in the same units a single part does. */
export function blueprintCost(parts: readonly PlacementRecord[]): number {
  let total = 0;
  for (const p of parts) total += costOf(p.kind);
  return total;
}

/**
 * Everything connected to the part you are looking at.
 *
 * A flood fill through touching boxes, which is the selection gesture this game
 * can afford: no drag, no mode, no second control scheme. Look at your
 * staircase, press the key, and what you get is the staircase — because a
 * staircase is a connected thing and the lawn it stands on is not a part.
 *
 * Boxes are expanded by `slack` before testing, because parts placed flush touch
 * *exactly* and floating-point equality is not a relationship you can build a
 * feature on. 6mm is the same figure `canPlaceAt` shrinks by for the mirror
 * image of this problem.
 *
 * Returns indices rather than records so the caller keeps ownership of its list,
 * and sorted so a capture is the same twice.
 */
export function connectedFrom(
  seed: number,
  boxes: readonly Box[],
  limit = MAX_BLUEPRINT_PARTS,
  slack = 0.006,
): number[] {
  if (seed < 0 || seed >= boxes.length) return [];
  const found = new Set<number>([seed]);
  const queue = [seed];
  while (queue.length > 0 && found.size < limit) {
    const here = boxes[queue.shift()!]!;
    for (let i = 0; i < boxes.length; i++) {
      if (found.has(i)) continue;
      if (!touching(here, boxes[i]!, slack)) continue;
      found.add(i);
      queue.push(i);
      if (found.size >= limit) break;
    }
  }
  return [...found].sort((a, b) => a - b);
}

function touching(a: Box, b: Box, slack: number): boolean {
  return a.minX - slack <= b.maxX && a.maxX + slack >= b.minX
    && a.minY - slack <= b.maxY && a.maxY + slack >= b.minY
    && a.minZ - slack <= b.maxZ && a.maxZ + slack >= b.minZ;
}
/**
 * Trim and cap a name somebody typed. Null when there is nothing left.
 *
 * Filtered by codepoint rather than by a regex over a literal, and the reason
 * is not hypothetical: the first version of this line was a character class
 * written to cover the control range, which meant typing control characters
 * into the source. The file became binary as far as grep was concerned, an
 * automated edit to it silently matched nothing, and the test that caught it
 * had a raw BEL in its own string literal doing the same thing. Two mistakes,
 * one cause, and this is the shape that cannot make it.
 */
export function cleanBlueprintName(raw: string): string | null {
  let out = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    // Tab, newline and carriage return become a space; everything else in the
    // control ranges goes. Deleting them all welds words together.
    if (code === 9 || code === 10 || code === 13) {
      out += ' ';
      continue;
    }
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue;
    out += ch;
  }
  out = out.replace(/\s+/g, ' ').trim();
  if (out.length === 0) return null;
  return out.slice(0, MAX_BLUEPRINT_NAME);
}

// ── The ones that ship with the game ────────────────────────────────────────
//
// Generated from the module rather than authored as coordinate lists, and that
// is the whole reason they can be trusted. `partKit.ts` opens by saying the
// 0.25m module "is simultaneously the stair rise, the ladder rung pitch, and the
// placement grid" — so a staircase built from `MODULE` and `STAIR_RUN` is
// correct by construction, and stays correct if either number ever moves. A
// hand-typed list of nine positions would be nine numbers that silently stop
// matching the grid.

const FLAT = { qx: 0, qy: 0, qz: 0, qw: 1 };
/** A quarter turn about Z: takes a part's long axis from +X to +Y. */
const ON_END = { qx: 0, qy: 0, qz: -Math.SQRT1_2, qw: Math.SQRT1_2 };

/**
 * Steps in the staircase, and the height of the ladder in modules.
 *
 * Small on purpose. Both of these have to fit inside `MAX_BLUEPRINT_PARTS`
 * *with* the parts that make them solid, and a staircase you can see through is
 * not a staircase — see below.
 */
export const STEPS = 5;

/**
 * A staircase that holds together.
 *
 * The obvious version is one plank per tread, 0.25 up and 0.5 along, and it is
 * wrong in a way that only shows up when you try to pick it up again: treads
 * five centimetres thick with twenty centimetres of air between them are not
 * *connected*, so the flood fill that saves a structure correctly returns one
 * plank. It also looks like a floating staircase, because it is one.
 *
 * Blocks instead, two per step along the run and three across the width, which
 * fills the profile: 0.25 of rise and 0.5 of run per step is the same 27
 * degrees `partKit.ts` calls comfortable, each step shares an edge with the
 * next, and the whole thing is solid underfoot at 0.75m wide — comfortably more
 * than a kid's 0.64m capsule.
 */
function staircase(): PlacementRecord[] {
  const parts: PlacementRecord[] = [];
  for (let step = 0; step < STEPS; step++) {
    for (let along = 0; along < 2; along++) {
      for (let across = 0; across < 3; across++) {
        parts.push({
          kind: 7, colorway: 0, ...FLAT,
          x: q((across - 1) * MODULE),
          y: q(step * MODULE + MODULE / 2),
          z: q(step * STAIR_RUN + along * MODULE + MODULE / 2),
        });
      }
    }
  }
  return normalize(parts);
}

/**
 * Two rails and a set of rungs.
 *
 * Rungs every module, which is the pitch `partKit.ts` names and is well inside
 * `STEP_HEIGHT` — so this is climbed by walking into it rather than by any
 * ladder mechanic, which is the whole point that file makes about the module
 * doing three jobs at once.
 *
 * The rails sit at x = ±0.3 and the rungs span ±0.25, so a rung's end lands
 * exactly on a rail's inner face. That is not decoration: a centimetre further
 * out and every rung overlaps a rail, which `canPlaceAt` refuses — the ladder
 * would be a blueprint that can never be stamped anywhere.
 */
function ladder(): PlacementRecord[] {
  const parts: PlacementRecord[] = [];
  const rungs = STEPS * 2 + 1;
  const height = (rungs + 1) * MODULE;
  // Posts are 1.5 long, stood on end and stacked to cover the height.
  const stack = Math.ceil(height / 1.5);
  for (const side of [-0.3, 0.3]) {
    for (let i = 0; i < stack; i++) {
      parts.push({
        kind: 4, colorway: 0, ...ON_END,
        x: q(side), y: q(i * 1.5 + 0.75), z: 0,
      });
    }
  }
  for (let i = 1; i <= rungs; i++) {
    parts.push({ kind: 2, colorway: 0, ...FLAT, x: 0, y: q(i * MODULE), z: 0 });
  }
  return normalize(parts);
}

/**
 * A wall you can put between yourself and a hose.
 *
 * Panels are 1m square and five centimetres thick, stood on end so the flat
 * face is what a balloon meets. Laid out along Z and stacked in Y — *not*
 * spaced along X, which was the first version and produced three separate
 * sheets a metre apart with a person-sized gap between each: a wall that stops
 * nothing, is not connected, and looks like a mistake.
 */
function wall(): PlacementRecord[] {
  const parts: PlacementRecord[] = [];
  for (let col = 0; col < 3; col++) {
    for (let row = 0; row < 2; row++) {
      parts.push({
        kind: 5, colorway: 0, ...ON_END,
        x: 0,
        y: q(0.5 + row * 1.0),
        z: q((col - 1) * 1.0),
      });
    }
  }
  return normalize(parts);
}

/**
 * The blueprints every player starts with.
 *
 * Three, and no more. A player's first thought on seeing this feature should be
 * "I could save my fort", not "which of these twelve do I want" — the built-ins
 * exist to show what a blueprint *is*, and a long list of them would answer a
 * question nobody asked and crowd out the ones somebody actually made.
 */
export function builtInBlueprints(): Blueprint[] {
  return [
    { id: 'built:stairs', name: 'Stairs', parts: staircase(), builtIn: true },
    { id: 'built:ladder', name: 'Ladder', parts: ladder(), builtIn: true },
    { id: 'built:wall', name: 'Wall', parts: wall(), builtIn: true },
  ];
}

/** Height and footprint, for the picker and for placing the ghost. */
export function blueprintExtent(parts: readonly PlacementRecord[]): {
  width: number; height: number; depth: number;
} {
  if (parts.length === 0) return { width: 0, height: 0, depth: 0 };
  let minX = Infinity; let maxX = -Infinity;
  let minY = Infinity; let maxY = -Infinity;
  let minZ = Infinity; let maxZ = -Infinity;
  for (const p of parts) {
    const k = getPartKind(p.kind);
    // The long axis is local +X, but a rotated part swaps which world axis that
    // is. A conservative sphere of the part's own diagonal is enough for a
    // picker label and avoids re-deriving the oriented box here.
    const r = Math.hypot(k.length, k.thickness, k.width) / 2;
    minX = Math.min(minX, p.x - r); maxX = Math.max(maxX, p.x + r);
    minY = Math.min(minY, p.y - r); maxY = Math.max(maxY, p.y + r);
    minZ = Math.min(minZ, p.z - r); maxZ = Math.max(maxZ, p.z + r);
  }
  return { width: maxX - minX, height: maxY - minY, depth: maxZ - minZ };
}
