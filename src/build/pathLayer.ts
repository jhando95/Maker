/**
 * Parts that lay themselves under your run.
 *
 * The aim-and-snap flow is right for careful work and wrong for the thing this
 * game is actually about half the time: *moving*. Building a walkway by aiming
 * at your own feet means walking, stopping, looking down, nudging a ghost,
 * walking again — so paths and bridges got built standing still, and building
 * never felt like part of running a round.
 *
 * Hold the lay key and the selected part is placed along your path as you go:
 * under you first, then cell by cell as you cross into each next one. Two
 * decisions carry the whole feature:
 *
 * **Heading comes from movement, not the camera.** You lay a bridge by backing
 * across the gap while facing the kid with the balloon, which is both the
 * correct game feel and the correct reading of what a body walking backwards
 * is doing. The heading snaps to the grid's four directions, so the path is
 * made of the same axis-aligned parts everything else is.
 *
 * **Height locks when the key goes down.** The first part's underside sits at
 * your feet; every later part in the gesture sits at that exact height,
 * however far you walk — which is precisely what lets you walk off an edge
 * and keep going: the next cell has no ground under it, but it touches the
 * part behind it, and touching is what the support rule asks for. Release and
 * press again to re-lock at wherever you now stand.
 *
 * This module is the pure half: given where the body is and how it moves, it
 * decides *what record to lay next*, and nothing else. Cost, overlap, support
 * and the wire all belong to the same stamp path blueprints go through — a
 * path part is an ordinary placement that chose its own coordinates.
 */

import { MODULE, getPartKind } from './partKit.ts';
import type { PlacementRecord } from './buildSystem.ts';

/** Same quantizer as every placement: 1mm, computed the same way. */
function q(v: number, step = 0.001): number {
  return Math.round(v / step) * step;
}

/**
 * A quarter turn about Y, on the 1e-4 grid every rotation in the game lives
 * on. ±X headings need no turn (a part's long axis is local +X and the shapes
 * are symmetric end to end); ±Z headings need this one.
 */
const QUARTER_Y = { qx: 0, qy: q(Math.SQRT1_2, 1e-4), qz: 0, qw: q(Math.SQRT1_2, 1e-4) };
const NO_TURN = { qx: 0, qy: 0, qz: 0, qw: 1 };

/** Below this ground speed the body is standing, and standing lays nothing. */
export const LAY_MIN_SPEED = 0.6;

/**
 * How far into the next cell the layer reaches, as a fraction of part length.
 *
 * Laying exactly the cell underfoot means the far edge arrives under you at
 * the moment you cross into it — one slow tick and you are over the gap
 * looking down. Reaching most of a cell ahead keeps the next board under your
 * lead foot instead of behind it.
 */
export const LAY_LEAD = 0.45;

export interface LayState {
  /** The underside of every part this gesture lays. */
  lockY: number;
  /** Axis unit vector the path currently runs along: (±1, 0) or (0, ±1). */
  hx: number;
  hz: number;
  /** Cell index along the heading axis of the last cell attempted. */
  cell: number | null;
  /** The fixed cross-axis coordinate of this run, snapped to the grid. */
  lane: number;
}

/** Start a gesture: lock the height to the feet that pressed the key. */
export function beginLay(feetY: number): LayState {
  return { lockY: q(feetY), hx: 1, hz: 0, cell: null, lane: 0 };
}

/**
 * One tick of the gesture. Returns the record to lay now, or null.
 *
 * Mutates `state` (the cell cursor and heading are the gesture), but never
 * looks at the world: whether the record can actually be placed — cost,
 * overlap, support — is the stamp path's answer, and a refusal simply leaves
 * `state.cell` pointing at the refused cell so it is not asked again until
 * the body reaches the next one.
 */
export function layStep(
  state: LayState,
  x: number, z: number,
  vx: number, vz: number,
  kind: number,
  colorway: number,
): PlacementRecord | null {
  const speed = Math.hypot(vx, vz);
  if (speed < LAY_MIN_SPEED) return null;

  // Snap the heading to the dominant axis of actual movement. Re-deciding
  // every tick is what lets a path turn a corner mid-run; re-anchoring the
  // cell cursor on a change is what keeps the corner from double-laying.
  const alongX = Math.abs(vx) >= Math.abs(vz);
  const hx = alongX ? Math.sign(vx) : 0;
  const hz = alongX ? 0 : Math.sign(vz);
  if (hx !== state.hx || hz !== state.hz) {
    state.hx = hx;
    state.hz = hz;
    state.cell = null;
  }

  const part = getPartKind(kind);
  const len = part.length;
  // The lane: where the path sits across its own direction. Snapped to the
  // module so two runs side by side land shoulder to shoulder rather than a
  // random centimetre apart.
  const across = alongX ? z : x;
  const lane = q(Math.round(across / MODULE) * MODULE);
  if (state.cell === null) state.lane = lane;

  // The cell the layer wants: the one under the body's lead edge.
  const along = (alongX ? x : z) * (alongX ? hx : hz);
  const cell = Math.floor(along / len + LAY_LEAD);
  if (cell === state.cell) return null;
  state.cell = cell;

  // Cell index back to world coordinates: centre of that cell on this axis.
  const centre = (cell + 0.5) * len * (alongX ? hx : hz);
  return {
    kind,
    colorway,
    x: q(alongX ? centre : state.lane),
    y: q(state.lockY + part.thickness / 2),
    z: q(alongX ? state.lane : centre),
    ...(alongX ? NO_TURN : QUARTER_Y),
  };
}
