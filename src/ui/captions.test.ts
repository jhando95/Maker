import { describe, it, expect } from 'vitest';
import {
  Captions, bearing, audible, RANGE, TEXT, COALESCE, MERGE, LIFE, MAX_LINES, ON_TOP,
  type CaptionKind,
} from './captions.ts';

// Every fixture below keeps its events inside the range of the kind it is
// using. That is not incidental tidiness: the range gate is the first thing
// `heard` does, so an event placed past it never reaches the rule under test
// and the assertion passes or fails for the wrong reason.

/** Looking down −Z, which is what a yaw of zero means everywhere else here. */
const north = (x = 0, z = 0) => ({ x, z, fx: 0, fz: -1 });

const say = (c: Captions, kind: CaptionKind, x: number, z: number, at: number, at3d = north()) =>
  c.heard({ kind, x, y: 0, z, at }, at3d);

describe('a caption may not say what the sound would not have', () => {
  // The rule the whole file exists for. The model knows where every event
  // happened and the screen has room for all of it, and captioning all of it
  // would quietly turn an accessibility option into wallhacks — a player with
  // captions on knowing about a kid spraying a fence forty metres away through
  // a house, and one with them off not.
  it('says nothing about something too far away to hear', () => {
    const c = new Captions();
    expect(say(c, 'spray', 0, -40, 0)).toBeNull();
    expect(c.current).toHaveLength(0);
  });

  it('carries a collapse exactly twice as far as a placement', () => {
    // `gameSounds.collapsed` passes 48 against a placement's 24, because a tower
    // coming down is the only warning the person who built it gets. If these
    // two ever disagree the caption is either deaf or clairvoyant.
    expect(RANGE.collapse).toBe(48);
    expect(RANGE.place).toBe(24);
    const c = new Captions();
    expect(say(c, 'place', 0, -40, 0)).toBeNull();
    expect(say(c, 'collapse', 0, -40, 0)).not.toBeNull();
  });

  it('measures the edge the same way for every kind', () => {
    for (const kind of Object.keys(RANGE) as CaptionKind[]) {
      expect(audible(kind, RANGE[kind])).toBe(true);
      expect(audible(kind, RANGE[kind] + 0.01)).toBe(false);
    }
  });

  it('ignores height, because the falloff does', () => {
    // `Bus.spatial` takes a listener at eye height and the sound where it
    // happened; a tower coming down two storeys up is not quieter for it.
    const c = new Captions();
    expect(c.heard({ kind: 'place', x: 0, y: 40, z: -10, at: 0 }, north())).not.toBeNull();
  });
});

describe('which way it came from', () => {
  it('puts a sound the player is looking at ahead', () => {
    expect(bearing(0, -10, 0, 0, 0, -1)).toBe('ahead');
  });

  it('puts a sound at their back behind, which is the one that matters', () => {
    expect(bearing(0, 10, 0, 0, 0, -1)).toBe('behind');
  });

  it('tells left from right', () => {
    // Facing −Z, +X is on the right hand. Getting this backwards is a bug that
    // reads perfectly in code and sends every player the wrong way.
    expect(bearing(10, 0, 0, 0, 0, -1)).toBe('right');
    expect(bearing(-10, 0, 0, 0, 0, -1)).toBe('left');
  });

  it('turns with the listener rather than with the world', () => {
    expect(bearing(10, 0, 0, 0, 1, 0)).toBe('ahead');
    expect(bearing(10, 0, 0, 0, -1, 0)).toBe('behind');
  });

  it('splits on the diagonals, so ahead is the ninety degrees being looked at', () => {
    expect(bearing(9, -10, 0, 0, 0, -1)).toBe('ahead');
    expect(bearing(11, -10, 0, 0, 0, -1)).toBe('right');
  });

  it('does not guess a direction for something underfoot', () => {
    // Inside a metre and a half there is no direction worth naming. The claim
    // is *stability*, not any particular word — asserting it comes back
    // 'ahead' passes either way, because a point just in front of the listener
    // is ahead whether or not the guard exists. What the guard buys is that it
    // does not flip to 'behind' the moment the player turns on the spot.
    const under = (fx: number, fz: number) => bearing(0, -(ON_TOP / 2), 0, 0, fx, fz);
    expect(under(0, -1)).toBe(under(0, 1));
    expect(under(0, -1)).toBe(under(1, 0));
  });

  it('survives a listener facing nowhere', () => {
    // A forward of zero happens for exactly one frame after a teleport, and a
    // NaN bearing is a caption that never renders again.
    expect(['ahead', 'behind', 'left', 'right']).toContain(bearing(5, 5, 0, 0, 0, 0));
  });
});

