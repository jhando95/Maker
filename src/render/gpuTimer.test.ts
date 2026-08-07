import { describe, it, expect } from 'vitest';
import { GpuTimer, TIME_ELAPSED, GPU_DISJOINT, EXTENSION, type TimerGl } from './gpuTimer.ts';

/**
 * A WebGL2 context with no GPU behind it.
 *
 * Every rule in `gpuTimer.ts` is about sequencing — what may be asked when,
 * what is thrown away, what happens when the pool runs dry — so a fake that is
 * strict about the sequence is worth more than a real context that is not. It
 * throws on the two things that would be silent bugs against a driver: reading
 * a result before it is available, which stalls the pipeline, and opening a
 * second `TIME_ELAPSED` query while one is active, which the spec forbids.
 */
function fakeGl(opts: { extension?: boolean; queries?: number } = {}) {
  const { extension = true, queries = Infinity } = opts;
  let made = 0;
  let active: object | null = null;
  let disjoint = false;
  const ready = new Map<object, number | null>();
  const issued: object[] = [];
  const deleted: object[] = [];
  const stalls: object[] = [];

  const gl = {
    QUERY_RESULT_AVAILABLE: 0x9867,
    QUERY_RESULT: 0x8866,
    getExtension: (name: string) => (extension && name === EXTENSION ? {} : null),
    createQuery: () => (made < queries ? ({ id: made++ } as unknown as WebGLQuery) : null),
    deleteQuery: (q: WebGLQuery | null) => {
      if (q) deleted.push(q);
    },
    beginQuery: (target: number, q: WebGLQuery) => {
      expect(target).toBe(TIME_ELAPSED);
      if (active) throw new Error('a TIME_ELAPSED query was already active');
      active = q;
      ready.set(q, null);
      issued.push(q);
    },
    endQuery: (target: number) => {
      expect(target).toBe(TIME_ELAPSED);
      if (!active) throw new Error('endQuery with nothing active');
      active = null;
    },
    getQueryParameter: (q: WebGLQuery, pname: number) => {
      if (pname === gl.QUERY_RESULT_AVAILABLE) return ready.get(q) != null;
      // Asking for the value before the driver says it has one blocks the CPU
      // until the GPU drains. Recorded rather than thrown so a test can assert
      // it never happens across a whole run.
      if (ready.get(q) == null) stalls.push(q);
      return ready.get(q) ?? 0;
    },
    getParameter: (pname: number) => {
      if (pname !== GPU_DISJOINT) return 0;
      const was = disjoint;
      // Reading clears it, exactly as the extension specifies. The ordering bug
      // this catches is only reachable because of that.
      disjoint = false;
      return was;
    },
  } satisfies TimerGl;

  return {
    gl: gl as TimerGl,
    /**
     * Mark the nth query *issued* as finished, with a result in nanoseconds.
     *
     * Issue order rather than slot id, because the ring recycles: the second
     * measured frame usually lands back in the slot the first one used, and a
     * test that addressed slots would be marking a query nobody is waiting on.
     */
    finish: (nth: number, ns: number) => {
      const q = issued[nth];
      if (q) ready.set(q, ns);
    },
    disrupt: () => {
      disjoint = true;
    },
    get deleted() {
      return deleted;
    },
    get stalls() {
      return stalls;
    },
    get made() {
      return made;
    },
  };
}

/** Issue one measured frame and collect. The shape of every real frame. */
function frame(t: GpuTimer): void {
  t.begin();
  t.end();
  t.poll();
}

