import { describe, it, expect } from 'vitest';
import {
  RECOVER_RATE, SINK_TIME, TOUCH_RADIUS,
  leaders, onLava, parTime, progressOf, sink, touching,
} from './lavaRules.ts';
import { COURSE, LAVA_SPAWN } from './lava.ts';
import { CAP_HEIGHT } from '../physics/constants.ts';

describe('what counts as lava', () => {
  it('is the ground under your feet, not a height', () => {
    // A height rule is easier and wrong in both directions: it makes a low crate
    // deadly and a plank laid flat on the grass safe, and a plank laid flat on
    // the grass is the first move every player makes.
    expect(onLava(true, false)).toBe(true);
    expect(onLava(false, false)).toBe(false);
  });

  it('is not something you can be in mid-air', () => {
    // A jump off a plank is neither a reprieve nor a death. Without this, a
    // player launched off the trampoline over the lawn would be sinking the
    // whole way up, which is a rule about where you *are* rather than what you
    // are standing on.
    expect(onLava(true, true)).toBe(false);
    expect(onLava(false, true)).toBe(false);
  });
});

describe('sinking', () => {
  it('takes the stated time to go under from dry', () => {
    let depth = 0;
    const dt = 1 / 60;
    let seconds = 0;
    while (depth < 1 && seconds < 10) {
      depth = sink(depth, dt, true);
      seconds += dt;
    }
    expect(depth).toBe(1);
    expect(seconds).toBeGreaterThan(SINK_TIME - 0.05);
    expect(seconds).toBeLessThan(SINK_TIME + 0.05);
  });

  it('climbs out faster than it goes in', () => {
    // At parity a course of tight hops kills you three jumps after a mistake
    // you have already corrected, which reads as the game cheating.
    const sunk = sink(0, SINK_TIME / 2, true);
    const dried = sink(sunk, SINK_TIME / 2, false);
    expect(sunk).toBeCloseTo(0.5, 5);
    expect(dried).toBe(0);
    expect(RECOVER_RATE).toBeGreaterThan(1);
  });

  it('never goes below dry or past under', () => {
    expect(sink(0, 5, false)).toBe(0);
    expect(sink(1, 5, true)).toBe(1);
  });

  it('gives a single frame of grass no meaningful cost', () => {
    // The whole reason it is a meter rather than a switch: clipping a corner of
    // lawn on the way through a gap is a thing you did right, not a mistake.
    const oneFrame = sink(0, 1 / 60, true);
    expect(oneFrame).toBeLessThan(0.02);
  });
});

describe('progress round the course', () => {
  it('counts a cleared checkpoint as a whole one', () => {
    // Standing on the far end of the leg is a whole leg of progress on top of
    // whatever was already cleared, because you are about to clear it too.
    expect(progressOf(2, 10, 10)).toBe(2);
    expect(progressOf(2, 0, 10)).toBe(3);
  });

  it('counts the walk between them as a fraction', () => {
    expect(progressOf(1, 5, 10)).toBeCloseTo(1.5, 6);
    expect(progressOf(0, 10, 10)).toBe(0);
    expect(progressOf(0, 0, 10)).toBe(1);
  });

  it('does not go backwards past the checkpoint you cleared', () => {
    // Overshooting the next one and coming back is not negative progress.
    expect(progressOf(1, 40, 10)).toBe(1);
  });

  it('survives a zero-length leg rather than dividing by it', () => {
    expect(Number.isFinite(progressOf(1, 0, 0))).toBe(true);
  });
});

describe('touching a checkpoint', () => {
  it('is a sphere, and a fat one', () => {
    const at = { name: 'x', x: 0, y: 0, z: 0 };
    expect(touching(0, 0, 0, at)).toBe(true);
    expect(touching(TOUCH_RADIUS - 0.01, 0, 0, at)).toBe(true);
    expect(touching(TOUCH_RADIUS + 0.01, 0, 0, at)).toBe(false);
  });

  it('counts height as distance, so a tower beside one is not on it', () => {
    // Otherwise the treehouse is claimable from directly underneath it, which
    // is the one place in the yard you can reach without solving anything.
    const at = { name: 'x', x: 0, y: 10, z: 0 };
    expect(touching(0, 0, 0, at)).toBe(false);
  });
});

describe('who won when the clock went', () => {
  it('is whoever got furthest', () => {
    expect(leaders(new Map([[0, 1.2], [1, 2.4], [2, 0.1]]))).toEqual([1]);
  });

  it('is everybody, when it is a tie', () => {
    // A genuine tie is a genuine tie. Inventing a rule to separate two players
    // who did the same thing is worse than saying so.
    expect(leaders(new Map([[0, 2], [1, 2], [2, 1]]))).toEqual([0, 1]);
  });

  it('is nobody, when nobody played', () => {
    expect(leaders(new Map())).toEqual([]);
  });
});

describe('the course itself', () => {
  it('finishes somewhere other than where the lawn sends you', () => {
    // The bug this rule exists for. With the deck as both the spawn and the
    // finish, being dunked on the last leg *awarded* the last checkpoint —
    // falling in the lava won you the round.
    const finish = COURSE[COURSE.length - 1]!;
    const backToSpawn = Math.hypot(
      finish.x - LAVA_SPAWN.x, finish.y - LAVA_SPAWN.y, finish.z - LAVA_SPAWN.z,
    );
    expect(backToSpawn, 'the finish is inside the respawn').toBeGreaterThan(TOUCH_RADIUS * 2);
  });

  it('never puts two checkpoints close enough to claim together', () => {
    for (let i = 1; i < COURSE.length; i++) {
      const a = COURSE[i - 1]!;
      const b = COURSE[i]!;
      const gap = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
      expect(gap, `${a.name} and ${b.name} overlap`).toBeGreaterThan(TOUCH_RADIUS * 2);
    }
  });

  it('makes the first leg a crossing rather than a step', () => {
    // If the opening checkpoint were within a jump of the deck, the mode would
    // teach nothing before its second leg.
    const first = COURSE[0]!;
    const fromSpawn = Math.hypot(
      first.x - LAVA_SPAWN.x, first.y - LAVA_SPAWN.y, first.z - LAVA_SPAWN.z,
    );
    expect(fromSpawn).toBeGreaterThan(8);
  });

  it('puts every checkpoint out of reach of somebody standing on the lawn', () => {
    // The whole mode is void if a checkpoint can be claimed from the grass:
    // touch is a sphere, so one sitting less than its radius above the ground
    // is one you collect by walking under it and taking the dunk.
    for (const at of COURSE) {
      expect(at.y, `${at.name} can be claimed from the lawn`)
        .toBeGreaterThan(TOUCH_RADIUS - CAP_HEIGHT * 0.5);
    }
  });
});

describe('par', () => {
  it('grows with the course rather than being a fixed number', () => {
    // A fixed par silently becomes impossible the first time a checkpoint is
    // added, and nothing says so.
    expect(parTime(3)).toBeGreaterThan(parTime(2));
    expect(parTime(0)).toBeGreaterThan(0);
  });
});
