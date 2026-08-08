import { describe, it, expect } from 'vitest';
import {
  TOUCH, anchored, collapseAfter, joinedTo, onGround, unsupported, wouldStand,
  type Box, type Structure,
} from './support.ts';

/** A part, described the way a test wants to describe one. */
interface Piece {
  id: number;
  x: number; y: number; z: number;
  w?: number; h?: number; d?: number;
  fixed?: boolean;
}

const boxOf = (p: Piece): Box => {
  const w = (p.w ?? 1) / 2, h = (p.h ?? 0.2) / 2, d = (p.d ?? 0.2) / 2;
  return {
    minX: p.x - w, maxX: p.x + w,
    minY: p.y - h, maxY: p.y + h,
    minZ: p.z - d, maxZ: p.z + d,
  };
};

/**
 * A world of boxes.
 *
 * `near` returns everything, which is exactly what the interface allows: a
 * broadphase may over-report and must never miss. Handing the module the
 * sloppiest legal implementation is the point — if it leans on the broadphase
 * to do its filtering, these tests find out.
 */
const world = (pieces: readonly Piece[], groundY = 0): Structure & { drop(id: number): Box } => {
  const live = new Map<number, Piece>();
  for (const p of pieces) live.set(p.id, p);
  return {
    groundY,
    ids: () => [...live.keys()].sort((a, b) => a - b),
    box: (id) => boxOf(live.get(id)!),
    near: () => [...live.keys()],
    fixed: (id) => live.get(id)?.fixed === true,
    drop(id) {
      const box = boxOf(live.get(id)!);
      live.delete(id);
      return box;
    },
  };
};

/** A tower: one part on the lawn and four stacked on it. */
const tower = (): Piece[] => [
  { id: 0, x: 0, y: 0.1, z: 0 },
  { id: 1, x: 0, y: 0.3, z: 0 },
  { id: 2, x: 0, y: 0.5, z: 0 },
  { id: 3, x: 0, y: 0.7, z: 0 },
  { id: 4, x: 0, y: 0.9, z: 0 },
];

describe('what counts as held up', () => {
  it('calls a part on the lawn grounded', () => {
    const s = world([{ id: 0, x: 0, y: 0.1, z: 0 }]);
    expect(onGround(s, s.box(0))).toBe(true);
    expect(anchored(s, 0)).toBe(true);
  });

  it('does not call one in the air grounded', () => {
    const s = world([{ id: 0, x: 0, y: 4, z: 0 }]);
    expect(anchored(s, 0)).toBe(false);
  });

  it('counts a part nailed to the map, wherever it is', () => {
    // The house, the fence, the treehouse. Half of what people build in this
    // game hangs off one of them and never touches the lawn at all.
    const s = world([
      { id: 0, x: 0, y: 4, z: 0, fixed: true, w: 2, h: 4, d: 2 },
      { id: 1, x: 1.49, y: 4, z: 0 },
    ]);
    expect(anchored(s, 1)).toBe(true);
  });

  it('joins parts that touch sideways, not only ones that stack', () => {
    // The rule this file exists to get right. A plank nailed to the side of a
    // post is held by that post; a rule that only looked downward would refuse
    // every rung, shelf and cantilever anybody builds.
    const s = world([
      { id: 0, x: 0, y: 1, z: 0, w: 0.2, h: 2, d: 0.2 },
      { id: 1, x: 0.6, y: 1.9, z: 0, w: 1 },
    ]);
    expect(joinedTo(s, s.box(1), 1)).toEqual([0]);
  });

  it('leaves a gap a gap', () => {
    const s = world([
      { id: 0, x: 0, y: 0.1, z: 0 },
      { id: 1, x: 0, y: 0.1 + 0.2 + TOUCH * 3, z: 0 },
    ]);
    expect(joinedTo(s, s.box(1), 1)).toEqual([]);
  });

  it('forgives the hair between two parts placed flush', () => {
    // Exact contact between two floats is not a thing to build a rule on. The
    // placement check shrinks its probe by 6mm for the same reason, the other
    // way round.
    const s = world([
      { id: 0, x: 0, y: 0.1, z: 0 },
      { id: 1, x: 0, y: 0.3 + 0.004, z: 0 },
    ]);
    expect(joinedTo(s, s.box(1), 1)).toEqual([0]);
  });
});