describe('a machine that cannot do this', () => {
  it('is the ordinary case, not an error', () => {
    const t = new GpuTimer(fakeGl({ extension: false }).gl);
    expect(t.available).toBe(false);
    frame(t);
    expect(t.ms).toBe(0);
    expect(t.depth).toBe(0);
    expect(t.latency).toBe(-1);
  });

  it('treats no context the same as no extension', () => {
    const t = new GpuTimer(null);
    expect(t.available).toBe(false);
    frame(t);
    expect(t.ms).toBe(0);
  });

  it('gives up when the driver refuses to make a query', () => {
    // A driver may advertise the extension and then hand back null, which is a
    // no less final refusal than not advertising it.
    const t = new GpuTimer(fakeGl({ queries: 0 }).gl);
    expect(t.available).toBe(false);
  });

  it('runs on a shorter ring when the driver stops part way', () => {
    const f = fakeGl({ queries: 2 });
    const t = new GpuTimer(f.gl);
    expect(t.available).toBe(true);
    expect(f.made).toBe(2);
    t.begin();
    t.end();
    t.begin();
    t.end();
    t.begin();
    expect(t.skipped).toBe(1);
  });
});

describe('timing a frame', () => {
  it('reports what the driver said, in milliseconds', () => {
    const f = fakeGl();
    const t = new GpuTimer(f.gl);
    t.begin();
    t.end();
    f.finish(0, 4_000_000);
    t.poll();
    expect(t.ms).toBeCloseTo(4, 6);
    expect(t.depth).toBe(1);
  });

  it('averages over the frames it has', () => {
    const f = fakeGl();
    const t = new GpuTimer(f.gl);
    for (const [nth, ns] of [
      [0, 2_000_000],
      [1, 6_000_000],
    ] as const) {
      t.begin();
      t.end();
      f.finish(nth, ns);
      t.poll();
    }
    expect(t.ms).toBeCloseTo(4, 6);
    expect(t.depth).toBe(2);
  });

  it('never asks for a result the driver has not got', () => {
    // The claim the whole polling design exists for. Reading early is a full
    // pipeline stall: the profiler would depress the frame rate it is measuring
    // and then report the depressed number as the truth.
    const f = fakeGl();
    const t = new GpuTimer(f.gl);
    for (let i = 0; i < 12; i++) frame(t);
    f.finish(0, 3_000_000);
    t.poll();
    expect(f.stalls).toEqual([]);
    expect(t.ms).toBeCloseTo(3, 6);
  });

  it('leaves an unfinished query alone', () => {
    const f = fakeGl();
    const t = new GpuTimer(f.gl);
    t.begin();
    t.end();
    t.poll();
    expect(t.depth).toBe(0);
    expect(t.ms).toBe(0);
  });

  it('does not collect the query it is still inside', () => {
    // A query that was begun and never ended cannot have a result, and asking
    // for one would stall on a driver that is still writing to it.
    const f = fakeGl();
    const t = new GpuTimer(f.gl);
    t.begin();
    f.finish(0, 5_000_000);
    t.poll();
    expect(t.depth).toBe(0);
    expect(f.stalls).toEqual([]);
  });

  it('ignores a second begin while one is open', () => {
    const f = fakeGl();
    const t = new GpuTimer(f.gl);
    t.begin();
    expect(() => t.begin()).not.toThrow();
    t.end();
  });

  it('reuses a slot once its result is in', () => {
    const f = fakeGl({ queries: 1 });
    const t = new GpuTimer(f.gl);
    t.begin();
    t.end();
    f.finish(0, 1_000_000);
    t.poll();
    t.begin();
    t.end();
    expect(t.skipped).toBe(0);
  });
});

describe('when the pool runs dry', () => {
  it('skips the frame rather than growing', () => {
    // An unbounded pool is a leak on a driver that never answers, and those
    // exist. A gap in the graph is the cheaper failure.
    const f = fakeGl();
    const t = new GpuTimer(f.gl, 3);
    for (let i = 0; i < 6; i++) frame(t);
    expect(t.skipped).toBe(3);
    expect(f.made).toBe(3);
  });

  it('recovers as results come back', () => {
    const f = fakeGl();
    const t = new GpuTimer(f.gl, 2);
    frame(t);
    frame(t);
    frame(t);
    expect(t.skipped).toBe(1);
    f.finish(0, 2_000_000);
    t.poll();
    t.begin();
    t.end();
    expect(t.skipped).toBe(1);
  });
});