describe('coalescing, which is most of what makes it readable', () => {
  it('folds a repeat into one line with a count', () => {
    // A thirty-part tower plays one clatter, not thirty, so it must not make
    // thirty lines either.
    const c = new Captions();
    say(c, 'spray', 1, -3, 0);
    say(c, 'spray', 1.2, -3, 0.2);
    say(c, 'spray', 1.4, -3, 0.4);
    expect(c.current).toHaveLength(1);
    expect(c.current[0]!.count).toBe(3);
    expect(c.current[0]!.text).toBe(TEXT.spray);
  });

  it('starts a new line once the window has passed', () => {
    const c = new Captions();
    say(c, 'spray', 1, -3, 0);
    say(c, 'spray', 1, -3, COALESCE + 0.1);
    expect(c.current).toHaveLength(2);
  });

  it('starts a new line for the same sound somewhere else', () => {
    const c = new Captions();
    say(c, 'spray', 0, -3, 0);
    say(c, 'spray', MERGE + 1, -3, 0.1);
    expect(c.current).toHaveLength(2);
  });

  it('never folds two different things together', () => {
    const c = new Captions();
    say(c, 'place', 1, -3, 0);
    say(c, 'remove', 1, -3, 0.1);
    expect(c.current.map((l) => l.kind)).toEqual(['place', 'remove']);
  });

  it('follows somebody walking down a fence rather than an older line', () => {
    // Coalescing against the newest match, not the first: a kid spraying along
    // a fence should keep feeding the line in front of them.
    //
    // The fixture has to put the new event within reach of *both* lines or the
    // rule is untestable — with only one candidate in range, first-match and
    // last-match agree and a planted reversal changes nothing. So: one line at
    // 0, another at 14 (further than MERGE, so they stay separate), and the
    // repeat at 7, which is seven metres from each.
    const c = new Captions();
    say(c, 'spray', 0, -3, 0);
    say(c, 'spray', 2 * MERGE - 2, -3, 0.1);
    say(c, 'spray', MERGE - 1, -3, 0.2);
    expect(c.current).toHaveLength(2);
    expect(c.current[0]!.count).toBe(1);
    expect(c.current[1]!.count).toBe(2);
    // And which one absorbed it, which is the only part that distinguishes the
    // two rules: whichever line coalesces is moved to the end, so counts-by-
    // position come out the same either way. The line left alone is the tell —
    // it is the one at 0 if the newest matched, and the one at 14 if the
    // oldest did.
    expect(c.current[0]!.sx).toBe(0);
  });

  it('moves a line that just repeated to where the eye is', () => {
    const c = new Captions();
    say(c, 'place', 1, -3, 0);
    say(c, 'spray', 1, -3, 0.1);
    say(c, 'place', 1, -3, 0.2);
    expect(c.current.map((l) => l.kind)).toEqual(['spray', 'place']);
  });

  it('updates the direction when the same thing moves round you', () => {
    const c = new Captions();
    say(c, 'spray', 0, -3, 0);
    expect(c.current[0]!.where).toBe('ahead');
    say(c, 'spray', 0, 3, 0.1);
    expect(c.current[0]!.where).toBe('behind');
    expect(c.current[0]!.count).toBe(2);
  });
});

describe('what stays on the screen', () => {
  it('drops the oldest rather than refusing the newest', () => {
    // A caption list that went silent once four things were on it would go
    // silent exactly when the garden got busy, which is when it is needed.
    const c = new Captions();
    // All in one place on purpose: different kinds never fold together, so
    // spreading them out is not needed — and spreading them out is how the
    // first version of this put three of the five outside their own range and
    // then asserted on a list that had never contained them.
    const kinds: CaptionKind[] = ['place', 'remove', 'spray', 'splash', 'water'];
    kinds.forEach((k, i) => say(c, k, 1, -3, i * 0.1));
    expect(c.current).toHaveLength(MAX_LINES);
    expect(c.current[0]!.kind).toBe('remove');
    expect(c.current[MAX_LINES - 1]!.kind).toBe('water');
  });

  it('expires a line once it has been up long enough', () => {
    const c = new Captions();
    say(c, 'place', 1, -3, 0);
    c.expire(LIFE - 0.1);
    expect(c.current).toHaveLength(1);
    c.expire(LIFE + 0.1);
    expect(c.current).toHaveLength(0);
  });

  it('ages from the last time it happened, not the first', () => {
    const c = new Captions();
    say(c, 'spray', 1, -3, 0);
    say(c, 'spray', 1, -3, 2);
    c.expire(LIFE + 0.5);
    expect(c.current).toHaveLength(1);
  });

  it('keeps the list in the order things last happened', () => {
    // This is what makes expiry a single pass from the front, and it is worth
    // asserting directly rather than implying: a coalesce refreshes a line's
    // time and moves it to the end in the same breath, so an old line can never
    // end up behind a young one. `expire` had a second sweep from the back
    // guarding exactly that case, and a planted bug in it broke no test —
    // because the state it guarded cannot happen.
    const c = new Captions();
    say(c, 'place', 1, -3, 0);
    say(c, 'spray', 1, -3, 0.1);
    say(c, 'place', 1, -3, 3);
    say(c, 'splash', 1, -3, 3.5);
    const times = c.current.map((l) => l.at);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('forgets everything on request', () => {
    const c = new Captions();
    say(c, 'place', 1, -3, 0);
    c.clear();
    expect(c.current).toHaveLength(0);
  });
});
