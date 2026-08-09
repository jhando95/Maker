/**
 * Where the frame went.
 *
 * The readout this project already has answers *how fast* — frames a second,
 * frame time, the worst frame in the last two seconds. It has never been able
 * to answer *what was slow*, and those are completely different questions. A
 * game that drops from 60 to 40 when six kids are on the lawn has one number to
 * look at and a guess to make, and this project has spent an afternoon proving
 * what guessing costs.
 *
 * `tools/bench.ts` measures systems in isolation, off-line, on a synthetic
 * world. That is the other half and not this one: it cannot tell you that a
 * live frame in Tag spends four times as long in the character rig as in the
 * physics, because it never runs a live frame.
 *
 * ## The constraint that shapes the whole file
 *
 * A profiler that allocates is a profiler that causes the stutter it is
 * measuring. Every buffer here is a `Float64Array` sized at construction, the
 * section list is fixed and known at compile time, and `read()` fills a caller-
 * owned array rather than building one. Nothing in the frame path makes an
 * object, which is checkable and is checked.
 *
 * ## Flat spans, not a tree
 *
 * Sections are disjoint: a frame is carved into named pieces that add up to it,
 * rather than nested scopes that would need a stack and would let two people
 * disagree about whether "sim" includes "physics". The leftover — whatever the
 * frame took minus the pieces — is reported as its own section, because a
 * profiler that quietly loses a third of the frame is worse than none: it tells
 * you the three things you instrumented are fine and never mentions the fourth.
 */

/**
 * The pieces of a frame.
 *
 * Fixed rather than open, so a section index is a compile-time constant and no
 * string is hashed sixty times a second. Adding one is a deliberate edit here,
 * which is the right amount of friction for something that shows up in a
 * player-visible readout.
 */
export const SECTIONS = ['sim', 'net', 'anim', 'draw', 'ui'] as const;
export type Section = (typeof SECTIONS)[number];

/** How many frames the rolling average covers. Two seconds at sixty. */
const WINDOW = 120;

/** What the leftover is called. Not a section: nobody can start or stop it. */
export const UNACCOUNTED = 'rest';

export interface SectionTime {
  name: string;
  /** Milliseconds a frame, averaged over the window. */
  ms: number;
  /** Share of the frame, 0..1. */
  share: number;
}

const INDEX: ReadonlyMap<string, number> = new Map(SECTIONS.map((s, i) => [s, i]));

export class FrameProfile {
  /** Accumulated inside the current frame. */
  private readonly current = new Float64Array(SECTIONS.length);
  /** When each open section started, or -1. */
  private readonly opened = new Float64Array(SECTIONS.length).fill(-1);
  /** A ring of per-section totals, plus one column for the whole frame. */
  private readonly history = new Float64Array(WINDOW * (SECTIONS.length + 1));
  private next = 0;
  private filled = 0;

  private readonly clock: () => number;

  /**
   * @param clock milliseconds, monotonic. Injected so a test can drive it —
   *   a profiler tested against the real clock is a test that measures the
   *   machine it happens to run on.
   */
  constructor(clock: () => number = () => performance.now()) {
    this.clock = clock;
  }

  /** Open a section. Opening one that is already open is ignored. */
  start(section: Section): void {
    const i = INDEX.get(section);
    if (i === undefined || this.opened[i]! >= 0) return;
    this.opened[i] = this.clock();
  }

  /** Close a section, adding its span to this frame. */
  stop(section: Section): void {
    const i = INDEX.get(section);
    if (i === undefined) return;
    const began = this.opened[i]!;
    if (began < 0) return;
    this.opened[i] = -1;
    this.current[i] = this.current[i]! + (this.clock() - began);
  }

  /**
   * Close the frame.
   *
   * @param frameMs what the whole frame took, measured by the loop. Taken
   *   rather than measured here for the same reason `FrameStats` takes it: the
   *   loop already knows, and a second clock is a second thing that can
   *   disagree with the first.
   */
  endFrame(frameMs: number): void {
    const stride = SECTIONS.length + 1;
    const row = this.next * stride;
    let named = 0;
    for (let i = 0; i < SECTIONS.length; i++) {
      // A section left open across the frame boundary is dropped rather than
      // carried: it is a missing `stop`, and carrying it would smear one bug
      // across every frame after it.
      this.opened[i] = -1;
      this.history[row + i] = this.current[i]!;
      named += this.current[i]!;
      this.current[i] = 0;
    }
    // Never negative, however the two clocks disagree at the edges.
    this.history[row + SECTIONS.length] = Math.max(frameMs, named);
    this.next = (this.next + 1) % WINDOW;
    if (this.filled < WINDOW) this.filled++;
  }

  /** How many frames the average currently covers. */
  get depth(): number {
    return this.filled;
  }

  /**
   * Average milliseconds and share per section, plus the leftover.
   *
   * Fills `into` rather than returning a fresh array, because this is read
   * every frame the readout is on and a profiler that allocates is a profiler
   * that causes the stutter it is measuring. The array is grown once, on the
   * first call, and reused after.
   */
  read(into: SectionTime[] = []): SectionTime[] {
    const stride = SECTIONS.length + 1;
    const n = Math.max(1, this.filled);
    let frame = 0;
    for (let f = 0; f < this.filled; f++) frame += this.history[f * stride + SECTIONS.length]!;
    const frameAvg = frame / n;

    while (into.length < SECTIONS.length + 1) into.push({ name: '', ms: 0, share: 0 });
    into.length = SECTIONS.length + 1;

    let named = 0;
    for (let i = 0; i < SECTIONS.length; i++) {
      let total = 0;
      for (let f = 0; f < this.filled; f++) total += this.history[f * stride + i]!;
      const ms = total / n;
      named += ms;
      const slot = into[i]!;
      slot.name = SECTIONS[i]!;
      slot.ms = ms;
      slot.share = frameAvg > 0 ? ms / frameAvg : 0;
    }

    // The leftover, always reported. A profiler that quietly loses a third of
    // the frame tells you the parts you instrumented are fine and never
    // mentions the part that is not.
    const rest = into[SECTIONS.length]!;
    rest.name = UNACCOUNTED;
    rest.ms = Math.max(0, frameAvg - named);
    rest.share = frameAvg > 0 ? rest.ms / frameAvg : 0;
    return into;
  }

  /** The section taking the most time, or null before any frame has closed. */
  heaviest(into: SectionTime[] = []): SectionTime | null {
    if (this.filled === 0) return null;
    const all = this.read(into);
    let best = all[0]!;
    for (const s of all) if (s.ms > best.ms) best = s;
    return best;
  }

  /** Forget everything. For a mode change, where the old frames mean nothing. */
  reset(): void {
    this.current.fill(0);
    this.opened.fill(-1);
    this.next = 0;
    this.filled = 0;
  }
}
