/**
 * How long the GPU actually took.
 *
 * `FrameProfile` carves a frame into named CPU spans, and the first thing it
 * found was that 88% of a frame in this harness is outside everything the game
 * instruments. It cannot do better than that, because it is a stopwatch on the
 * main thread and the main thread is not where the pixels happen. `draw` is 24
 * milliseconds — of *submitting* draw calls. Whether the GPU then spent one
 * millisecond on them or thirty is a question the CPU cannot answer, because
 * `renderer.render` returns the moment the commands are queued and not when
 * they are done.
 *
 * The only honest way to ask is to make the GPU time itself.
 * `EXT_disjoint_timer_query_webgl2` does exactly that: a query bracketing the
 * draw calls, resolved by the driver, read back some frames later in
 * nanoseconds. It is the standard tool and it has four traps, all of which this
 * file exists to handle.
 *
 * ## The answer arrives late, and asking early is the classic mistake
 *
 * A query's result is not ready on the frame that issued it — the commands have
 * not run yet. Calling `getQueryParameter(q, QUERY_RESULT)` before
 * `QUERY_RESULT_AVAILABLE` says yes **blocks the CPU until the GPU catches up**,
 * which is a full pipeline stall: the profiler would flatten the frame rate it
 * is measuring and then report the flattened number as the truth. So this only
 * ever polls, never waits, and the number on the screen belongs to a frame a
 * few back. That is stated rather than hidden — see `latency`.
 *
 * ## The driver can invalidate everything, and usually does at the worst moment
 *
 * `GPU_DISJOINT_EXT` is the driver saying "something preempted me — every
 * timing you have in flight is garbage". It fires when another window takes the
 * GPU, on a power-state change, when a laptop switches graphics chips. Those
 * are exactly the moments somebody is staring at the readout wondering why the
 * game stuttered, and the reading they would get is a fabricated spike. A
 * discarded measurement is worth more than an invented one, so the flag taints
 * everything outstanding and those results are read and thrown away.
 *
 * ## The pool is fixed, because an unbounded one is a leak
 *
 * Results come back a few frames late, so several queries are alive at once. A
 * pool that grows whenever nothing has come back yet is a pool that grows
 * without limit on a driver that never answers — and drivers that never answer
 * exist. The ring is small and fixed; when it is full a frame simply goes
 * unmeasured, which is a gap in a graph rather than a leak in a game.
 *
 * ## Most machines do not have it
 *
 * Safari has never shipped it, most mobile drivers do not expose it, and the
 * software rasteriser this project's CI runs on certainly does not. So absence
 * is the ordinary case rather than the error case: `available` is false, every
 * method is a no-op, and no call site needs a branch around it.
 */

/** `TIME_ELAPSED_EXT`. Named here so a test does not need a real WebGL context. */
export const TIME_ELAPSED = 0x88bf;
/** `GPU_DISJOINT_EXT`. */
export const GPU_DISJOINT = 0x8fbb;

/** The extension's name, as `getExtension` wants it. */
export const EXTENSION = 'EXT_disjoint_timer_query_webgl2';

/**
 * How many queries may be in flight.
 *
 * Three or four frames of latency is typical; five leaves room for a driver
 * that is a frame slower than typical without dropping every other sample.
 */
export const RING = 5;

/** Frames the rolling average covers. Two seconds at sixty, as elsewhere. */
export const WINDOW = 120;

/** Nanoseconds to milliseconds. The extension reports the former. */
const NS_PER_MS = 1e6;

/**
 * The slice of WebGL2 this needs.
 *
 * Declared rather than taking a `WebGL2RenderingContext`, because every rule in
 * this file is about *sequencing* — what may be asked when, what is thrown away
 * and when the pool is full — and none of it is about rasterising. A fake
 * context drives all of it in a test, on a machine with no GPU at all, which is
 * the only way this code was ever going to be checked in CI.
 */
export interface TimerGl {
  createQuery(): WebGLQuery | null;
  deleteQuery(query: WebGLQuery | null): void;
  beginQuery(target: number, query: WebGLQuery): void;
  endQuery(target: number): void;
  getQueryParameter(query: WebGLQuery, pname: number): unknown;
  getParameter(pname: number): unknown;
  getExtension(name: string): unknown;
  readonly QUERY_RESULT_AVAILABLE: number;
  readonly QUERY_RESULT: number;
}

interface Slot {
  query: WebGLQuery;
  /** The frame this was issued on, so lateness can be reported rather than assumed. */
  frame: number;
  /** In flight, waiting on the driver. */
  busy: boolean;
  /** The driver went disjoint while this was outstanding: read it, bin it. */
  tainted: boolean;
}

export class GpuTimer {
  private gl: TimerGl | null;
  private readonly slots: Slot[] = [];
  private readonly history = new Float64Array(WINDOW);
  private open: Slot | null = null;
  private frame = 0;
  private next = 0;
  private filled = 0;
  private lastFrame = -1;

  /** Frames that went unmeasured because every query was still in flight. */
  skipped = 0;
  /** Results binned because the driver reported a disjoint. */
  discarded = 0;