describe('taking a leg out', () => {
  it('brings down everything that was standing on it', () => {
    const s = world(tower());
    const gone = s.drop(0);
    expect(collapseAfter(s, gone)).toEqual([1, 2, 3, 4]);
  });

  it('brings down nothing when what is left still reaches the ground', () => {
    const s = world(tower());
    const gone = s.drop(4);
    expect(collapseAfter(s, gone)).toEqual([]);
  });

  it('cuts a tower in half rather than dropping all of it', () => {
    const s = world(tower());
    const gone = s.drop(2);
    expect(collapseAfter(s, gone)).toEqual([3, 4]);
  });

  it('leaves a structure standing while it has a second way down', () => {
    // Two legs and a beam across them. Take one leg and the beam still stands,
    // which is the difference between a support rule and a stack rule.
    const s = world([
      { id: 0, x: -1, y: 1, z: 0, w: 0.2, h: 2, d: 0.2 },
      { id: 1, x: 1, y: 1, z: 0, w: 0.2, h: 2, d: 0.2 },
      { id: 2, x: 0, y: 2.1, z: 0, w: 2.4 },
    ]);
    expect(collapseAfter(s, s.drop(0))).toEqual([]);
  });

  it('and drops it once the last way down goes', () => {
    const s = world([
      { id: 1, x: 1, y: 1, z: 0, w: 0.2, h: 2, d: 0.2 },
      { id: 2, x: 0, y: 2.1, z: 0, w: 2.4 },
    ]);
    expect(collapseAfter(s, s.drop(1))).toEqual([2]);
  });

  it('drops each stranded piece and keeps each standing one, in the same breath', () => {
    // One removal, two components: a bridge out to nothing on one side and a
    // post on the ground on the other.
    const s = world([
      { id: 0, x: 0, y: 0.1, z: 0 },
      { id: 1, x: 0, y: 0.3, z: 0 },
      { id: 2, x: 0.9, y: 0.5, z: 0 },
      { id: 3, x: 1.8, y: 0.5, z: 0 },
      { id: 4, x: -0.9, y: 0.5, z: 0 },
      { id: 5, x: -0.9, y: 0.2, z: 0, h: 0.4 },
    ]);
    // 1 carries the run out to 3 and also touches 4, which stands on 5.
    expect(collapseAfter(s, s.drop(1))).toEqual([2, 3]);
  });

  it('never reports the same part twice, however many ways it was joined', () => {
    // Two neighbours of the removed part in the same stranded component. The
    // flood has to notice it has already walked that component.
    const s = world([
      { id: 0, x: 0, y: 2, z: 0, w: 0.2 },
      { id: 1, x: 0.15, y: 2.15, z: 0, w: 0.2 },
      { id: 2, x: 0.15, y: 1.85, z: 0, w: 0.2 },
      { id: 3, x: 0.3, y: 2, z: 0, w: 0.2 },
    ]);
    expect(collapseAfter(s, s.drop(0))).toEqual([1, 2, 3]);
  });

  it('comes back in order, because the order goes on the wire', () => {
    const s = world([
      { id: 7, x: 0, y: 0.3, z: 0 },
      { id: 2, x: 0, y: 0.5, z: 0 },
      { id: 9, x: 0, y: 0.7, z: 0 },
      { id: 4, x: 0, y: 0.1, z: 0 },
    ]);
    expect(collapseAfter(s, s.drop(4))).toEqual([2, 7, 9]);
  });

  it('does not wander into the map and pull the house down', () => {
    // A plank nailed to the fence, and the fence touching half the world. The
    // flood must stop at anything fixed rather than walking through it.
    const s = world([
      { id: 0, x: 0, y: 1, z: 0, fixed: true, w: 40, h: 2, d: 0.2 },
      { id: 1, x: 0, y: 2.2, z: 0, w: 1 },
      { id: 2, x: 0, y: 2.4, z: 0, w: 1 },
    ]);
    expect(collapseAfter(s, s.drop(1))).toEqual([2]);
    expect(s.ids()).toContain(0);
  });

  it('says nothing when the part that went had nothing on it', () => {
    const s = world([{ id: 0, x: 0, y: 0.1, z: 0 }, { id: 1, x: 9, y: 0.1, z: 9 }]);
    expect(collapseAfter(s, s.drop(0))).toEqual([]);
  });
});

