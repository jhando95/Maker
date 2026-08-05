/**
 * Keeps the frame rate playable on hardware nobody tested on.
 *
 * The simulation cost is measurable and bounded — `npm run bench` says the
 * heaviest thing a tick does is a few percent of the budget at three thousand
 * parts. The GPU cost is neither. It depends on a machine this code will never
 * see, and the honest answer to "will this run at 60fps" is that it depends on
 * how many pixels it is asked to fill.
 *
 * So that number is made adjustable. Render scale is the one quality lever with
 * no aesthetic opinion attached: shadows and outlines are how the game looks and
 * belong to the player, but nobody chooses a resolution for its own sake. The
 * player's setting stays the *ceiling* — the governor picks something at or
 * below it and never above — which is what stops this from fighting whoever
 * moved the slider.
 *
 * Two properties matter more than the exact thresholds:
 *
 * - Degrade fast, recover slowly. A player who drops frames wants it fixed now;
 *   a player who has headroom does not notice getting it back a few seconds
 *   later. Asymmetric timing is also what prevents a machine sitting exactly on
 *   the boundary from oscillating between two resolutions forever.
 * - Judge on the proportion of slow frames in a second, not on any single frame.
 *   One 40ms frame is a garbage collection, not a machine that cannot keep up,
 *   and reacting to it would drop quality on a game running perfectly.
 *
 * Waiting longer to recover than to degrade is not on its own enough to stop
 * the loop, because the thing being measured *changes when the scale changes*.
 * A machine that is slow at 100% and comfortable at 90% will be judged
 * comfortable, restored to 100%, found slow, dropped to 90%, and around again
 * forever — each step correct in isolation and the whole thing unusable. So
 * recovery is predictive: it asks whether the frames being measured now would
 * still fit the budget with the extra pixels the next step up would add. Since
 * some of a frame's cost does not scale with resolution at all, that estimate
 * is deliberately pessimistic, and errs toward staying where it is.
 */

export interface GovernorOptions {
  targetFps: number;
  /** Lowest scale to fall to. Below this the image stops being readable. */
  minScale: number;
  /** Size of one adjustment. */
  step: number;
  /** A frame counts as slow past this multiple of the budget. */
  slowFactor: number;
  /** Fraction of slow frames that makes a second a bad one. */
  badFraction: number;
  /** Fraction below which a second counts as comfortable. */
  goodFraction: number;
  /** Consecutive bad seconds before stepping down. */
  degradeAfter: number;
  /** Consecutive good seconds before stepping back up. */
  recoverAfter: number;
  /**
   * How much of the budget the *predicted* frame time must leave spare before
   * stepping up. Below 1 so a step up lands with room, not exactly on the line.
   */
  recoverMargin: number;
}

export const DEFAULT_GOVERNOR: GovernorOptions = {
  targetFps: 60,
  minScale: 0.5,
  step: 0.1,
  // 1.25 rather than 1.0: a display running at exactly 60Hz produces frames
  // scattered either side of 16.67ms, and calling half of them slow would
  // condemn a machine that is hitting its target.
  slowFactor: 1.25,
  badFraction: 0.3,
  goodFraction: 0.05,
  degradeAfter: 2,
  recoverAfter: 6,
  recoverMargin: 0.9,
};

export interface GovernorChange {
  scale: number;
  previous: number;
  reason: 'degrade' | 'recover';
}

export class PerformanceGovernor {
  private readonly options: GovernorOptions;

  /** The player's chosen scale. The governor never exceeds it. */
  private ceiling = 1;
  private scale = 1;

  private frames = 0;
  private slowFrames = 0;
  private secondElapsed = 0;
  private badSeconds = 0;
  private goodSeconds = 0;

  /**
   * Seconds to ignore after a change.
   *
   * Resizing the drawing buffer costs a frame or two on its own, and letting
   * that cost count as evidence would make one step down cause the next.
   */
  private settleFor = 0;

