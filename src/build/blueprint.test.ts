import { describe, expect, it } from 'vitest';
import {
  MAX_BLUEPRINT_NAME,
  MAX_BLUEPRINT_PARTS,
  blueprintCost,
  builtInBlueprints,
  cleanBlueprintName,
  connectedFrom,
  normalize,
  rotated,
  stampAt,
  type Box,
} from './blueprint.ts';
import { costOf } from './lumber.ts';
import { MODULE, STAIR_RUN, getPartKind } from './partKit.ts';
import { worldAabb, type PlacementRecord } from './buildSystem.ts';

const at = (x: number, y: number, z: number, kind = 0): PlacementRecord => ({
  kind, colorway: 0, x, y, z, qx: 0, qy: 0, qz: 0, qw: 1,
});

const box = (
  x: number, y: number, z: number, r = 0.1,
): Box => ({
  minX: x - r, maxX: x + r, minY: y - r, maxY: y + r, minZ: z - r, maxZ: z + r,
});

describe('anchoring a captured group', () => {
  it('centres the footprint horizontally', () => {
    const out = normalize([at(10, 0, 4), at(14, 0, 8)]);
    expect(out.map((p) => p.x)).toEqual([-2, 2]);
    expect(out.map((p) => p.z)).toEqual([-2, 2]);
  });

  it('puts the anchor under the lowest part, not through the middle of it', () => {
    // The vertical axis is measured from the *box*, not the centre, and this is
    // the assertion that says so. Anchored on the lowest centre, a blueprint
    // sinks half its bottom part into whatever you set it on: 25mm for a plank,
    // which nobody notices, and 125mm for a block, which the placement check
    // refuses. Every stamp of the block staircase failed on exactly that.
    const out = normalize([at(0, 3, 0), at(0, 5, 0), at(0, 9, 0)]);
    expect(Math.min(...out.map((p) => worldAabb(p).minY))).toBeCloseTo(0, 6);
    // The gaps between them are untouched: only the origin moved.
    expect(out[1]!.y - out[0]!.y).toBeCloseTo(2, 6);
    expect(out[2]!.y - out[1]!.y).toBeCloseTo(4, 6);
  });

  it('leaves a single part centred over the anchor and sitting on it', () => {
    const [p] = normalize([at(7, 2, -3)]);
    expect(p).toMatchObject({ x: 0, z: 0 });
    expect(worldAabb(p!).minY).toBeCloseTo(0, 6);
  });

  it('keeps kind, colour and rotation untouched', () => {
    const spun = { ...at(5, 5, 5, 3), colorway: 2, qy: 1, qw: 0 };
    expect(normalize([spun])[0]).toMatchObject({ kind: 3, colorway: 2, qy: 1, qw: 0 });
  });

  it('does not modify what it was given', () => {
    const source = [at(10, 4, 10)];
    normalize(source);
    expect(source[0]).toMatchObject({ x: 10, y: 4, z: 10 });
  });

  it('has nothing to say about an empty set', () => {
    expect(normalize([])).toEqual([]);
  });
});

describe('turning a blueprint', () => {
  it('leaves it alone at zero turns', () => {
    const parts = [at(1, 0, 2), at(-3, 1, 0)];
    expect(rotated(parts, 0)).toEqual(parts);
  });

  it('takes +Z toward +X on a quarter turn', () => {
    const [p] = rotated([at(0, 0, 1)], 1);
    expect(p!.x).toBeCloseTo(1, 9);
    expect(p!.z).toBeCloseTo(0, 9);
  });

  it('mirrors through the anchor on a half turn', () => {
    const [p] = rotated([at(2, 1, -3)], 2);
    expect(p).toMatchObject({ x: -2, y: 1, z: 3 });
  });

  it('comes back to exactly where it started after four', () => {
    // Exactly, not nearly. `Math.cos(Math.PI / 2)` is 6.1e-17 rather than zero,
    // and four of those compounded is a blueprint that no longer sits on the
    // grid it was built on — which is why the quarter turns are a lookup table.
    const parts = [at(1.25, 0.5, -2.75), at(-0.5, 1, 0.25)];
    expect(rotated(parts, 4)).toEqual(parts);
  });

  it('turns the parts as well as their positions', () => {
    // A plank lying along +X has to end up lying along -Z. Rotating positions
    // and forgetting quaternions gives a staircase whose treads all face the
    // original direction, which looks like a rendering bug.
    const [p] = rotated([at(0, 0, 0)], 1);
    // Quarter turn about +Y: (0, sin45, 0, cos45).
    expect(p!.qy).toBeCloseTo(Math.SQRT1_2, 3);
    expect(p!.qw).toBeCloseTo(Math.SQRT1_2, 3);
  });

  it('keeps quaternions unit length', () => {
    const spun = { ...at(1, 0, 0), qx: 0.5, qy: 0.5, qz: 0.5, qw: 0.5 };
    for (const turns of [1, 2, 3]) {
      const [p] = rotated([spun], turns);
      expect(Math.hypot(p!.qx, p!.qy, p!.qz, p!.qw)).toBeCloseTo(1, 3);
    }
  });

  it('treats turns beyond the fourth and below zero as the same four', () => {
    const parts = [at(1, 0, 2)];
    expect(rotated(parts, 5)).toEqual(rotated(parts, 1));
    expect(rotated(parts, -1)).toEqual(rotated(parts, 3));
  });
});