  /**
   * @param gl a WebGL2 context, or null where there is none. Null is not an
   *   error: it is the shape of every environment that cannot do this, and
   *   collapsing "no context" and "no extension" into one dead state means a
   *   caller writes the same code either way.
   */
  constructor(gl: TimerGl | null, ring = RING) {
    this.gl = gl && gl.getExtension(EXTENSION) ? gl : null;
    if (!this.gl) return;
    for (let i = 0; i < ring; i++) {
      const query = this.gl.createQuery();
      // A driver that hands back null has told us it will not do this. Stopping
      // at the first refusal leaves a smaller ring rather than an array with
      // holes in it that every loop below would have to test for.
      if (!query) break;
      this.slots.push({ query, frame: -1, busy: false, tainted: false });
    }
    if (this.slots.length === 0) this.gl = null;
  }

  /** Whether anything here will produce a number. False on most machines. */
  get available(): boolean {
    return this.gl !== null;
  }

  /**
   * Start timing.
   *
   * Silently does nothing when a query is already open, when the ring is full,
   * or when there is no extension — the three cases a call site would otherwise
   * have to know about. Only one `TIME_ELAPSED` query may be active at a time,
   * which is a spec rule and not a choice.
   */
  begin(): void {
    const gl = this.gl;
    if (!gl || this.open) return;
    const slot = this.free();
    if (!slot) {
      this.skipped++;
      return;
    }
    slot.busy = true;
    slot.tainted = false;
    slot.frame = this.frame;
    this.open = slot;
    gl.beginQuery(TIME_ELAPSED, slot.query);
  }

  /** Stop timing. Harmless if nothing was started. */
  end(): void {
    const gl = this.gl;
    if (!gl || !this.open) return;
    gl.endQuery(TIME_ELAPSED);
    this.open = null;
  }

  /**
   * Collect whatever the driver has finished, and advance the frame counter.
   *
   * Called once a frame, after `end`. The disjoint flag is read *first* and
   * before anything is collected, because reading it clears it: it reports
   * whether a disjoint happened since the last read, so a result collected
   * before the check would be one the check was supposed to cover.
   */
  poll(): void {
    const gl = this.gl;
    if (!gl) return;
    this.frame++;

    if (gl.getParameter(GPU_DISJOINT)) {
      // Everything outstanding spans the disruption, including the query that
      // is open right now. Tainting rather than deleting, because a query the
      // driver is still writing to cannot be reused until it answers.
      for (const slot of this.slots) if (slot.busy) slot.tainted = true;
    }

    for (const slot of this.slots) {
      if (!slot.busy || slot === this.open) continue;
      if (!gl.getQueryParameter(slot.query, gl.QUERY_RESULT_AVAILABLE)) continue;
      const ns = Number(gl.getQueryParameter(slot.query, gl.QUERY_RESULT));
      slot.busy = false;
      if (slot.tainted) {
        this.discarded++;
        slot.tainted = false;
        continue;
      }
      // A driver under no obligation to be sane occasionally returns a negative
      // or absurd figure; a rolling average is exactly the thing one of those
      // poisons for two seconds.
      if (!Number.isFinite(ns) || ns < 0) {
        this.discarded++;
        continue;
      }
      this.record(ns / NS_PER_MS, slot.frame);
    }
  }

  /** Average GPU milliseconds a frame, or 0 before anything has come back. */
  get ms(): number {
    if (this.filled === 0) return 0;
    let total = 0;
    for (let i = 0; i < this.filled; i++) total += this.history[i]!;
    return total / this.filled;
  }

  /** How many measurements the average covers. */
  get depth(): number {
    return this.filled;
  }

  /**
   * Frames this has seen, which is what `latency` is measured against.
   *
   * Exposed because the only honest bound on lateness is the length of the
   * session: a shared runner rasterising in software can be thirty frames
   * behind and be working perfectly, and a check that picked a smaller number
   * would be asserting the machine rather than the timer.
   */
  get frames(): number {
    return this.frame;
  }

  /**
   * How many frames behind the newest reading is.
   *
   * On the readout beside the number, because a GPU time that is four frames
   * stale is the truth about a frame that has already gone — which matters the
   * moment somebody turns to face something expensive and wonders why the
   * number has not moved yet. -1 before anything has arrived.
   */
  get latency(): number {
    return this.lastFrame < 0 ? -1 : this.frame - this.lastFrame;
  }

  /** Release the queries. Safe to call twice. */
  dispose(): void {
    const gl = this.gl;
    if (!gl) return;
    if (this.open) {
      gl.endQuery(TIME_ELAPSED);
      this.open = null;
    }
    for (const slot of this.slots) gl.deleteQuery(slot.query);
    this.slots.length = 0;
    this.gl = null;
  }

  /** Forget the average. For a mode change, where the old frames mean nothing. */
  reset(): void {
    this.next = 0;
    this.filled = 0;
    this.lastFrame = -1;
    this.skipped = 0;
    this.discarded = 0;
  }

  private free(): Slot | null {
    for (const slot of this.slots) if (!slot.busy) return slot;
    return null;
  }

  private record(ms: number, frame: number): void {
    this.history[this.next] = ms;
    this.next = (this.next + 1) % WINDOW;
    if (this.filled < WINDOW) this.filled++;
    // Out-of-order completion is legal; the newest reading is the one worth
    // reporting lateness for, so an older straggler must not move it backwards.
    if (frame > this.lastFrame) this.lastFrame = frame;
  }
}