  enabled = true;

  onChange: ((change: GovernorChange) => void) | null = null;

  constructor(options: Partial<GovernorOptions> = {}) {
    this.options = { ...DEFAULT_GOVERNOR, ...options };
    this.scale = this.ceiling;
  }

  /**
   * The player's render-scale setting.
   *
   * Raising it gives the governor room to recover into; lowering it takes
   * effect immediately, because a player who just asked for less should get it
   * without waiting out a recovery window.
   */
  setCeiling(ceiling: number): void {
    this.ceiling = ceiling;
    if (this.scale > ceiling) this.scale = ceiling;
    this.reset();
  }

  /** The scale to actually render at. */
  get currentScale(): number {
    return this.enabled ? this.scale : this.ceiling;
  }

  /** True when the governor has pulled the scale below what the player asked for. */
  get isThrottling(): boolean {
    return this.currentScale < this.ceiling - 1e-6;
  }

  /**
   * Feed one rendered frame. `frameDt` is in seconds.
   *
   * Returns a change when the scale moved, so the caller can apply it and say
   * so, or null on the overwhelming majority of frames where nothing happens.
   */
  frame(frameDt: number): GovernorChange | null {
    if (!this.enabled) return null;

    if (this.settleFor > 0) {
      this.settleFor -= frameDt;
      return null;
    }

    const budget = 1 / this.options.targetFps;
    this.frames++;
    if (frameDt > budget * this.options.slowFactor) this.slowFrames++;
    this.secondElapsed += frameDt;

    if (this.secondElapsed < 1) return null;

    const slowRatio = this.frames > 0 ? this.slowFrames / this.frames : 0;
    const meanFrame = this.secondElapsed / this.frames;
    this.frames = 0;
    this.slowFrames = 0;
    this.secondElapsed = 0;

    if (slowRatio >= this.options.badFraction) {
      this.badSeconds++;
      this.goodSeconds = 0;
    } else if (slowRatio <= this.options.goodFraction) {
      this.goodSeconds++;
      this.badSeconds = 0;
    } else {
      // In between: neither struggling nor comfortable. Hold, and let neither
      // counter accumulate — this middle band is what keeps a machine sitting
      // on the boundary from stepping down and up forever.
      this.badSeconds = 0;
      this.goodSeconds = 0;
    }

    if (this.badSeconds >= this.options.degradeAfter && this.scale > this.options.minScale) {
      return this.moveTo(Math.max(this.options.minScale, round1(this.scale - this.options.step)), 'degrade');
    }
    if (this.goodSeconds >= this.options.recoverAfter && this.scale < this.ceiling) {
      const next = Math.min(this.ceiling, round1(this.scale + this.options.step));
      // Pixel count goes with the square of the scale, so this is what the
      // frames being measured right now would cost one step up. Only step up if
      // that still fits — the whole point is to not undo a drop that was needed.
      const predicted = meanFrame * (next / this.scale) ** 2;
      if (predicted < budget * this.options.recoverMargin) return this.moveTo(next, 'recover');
      // Not enough headroom. Start the streak over rather than trying again
      // next second, so a machine parked just below the line is not re-testing
      // the same losing bet once a second forever.
      this.goodSeconds = 0;
    }
    return null;
  }

  private moveTo(scale: number, reason: GovernorChange['reason']): GovernorChange {
    const change: GovernorChange = { scale, previous: this.scale, reason };
    this.scale = scale;
    this.reset();
    // Long enough for the resize itself to fall outside the next measurement.
    this.settleFor = 1;
    this.onChange?.(change);
    return change;
  }

  private reset(): void {
    this.frames = 0;
    this.slowFrames = 0;
    this.secondElapsed = 0;
    this.badSeconds = 0;
    this.goodSeconds = 0;
  }
}

/** Keep the scale on clean tenths, so it never drifts to 0.7999999999999999. */
function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
