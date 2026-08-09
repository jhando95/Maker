/**
 * Turning a running mode into something a wire can carry.
 *
 * Kept out of both `session.ts` and the modes themselves. The session has no
 * business knowing what a marker is, and a mode has no business knowing a
 * network exists — the whole reason a guest can be in a round at all is that
 * modes publish state and never render, and that stays true only if nothing in
 * `src/game` ever imports `src/net`.
 */

import type { GameMode, Marker } from '../game/gameMode.ts';
import {
  MARKER_FLAG, MARKER_KINDS, type PackedMarker, type PackedRound,
} from './protocol.ts';

function packMarker(m: Marker): PackedMarker {
  const kind = MARKER_KINDS.indexOf(m.kind);
  return [
    kind < 0 ? 0 : kind,
    round(m.x), round(m.y), round(m.z),
    m.color,
    (m.active === true ? MARKER_FLAG.active : 0) | (m.faded === true ? MARKER_FLAG.faded : 0),
  ];
}

/** Two decimals. A marker is a pin on a compass, not a survey point. */
function round(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Describe the round for everybody else.
 *
 * `over` is filled from `summary()` the moment the mode reports itself finished,
 * rather than waiting for the shell's four-second pause before the result
 * screen. The pause is presentation — it exists so the last capture is visible
 * before the game talks about it — and each machine is entitled to run its own.
 * Sending the outcome as soon as it is decided means a guest whose connection
 * hiccups over those four seconds still learns how the round ended.
 */
export function packRound(mode: GameMode | null): PackedRound | null {
  if (mode === null) return null;
  const hud = mode.hud();
  return {
    id: mode.id,
    name: mode.name,
    phase: hud.phase,
    timer: hud.timer === null ? null : Math.round(hud.timer * 10) / 10,
    msg: hud.message,
    pri: hud.primary === null ? null : [hud.primary.label, hud.primary.value],
    sec: hud.secondary === null ? null : [hud.secondary.label, hud.secondary.value],
    score: hud.score === undefined || hud.score === null
      ? null
      : [hud.score.left, hud.score.right],
    build: mode.buildingAllowed,
    wood: mode.lumber === undefined || mode.lumber.unlimited ? null : mode.lumber.available,
    markers: mode.markers().map(packMarker),
    over: mode.finished
      ? {
        won: mode.won,
        headline: mode.summary().headline,
        lines: mode.summary().lines.map((l) => [l.label, l.value] as [string, string]),
      }
      : null,
  };
}
