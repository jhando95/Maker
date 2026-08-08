import { describe, it, expect } from 'vitest';
import { project, projectClamped, viewFor, type MapView } from './minimapModel.ts';

/** Forty metres across a two-hundred-pixel map, centred on the origin. */
const view: MapView = { centreX: 0, centreZ: 0, span: 40, size: 200 };

describe('putting a metre on a pixel', () => {
  it('puts the centre of the world in the middle of the map', () => {
    expect(project(view, 0, 0)).toEqual({ x: 100, y: 100, clamped: false });
  });

  it('scales by the span, not by anything else', () => {
    // Twenty metres is half the span, so half the map: a hundred pixels.
    expect(project(view, 20, 0).x).toBe(200);
    expect(project(view, -20, 0).x).toBe(0);
    expect(project(view, 0, 10).y).toBe(150);
  });

  it('sends +z downward, which is the direction it faces on a north-up map', () => {
    // A mirror-image map is worse than no map: a player who cannot trust it has
    // to learn to invert it, and they will do that wrong under pressure.
    expect(project(view, 0, 5).y).toBeGreaterThan(project(view, 0, -5).y);
    expect(project(view, 5, 0).x).toBeGreaterThan(project(view, -5, 0).x);
  });

  it('moves with the centre', () => {
    const shifted: MapView = { ...view, centreX: 20, centreZ: -10 };
    expect(project(shifted, 20, -10)).toEqual({ x: 100, y: 100, clamped: false });
  });
});

describe('a marker off the edge', () => {
  it('is left alone while it is on the map', () => {
    const p = projectClamped(view, 5, 5);
    expect(p.clamped).toBe(false);
    expect(p).toEqual(project(view, 5, 5));
  });

  it('is pinned to the rim once it is not', () => {
    const p = projectClamped(view, 400, 0);
    expect(p.clamped).toBe(true);
    expect(p.x).toBe(200);
    expect(p.y).toBe(100);
  });

  it('and is pinned in the direction it actually lies', () => {
    // The failure this replaces: clamping x and y separately walks the marker
    // along the edge into a corner, so a thing due north-east and a thing due
    // east both point at the corner.
    const p = projectClamped(view, 1000, 500);
    expect(p.clamped).toBe(true);
    const dx = p.x - 100;
    const dy = p.y - 100;
    // Twice as far east as south, so twice as far right as down.
    expect(dx / dy).toBeCloseTo(2, 6);
  });

  it('keeps a pinned marker fully on the map when asked', () => {
    const p = projectClamped(view, 400, 0, 8);
    expect(p.x).toBe(192);
  });

  it('does not divide by zero when the marker is exactly in the middle', () => {
    const p = projectClamped({ ...view, size: 0 }, 0, 0);
    expect(Number.isFinite(p.x)).toBe(true);
    expect(Number.isFinite(p.y)).toBe(true);
  });
});

describe('holding the view inside the world', () => {
  const half = 58;

  it('follows the player in the middle of the world', () => {
    const v = viewFor(10, -5, 40, 200, half);
    expect(v.centreX).toBe(10);
    expect(v.centreZ).toBe(-5);
  });

  it('stops at the edge rather than showing what is not there', () => {
    // Half the picture outside the world reads as unexplored rather than as
    // nothing, which is a worse lie than sliding the player off centre.
    const v = viewFor(200, 0, 40, 200, half);
    expect(v.centreX).toBe(half - 20);
    const back = viewFor(-200, 0, 40, 200, half);
    expect(back.centreX).toBe(-(half - 20));
  });

  it('clamps each axis on its own', () => {
    const v = viewFor(200, 3, 40, 200, half);
    expect(v.centreX).toBe(half - 20);
    expect(v.centreZ).toBe(3);
  });

  it('falls back to the middle when the map is bigger than the world', () => {
    // Not an error: a player can zoom out past the fence line, and the honest
    // answer is the whole world centred rather than an argument between two
    // constraints that cannot both hold.
    const v = viewFor(40, 40, 500, 200, half);
    expect(v.centreX).toBe(0);
    expect(v.centreZ).toBe(0);
  });

  it('carries the span and the size through untouched', () => {
    const v = viewFor(0, 0, 37, 211, half);
    expect(v.span).toBe(37);
    expect(v.size).toBe(211);
  });
});
