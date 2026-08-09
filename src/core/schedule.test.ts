import { describe, it, expect } from 'vitest';
import { Schedule, step, type Measure, type Stage } from './schedule.ts';

interface Ctx { log: string[]; hosting: boolean }
const ctx = (hosting = false): Ctx => ({ log: [], hosting });

const says = (name: string, extra: Partial<Stage<Ctx>> = {}): Stage<Ctx> =>
  step<Ctx>(name, (c) => c.log.push(name), extra);

/** A stopwatch that records what was opened and closed, in order. */
function recorder(): Measure & { events: string[]; open: string[] } {
  const events: string[] = [];
  const open: string[] = [];
  return {
    events,
    open,
    start(s) { events.push(`+${s}`); open.push(s); },
    stop(s) { events.push(`-${s}`); open.splice(open.lastIndexOf(s), 1); },
  };
}

describe('running in order', () => {
  it('runs every stage, once, in the order given', () => {
    const c = ctx();
    new Schedule([says('a'), says('b'), says('c')]).run(c);
    expect(c.log).toEqual(['a', 'b', 'c']);
  });

  it('says what the order is without running it', () => {
    expect(new Schedule([says('a'), says('b')]).names).toEqual(['a', 'b']);
  });

  it('skips a stage that says not now, and does not measure it either', () => {
    const c = ctx(false);
    const m = recorder();
    new Schedule([
      says('always'),
      says('hosting', { when: (x: Ctx) => x.hosting }),
    ]).run(c, m);
    expect(c.log).toEqual(['always']);
    expect(m.events).toEqual(['+always', '-always']);
  });

  it('runs the conditional one when the condition holds', () => {
    const c = ctx(true);
    new Schedule([says('hosting', { when: (x: Ctx) => x.hosting })]).run(c);
    expect(c.log).toEqual(['hosting']);
  });
});

describe('measuring', () => {
  it('opens and closes each stage under its own name', () => {
    const m = recorder();
    new Schedule([says('a'), says('b')]).run(ctx(), m);
    expect(m.events).toEqual(['+a', '-a', '+b', '-b']);
  });

  it('puts several stages in one section when they ask for one', () => {
    // The readout has a fixed handful of sections and the schedule has more
    // stages than that.
    const m = recorder();
    new Schedule([
      says('drain', { section: 'net' }),
      says('publish', { section: 'net' }),
    ]).run(ctx(), m);
    expect(m.events).toEqual(['+net', '-net', '+net', '-net']);
  });

  it('closes a section even when the stage throws', () => {
    // The whole reason this is a runner rather than two calls. Five of the six
    // hand-written pairs this replaces had no `finally`, so a throw left a
    // section open across the frame and blanked the readout for the one frame
    // that explains the throw.
    const m = recorder();
    const boom = new Schedule<Ctx>([step('boom', () => { throw new Error('no'); })]);
    expect(() => boom.run(ctx(), m)).toThrow('no');
    expect(m.open).toEqual([]);
    expect(m.events).toEqual(['+boom', '-boom']);
  });

  it('lets the throw out, because a schedule is not an error handler', () => {
    const boom = new Schedule<Ctx>([step('boom', () => { throw new Error('up'); })]);
    expect(() => boom.run(ctx())).toThrow('up');
  });

  it('runs perfectly well with nobody watching', () => {
    const c = ctx();
    new Schedule([says('a')]).run(c);
    expect(c.log).toEqual(['a']);
  });
});

describe('names', () => {
  it('refuses two stages with the same one', () => {
    // Two stages reporting under one name add their costs together in the
    // readout and make `check` unable to say which of them is out of order.
    expect(() => new Schedule([says('a'), says('a')])).toThrow(/two stages/);
  });

  it('allows two stages to share a section, which is a different thing', () => {
    expect(() => new Schedule([
      says('a', { section: 'net' }), says('b', { section: 'net' }),
    ])).not.toThrow();
  });
});

