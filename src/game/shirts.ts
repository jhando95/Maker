/**
 * What colour somebody is wearing.
 *
 * Its own file because three separate things need the answer and must agree: the
 * character batch paints the shirt, the HUD paints the score in the same two
 * colours, and the local player is drawn by the same code as everyone else. When
 * this lived inside the mode renderer, the HUD had a hand-copied pair of hex
 * values beside it, which is one edit away from a scoreboard that disagrees with
 * the lawn.
 *
 * It answers one question — *given a side, and how wet and how stunned they are,
 * what colour is that person* — which keeps the three callers from each having
 * their own idea of how soaking looks.
 */

import * as THREE from 'three';
import type { Team } from './actor.ts';
import { wetBlend } from './wetness.ts';

/**
 * A dry shirt and the same shirt wringing wet, per side.
 *
 * Two palettes rather than one because the moment your own team existed, one
 * palette meant every kid on the lawn looked identical and the flag game became
 * guesswork — you cannot decide who to throw at if you cannot tell who is who.
 * Violet against the neighbourhood's oranges and greens rather than a second
 * warm colour, and deliberately not the pale blue a stunned kid washes out to,
 * which would make "on your side" and "out of it" the same cue.
 */
export const SHIRTS: Record<Team, { dry: THREE.Color; soaked: THREE.Color }> = {
  left: {
    dry: new THREE.Color().setHex(0x7a3fc8, THREE.SRGBColorSpace),
    soaked: new THREE.Color().setHex(0x321a5c, THREE.SRGBColorSpace),
  },
  right: {
    dry: new THREE.Color().setHex(0xe07a4f, THREE.SRGBColorSpace),
    soaked: new THREE.Color().setHex(0x6b3524, THREE.SRGBColorSpace),
  },
};

/**
 * What being stunned looks like: your own shirt, washed out.
 *
 * Not a colour of its own. A fixed pale blue for "out of it" competed with the
 * blue-violet of a team — a screenshot with one kid from each side in it had
 * them reading as the same thing, and under the toon ramp a mid violet
 * desaturates almost exactly onto that blue. Washing the team colour toward this
 * keeps who someone is while saying they are briefly not a threat, which are two
 * different questions and should not share a channel.
 */
export const STUNNED_WASH = new THREE.Color().setHex(0xd6e2ea, THREE.SRGBColorSpace);
const STUNNED_AMOUNT = 0.72;

/**
 * Write a shirt colour into `out`, so this allocates nothing per character.
 *
 * Returns `out` for the convenience of the caller, which is always inside a
 * per-frame loop over everybody in the world.
 */
export function shirtColor(
  out: THREE.Color, team: Team, wetness = 0, stunned = false,
  own: THREE.Color | null = null,
): THREE.Color {
  const shirt = SHIRTS[team];
  // `own` is what somebody picked in the locker, and it is only ever passed
  // where no side is being told from another — free build, and the yard you
  // stand in while choosing. It still soaks and still washes out when you are
  // out of it, because those two cues are about the round rather than about the
  // shirt, and a chosen colour that ignored them would be a player who cannot
  // be read at all.
  out.copy(own ?? shirt.dry);
  // Darkens as it soaks, which is how the player reads who is nearly finished
  // and picks a target. Toward the team's own soaked tone even for a chosen
  // colour: what the cue has to say is "nearly finished", not "which violet".
  out.lerp(shirt.soaked, wetBlend(wetness));
  if (stunned) out.lerp(STUNNED_WASH, STUNNED_AMOUNT);
  return out;
}
