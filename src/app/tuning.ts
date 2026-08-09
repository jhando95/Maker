/**
 * Every number somebody might want to argue about, in one place, editable while
 * the game runs.
 *
 * The engine under this game is three.js plus about four thousand lines of
 * renderer, physics and rules written for this game and no other. What it has
 * never had is the thing a tailored engine is actually *for*: a way to change
 * how the game feels without changing the program. Deciding whether a
 * trampoline should throw a kid three metres or four currently means editing a
 * constant, waiting for a reload, and losing the round you were testing it in —
 * so in practice the question gets asked once, answered from a guess, and never
 * revisited.
 *
 * ## Registered, not listed
 *
 * The tempting design is a file of every tunable value. That is the two-lists
 * bug this project has now lost to four times: a number would exist here and in
 * the code that uses it, and they would drift. So a knob is **registered by the
 * module that owns it**, next to the code that reads it, and this holds no
 * knowledge of what any of them mean.
 *
 * ## Clamped, because a slider is not a validator
 *
 * Every knob carries its own range and every write goes through it. A dev panel
 * that can set gravity to minus four hundred is a dev panel that produces bug
 * reports about a game nobody shipped.
 *
 * ## Exported as source, not saved as state
 *
 * `asSource()` prints the changed values as the lines you would paste back into
 * the code. That is deliberate and it is the whole workflow: a tweak that lives
 * only in a browser's storage is a game that behaves differently on the machine
 * it was tuned on, which is the "works on mine" bug with extra steps. Tuning
 * ends in a commit or it did not happen.
 */

export interface KnobSpec {
  /** Stable identity, `group.name`, used by the panel and by `asSource`. */
  key: string;
  /** What it is called on screen. */
  label: string;
  value: number;
  min: number;
  max: number;
  /** Slider granularity. Also what a value is rounded to on the way in. */
  step: number;
  /** One line on what it does, shown beside it. */
  help?: string;
  /** Where in the source the default lives, so a change knows where to go. */
  home?: string;
}

export interface Knob extends KnobSpec {
  /** What it was registered with, so it can be put back. */
  readonly initial: number;
}

/** Rounded to the knob's own step, then held inside its own range. */
export function clampTo(spec: { min: number; max: number; step: number }, value: number): number {
  // Only NaN is genuinely unanswerable. An infinity has an obvious right answer
  // — the end of the range it is heading for — and treating it as unanswerable
  // sends a slider dragged hard to the right all the way to the left.
  if (Number.isNaN(value)) return spec.min;
  const stepped = spec.step > 0 ? Math.round(value / spec.step) * spec.step : value;
  const held = Math.max(spec.min, Math.min(spec.max, stepped));
  // Rounding at the step reintroduces the float error it was meant to remove —
  // 0.1 * 3 is not 0.30000000000000004 to anybody looking at a slider.
  return Number(held.toFixed(6));
}

export class Tuning {
  private readonly knobs = new Map<string, Knob>();
  private readonly listeners = new Set<(key: string, value: number) => void>();

  /**
   * Declare a knob and get back a reader for it.
   *
   * A function rather than a number, because the point is that it changes. A
   * caller that reads it once at module load has opted out of the whole feature
   * and will not notice — so the shape of the return value is the reminder.
   */
  register(spec: KnobSpec): () => number {
    if (this.knobs.has(spec.key)) {
      throw new Error(`tuning: two knobs called "${spec.key}"`);
    }
    if (!(spec.min <= spec.max)) {
      throw new Error(`tuning: "${spec.key}" has a range of ${spec.min}..${spec.max}`);
    }
    const value = clampTo(spec, spec.value);
    this.knobs.set(spec.key, { ...spec, value, initial: value });
    return () => this.knobs.get(spec.key)!.value;
  }

  get(key: string): number | undefined {
    return this.knobs.get(key)?.value;
  }

  /** Set one, clamped. Returns what it actually became. */
  set(key: string, value: number): number | undefined {
    const knob = this.knobs.get(key);
    if (knob === undefined) return undefined;
    const next = clampTo(knob, value);
    if (next === knob.value) return next;
    knob.value = next;
    for (const listener of this.listeners) listener(key, next);
    return next;
  }

  /** Put one back, or all of them. */
  reset(key?: string): void {
    for (const knob of this.knobs.values()) {
      if (key !== undefined && knob.key !== key) continue;
      if (knob.value === knob.initial) continue;
      knob.value = knob.initial;
      for (const listener of this.listeners) listener(knob.key, knob.value);
    }
  }

  /** Everything, in registration order, for a panel to draw. */
  all(): readonly Knob[] {
    return [...this.knobs.values()];
  }

  /** Only the ones that are no longer what they were registered with. */
  changed(): readonly Knob[] {
    return this.all().filter((k) => k.value !== k.initial);
  }

  onChange(listener: (key: string, value: number) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /**
   * The changed values as lines to paste into the source.
   *
   * With the file each one came from, because the point of tuning is to end in
   * a commit, and a list of numbers with no addresses is a puzzle rather than a
   * patch.
   */
  asSource(): string {
    const changed = this.changed();
    if (changed.length === 0) return '// nothing changed';
    return changed
      .map((k) => `${k.home ?? '?'}: ${k.key} = ${k.value}   // was ${k.initial}`)
      .join('\n');
  }
}
