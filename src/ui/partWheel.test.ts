import { describe, it, expect } from 'vitest';
import { wedgeAt, wedgeDirection, DEAD_ZONE_PX } from './partWheel.ts';

/**
 * The geometry only. Whether the wheel looks right is a screenshot; whether the
 * angle you flicked names the wedge under your eyes is arithmetic, and that is
 * the part that fails silently — a wheel off by half a step still looks
 * perfectly fine and picks the wrong thing every time.
 */

const FAR = DEAD_ZONE_PX * 3;

describe('wedgeAt', () => {
  it('picks nothing inside the dead zone', () => {
    // Opening the wheel and letting go without moving keeps what you had,
    // rather than picking whatever sits at zero degrees.
    expect(wedgeAt(0, 0, 8)).toBeNull();
    expect(wedgeAt(DEAD_ZONE_PX - 1, 0, 8)).toBeNull();
  });

  it('picks something once clear of it', () => {
    expect(wedgeAt(DEAD_ZONE_PX + 2, 0, 8)).not.toBeNull();
  });

  it('puts wedge zero at the top', () => {
    // Screen +y is down, so straight up is negative.
    expect(wedgeAt(0, -FAR, 8)).toBe(0);
  });

  it('runs clockwise, like a clock face', () => {
    expect(wedgeAt(FAR, 0, 8)).toBe(2);       // right = a quarter turn
    expect(wedgeAt(0, FAR, 8)).toBe(4);       // down = half
    expect(wedgeAt(-FAR, 0, 8)).toBe(6);      // left = three quarters
  });

  it('centres each wedge on its own direction', () => {
    // The half-step offset. Without it every wedge is picked by the direction
    // of its own leading edge, which feels rotated by half a slot and is
    // maddening to diagnose from a screenshot.
    for (let count of [4, 6, 8]) {
      for (let i = 0; i < count; i++) {
        const dir = wedgeDirection(i, count);
        expect(wedgeAt(dir.x * FAR, dir.y * FAR, count), `count ${count}, wedge ${i}`).toBe(i);
      }
    }
  });

  it('is stable just either side of a boundary', () => {
    // A direction exactly between two wedges must land on one of them and stay
    // there; the failure mode is a selection that flickers as the hand shakes.
    const count = 8;
    const step = (Math.PI * 2) / count;
    const boundary = step / 2 + 1e-6;
    const at = (angle: number) =>
      wedgeAt(Math.sin(angle) * FAR, -Math.cos(angle) * FAR, count);
    expect(at(boundary)).toBe(1);
    expect(at(boundary - 2e-6)).toBe(0);
  });

  it('covers the whole circle with no gaps', () => {
    const count = 8;
    const seen = new Set<number>();
    for (let deg = 0; deg < 360; deg++) {
      const a = (deg * Math.PI) / 180;
      const w = wedgeAt(Math.sin(a) * FAR, -Math.cos(a) * FAR, count);
      expect(w, `no wedge at ${deg}°`).not.toBeNull();
      seen.add(w!);
    }
    expect(seen.size).toBe(count);
  });

  it('gives every wedge a fair share of the circle', () => {
    const count = 8;
    const tally = new Map<number, number>();
    for (let deg = 0; deg < 3600; deg++) {
      const a = (deg * Math.PI) / 1800;
      const w = wedgeAt(Math.sin(a) * FAR, -Math.cos(a) * FAR, count)!;
      tally.set(w, (tally.get(w) ?? 0) + 1);
    }
    for (const [wedge, n] of tally) {
      expect(Math.abs(n - 3600 / count), `wedge ${wedge} is lopsided`).toBeLessThanOrEqual(1);
    }
  });

  it('handles counts that do not divide the circle evenly', () => {
    for (const count of [3, 5, 7, 9]) {
      for (let i = 0; i < count; i++) {
        const dir = wedgeDirection(i, count);
        expect(wedgeAt(dir.x * FAR, dir.y * FAR, count)).toBe(i);
      }
    }
  });

  it('refuses to divide by nothing', () => {
    expect(wedgeAt(FAR, 0, 0)).toBeNull();
  });
});

describe('wedgeDirection', () => {
  it('returns unit vectors', () => {
    for (let i = 0; i < 8; i++) {
      const d = wedgeDirection(i, 8);
      expect(Math.hypot(d.x, d.y)).toBeCloseTo(1, 9);
    }
  });

  it('starts at the top and steps clockwise', () => {
    const first = wedgeDirection(0, 4);
    expect(first.x).toBeCloseTo(0, 9);
    expect(first.y).toBeCloseTo(-1, 9);

    const second = wedgeDirection(1, 4);
    expect(second.x).toBeCloseTo(1, 9);
    expect(second.y).toBeCloseTo(0, 9);
  });

  it('round-trips with wedgeAt', () => {
    for (const count of [2, 4, 8, 12]) {
      for (let i = 0; i < count; i++) {
        const d = wedgeDirection(i, count);
        expect(wedgeAt(d.x * 100, d.y * 100, count)).toBe(i);
      }
    }
  });
});
