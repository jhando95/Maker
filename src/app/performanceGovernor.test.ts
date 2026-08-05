import { describe, it, expect } from 'vitest';
import { PerformanceGovernor, DEFAULT_GOVERNOR } from './performanceGovernor.ts';

const BUDGET = 1000 / 60;

/**
 * A machine, in milliseconds per frame.
 *
 * `fixed` is the part that does not care about resolution — simulation, scene
 * traversal, driver overhead. `fill` is the part that does, at full scale, and
 * goes with the square of the scale because that is how pixel counts work.
 *
 * Feeding the governor a constant frame time would test nothing interesting:
 * the loop that can misbehave is the one where the measurement responds to the
 * decision, and only a model that closes that loop can expose it.
 */
interface Machine {
  fixed: number;
  fill: number;
}

const FAST: Machine = { fixed: 2, fill: 6 };        // 8ms at full scale
const OVERLOADED: Machine = { fixed: 4, fill: 40 }; // 44ms at full, 14ms at half
/** Slow at 100%, comfortable at 90% — the shape that makes a governor ping-pong. */
const BOUNDARY: Machine = { fixed: 2, fill: 19 };

function frameMs(m: Machine, scale: number): number {
  return m.fixed + m.fill * scale * scale;
}

/** Run a machine against the governor for `seconds` of simulated time. */
function run(gov: PerformanceGovernor, m: Machine, seconds: number): void {
  let elapsed = 0;
  let guard = 0;
  while (elapsed < seconds && guard++ < 2_000_000) {
    const dt = frameMs(m, gov.currentScale) / 1000;
    gov.frame(dt);
    elapsed += dt;
  }
}

/** Run at a fixed frame time regardless of scale, for the timing-only tests. */
function runFlat(gov: PerformanceGovernor, frameMsValue: number, seconds: number): void {
  const dt = frameMsValue / 1000;
  for (let i = 0; i < Math.ceil(seconds / dt); i++) gov.frame(dt);
}

