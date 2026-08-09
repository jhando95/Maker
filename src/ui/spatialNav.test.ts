import { describe, it, expect } from 'vitest';
import {
  CROSS_WEIGHT, FIRST_REPEAT, NAV_DEADZONE, REPEAT, StepRepeat,
  nextInDirection, type Rect,
} from './spatialNav.ts';

const at = (x: number, y: number, width = 100, height = 20): Rect => ({ x, y, width, height });

/** A plain column, as most of these menus are. */
const column: Rect[] = [at(0, 0), at(0, 30), at(0, 60), at(0, 90)];

describe('a column', () => {
  it('goes down one at a time', () => {
    expect(nextInDirection(column, 0, 'down')).toBe(1);
    expect(nextInDirection(column, 1, 'down')).toBe(2);
    expect(nextInDirection(column, 2, 'down')).toBe(3);
  });

  it('and up again', () => {
    expect(nextInDirection(column, 3, 'up')).toBe(2);
    expect(nextInDirection(column, 1, 'up')).toBe(0);
  });

  it('stops at the ends without wrapping', () => {
    expect(nextInDirection(column, 3, 'down')).toBeNull();
    expect(nextInDirection(column, 0, 'up')).toBeNull();
  });

  it('comes round when asked to wrap', () => {
    expect(nextInDirection(column, 3, 'down', true)).toBe(0);
    expect(nextInDirection(column, 0, 'up', true)).toBe(3);
  });

  it('has nothing to the sides', () => {
    expect(nextInDirection(column, 1, 'left')).toBeNull();
    expect(nextInDirection(column, 1, 'right')).toBeNull();
  });
});

describe('a row of buttons on a row of rows', () => {
  // The Blueprints screen: a name and three buttons per line, three lines. This
  // is the layout a flat next/previous list gets wrong — down from a name would
  // land on the Hold beside it.
  const rects: Rect[] = [];
  for (let line = 0; line < 3; line++) {
    rects.push(at(0, line * 40, 200, 20));    // the name
    rects.push(at(210, line * 40, 60, 20));   // Hold
    rects.push(at(280, line * 40, 60, 20));   // Rename
    rects.push(at(350, line * 40, 60, 20));   // Delete
  }

  it('moves along a line to the right', () => {
    expect(nextInDirection(rects, 0, 'right')).toBe(1);
    expect(nextInDirection(rects, 1, 'right')).toBe(2);
    expect(nextInDirection(rects, 2, 'right')).toBe(3);
    expect(nextInDirection(rects, 3, 'right')).toBeNull();
  });

  it('and down to the next line rather than sideways along this one', () => {
    // The whole reason this is geometric. In DOM order the next entry after the
    // first name is the Hold button beside it.
    expect(nextInDirection(rects, 0, 'down')).toBe(4);
    expect(nextInDirection(rects, 4, 'down')).toBe(8);
  });

  it('keeps its column when it moves between lines', () => {
    // Down from the second line's Delete is the third line's Delete, not its
    // name — a highlight that slides back to the left every row would make
    // deleting three blueprints take twelve presses.
    expect(nextInDirection(rects, 7, 'down')).toBe(11);
    expect(nextInDirection(rects, 7, 'up')).toBe(3);
  });
});

describe('choosing between several candidates', () => {
  it('prefers the one directly below to a nearer one off to the side', () => {
    const rects: Rect[] = [
      at(0, 0, 100, 20),      // current
      at(400, 24, 100, 20),   // closer down the page, far to the right
      at(0, 40, 100, 20),     // further down, directly below
    ];
    expect(nextInDirection(rects, 0, 'down')).toBe(2);
  });

  it('but not at any distance, or a menu would jump the page', () => {
    // The sideways penalty is a weight, not a veto. At three to one, something
    // aligned has to be within three times the offset to win.
    const rects: Rect[] = [
      at(0, 0, 100, 20),
      at(400, 24, 100, 20),    // 24 down, 400 across
      at(0, 4000, 100, 20),    // aligned, and a screen and a half away
    ];
    expect(nextInDirection(rects, 0, 'down')).toBe(1);
  });

  it('treats anything overlapping the current item as perfectly aligned', () => {
    // Two buttons of different widths in one column are still one column.
    const rects: Rect[] = [
      at(0, 0, 300, 20),
      at(280, 40, 40, 20),   // only just overlaps, but it does
      at(0, 60, 300, 20),
    ];
    expect(nextInDirection(rects, 0, 'down')).toBe(1);
    expect(CROSS_WEIGHT).toBeGreaterThan(1);
  });

  it('ignores what is level with it, in every direction', () => {
    const rects: Rect[] = [at(0, 0), at(0, 0), at(0, 30)];
    expect(nextInDirection(rects, 0, 'down')).toBe(2);
    expect(nextInDirection(rects, 0, 'up')).toBeNull();
  });
});

