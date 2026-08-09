/**
 * What to put on screen when somebody asks how the game is running.
 *
 * There is already a debug overlay behind a key, and it answers a developer's
 * question — how high is the player, are they grounded, how many parts are in
 * the world. This answers a player's, and the difference is not cosmetic: a
 * player wants to know whether the game is smooth, and the number that says so
 * is not the one everybody prints.
 *
 * ## Why the average is the wrong number
 *
 * A frame rate averaged over a second is the first thing every game shows and
 * the least useful. Fifty-nine frames at 4ms and one at 200ms averages to a
 * comfortable-looking 76 fps and feels like a stutter, because the stutter is
 * what you notice — nobody has ever been pleased by the frames that arrived on
 * time. So this keeps the worst frame in the window alongside the average, which
 * is the pair the industry settled on for the same reason.
 *
 * The low is reported as a frame rate rather than as a duration, so the two
 * numbers can be compared at a glance: `58 fps` next to `low 22` says the thing
 * that matters, where `16.9ms / 45ms` makes a reader do arithmetic to find out
 * whether they should care.
 *
 * ## Why it is sampled rather than counted
 *
 * Frame times go in one at a time and the summary is derived on demand, so a
 * caller that reads this once a second costs nothing extra and a caller that
 * reads it never costs nothing at all. The window is a ring buffer of fixed
 * size: no allocation per frame, which would be a stutter of its own.
 */

/** How many frames the window holds. Two seconds at 60Hz. */
export const WINDOW = 120;

/**
 * How long between recomputes of the displayed numbers, in seconds.
 *
 * A readout that updates every frame is unreadable — the digits blur and the
 * eye cannot settle on one. Four times a second is fast enough to feel live and
 * slow enough to read, and it is what the numbers are refreshed at rather than
 * what they are measured over.
 */
export const REFRESH = 0.25;

export interface FrameSummary {
  /** Mean frame rate over the window. */
  fps: number;
  /** Mean frame time, in milliseconds. */
  ms: number;
  /**
   * The worst frame in the window, as a frame rate.
   *
   * Named for what a player experiences rather than for the statistic: this is
   * one frame, not a percentile, because at 120 samples the 1% low *is* the
   * worst frame and calling it a percentile would suggest a rigour the sample
   * size does not support.
   */
  low: number;
}

export class FrameStats {
  private readonly samples = new Float32Array(WINDOW);
  private next = 0;
  private filled = 0;
  private since = 0;
  private summary: FrameSummary = { fps: 0, ms: 0, low: 0 };

  /**
   * Record one frame.
   *
   * Takes the frame's own duration rather than a timestamp, so this never has
   * to ask what time it is — the loop already knows, and a second clock is a
   * second thing that can disagree.
   *
   * Returns true when the summary changed, so a caller can skip touching the
   * DOM on the frames where nothing new would be written.
   */
  frame(dt: number): boolean {
    // A tab that was in the background hands back one enormous frame on return,
    // and it is not a stutter anybody experienced — it is the time they spent
    // reading something else. Left in, it pins the low at 1 fps for two seconds
    // every time somebody alt-tabs back into the game.
    if (dt > 0 && dt < 1) {
      this.samples[this.next] = dt;
      this.next = (this.next + 1) % WINDOW;
      if (this.filled < WINDOW) this.filled++;
    }

    this.since += dt;
    if (this.since < REFRESH || this.filled === 0) return false;
    // The remainder is carried rather than dropped, so the cadence does not
    // drift: fifteen frames of a sixtieth come to 0.24999999999999997, which is
    // under a quarter and would push every refresh one frame later than the
    // last. Zeroing here makes the readout update at 3.75Hz and wander.
    this.since -= REFRESH;

    let total = 0;
    let worst = 0;
    for (let i = 0; i < this.filled; i++) {
      const s = this.samples[i]!;
      total += s;
      if (s > worst) worst = s;
    }
    const mean = total / this.filled;
    this.summary = {
      fps: 1 / mean,
      ms: mean * 1000,
      low: worst > 0 ? 1 / worst : 0,
    };
    return true;
  }

  /** The numbers as of the last refresh. */
  get current(): FrameSummary {
    return this.summary;
  }

  reset(): void {
    this.next = 0;
    this.filled = 0;
    this.since = 0;
    this.summary = { fps: 0, ms: 0, low: 0 };
  }
}
