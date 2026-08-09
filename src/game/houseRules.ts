/**
 * House rules: the game's rules as a toy, which is what custom games are.
 *
 * Halo's Forge mattered less for the crates than for the moment the *rules*
 * became something you could bend — low gravity, big launches, and suddenly
 * the same map is four new games. This game already has the seam: MOTION and
 * KNOCKBACK are live multipliers read at the point of use, built for the
 * developer panel. House rules are the player-facing half of that seam —
 * named presets a kid would pick, not sliders an engineer would.
 *
 * A preset applies when a round starts and Classic is restored when it ends,
 * so nothing leaks into the next round or into Shed Day. Solo rounds only for
 * now: a networked round needs the preset on the wire beside the seed (a
 * guest predicting under different gravity corrects on every snapshot), and
 * that is a protocol change this module deliberately does not smuggle in —
 * the menu simply does not offer house rules when a session is live.
 */

import { MOTION, KNOCKBACK } from '../physics/constants.ts';

export interface HouseRules {
  readonly id: string;
  readonly name: string;
  readonly blurb: string;
  readonly gravityScale: number;
  readonly jumpScale: number;
  readonly knockbackScale: number;
}

export const HOUSE_RULES: readonly HouseRules[] = [
  {
    id: 'classic', name: 'Classic', blurb: 'The yard as it is.',
    gravityScale: 1, jumpScale: 1, knockbackScale: 1,
  },
  {
    id: 'moon', name: 'Moon Yard', blurb: 'Half gravity, big lazy jumps.',
    gravityScale: 0.5, jumpScale: 1.15, knockbackScale: 1.3,
  },
  {
    id: 'bouncy', name: 'Bouncy Castle', blurb: 'Everything hits like a pillow fight.',
    gravityScale: 1, jumpScale: 1.25, knockbackScale: 2.2,
  },
  {
    id: 'heavy', name: 'Heavyweight', blurb: 'Fast falls, short hops, hits that stick.',
    gravityScale: 1.5, jumpScale: 0.9, knockbackScale: 0.6,
  },
] as const;

const SHIPPED = {
  gravity: MOTION.gravityScale,
  jump: MOTION.jumpScale,
  knockSpeed: KNOCKBACK.speed,
  knockLift: KNOCKBACK.lift,
};

/** Apply a preset for the round about to start. */
export function applyHouseRules(rules: HouseRules): void {
  MOTION.gravityScale = SHIPPED.gravity * rules.gravityScale;
  MOTION.jumpScale = SHIPPED.jump * rules.jumpScale;
  KNOCKBACK.speed = SHIPPED.knockSpeed * rules.knockbackScale;
  KNOCKBACK.lift = SHIPPED.knockLift * Math.sqrt(rules.knockbackScale);
}

/** Back to the yard as shipped. Called when a round ends, however it ends. */
export function resetHouseRules(): void {
  MOTION.gravityScale = SHIPPED.gravity;
  MOTION.jumpScale = SHIPPED.jump;
  KNOCKBACK.speed = SHIPPED.knockSpeed;
  KNOCKBACK.lift = SHIPPED.knockLift;
}