describe('when the driver goes disjoint', () => {
  it('bins everything that was in flight', () => {
    // A preemption spike is not a measurement of this game, and putting one on
    // the readout is worse than putting nothing there.
    const f = fakeGl();
    const t = new GpuTimer(f.gl);
    t.begin();
    t.end();
    t.begin();
    t.end();
    f.disrupt();
    f.finish(0, 90_000_000);
    f.finish(1, 91_000_000);
    t.poll();
    expect(t.discarded).toBe(2);
    expect(t.depth).toBe(0);
    expect(t.ms).toBe(0);
  });

  it('checks the flag before collecting, not after', () => {
    // The flag reports whether a disjoint happened since it was last read, and
    // reading it clears it. Collect first and this frame's results escape the
    // check they were supposed to be covered by, and the spike lands in the
    // average anyway.
    const f = fakeGl();
    const t = new GpuTimer(f.gl);
    t.begin();
    t.end();
    f.finish(0, 90_000_000);
    f.disrupt();
    t.poll();
    expect(t.discarded).toBe(1);
    expect(t.depth).toBe(0);
  });

  it('lets the next clean frame through', () => {
    const f = fakeGl();
    const t = new GpuTimer(f.gl);
    t.begin();
    t.end();
    f.disrupt();
    f.finish(0, 90_000_000);
    t.poll();
    t.begin();
    t.end();
    f.finish(1, 3_000_000);
    t.poll();
    expect(t.ms).toBeCloseTo(3, 6);
    expect(t.discarded).toBe(1);
  });

  it('taints the query that is open at the time', () => {
    // The open query spans the disruption too — it is the one most likely to,
    // since it is the one the disruption interrupted.
    const f = fakeGl();
    const t = new GpuTimer(f.gl);
    t.begin();
    f.disrupt();
    t.poll();
    t.end();
    f.finish(0, 90_000_000);
    t.poll();
    expect(t.discarded).toBe(1);
    expect(t.depth).toBe(0);
  });

  it('bins a result no driver should have produced', () => {
    const f = fakeGl();
    const t = new GpuTimer(f.gl);
    t.begin();
    t.end();
    f.finish(0, -5);
    t.poll();
    expect(t.discarded).toBe(1);
    expect(t.depth).toBe(0);
  });
});

describe('saying how late the number is', () => {
  it('counts the frames since the reading was taken', () => {
    const f = fakeGl();
    const t = new GpuTimer(f.gl);
    t.begin();
    t.end();
    t.poll();
    t.poll();
    t.poll();
    f.finish(0, 2_000_000);
    t.poll();
    // Issued on frame 0, collected on the poll that advanced the count to 4.
    expect(t.latency).toBe(4);
  });

  it('is not dragged backwards by a straggler', () => {
    // Out-of-order completion is legal, and lateness is a claim about the
    // newest reading rather than about the last one to arrive.
    const f = fakeGl();
    const t = new GpuTimer(f.gl);
    frame(t);
    frame(t);
    f.finish(1, 3_000_000);
    t.poll();
    const fresh = t.latency;
    f.finish(0, 3_000_000);
    t.poll();
    expect(t.latency).toBe(fresh + 1);
  });
});

describe('housekeeping', () => {
  it('forgets the average on request', () => {
    const f = fakeGl();
    const t = new GpuTimer(f.gl);
    t.begin();
    t.end();
    f.finish(0, 4_000_000);
    t.poll();
    t.reset();
    expect(t.ms).toBe(0);
    expect(t.depth).toBe(0);
    expect(t.latency).toBe(-1);
    expect(t.discarded).toBe(0);
  });

  it('hands the queries back and closes an open one', () => {
    const f = fakeGl();
    const t = new GpuTimer(f.gl, 3);
    t.begin();
    t.dispose();
    expect(f.deleted).toHaveLength(3);
    expect(t.available).toBe(false);
    expect(() => t.dispose()).not.toThrow();
  });
});
