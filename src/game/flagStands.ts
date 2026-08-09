/**
 * Where the flags play from: the stands players planted, if they planted any.
 *
 * This is the piece that makes Shed Day's markers *meet* the modes. A flag
 * stand is an ordinary part — placed, supported, blueprinted and networked by
 * machinery that has no idea it matters — and this scan is the one place that
 * knows it does. Capture the Flag calls it once, at round start, and plays
 * from whatever it finds; a yard with no stands plays from the map's own
 * bases, exactly as it always has.
 *
 * Which side a stand claims is its paint. Painted blue it is the left team's
 * base, painted red the right's — the same two colorways the mode has always
 * drawn its base markers in, so the rule is learnable by looking at the round
 * you just played. Any other colorway is decoration and claims nothing.
 *
 * When a side has several, the *last one placed* wins. Placement order is the
 * part id, which the host allocates — so two machines cannot disagree about
 * which stand counts, and re-planting your flag somewhere better is one
 * action rather than find-and-demolish-the-old-one.
 */

import type { BuildSystem } from '../build/buildSystem.ts';
import {
  FLAG_POLE_KIND, LEFT_STAND_COLORWAY, RIGHT_STAND_COLORWAY, worldAabb,
} from '../build/partKit.ts';

/** A base a flag plays from. `y` is the ground the stand actually sits on. */
export interface StandHome {
  x: number;
  y: number;
  z: number;
}

export interface FlagStands {
  left: StandHome | null;
  right: StandHome | null;
}

/**
 * The claimed stands, read out of the placed world.
 *
 * The home is the *foot* of the pole rather than its centre — a stand on a
 * tower puts the base on the tower's deck, which is where the capture radius
 * and the flag both belong. Read from the part's world bounds so a pole
 * planted leaning still grounds its flag at its lowest point.
 */
export function flagStands(build: BuildSystem): FlagStands {
  let left: { id: number; home: StandHome } | null = null;
  let right: { id: number; home: StandHome } | null = null;

  for (const [id, record] of build.serializeWithIds()) {
    if (record.kind !== FLAG_POLE_KIND) continue;
    const claims =
      record.colorway === LEFT_STAND_COLORWAY ? 'left'
        : record.colorway === RIGHT_STAND_COLORWAY ? 'right'
          : null;
    if (claims === null) continue;

    const home = { x: record.x, y: worldAabb(record).minY, z: record.z };
    if (claims === 'left') {
      if (left === null || id > left.id) left = { id, home };
    } else if (right === null || id > right.id) {
      right = { id, home };
    }
  }

  return { left: left?.home ?? null, right: right?.home ?? null };
}