describe('the awkward cases', () => {
  it('says nothing rather than throwing when there is nothing to say', () => {
    expect(nextInDirection([], 0, 'down')).toBeNull();
    expect(nextInDirection([at(0, 0)], 0, 'down')).toBeNull();
    expect(nextInDirection(column, 99, 'down')).toBeNull();
    expect(nextInDirection(column, -1, 'down')).toBeNull();
  });

  it('never returns where it started, wrapping or not', () => {
    for (const dir of ['up', 'down', 'left', 'right'] as const) {
      for (let i = 0; i < column.length; i++) {
        expect(nextInDirection(column, i, dir)).not.toBe(i);
        expect(nextInDirection(column, i, dir, true)).not.toBe(i);
      }
    }
  });

  it('gets everywhere in a column by going down and wrapping', () => {
    const seen = new Set<number>();
    let at_ = 0;
    for (let i = 0; i < column.length * 2; i++) {
      seen.add(at_);
      at_ = nextInDirection(column, at_, 'down', true)!;
    }
    expect(seen.size).toBe(column.length);
  });
});

describe('a held stick', () => {
  const dt = 1 / 60;

  it('does nothing inside the deadzone', () => {
    const r = new StepRepeat();
    expect(r.step(NAV_DEADZONE - 0.01, dt)).toBe(0);
    expect(r.step(-NAV_DEADZONE + 0.01, dt)).toBe(0);
  });

  it('steps once the moment it is pushed', () => {
    // A menu that waits before responding at all feels broken rather than
    // deliberate. The delay is only before the second step.
    const r = new StepRepeat();
    expect(r.step(1, dt)).toBe(1);
    expect(r.step(1, dt)).toBe(0);
  });

  it('then repeats, after a pause and at a rate', () => {
    const r = new StepRepeat();
    r.step(1, dt);
    let steps = 0;
    let elapsed = 0;
    for (let i = 0; i < 60; i++) { elapsed += dt; steps += r.step(1, dt) === 1 ? 1 : 0; }
    // One second at a pause of 0.42 and a rate of 0.13 is four or five more.
    const expected = Math.floor((elapsed - FIRST_REPEAT) / REPEAT);
    expect(steps).toBeGreaterThanOrEqual(expected - 1);
    expect(steps).toBeLessThanOrEqual(expected + 1);
  });

  it('waits longer for the second step than for the ones after it', () => {
    const r = new StepRepeat();
    r.step(1, dt);
    let toSecond = 0;
    while (r.step(1, dt) === 0) toSecond++;
    let toThird = 0;
    while (r.step(1, dt) === 0) toThird++;
    expect(toSecond).toBeGreaterThan(toThird);
  });

  it('starts again the moment it is let go', () => {
    const r = new StepRepeat();
    r.step(1, dt);
    for (let i = 0; i < 10; i++) r.step(1, dt);
    expect(r.step(0, dt)).toBe(0);
    expect(r.step(1, dt)).toBe(1);
  });

  it('and reversing is letting go', () => {
    // Pushing up straight after down should move once immediately rather than
    // waiting out whatever was left of the downward repeat.
    const r = new StepRepeat();
    r.step(1, dt);
    expect(r.step(-1, dt)).toBe(-1);
    expect(r.step(-1, dt)).toBe(0);
  });

  it('forgets a held direction when it is reset, not just the time left', () => {
    // Closing a menu mid-repeat and re-opening it must not resume the scroll.
    //
    // Asserted on the *pause after* rather than on the step itself, which is
    // what the first version did and could not fail: clearing only the timer
    // also produces an immediate step, and the two are then indistinguishable
    // until the step after that. What separates them is whether the reopened
    // menu treats the stick as a fresh press — a long pause — or as a repeat
    // already in flight.
    const pauseAfterPress = (r: StepRepeat): number => {
      let frames = 0;
      while (r.step(1, dt) === 0) frames++;
      return frames;
    };

    const fresh = new StepRepeat();
    fresh.step(1, dt);
    const afterFirst = pauseAfterPress(fresh);

    const reopened = new StepRepeat();
    reopened.step(1, dt);
    pauseAfterPress(reopened);            // now mid-repeat, on the short rate
    reopened.reset();
    expect(reopened.step(1, dt)).toBe(1);
    expect(pauseAfterPress(reopened)).toBe(afterFirst);
    // And that really is the long pause rather than the short one.
    expect(afterFirst).toBeGreaterThan(FIRST_REPEAT / dt * 0.5);
  });

  it('steps the same way on any frame rate, given the same time', () => {
    const fast = new StepRepeat();
    const slow = new StepRepeat();
    let fastSteps = 0;
    let slowSteps = 0;
    for (let i = 0; i < 120; i++) fastSteps += fast.step(1, 1 / 120) !== 0 ? 1 : 0;
    for (let i = 0; i < 30; i++) slowSteps += slow.step(1, 1 / 30) !== 0 ? 1 : 0;
    expect(Math.abs(fastSteps - slowSteps)).toBeLessThanOrEqual(1);
  });
});
