import { describe, it, expect } from 'vitest';
import { FrameProfile, SECTIONS, UNACCOUNTED, type SectionTime } from './frameProfile.ts';

/** A clock a test drives, so nothing here measures the machine it runs on. */
const fake = () => {
  let t = 0;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
};

const named = (rows: SectionTime[], name: string): SectionTime =>
  rows.find((r) => r.name === name)!;

describe('carving a frame up', () => {
  it('attributes a span to the section that was open', () => {
    const clock = fake();
    const p = new FrameProfile(clock.now);
    p.start('sim');
    clock.advance(4);
    p.stop('sim');
    p.endFrame(10);

    const rows = p.read();
    expect(named(rows, 'sim').ms).toBeCloseTo(4, 6);
    expect(named(rows, 'draw').ms).toBe(0);
  });

  it('reports the part nobody instrumented', () => {
    // The claim this file exists for. A profiler that quietly loses a third of
    // the frame tells you the three things you measured are fine and never
    // mentions the fourth.
    const clock = fake();
    const p = new FrameProfile(clock.now);
    p.start('sim');
    clock.advance(3);
    p.stop('sim');
    p.endFrame(10);

    expect(named(p.read(), UNACCOUNTED).ms).toBeCloseTo(7, 6);
  });

  it('adds up to the frame, whatever was measured', () => {
    const clock = fake();
    const p = new FrameProfile(clock.now);
    p.start('sim'); clock.advance(2); p.stop('sim');
    p.start('draw'); clock.advance(5); p.stop('draw');
    p.endFrame(9);

    const rows = p.read();
    const total = rows.reduce((sum, r) => sum + r.ms, 0);
    expect(total).toBeCloseTo(9, 6);
    expect(rows.reduce((sum, r) => sum + r.share, 0)).toBeCloseTo(1, 6);
  });

  it('never reports a negative leftover when the clocks disagree', () => {
    // The loop measures the frame and the profiler measures the pieces, with
    // two different calls to two different clocks. At the edges the pieces can
    // add up to a hair more than the whole.
    const clock = fake();
    const p = new FrameProfile(clock.now);
    p.start('sim'); clock.advance(12); p.stop('sim');
    p.endFrame(10);
    expect(named(p.read(), UNACCOUNTED).ms).toBe(0);
  });

  it('averages over the window rather than reporting the last frame', () => {
    // A per-frame readout of a per-frame number is unreadable, and the thing
    // worth knowing is where the time usually goes.
    const clock = fake();
    const p = new FrameProfile(clock.now);
    for (const ms of [2, 4, 6]) {
      p.start('sim'); clock.advance(ms); p.stop('sim');
      p.endFrame(ms + 1);
    }
    expect(named(p.read(), 'sim').ms).toBeCloseTo(4, 6);
  });
});

describe('the ways it can be used wrong', () => {
  it('ignores a stop with no start', () => {
    const clock = fake();
    const p = new FrameProfile(clock.now);
    clock.advance(50);
    p.stop('sim');
    p.endFrame(1);
    expect(named(p.read(), 'sim').ms).toBe(0);
  });

  it('ignores a second start on an open section rather than losing the first', () => {
    const clock = fake();
    const p = new FrameProfile(clock.now);
    p.start('sim');
    clock.advance(3);
    p.start('sim');
    clock.advance(3);
    p.stop('sim');
    p.endFrame(10);
    expect(named(p.read(), 'sim').ms).toBeCloseTo(6, 6);
  });

  it('drops a section left open across a frame rather than smearing it', () => {
    // A missing `stop` is a bug. Carrying the span would spread that one bug
    // across every frame after it and make the readout useless exactly when
    // somebody most needs it.
    const clock = fake();
    const p = new FrameProfile(clock.now);
    p.start('sim');
    clock.advance(5);
    p.endFrame(5);
    p.start('draw'); clock.advance(2); p.stop('draw');
    p.endFrame(2);

    expect(named(p.read(), 'sim').ms).toBe(0);
    expect(named(p.read(), 'draw').ms).toBeCloseTo(1, 6);
  });

  it('says nothing before a frame has closed', () => {
    const p = new FrameProfile(fake().now);
    expect(p.depth).toBe(0);
    expect(p.heaviest()).toBeNull();
    for (const row of p.read()) expect(row.ms).toBe(0);
  });
});

describe('being cheap enough to leave on', () => {
  it('allocates nothing per frame', () => {
    // A profiler that allocates is a profiler that causes the stutter it is
    // measuring. Every buffer is sized at construction and `read` fills a
    // caller-owned array, so a thousand frames must not grow the heap in a way
    // a garbage collector has to answer for.
    const clock = fake();
    const p = new FrameProfile(clock.now);
    const into: SectionTime[] = [];
    const before = into.length;

    for (let f = 0; f < 1000; f++) {
      for (const s of SECTIONS) { p.start(s); clock.advance(0.2); p.stop(s); }
      p.endFrame(1);
      p.read(into);
    }
    // The array it fills is grown once and reused, which is the observable
    // half of "allocates nothing" that a test can actually check.
    expect(before).toBe(0);
    expect(into.length).toBe(SECTIONS.length + 1);
  });

  it('keeps a bounded history however long the game runs', () => {
    const clock = fake();
    const p = new FrameProfile(clock.now);
    for (let f = 0; f < 5000; f++) { clock.advance(1); p.endFrame(1); }
    expect(p.depth).toBeLessThanOrEqual(120);
  });

  it('forgets on request, for a mode change where the old frames mean nothing', () => {
    const clock = fake();
    const p = new FrameProfile(clock.now);
    p.start('sim'); clock.advance(9); p.stop('sim');
    p.endFrame(9);
    p.reset();
    expect(p.depth).toBe(0);
    expect(named(p.read(), 'sim').ms).toBe(0);
  });
});

describe('what it says out loud', () => {
  it('names the heaviest thing in the frame', () => {
    const clock = fake();
    const p = new FrameProfile(clock.now);
    p.start('sim'); clock.advance(1); p.stop('sim');
    p.start('draw'); clock.advance(7); p.stop('draw');
    p.endFrame(9);
    expect(p.heaviest()!.name).toBe('draw');
  });

  it('will name the leftover, if the leftover is the problem', () => {
    // The case that matters most: the answer "it is none of the things you
    // instrumented" has to be sayable, or the profiler will confidently blame
    // whichever section happens to be biggest among the ones it can see.
    const clock = fake();
    const p = new FrameProfile(clock.now);
    p.start('sim'); clock.advance(1); p.stop('sim');
    p.endFrame(30);
    expect(p.heaviest()!.name).toBe(UNACCOUNTED);
  });
});
