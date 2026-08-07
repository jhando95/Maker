/**
 * What the garden sounds like, for somebody who cannot hear it.
 *
 * This is an accessibility feature and it is also a gameplay one, which is why
 * it is worth building rather than filing. The collapse sound carries
 * forty-eight metres — twice a placement — and the reason is written into
 * `gameSounds.ts`: *in a mode where two people are dismantling each other's
 * forts it is the only warning the other one gets*. A player who cannot hear it
 * is not missing flavour. They are missing the warning.
 *
 * ## The rule the whole file is built around
 *
 * **A caption may not say anything the sound would not have said.** Same range,
 * same falloff, same silence. It is tempting to caption everything — the model
 * knows where every event happened and the screen has room — and that would
 * quietly turn an accessibility option into wallhacks: a player with captions
 * on would know a kid was spraying a fence forty metres away through a house,
 * and one with them off would not. In a party game played between friends,
 * making the accessible option the strong option is its own kind of exclusion.
 *
 * So every kind carries the range its sound carries, and out of range there is
 * no line. The ranges are stated here next to each other rather than imported
 * one at a time, because the property that matters is that they *match*, and a
 * table you can read in one glance is the only way anybody will notice when one
 * drifts.
 *
 * ## Coalescing, which is most of what makes it readable
 *
 * A thirty-part tower does not make thirty sounds — the bus plays one clatter,
 * scaled — so it must not make thirty lines either. Spraying is five hisses a
 * second while somebody draws. Repeats of a kind near the same place inside a
 * short window become one line with a count on it, which is both what the ear
 * would have heard and the only version anybody can read.
 */

/** The things worth saying out loud. Footsteps are deliberately not here. */
export type CaptionKind =
  | 'collapse' | 'place' | 'remove' | 'spray' | 'splash' | 'water' | 'voice';

/** Where it came from, relative to where the listener is looking. */
export type Where = 'ahead' | 'left' | 'right' | 'behind';

export interface Sounded {
  kind: CaptionKind;
  x: number;
  y: number;
  z: number;
  /** Seconds, monotonic. The caller's clock, so a test can drive it. */
  at: number;
}

export interface Caption {
  kind: CaptionKind;
  /**
   * Where it happened, kept on the line so a repeat can be matched against it.
   *
   * On the caption rather than in a parallel map, because two structures that
   * must agree about the same thing is a bug waiting for the next edit — the
   * same argument the rebinding code lost once already.
   */
  sx: number;
  sz: number;
  text: string;
  where: Where;
  /** How many of it, after coalescing. One unless it repeated. */
  count: number;
  /** When the most recent one arrived, so age is age since it last happened. */
  at: number;
}

/**
 * How far each sound carries, in metres.
 *
 * These are the audio ranges and they must stay the audio ranges. A caption
 * that outran its sound would be an advantage rather than an accommodation.
 */
export const RANGE: Readonly<Record<CaptionKind, number>> = {
  // Twice a placement, because a tower coming down is the only warning the
  // person who built it gets. `gameSounds.collapsed` passes 48 for the same
  // reason and the two are meant to be read together.
  collapse: 48,
  place: 24,
  remove: 24,
  spray: 24,
  splash: 24,
  water: 24,
  voice: 24,
};

/** What each one says. Short, because it is read out of the corner of an eye. */
export const TEXT: Readonly<Record<CaptionKind, string>> = {
  collapse: 'something collapses',
  place: 'building',
  remove: 'taking apart',
  spray: 'spray can',
  splash: 'splash',
  water: 'running water',
  voice: 'talking',
};

/** Repeats of a kind inside this many seconds fold into one line. */
export const COALESCE = 2.5;
/** …and within this many metres. Past it, it is a second event somewhere else. */
export const MERGE = 8;
/** How long a line stays up after the last thing that fed it. */
export const LIFE = 4;
/** How many lines at once. More than this and nobody reads any of them. */
export const MAX_LINES = 4;
/** Within this, direction is meaningless and saying one would be a guess. */
export const ON_TOP = 1.5;

