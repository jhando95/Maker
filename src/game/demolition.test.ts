import { describe, it, expect } from 'vitest';
import {
  PULL_REACH, PULL_TIME, bestTarget, canPull, pullProgress, pulledFree,
  type Pullable,
} from './demolition.ts';

const part = (over: Partial<Pullable> = {}): Pullable =>
  ({ id: 1, distance: 0.5, fixed: false, brings: 1, ...over });

describe('what a kid may pull', () => {
  it('allows a plank somebody built, within arm\'s length', () => {
    expect(canPull(part())).toBe(true);
  });

  it('refuses the map, however close it is', () => {
    // A kid who can take the fence apart eventually takes the house apart, and
    // the level ends up with a hole in it that nobody put there.
    expect(canPull(part({ fixed: true, distance: 0 }))).toBe(false);
  });

  it('refuses anything out of reach', () => {
    expect(canPull(part({ distance: PULL_REACH + 0.01 }))).toBe(false);
    expect(canPull(part({ distance: PULL_REACH }))).toBe(true);
  });

  it('is a shorter reach than a player has, so it reads as hands on a plank', () => {
    // Not a number for its own sake: a bot that can pull from four metres is
    // picking a fort apart from outside it.
    expect(PULL_REACH).toBeLessThan(2);
  });
});

describe('which one to haul on', () => {
  it('takes the part that brings the most down, not the nearest', () => {
    // The whole design. Nearest-first makes a fort a pool of hit points and the
    // answer is more planks; most-load-bearing makes it a structure and the
    // answer is a second way to the ground.
    const near = part({ id: 1, distance: 0.2, brings: 1 });
    const leg = part({ id: 2, distance: 1.2, brings: 14 });
    expect(bestTarget([near, leg])).toBe(leg);
  });

  it('breaks a tie on load with distance, and then with id', () => {
    const far = part({ id: 3, distance: 1.0, brings: 4 });
    const close = part({ id: 9, distance: 0.4, brings: 4 });
    expect(bestTarget([far, close])).toBe(close);

    const a = part({ id: 9, distance: 0.4, brings: 4 });
    const b = part({ id: 2, distance: 0.4, brings: 4 });
    // Two machines watching the same fort must not disagree about which plank
    // went, and "whichever the broadphase listed first" is not an agreement.
    expect(bestTarget([a, b])).toBe(b);
  });

  it('ignores everything it may not pull', () => {
    const wall = part({ id: 1, fixed: true, brings: 40 });
    const away = part({ id: 2, distance: 9, brings: 30 });
    const plank = part({ id: 3, brings: 1 });
    expect(bestTarget([wall, away, plank])).toBe(plank);
  });

  it('says nothing when there is nothing to pull', () => {
    expect(bestTarget([])).toBeNull();
    expect(bestTarget([part({ fixed: true })])).toBeNull();
  });
});

describe('the pull itself', () => {
  it('runs from nothing to done over its own time', () => {
    expect(pullProgress(0)).toBe(0);
    expect(pullProgress(PULL_TIME / 2)).toBeCloseTo(0.5, 6);
    expect(pullProgress(PULL_TIME)).toBe(1);
  });

  it('does not run past done, or before started', () => {
    expect(pullProgress(PULL_TIME * 4)).toBe(1);
    expect(pullProgress(-3)).toBe(0);
  });

  it('comes away exactly when it says it does', () => {
    expect(pulledFree(PULL_TIME - 0.001)).toBe(false);
    expect(pulledFree(PULL_TIME)).toBe(true);
  });

  it('takes long enough that a player can come and stop it', () => {
    // The other half of why this is not instant: a fort under attack has to be
    // a thing you can respond to, or it is just a timer running down.
    expect(PULL_TIME).toBeGreaterThan(1.5);
  });
});
