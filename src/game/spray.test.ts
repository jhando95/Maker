import { describe, it, expect } from 'vitest';
import {
  MAX_SIZE, MIN_SIZE, PER_PLAYER, SPRAY_RANGE, TAG_COLORS, TAG_SHAPES, WORLD_LIMIT,
  addTag, clampTag, inRange, orphaned, type TagRecord,
} from './spray.ts';

const tag = (over: Partial<TagRecord> = {}): TagRecord =>
  clampTag({ shape: 0, color: 0, size: 0.5, spin: 0, x: 0, y: 1, z: 0, nx: 0, ny: 0, nz: 1, part: -1, ...over },
    over.by ?? 0);

describe('the shapes and colours', () => {
  it('offers every mark except the absence of one', () => {
    expect(TAG_SHAPES).not.toContain('none');
    expect(TAG_SHAPES.length).toBeGreaterThan(8);
  });

  it('has no white and no black', () => {
    // One disappears on the house and the other reads as a hole in the fence.
    for (const c of TAG_COLORS) {
      const r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
      expect(Math.min(r, g, b)).toBeGreaterThan(40);
      expect(Math.max(r, g, b)).toBeLessThan(256);
      expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeGreaterThan(30);
    }
  });
});

describe('clamping what arrives from a client', () => {
  it('turns nonsense into a legal tag rather than throwing', () => {
    // This is the wire format. A host repeats what it received to everybody
    // else, so a shape index of four thousand has to become a tag.
    const t = clampTag({ shape: 4000, color: -7, size: 900, x: 'no', spin: NaN });
    expect(t.shape).toBeGreaterThanOrEqual(0);
    expect(t.shape).toBeLessThan(TAG_SHAPES.length);
    expect(t.color).toBeGreaterThanOrEqual(0);
    expect(t.color).toBeLessThan(TAG_COLORS.length);
    expect(t.size).toBeLessThanOrEqual(MAX_SIZE);
    expect(t.x).toBe(0);
    expect(Number.isFinite(t.spin)).toBe(true);
  });

  it('survives being handed nothing at all', () => {
    expect(() => clampTag(undefined)).not.toThrow();
    expect(() => clampTag(null)).not.toThrow();
  });

  it('keeps a size inside the range it says it has', () => {
    expect(clampTag({ size: 0.001 }).size).toBe(MIN_SIZE);
    expect(clampTag({ size: 40 }).size).toBe(MAX_SIZE);
  });

  it('normalises the surface it was sprayed against', () => {
    const t = clampTag({ nx: 0, ny: 0, nz: 7 });
    expect(Math.hypot(t.nx, t.ny, t.nz)).toBeCloseTo(1, 3);
  });

  it('turns a zero normal into one that cannot look like a bug', () => {
    // A tag with no direction has to become a mark on the ground rather than a
    // sliver seen edge-on from every angle.
    const t = clampTag({ nx: 0, ny: 0, nz: 0 });
    expect(t.ny).toBeCloseTo(1, 3);
  });

  it('quantises, because two machines have to agree exactly', () => {
    const t = clampTag({ x: 1.23456789, y: 2.98765, z: -0.00049 });
    expect(t.x).toBeCloseTo(1.235, 9);
    expect(t.z).toBe(-0);
  });

  it('stamps the sprayer from the caller, never from the message', () => {
    // Otherwise "I sprayed this" becomes "*they* sprayed this", and the cap
    // that stops one person filling the garden is somebody else's to spend.
    const t = clampTag({ by: 99 } as unknown, 4);
    expect(t.by).toBe(4);
  });
});

describe('the caps, which are part of the mechanic', () => {
  const many = (n: number, by: number): TagRecord[] =>
    Array.from({ length: n }, (_, i) => tag({ by, x: i }));

  it('never refuses a spray', () => {
    // Nobody is told "no more paint". The cap moves the oldest one instead,
    // which is a limit on how much of the garden you occupy rather than on how
    // long you may stand there enjoying yourself.
    let tags = many(PER_PLAYER, 1);
    const out = addTag(tags, tag({ by: 1, x: 999 }));
    expect(out.tags.some((t) => t.x === 999)).toBe(true);
    expect(out.tags.length).toBe(PER_PLAYER);
    expect(out.dropped).toHaveLength(1);
  });

  it('takes the spammer\'s own oldest and nobody else\'s', () => {
    // A rule that took somebody else's would make a can of paint a weapon.
    const theirs = many(PER_PLAYER, 2);
    const mine = many(PER_PLAYER, 1);
    const out = addTag([...theirs, ...mine], tag({ by: 1, x: 999 }));
    expect(out.dropped.every((t) => t.by === 1)).toBe(true);
    expect(out.tags.filter((t) => t.by === 2)).toHaveLength(PER_PLAYER);
  });

  it('holds the world to a ceiling however many people are spraying', () => {
    const crowd: TagRecord[] = [];
    for (let who = 0; who < 20; who++) crowd.push(...many(PER_PLAYER, who));
    let tags = crowd;
    for (let i = 0; i < 50; i++) tags = addTag(tags, tag({ by: 100 + i })).tags;
    expect(tags.length).toBeLessThanOrEqual(WORLD_LIMIT);
  });

  it('leaves everything alone while there is room', () => {
    const out = addTag(many(3, 1), tag({ by: 1 }));
    expect(out.dropped).toHaveLength(0);
    expect(out.tags).toHaveLength(4);
  });
});

describe('a tag goes when what it is on goes', () => {
  it('names the ones stuck to parts that came down', () => {
    // With the support rule in, parts vanish in groups. A tag left behind by
    // the plank it was painted on is a mark hanging in mid-air.
    const tags = [tag({ part: 3 }), tag({ part: 7 }), tag({ part: -1 })];
    expect(orphaned(tags, new Set([3, 7]))).toHaveLength(2);
  });

  it('leaves the ones on the map alone, whatever came down', () => {
    const tags = [tag({ part: -1 })];
    expect(orphaned(tags, new Set([-1, 0, 1]))).toHaveLength(0);
  });

  it('says nothing when nothing came down', () => {
    expect(orphaned([tag({ part: 3 })], new Set())).toHaveLength(0);
  });
});

describe('reaching a surface', () => {
  it('needs something to spray onto', () => {
    expect(inRange(1, false)).toBe(false);
    expect(inRange(1, true)).toBe(true);
  });

  it('is a can rather than a rifle', () => {
    expect(inRange(SPRAY_RANGE, true)).toBe(true);
    expect(inRange(SPRAY_RANGE + 0.01, true)).toBe(false);
    expect(SPRAY_RANGE).toBeLessThan(5);
  });
});