/**
 * Which way it came from, in four words.
 *
 * Four rather than eight because a caption is read at a glance and "ahead and
 * slightly to the left" is not a glance. The quadrants are split on the
 * diagonals, so `ahead` covers the ninety degrees a player is actually looking
 * at and `behind` covers the ninety they cannot see — which is the one that
 * matters, and the reason this exists at all.
 */
export function bearing(
  sx: number, sz: number,
  lx: number, lz: number,
  fx: number, fz: number,
): Where {
  const dx = sx - lx;
  const dz = sz - lz;
  if (Math.hypot(dx, dz) < ON_TOP) return 'ahead';
  const len = Math.hypot(fx, fz) || 1;
  const nx = fx / len;
  const nz = fz / len;
  // Forward component and the one at right angles to it. The right vector of a
  // ground-plane forward `(nx, nz)` is `(-nz, nx)`, which is the whole of the
  // trigonometry here and is worth writing down once rather than deriving at
  // three call sites.
  const forward = dx * nx + dz * nz;
  const right = dx * -nz + dz * nx;
  if (Math.abs(forward) >= Math.abs(right)) return forward >= 0 ? 'ahead' : 'behind';
  return right >= 0 ? 'right' : 'left';
}

/** Whether a sound at this distance would have been audible at all. */
export function audible(kind: CaptionKind, distance: number): boolean {
  return distance <= RANGE[kind];
}

/**
 * The live caption list.
 *
 * Holds no DOM and no renderer: it is a list of strings with times on them, so
 * every rule above can be checked without a browser. The one thing it does own
 * is the clock-free ordering — newest last, so a reader's eye lands on the new
 * line in the same place every time.
 */
export class Captions {
  private readonly lines: Caption[] = [];

  /**
   * Something made a noise.
   *
   * @param listener where the ears are, and which way they face on the ground.
   * @returns the caption it landed in, or null if it was out of earshot.
   */
  heard(
    event: Sounded,
    listener: { x: number; z: number; fx: number; fz: number },
  ): Caption | null {
    const distance = Math.hypot(event.x - listener.x, event.z - listener.z);
    if (!audible(event.kind, distance)) return null;

    const where = bearing(event.x, event.z, listener.x, listener.z, listener.fx, listener.fz);
    // Coalesce against the newest matching line rather than the first, because
    // somebody walking down a fence spraying it should keep feeding the line in
    // front of them rather than an older one they have walked away from.
    for (let i = this.lines.length - 1; i >= 0; i--) {
      const line = this.lines[i]!;
      if (line.kind !== event.kind) continue;
      if (event.at - line.at > COALESCE) continue;
      if (Math.hypot(event.x - line.sx, event.z - line.sz) > MERGE) continue;
      line.count++;
      line.at = event.at;
      line.where = where;
      line.sx = event.x;
      line.sz = event.z;
      // Moved to the end: it just happened, so it belongs where the eye is.
      this.lines.splice(i, 1);
      this.lines.push(line);
      return line;
    }

    const line: Caption = {
      kind: event.kind,
      text: TEXT[event.kind],
      where,
      count: 1,
      at: event.at,
      sx: event.x,
      sz: event.z,
    };
    this.lines.push(line);
    // Oldest out rather than newest refused: a caption that stopped updating
    // because four things were already on screen would go silent exactly when
    // the garden got busy, which is when it is most needed.
    while (this.lines.length > MAX_LINES) this.lines.shift();
    return line;
  }

  /**
   * Drop anything that has been up long enough.
   *
   * One pass from the front, which is correct because the list is always in
   * ascending order of `at`: a new line is appended with the newest time, and a
   * coalesced one has its time refreshed and is moved to the end at the same
   * moment. There is no way to end up with an old line behind a young one.
   *
   * This started as two passes — a `shift` loop and then a sweep from the back
   * "because the list is not sorted after a coalesce" — and the sweep was dead
   * code guarding a state that cannot happen. It came out when a planted bug
   * failed to break any test: nothing was checking it because nothing could.
   */
  expire(now: number): void {
    while (this.lines.length > 0 && now - this.lines[0]!.at > LIFE) this.lines.shift();
  }

  /** What to draw, oldest first. */
  get current(): readonly Caption[] {
    return this.lines;
  }

  clear(): void {
    this.lines.length = 0;
  }
}