describe('the local flood against the whole-world sweep', () => {
  // The check that matters most, and the only one that would catch the fast
  // path getting clever and wrong: after any single removal, what the local
  // search brings down has to be exactly what a full recomputation says is in
  // the air. Run over every part of every shape, so a case nobody thought of
  // is still covered.
  const shapes: Record<string, Piece[]> = {
    tower: tower(),
    bridge: [
      { id: 0, x: -3, y: 1, z: 0, fixed: true, w: 1, h: 2, d: 2 },
      { id: 1, x: -2.2, y: 1.9, z: 0, w: 1 },
      { id: 2, x: -1.3, y: 1.9, z: 0, w: 1 },
      { id: 3, x: -0.4, y: 1.9, z: 0, w: 1 },
      { id: 4, x: 0.5, y: 1.9, z: 0, w: 1 },
    ],
    scaffold: [
      { id: 0, x: -1, y: 1, z: 0, w: 0.2, h: 2, d: 0.2 },
      { id: 1, x: 1, y: 1, z: 0, w: 0.2, h: 2, d: 0.2 },
      { id: 2, x: 0, y: 2.1, z: 0, w: 2.4 },
      { id: 3, x: 0, y: 2.3, z: 0, w: 2.4 },
      { id: 4, x: 0, y: 2.5, z: 0, w: 2.4 },
    ],
    lean: [
      { id: 0, x: 0, y: 1, z: 0, fixed: true, w: 2, h: 2, d: 2 },
      { id: 1, x: 1.6, y: 1.5, z: 0, w: 1.2 },
      { id: 2, x: 2.6, y: 1.5, z: 0, w: 1.2 },
      { id: 3, x: 3.6, y: 1.5, z: 0, w: 1.2 },
      { id: 4, x: 3.6, y: 0.7, z: 0, w: 0.2, h: 1.4, d: 0.2 },
    ],
  };

  for (const [name, pieces] of Object.entries(shapes)) {
    for (const victim of pieces) {
      if (victim.fixed === true) continue;
      it(`agrees about ${name} with part ${victim.id} taken out`, () => {
        const s = world(pieces);
        const local = collapseAfter(s, s.drop(victim.id));
        expect(local).toEqual(unsupported(s));
      });
    }
  }
});

describe('before the wood is spent', () => {
  const at = (x: number, y: number, z: number): Box =>
    ({ minX: x - 0.5, maxX: x + 0.5, minY: y - 0.1, maxY: y + 0.1, minZ: z - 0.1, maxZ: z + 0.1 });

  it('says yes to a part on the lawn', () => {
    expect(wouldStand(world([]), at(0, 0.1, 0))).toBe(true);
  });

  it('says no to one in mid-air with nothing near it', () => {
    expect(wouldStand(world([{ id: 0, x: 9, y: 0.1, z: 9 }]), at(0, 4, 0))).toBe(false);
  });

  it('says yes to one nailed to the map, however high', () => {
    const s = world([{ id: 0, x: 0, y: 4, z: 0, fixed: true, w: 2, h: 4, d: 2 }]);
    expect(wouldStand(s, at(1.5, 4, 0))).toBe(true);
  });

  it('says yes to one nailed to a tower that reaches the ground', () => {
    const s = world(tower());
    expect(wouldStand(s, at(0, 1.05, 0))).toBe(true);
  });

  it('says NO to one nailed to something that is itself floating', () => {
    // The reason this floods instead of looking at its neighbours. The warning
    // is a warning rather than a refusal, so a player who ignores it leaves a
    // floating part behind — and the next part nailed to that one would be
    // called supported by something that is not.
    const s = world([{ id: 0, x: 0, y: 4, z: 0 }]);
    expect(wouldStand(s, at(0.9, 4, 0))).toBe(false);
  });

  it('follows a floating run all the way back to the ground before deciding', () => {
    const s = world([
      { id: 0, x: 0, y: 0.1, z: 0 },
      { id: 1, x: 0.9, y: 0.3, z: 0 },
      { id: 2, x: 1.8, y: 0.5, z: 0 },
    ]);
    expect(wouldStand(s, at(2.7, 0.7, 0))).toBe(true);
  });

  it('changes its mind when the thing that was holding it up goes', () => {
    // The claim that the answer is about the world rather than about the box.
    // One post on the lawn and a shelf against its top: the shelf stands, and
    // the moment the post is taken away the same shelf does not.
    const s = world([{ id: 0, x: 0, y: 0.75, z: 0, w: 0.2, h: 1.5, d: 0.2 }]);
    const shelf = at(0.5, 1.4, 0);
    expect(wouldStand(s, shelf)).toBe(true);
    s.drop(0);
    expect(wouldStand(s, shelf)).toBe(false);
  });

  it('is the same question `collapseAfter` answers, from the other side', () => {
    // Place a part where a box would *not* stand, and taking it away again has
    // to strand nothing — there was nothing holding it and nothing hanging off
    // it. Place one where a box would stand, and it joins something that does.
    const floating = world([{ id: 0, x: 0, y: 4, z: 0 }]);
    expect(wouldStand(floating, at(0.9, 4, 0))).toBe(false);
    expect(collapseAfter(floating, at(0.9, 4, 0))).toEqual([0]);
  });
});