describe('stamping one somewhere', () => {
  it('offsets every part by the same amount', () => {
    const out = stampAt([at(0, 0, 0), at(0, 2, 0)], 5, 1, -3);
    expect(out[0]).toMatchObject({ x: 5, y: 1, z: -3 });
    expect(out[1]).toMatchObject({ x: 5, y: 3, z: -3 });
  });

  it('turns before it moves, not after', () => {
    // The order is the whole of whether a blueprint rotates about itself or
    // swings around the origin of the world.
    const out = stampAt([at(0, 0, 2)], 10, 0, 10, 1);
    expect(out[0]!.x).toBeCloseTo(12, 9);
    expect(out[0]!.z).toBeCloseTo(10, 9);
  });

  it('lands on the same coordinates twice', () => {
    const parts = normalize([at(1, 0, 0), at(2, 0.25, 0.5)]);
    expect(stampAt(parts, 3.5, 0, -1.25, 2)).toEqual(stampAt(parts, 3.5, 0, -1.25, 2));
  });
});

describe('what it costs', () => {
  it('is the sum of its parts, priced the way the yard prices them', () => {
    // Against `costOf` rather than against a number typed here, so this cannot
    // agree with itself while disagreeing with the lumber pile.
    const parts = [at(0, 0, 0, 0), at(0, 0, 0, 1), at(0, 0, 0, 5)];
    expect(blueprintCost(parts)).toBe(costOf(0) + costOf(1) + costOf(5));
  });

  it('is nothing for nothing', () => {
    expect(blueprintCost([])).toBe(0);
  });
});

describe('picking up everything that is joined together', () => {
  it('takes a chain of touching parts', () => {
    const boxes = [box(0, 0, 0), box(0.2, 0, 0), box(0.4, 0, 0)];
    expect(connectedFrom(0, boxes)).toEqual([0, 1, 2]);
  });

  it('leaves anything not connected to it behind', () => {
    // The reason this is a flood fill rather than a radius: a player standing
    // between their fort and somebody else's wants one of them.
    const boxes = [box(0, 0, 0), box(0.2, 0, 0), box(20, 0, 0)];
    expect(connectedFrom(0, boxes)).toEqual([0, 1]);
  });

  it('reaches round a corner rather than only along a line', () => {
    const boxes = [box(0, 0, 0), box(0.2, 0, 0), box(0.2, 0.2, 0), box(0.2, 0.4, 0)];
    expect(connectedFrom(0, boxes)).toEqual([0, 1, 2, 3]);
  });

  it('bridges the sub-millimetre gap two flush parts really have', () => {
    // The common case in this game, and the reason for the slack. Two boxes
    // sharing a face *exactly* connect with no slack at all — the comparison is
    // inclusive — so a test written that way passes whatever the slack is, and
    // planting `slack = 0` proved it. Positions are quantized to a millimetre,
    // so the gap that actually occurs is a fraction of one.
    const a = { minX: 0, maxX: 1, minY: 0, maxY: 1, minZ: 0, maxZ: 1 };
    const b = { minX: 1.003, maxX: 2, minY: 0, maxY: 1, minZ: 0, maxZ: 1 };
    expect(connectedFrom(0, [a, b])).toEqual([0, 1]);
  });

  it('does not join parts with a gap somebody could see', () => {
    const a = { minX: 0, maxX: 1, minY: 0, maxY: 1, minZ: 0, maxZ: 1 };
    const b = { minX: 1.2, maxX: 2, minY: 0, maxY: 1, minZ: 0, maxZ: 1 };
    expect(connectedFrom(0, [a, b])).toEqual([0]);
  });

  it('stops at the cap rather than swallowing a whole fort', () => {
    const boxes = Array.from({ length: 200 }, (_, i) => box(i * 0.15, 0, 0));
    expect(connectedFrom(0, boxes, 10)).toHaveLength(10);
  });

  it('gives the same answer twice', () => {
    const boxes = [box(0, 0, 0), box(0.2, 0, 0), box(0.4, 0, 0), box(0.2, 0.2, 0)];
    expect(connectedFrom(2, boxes)).toEqual(connectedFrom(2, boxes));
  });

  it('returns nothing for a seed that is not there', () => {
    expect(connectedFrom(-1, [box(0, 0, 0)])).toEqual([]);
    expect(connectedFrom(9, [box(0, 0, 0)])).toEqual([]);
  });
});