describe('checking the order without running it', () => {
  const drain = says('drain', { writes: ['wire'] });
  const tick = says('tick', { reads: ['wire'], writes: ['world'] });
  const draw = says('draw', { reads: ['world'] });

  it('is happy with an order that works', () => {
    expect(new Schedule([drain, tick, draw]).check()).toEqual([]);
  });

  it('catches a stage that reads something written after it', () => {
    const problems = new Schedule([tick, drain, draw]).check();
    expect(problems).toEqual([{ stage: 'tick', resource: 'wire', kind: 'late' }]);
  });

  it('and one that reads something nothing writes at all', () => {
    const problems = new Schedule([says('odd', { reads: ['nowhere'] })]).check();
    expect(problems).toEqual([{ stage: 'odd', resource: 'nowhere', kind: 'missing' }]);
  });

  it('tells those two apart, because the fixes are different', () => {
    // `late` is a reordering; `missing` is a stage nobody wrote.
    const late = new Schedule([tick, drain]).check();
    const missing = new Schedule([says('odd', { reads: ['nowhere'] })]).check();
    expect(late[0]!.kind).toBe('late');
    expect(missing[0]!.kind).toBe('missing');
  });

  it('counts a stage that only sometimes runs as a writer', () => {
    // A stage that runs only while hosting still satisfies a later reader, and
    // refusing to say so would report a problem on every guest.
    const sometimes = says('host', { writes: ['wire'], when: (c: Ctx) => c.hosting });
    expect(new Schedule([sometimes, tick]).check()).toEqual([]);
    // And in the other order it is `late` rather than `missing` — which is the
    // half the first version of this could not see, because both loops treated
    // a conditional writer the same and only the `late`/`missing` split ever
    // reads the difference. The two have different fixes: `late` is a
    // reordering, `missing` is a stage nobody wrote.
    expect(new Schedule([tick, sometimes]).check()).toEqual([
      { stage: 'tick', resource: 'wire', kind: 'late' },
    ]);
  });

  it('lets a stage read what it writes itself, once something earlier wrote it', () => {
    // A stage that both reads and writes one thing is the common case — every
    // integrator does — and it must not be treated as its own writer, or a
    // schedule that has forgotten to build the world at all looks fine.
    const build = says('build', { writes: ['world'] });
    const both = says('both', { reads: ['world'], writes: ['world'] });
    expect(new Schedule([build, both]).check()).toEqual([]);
    expect(new Schedule([both, build]).check()).toEqual([
      { stage: 'both', resource: 'world', kind: 'late' },
    ]);
    expect(new Schedule([both]).check()).toEqual([
      { stage: 'both', resource: 'world', kind: 'late' },
    ]);
  });

  it('reports every unmet read rather than only the first', () => {
    const greedy = says('greedy', { reads: ['wire', 'world', 'nowhere'] });
    expect(new Schedule([greedy]).check()).toHaveLength(3);
  });

  it('has nothing to say about a schedule that declares nothing', () => {
    // Declaring is opt-in: most stages only touch their own state, and
    // demanding a declaration from all of them would make the list noise.
    expect(new Schedule([says('a'), says('b')]).check()).toEqual([]);
  });
});

describe('swapping a stage out', () => {
  it('replaces it in place, keeping the order', () => {
    const s = new Schedule([says('a'), says('b'), says('c')]);
    const c = ctx();
    s.replacing('b', says('B')).run(c);
    expect(c.log).toEqual(['a', 'B', 'c']);
  });

  it('leaves the original alone', () => {
    const s = new Schedule([says('a'), says('b')]);
    s.replacing('b', says('B'));
    const c = ctx();
    s.run(c);
    expect(c.log).toEqual(['a', 'b']);
  });

  it('refuses a name that is not there', () => {
    expect(() => new Schedule([says('a')]).replacing('z', says('Z'))).toThrow(/no stage/);
  });
});