describe('PerformanceGovernor', () => {
  it('leaves a machine that keeps up alone', () => {
    const gov = new PerformanceGovernor();
    run(gov, FAST, 60);
    expect(gov.currentScale).toBe(1);
    expect(gov.isThrottling).toBe(false);
  });

  it('steps down when frames are consistently slow', () => {
    const gov = new PerformanceGovernor();
    run(gov, OVERLOADED, 10);
    expect(gov.currentScale).toBeLessThan(1);
    expect(gov.isThrottling).toBe(true);
  });

  it('stops dropping once the machine is keeping up', () => {
    const gov = new PerformanceGovernor();
    run(gov, OVERLOADED, 120);
    const settled = gov.currentScale;
    expect(frameMs(OVERLOADED, settled)).toBeLessThan(BUDGET * DEFAULT_GOVERNOR.slowFactor);
    // And it should not have given away more resolution than it had to.
    expect(settled).toBeGreaterThan(DEFAULT_GOVERNOR.minScale);
  });

  it('does not react to a single slow frame', () => {
    // One 40ms frame is a garbage collection, not a machine that cannot cope.
    const gov = new PerformanceGovernor();
    for (let s = 0; s < 30; s++) {
      runFlat(gov, 15, 1);
      gov.frame(0.04);
    }
    expect(gov.currentScale).toBe(1);
  });

  it('does not ping-pong on a machine that sits on the boundary', () => {
    // The failure worth writing the predictive rule for: slow at 100%,
    // comfortable at 90%, so every decision is individually right and the
    // result is a resolution that changes every few seconds forever.
    const gov = new PerformanceGovernor();
    const changes: string[] = [];
    gov.onChange = (c) => changes.push(`${c.reason}->${c.scale}`);

    run(gov, BOUNDARY, 300);

    expect(frameMs(BOUNDARY, 1)).toBeGreaterThan(BUDGET * DEFAULT_GOVERNOR.slowFactor);
    expect(frameMs(BOUNDARY, gov.currentScale)).toBeLessThan(BUDGET * DEFAULT_GOVERNOR.slowFactor);
    // Five minutes of play should settle, not oscillate.
    expect(changes.length, changes.join(' ')).toBeLessThanOrEqual(2);
    expect(changes.filter((c) => c.startsWith('recover'))).toEqual([]);
  });

  it('recovers when the load genuinely passes', () => {
    const gov = new PerformanceGovernor();
    run(gov, OVERLOADED, 60);
    expect(gov.isThrottling).toBe(true);

    // The heavy moment ends — a wave cleared, a dense fort left behind.
    run(gov, FAST, 300);
    expect(gov.currentScale).toBe(1);
    expect(gov.isThrottling).toBe(false);
  });

  it('degrades faster than it recovers', () => {
    /** Simulated seconds until the governor first moves, or null if it never does. */
    const timeToFirstChange = (gov: PerformanceGovernor, m: Machine): number | null => {
      let elapsed = 0;
      let at: number | null = null;
      gov.onChange = () => { at ??= elapsed; };
      while (elapsed < 60 && at === null) {
        const dt = frameMs(m, gov.currentScale) / 1000;
        gov.frame(dt);
        elapsed += dt;
      }
      return at;
    };

    const down = new PerformanceGovernor();
    const toDegrade = timeToFirstChange(down, OVERLOADED);

    // Pin the scale low with a ceiling, then lift the ceiling: same starting
    // point, clean counters, so the two timings are actually comparable.
    const up = new PerformanceGovernor();
    up.setCeiling(0.5);
    up.setCeiling(1);
    const toRecover = timeToFirstChange(up, FAST);

    // A player dropping frames wants it fixed now; a player with headroom does
    // not notice getting it back a few seconds later.
    expect(toDegrade).not.toBeNull();
    expect(toRecover).not.toBeNull();
    expect(toRecover!).toBeGreaterThan(toDegrade! * 2);
  });

  it('never falls below the floor', () => {
    const gov = new PerformanceGovernor();
    run(gov, { fixed: 8, fill: 400 }, 300);
    expect(gov.currentScale).toBe(DEFAULT_GOVERNOR.minScale);
  });

  it('never rises above what the player asked for', () => {
    const gov = new PerformanceGovernor();
    gov.setCeiling(0.8);
    run(gov, FAST, 300);
    expect(gov.currentScale).toBe(0.8);
  });

  it('applies a lowered ceiling immediately', () => {
    // Someone who just moved the slider down should get it now, not after a
    // recovery window.
    const gov = new PerformanceGovernor();
    run(gov, FAST, 5);
    expect(gov.currentScale).toBe(1);
    gov.setCeiling(0.6);
    expect(gov.currentScale).toBe(0.6);
  });

  it('a raised ceiling gives it room to recover into', () => {
    const gov = new PerformanceGovernor();
    gov.setCeiling(0.6);
    run(gov, { fixed: 4, fill: 60 }, 60);
    expect(gov.currentScale).toBe(DEFAULT_GOVERNOR.minScale);

    gov.setCeiling(1);
    run(gov, FAST, 300);
    expect(gov.currentScale).toBe(1);
  });

  it('ignores the frames right after a change', () => {
    // Resizing the drawing buffer costs a frame on its own. Counting that as
    // evidence would make one step down cause the next.
    const gov = new PerformanceGovernor();
    const changes: number[] = [];
    gov.onChange = (c) => changes.push(c.scale);

    runFlat(gov, BUDGET * 2, 2.5);
    expect(changes.length).toBe(1);

    gov.frame(0.2); // the resize hitch
    gov.frame(0.2);
    runFlat(gov, 8, 0.5);
    expect(changes.length).toBe(1);
  });

  it('reports why it moved', () => {
    const gov = new PerformanceGovernor();
    const reasons: string[] = [];
    gov.onChange = (c) => reasons.push(c.reason);
    run(gov, OVERLOADED, 60);
    run(gov, FAST, 300);
    expect(reasons[0]).toBe('degrade');
    expect(reasons.at(-1)).toBe('recover');
  });

  it('does nothing at all when switched off', () => {
    const gov = new PerformanceGovernor();
    gov.enabled = false;
    run(gov, OVERLOADED, 120);
    expect(gov.currentScale).toBe(1);
    expect(gov.isThrottling).toBe(false);
  });

  it('reports the ceiling while off, not a stale throttled value', () => {
    // Turning the governor off must hand control straight back, or the player
    // is left at whatever resolution it happened to have chosen.
    const gov = new PerformanceGovernor();
    run(gov, OVERLOADED, 120);
    expect(gov.isThrottling).toBe(true);
    gov.enabled = false;
    expect(gov.currentScale).toBe(1);
  });

  it('keeps the scale on clean tenths', () => {
    const gov = new PerformanceGovernor();
    const seen: number[] = [];
    gov.onChange = (c) => seen.push(c.scale);
    run(gov, OVERLOADED, 60);
    run(gov, FAST, 300);
    expect(seen.length).toBeGreaterThan(2);
    for (const s of seen) {
      expect(Math.abs(s * 10 - Math.round(s * 10))).toBeLessThan(1e-9);
    }
  });
});