describe('naming one', () => {
  it('keeps an ordinary name', () => {
    expect(cleanBlueprintName('  Front  Wall ')).toBe('Front Wall');
  });

  it('refuses a name that is only whitespace', () => {
    expect(cleanBlueprintName('   ')).toBeNull();
    expect(cleanBlueprintName('')).toBeNull();
  });

  it('turns a newline into a space rather than deleting it', () => {
    // Deleting control characters welds words together: "one\ntwo" arrives as
    // "onetwo". The same mistake chat made and the same fix.
    expect(cleanBlueprintName('big\nwall')).toBe('big wall');
  });

  it('drops control characters that are not whitespace', () => {
    // Written as an escape, not as a literal. A control character typed into a
    // source file makes the file itself unreadable — which is the mistake this
    // very test made on its first draft, arriving as a space and failing.
    expect(cleanBlueprintName('we\u0007ird')).toBe('weird');
  });

  it('caps a very long one', () => {
    expect(cleanBlueprintName('x'.repeat(200))).toHaveLength(MAX_BLUEPRINT_NAME);
  });
});

describe('the ones that ship with the game', () => {
  const built = builtInBlueprints();

  it('are all within the cap on parts', () => {
    for (const b of built) {
      expect(b.parts.length).toBeGreaterThan(0);
      expect(b.parts.length).toBeLessThanOrEqual(MAX_BLUEPRINT_PARTS);
    }
  });

  it('are already anchored, with their undersides on the anchor', () => {
    // Generated, so this could only fail if `normalize` stopped being applied —
    // which is exactly the kind of thing that would produce a blueprint that
    // floats, or one that can never be stamped because its base is underground,
    // with no error anywhere either way.
    for (const b of built) {
      const lowest = Math.min(...b.parts.map((p) => worldAabb(p).minY));
      expect(lowest, `${b.name} does not sit on its anchor`).toBeCloseTo(0, 6);
    }
  });

  it('cannot be deleted', () => {
    for (const b of built) expect(b.builtIn).toBe(true);
  });

  it('are each one connected thing', () => {
    // The property that turns a blueprint into a *structure*, and the one this
    // file got wrong first: a staircase of five-centimetre treads with twenty
    // centimetres of air between them is not connected, so the flood fill that
    // saves a rebuilt one correctly returns a single plank — and it looks like
    // a floating staircase, because it is one. Checked through the same
    // `connectedFrom` a capture uses, on the same boxes the collision world
    // would build.
    for (const b of built) {
      const boxes = b.parts.map(worldAabb);
      expect(connectedFrom(0, boxes, b.parts.length)).toHaveLength(b.parts.length);
    }
  });

  it('do not have parts inside each other', () => {
    // A blueprint whose own parts overlap can never be stamped anywhere, since
    // every placement is checked against the world it is going into. The rungs
    // of the ladder meet the rails exactly, and a centimetre either way breaks
    // one of these two tests.
    for (const b of built) {
      const boxes = b.parts.map(worldAabb);
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i]!;
          const c = boxes[j]!;
          const shrink = 0.006;
          const overlaps = a.minX + shrink < c.maxX - shrink && a.maxX - shrink > c.minX + shrink
            && a.minY + shrink < c.maxY - shrink && a.maxY - shrink > c.minY + shrink
            && a.minZ + shrink < c.maxZ - shrink && a.maxZ - shrink > c.minZ + shrink;
          expect(overlaps, `parts ${i} and ${j} of ${b.name} overlap`).toBe(false);
        }
      }
    }
  });

  it('build a staircase out of the module the grid is made of', () => {
    // Not a restatement of the code: the point is that the staircase is derived
    // from the same two numbers the snap lattice is, so it stays climbable if
    // either of them ever moves. A hand-typed list of coordinates would not.
    const stairs = built.find((b) => b.id === 'built:stairs')!;
    const levels = [...new Set(stairs.parts.map((p) => p.y))].sort((a, b) => a - b);
    expect(levels.length).toBeGreaterThan(2);
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i]! - levels[i - 1]!).toBeCloseTo(MODULE, 6);
    }
    // And the run: each level starts one `STAIR_RUN` further along than the last.
    const frontOf = (y: number) =>
      Math.min(...stairs.parts.filter((p) => p.y === y).map((p) => p.z));
    for (let i = 1; i < levels.length; i++) {
      expect(frontOf(levels[i]!) - frontOf(levels[i - 1]!)).toBeCloseTo(STAIR_RUN, 6);
    }
  });

  it('space the ladder rungs inside a single step up', () => {
    // The claim that makes it a ladder rather than a wall: every rung has to be
    // reachable by walking into it. Checked against the movement constant
    // rather than against 0.25, so raising the rung pitch past what a kid can
    // step onto fails here.
    const ladder = built.find((b) => b.id === 'built:ladder')!;
    const rungs = ladder.parts.filter((p) => p.qz === 0);
    const heights = [...new Set(rungs.map((p) => p.y))].sort((a, b) => a - b);
    expect(heights.length).toBeGreaterThan(3);
    for (let i = 1; i < heights.length; i++) {
      expect(heights[i]! - heights[i - 1]!).toBeLessThan(0.55);
    }
  });

  it('use parts that exist', () => {
    for (const b of built) {
      for (const p of b.parts) expect(() => getPartKind(p.kind)).not.toThrow();
    }
  });

  it('cost something, so they cannot be free in a metered round', () => {
    for (const b of built) expect(blueprintCost(b.parts)).toBeGreaterThan(0);
  });
});
