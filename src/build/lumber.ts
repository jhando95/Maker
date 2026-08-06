/**
 * How much wood you have.
 *
 * Building was free and unlimited, which sounds harmless and quietly removes
 * every decision from the part of the game it is named after. With no cost, the
 * best play is always to build the maximum everywhere, and the only thing that
 * separates two players is how fast they can click during the build phase.
 *
 * The measurement that made this concrete, taken on the real map with the
 * player standing still for the whole afternoon so the only variable is what
 * was built:
 *
 *   nothing built                                 keeps   0% of the water
 *   a tight fence round all three taps (80)       keeps  61%
 *   the same fence one plank short of closing (60) keeps   8%
 *   one tap walled properly, head height (78)     keeps  20%
 *   a loose fence round all three (510)           keeps  22%
 *
 * Two things fall out of that. Building is worth doing — nothing to sixty-one
 * per cent is the difference between losing and winning. And more wood is not
 * better wood: the five-hundred-plank version does worse than the eighty-plank
 * one, because what stops a kid is a closed ring near the tap and not a big
 * wall somewhere near it. With free lumber neither of those is a decision. You
 * build the maximum everywhere, and the only thing separating two players is
 * how fast they can click during the build phase.
 *
 * ## Why a stack rather than a resource to harvest
 *
 * Harvesting is a different game. These are forty-five to seventy second build
 * phases; spending twenty of them chopping means less building, and gathering
 * is not the fun part. In a multiplayer match it also rewards whoever spends
 * the most time *not* playing the party game. A stack of lumber costs one
 * number, needs no new verbs, and is fair by construction: both sides get the
 * same pile, so the round is decided by how you built rather than by who
 * farmed.
 *
 * ## Taking something down gives the wood back
 *
 * In full. Remodelling has to be free or the game punishes iterating, which is
 * the entire pleasure of building — a player who is frightened of wasting a
 * plank stops experimenting. Scarcity should make you choose *what* to build,
 * never make you afraid to change your mind.
 */

import { PART_KINDS, MODULE, BOARD_THICKNESS, type PartKind } from './partKit.ts';

/**
 * What one plank costs. Everything else is priced against it.
 *
 * Integers rather than a continuous volume, because a counter that ticks down
 * by 2.4 is a counter nobody can plan against.
 */
export const PLANK_COST = 1;

/**
 * Price by volume, against a plank.
 *
 * By size rather than by a hand-written table, so a part added later is priced
 * automatically and cannot be accidentally free. The property that matters is
 * that two ways of covering the same wall cost the same: four planks laid side
 * by side span a metre and cost four, and the one-metre panel that replaces them
 * also costs four. A budget that made one of those cheaper would not be asking
 * the player what to build, only which part to spam.
 *
 * A wedge is charged for half the box it occupies, because half of it is air.
 * That does not make ramps cheap — the ramp is the most expensive part in the
 * kit at five, and a plank ladder up the same two metres costs about seven for
 * a run you can only climb slowly. What it buys is that you can sprint up it and
 * hide behind it. The kit's answer to "how do I get up there" is deliberately a
 * choice between a cheap slow way and an expensive fast one.
 *
 * The floor of one is what stops offcuts being free. It does mean a short plank
 * costs the same as a full one, so the short plank is for fitting a gap rather
 * than for saving wood.
 */
export function partCost(kind: PartKind): number {
  const plank = 1.0 * BOARD_THICKNESS * MODULE;
  const volume = kind.length * kind.thickness * kind.width * (kind.isWedge ? 0.5 : 1);
  return Math.max(1, Math.round(volume / plank));
}

/** Costs for the whole kit, computed once. */
export const PART_COSTS: readonly number[] = PART_KINDS.map(partCost);

export function costOf(kindIndex: number): number {
  return PART_COSTS[kindIndex] ?? PLANK_COST;
}

/**
 * The pile in the corner of the yard.
 *
 * `Infinity` is a legitimate stock and means Free Build: the sandbox is where
 * you go to just make things, and metering it there would be pure loss with
 * nothing bought.
 */
export class Lumber {
  private stock: number;

  constructor(initial: number) {
    this.stock = initial;
  }

  get available(): number {
    return this.stock;
  }

  get unlimited(): boolean {
    return this.stock === Infinity;
  }

  canAfford(cost: number): boolean {
    return this.stock >= cost;
  }

  /** Take the wood. Returns false and changes nothing if there is not enough. */
  spend(cost: number): boolean {
    if (!this.canAfford(cost)) return false;
    this.stock -= cost;
    return true;
  }

  /** Give it back, for a part taken down. */
  refund(cost: number): void {
    if (this.stock === Infinity) return;
    this.stock += cost;
  }

  /**
   * A delivery at the start of a build phase.
   *
   * Capped, so a player who spent nothing all round cannot bank five phases of
   * lumber and then build a fort no budget was ever meant to allow.
   */
  deliver(amount: number, cap: number): void {
    if (this.stock === Infinity) return;
    this.stock = Math.min(cap, this.stock + amount);
  }

  set(amount: number): void {
    this.stock = amount;
  }
}

/**
 * Starting pile, and what arrives before each later build phase.
 *
 * Sized against the measurement above. A hundred and twenty is a little over
 * what it takes to fence all three taps thinly, and a little over half of what
 * it takes to wall two of them to head height — so the opening build phase is
 * spent choosing between covering everything badly and covering something
 * properly, which is the question the mode is made of. In general terms it is
 * thirty square metres of wall: near enough four walls of a small fort, which
 * is what makes it feel like a pile of wood rather than a currency.
 *
 * The top-up is deliberately much smaller. A repair phase should be enough to
 * patch what broke, not enough to rebuild somewhere else — otherwise every
 * phase resets the decision and none of them matter.
 */
export const STARTING_LUMBER = 120;
export const PHASE_DELIVERY = 35;
/** Nobody carries more than this, however frugal they were. */
export const LUMBER_CAP = 180;
