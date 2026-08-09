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
 * Alone, the picked preset applies when a round or Shed Day starts. In a
 * session, the preset is the *host's*, session-wide: it rides the welcome by
 * id, a guest applies it before their first predicted tick, and it outlives
 * any round the host starts or ends — leaving the session is what restores
 * the yard as shipped. The id travels rather than the multipliers, because
 * both ends of a version-matched session hold this same table, and numbers on
 * the wire would let a bent host send physics no preset names.
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

/**
 * The preset with this id, or Classic for one this build has never heard of.
 *
 * The fallback is for defence, not for use: version-matched peers hold the
 * same table, so an unknown id cannot arrive from a well-behaved host. But the
 * id still crosses a wire, and a guest that threw on a strange string would be
 * a guest anybody could disconnect with one hand-typed message.
 */
export function houseRuleById(id: string): HouseRules {
  return HOUSE_RULES.find((r) => r.id === id) ?? HOUSE_RULES[0]!;
}

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
