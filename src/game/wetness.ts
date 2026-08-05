/**
 * How wet everybody is.
 *
 * The game used to be one-hit: a balloon either took you out or did nothing, so
 * every exchange was a coin toss and the only tactic was to throw first. A meter
 * makes chip damage worth something, makes finishing someone a decision, and
 * gives breaking off a purpose.
 *
 * Three rules do the work, and each exists because the obvious version of it
 * fails:
 *
 * - **Wet clothes soak faster.** Incoming wetness scales up with how wet you
 *   already are. The obvious alternative — wet legs move slower — is decorative
 *   here, because sprint is 7.4m/s and free while the fastest bot is 4.4, so a
 *   soaked player still outruns everything. Worse, it taxes you at the moment
 *   you are already losing, and the tax is a longer walk. Scaling *intake*
 *   resolves a fight instead of dragging it out.
 *
 * - **Drying is fast, once it starts.** A short grace and then a quick decay, so
 *   a broken engagement resets cleanly. Slow decay sounds more punishing and is
 *   actually just bookkeeping: with five attackers you never get the ten
 *   uninterrupted seconds it would need, so it stops being a mechanic and
 *   becomes a number that is always near 1.
 *
 * - **There is a cap on how fast you can be soaked.** Wetness is additive and
 *   the player is always outnumbered, so without a cap five kids are five times
 *   as lethal as one and the player is deleted in under two seconds of exposure.
 *   The cap is what makes being outnumbered hard rather than instant.
 */

/** Fully soaked. */
export const SOAKED = 1;

/** Seconds of not being hit before drying starts. */
export const DRY_GRACE = 1.2;
/** Wetness shed per second once drying. */
export const DRY_RATE = 0.3;

/**
 * How much worse being wet makes the next hit.
 *
 * At full wetness you take 60% more, so the last third of someone's meter goes
 * quickest and a fight that is nearly won finishes rather than stalling.
 */
export const SOAK_SCALING = 0.6;

/**
 * Ceiling on *sustained* wetness taken per second, however many people are throwing.
 *
 * Set to exactly what a soaker delivers point blank, which makes it a rule
 * rather than a fudge: **nothing can wet you faster than a hose in your face**. Six kids in
 * a crossfire cannot beat that rate, they can only guarantee it — so being
 * surrounded is reliably bad instead of instantly fatal, and one-to-one the
 * weapon you are holding is never quietly throttled.
 */
export const MAX_INTAKE_PER_SECOND = 0.9;

/**
 * How much intake can be banked up and spent on a single hit.
 *
 * The cap has to limit a rate without flattening an impulse, and a per-tick
 * allowance cannot do both: at 60Hz it is 0.015, which a stream drawing exactly
 * that per tick never notices, while a balloon's single 0.55 arrives as 0.015 —
 * a thirty-seventh of it. That is not a balance number, it is a weapon that
 * quietly does nothing, and the arsenal's own tests could not see it because
 * they check rates, which is the one thing a per-tick budget gets right.
 *
 * So the budget is a bucket that refills at the sustained rate, and it holds
 * exactly one direct hit. That is the line worth drawing: **a balloon out of
 * the blue lands whole, a second one in the same breath does not.** Six kids
 * throwing at once get one opening hit between them and the sustained rate
 * after it — being surrounded is worse than being chased, but not six times
 * worse, and never instant.
 *
 * Sized to the heaviest single hit in the arsenal; waterKit's tests hold the
 * two numbers together.
 */
export const INTAKE_BURST = 0.55;

export interface WetnessState {
  /** 0 dry, 1 soaked. */
  value: number;
  /** Counts down from DRY_GRACE after each hit. */
  grace: number;
  /** Intake banked in the bucket, spent by hits and refilled by ticks. */
  intakeLeft: number;
}

export function makeWetness(): WetnessState {
  return { value: 0, grace: 0, intakeLeft: INTAKE_BURST };
}

export function resetWetness(w: WetnessState): void {
  w.value = 0;
  w.grace = 0;
  w.intakeLeft = INTAKE_BURST;
}

/**
 * Advance one tick: refill the intake bucket, run the grace timer, dry off.
 *
 * Call once per tick per character, before any hits are applied, so a hit spends
 * a budget that includes this tick's refill.
 */
export function tickWetness(w: WetnessState, dt: number): void {
  w.intakeLeft = Math.min(INTAKE_BURST, w.intakeLeft + MAX_INTAKE_PER_SECOND * dt);

  if (w.grace > 0) {
    w.grace = Math.max(0, w.grace - dt);
    return;
  }
  w.value = Math.max(0, w.value - DRY_RATE * dt);
}

/**
 * Apply an amount of wetness, scaled and capped.
 *
 * Returns how much actually landed, which is what a hit marker should reflect —
 * showing the raw amount would tell the player they connected harder than they
 * did whenever the cap or the ceiling clipped it.
 */
export function soak(w: WetnessState, amount: number): number {
  if (amount <= 0) return 0;

  const scaled = amount * (1 + w.value * SOAK_SCALING);
  const allowed = Math.min(scaled, w.intakeLeft, SOAKED - w.value);
  if (allowed <= 0) {
    // Still counts as being under fire even when nothing lands, or standing in
    // a stream while capped would quietly start you drying.
    w.grace = DRY_GRACE;
    return 0;
  }

  w.intakeLeft -= allowed;
  w.value = Math.min(SOAKED, w.value + allowed);
  w.grace = DRY_GRACE;
  return allowed;
}

export function isSoaked(w: WetnessState): boolean {
  return w.value >= SOAKED - 1e-6;
}

/**
 * Which of four stages to draw.
 *
 * A hidden float on six characters is unreadable, and reading "is that one
 * nearly done?" off the world is the whole reason the meter beats one-hit. Four
 * stages is the fewest that reads as progress rather than as a switch.
 */
export type WetStage = 'dry' | 'damp' | 'wet' | 'drenched';

export function wetStage(value: number): WetStage {
  if (value < 0.2) return 'dry';
  if (value < 0.55) return 'damp';
  if (value < 0.85) return 'wet';
  return 'drenched';
}

/**
 * Tint for a character at a given wetness: dry colour toward a dark soaked one.
 *
 * Returned as a 0..1 blend rather than a colour so the renderer keeps ownership
 * of what dry actually looks like.
 */
export function wetBlend(value: number): number {
  return Math.min(1, value * 0.85);
}
