import { describe, it, expect } from 'vitest';
import { FrameStats, REFRESH, WINDOW } from './frameStats.ts';

/** Feed n frames of the same length. Returns how many times it refreshed. */
function steady(stats: FrameStats, dt: number, frames: number): number {
  let refreshes = 0;
  for (let i = 0; i < frames; i++) if (stats.frame(dt)) refreshes++;
  return refreshes;
}

describe('FrameStats', () => {
  it('says nothing until it has seen a frame', () => {
    const stats = new FrameStats();
    expect(stats.current).toEqual({ fps: 0, ms: 0, low: 0 });
  });

  it('reports a steady sixty as sixty', () => {
    const stats = new FrameStats();
    steady(stats, 1 / 60, 90);
    expect(stats.current.fps).toBeCloseTo(60, 4);
    expect(stats.current.ms).toBeCloseTo(1000 / 60, 4);
    expect(stats.current.low).toBeCloseTo(60, 4);
  });

  it('refreshes a few times a second rather than every frame', () => {
    // A readout that rewrites itself sixty times a second is unreadable — the
    // digits blur and the eye cannot settle on one.
    //
    // A range rather than an exact count, and honestly so: a quarter second is
    // not a whole number of frames at any real frame rate, so whether the
    // fifteenth or the sixteenth crosses the line is floating point and not
    // design. What is design is that it is nearer four than sixty.
    const stats = new FrameStats();
    const refreshes = steady(stats, 1 / 60, 60);
    const expected = 1 / REFRESH;
    expect(refreshes).toBeGreaterThanOrEqual(expected - 1);
    expect(refreshes).toBeLessThanOrEqual(expected + 1);
  });

  it('shows the stutter the average hides', () => {
    // The reason there are two numbers. Fifty-nine good frames and one terrible
    // one average out to something that looks fine and feels broken; the whole
    // job of the low is to disagree with the mean at exactly that moment.
    const stats = new FrameStats();
    for (let i = 0; i < 59; i++) stats.frame(1 / 240);
    stats.frame(0.2);

    expect(stats.current.fps).toBeGreaterThan(40);
    expect(stats.current.low).toBeCloseTo(5, 1);
  });

  it('forgets a stutter once it has scrolled out of the window', () => {
    // Otherwise one bad frame during loading brands the readout for the rest of
    // the session, and a number that never recovers is a number nobody trusts.
    const stats = new FrameStats();
    stats.frame(0.2);
    steady(stats, 1 / 60, WINDOW + 4);
    expect(stats.current.low).toBeCloseTo(60, 2);
  });

  it('ignores the frame that spans a trip to another tab', () => {
    // A backgrounded tab hands back one enormous frame on return. That is not a
    // stutter anybody experienced, and left in it pins the low at 1 fps for two
    // seconds every time somebody alt-tabs back in.
    const stats = new FrameStats();
    steady(stats, 1 / 60, 90);
    const before = stats.current.low;
    stats.frame(12);
    expect(stats.current.low).toBeCloseTo(before, 4);
  });

  it('ignores a frame with no time in it', () => {
    // Two reads in the same millisecond, which happens on a fast machine with a
    // coarse clock. A zero would divide into an infinite frame rate.
    const stats = new FrameStats();
    steady(stats, 1 / 60, 90);
    stats.frame(0);
    expect(Number.isFinite(stats.current.fps)).toBe(true);
    expect(Number.isFinite(stats.current.low)).toBe(true);
  });

  it('keeps only the last two seconds', () => {
    // The window is what makes the low meaningful: measured over a whole
    // session it is a record of the worst thing that ever happened, which is
    // history rather than a reading.
    const stats = new FrameStats();
    steady(stats, 1 / 30, WINDOW * 2);
    expect(stats.current.fps).toBeCloseTo(30, 4);
  });

  it('starts over when told to', () => {
    const stats = new FrameStats();
    steady(stats, 1 / 20, 60);
    stats.reset();
    expect(stats.current).toEqual({ fps: 0, ms: 0, low: 0 });
  });
});
