/**
 * The buildable set.
 *
 * One invariant governs every part: the long axis is local +X, thickness is
 * local +Y, width is local +Z. Snap features (face frames, edge frames, corner
 * frames) are derived from half-extents on demand rather than stored per part,
 * and that only works because every part agrees on which axis means what.
 *
 * Dimensions are built from a 0.25m module. That single number is simultaneously
 * the stair rise, the ladder rung pitch, and the placement grid, so a player who
 * stacks parts on the grid gets a climbable staircase without being told what a
 * climbable staircase is. Board thickness is 0.05m, which divides the module
 * exactly (5 x 0.05 = 0.25), so boards laid flat stack into module-aligned
 * heights instead of drifting off the grid.
 */

/** Base grid. Stair rise, ladder rung pitch, and snap lattice all equal this. */
export const MODULE = 0.25;
/** Fine grid, for deliberate off-module placement. Also the board thickness. */
export const FINE_MODULE = 0.05;
export const BOARD_THICKNESS = 0.05;
/** Comfortable stair: 0.5 run over 0.25 rise is about 27 degrees. */
export const STAIR_RUN = 0.5;

export type PartKindId = number;

export interface PartKind {
  id: PartKindId;
  /** Stable string key — this is what gets serialized, not the numeric id. */
  key: string;
  /** Shown in the hotbar. */
  name: string;
  /** Full dimensions in meters: length along +X, thickness along +Y, width along +Z. */
  length: number;
  thickness: number;
  width: number;
  /** Edge bevel width. Visible chamfer is most of what sells the cartoon look. */
  chamfer: number;
  /** Wedge parts taper along +X, so their +Y face is a ramp rather than flat. */
  isWedge: boolean;
  /** Palette family, used to pick the base tint and outline color. */
  material: 'wood' | 'ply' | 'metal';
}

function part(
  id: number,
  key: string,
  name: string,
  length: number,
  thickness: number,
  width: number,
  opts: Partial<Pick<PartKind, 'chamfer' | 'isWedge' | 'material'>> = {},
): PartKind {
  return {
    id,
    key,
    name,
    length,
    thickness,
    width,
    chamfer: opts.chamfer ?? 0.008,
    isWedge: opts.isWedge ?? false,
    material: opts.material ?? 'wood',
  };
}

/**
 * Eight kinds, one per hotbar slot.
 *
 * Every length is a whole number of modules, so parts butt end to end and stack
 * without accumulating error. Plank width is exactly one module, which means
 * four planks laid side by side span a metre with no seam left over — the
 * difference between a wall that looks built and one that looks approximated.
 */
export const PART_KINDS: readonly PartKind[] = [
  part(0, 'plank', 'Plank', 1.0, BOARD_THICKNESS, MODULE),
  part(1, 'plank_long', 'Long Plank', 2.0, BOARD_THICKNESS, MODULE),
  part(2, 'plank_short', 'Short Plank', 0.5, BOARD_THICKNESS, MODULE),
  part(3, 'beam', 'Beam', 2.0, 0.1, 0.1, { chamfer: 0.012 }),
  part(4, 'post', 'Post', 1.5, 0.1, 0.1, { chamfer: 0.012 }),
  part(5, 'panel', 'Panel', 1.0, BOARD_THICKNESS, 1.0, { chamfer: 0.006, material: 'ply' }),
  part(6, 'ramp', 'Ramp', 1.0, 0.5, MODULE, { isWedge: true, chamfer: 0.01 }),
  part(7, 'block', 'Block', MODULE, MODULE, MODULE, { chamfer: 0.015 }),
];

export const PART_BY_KEY: ReadonlyMap<string, PartKind> = new Map(
  PART_KINDS.map((k) => [k.key, k]),
);

export function getPartKind(id: PartKindId): PartKind {
  const kind = PART_KINDS[id];
  if (kind === undefined) throw new RangeError(`unknown part kind ${id}`);
  return kind;
}

/**
 * Collision shape for a part, expressed in the part's own local frame.
 *
 * Every part in the collision world is an oriented box, but the ramp renders as
 * a wedge. Colliding it as its bounding box puts an invisible wall over the
 * slope — you can see the ramp and cannot walk up it.
 *
 * The fix is a proxy: a thin slab lying along the slope face, so the walkable
 * surface matches what is drawn. The wedge's slope runs corner to corner through
 * the local origin, from (-hx, +hy) to (+hx, -hy), so the slab is that segment
 * rotated about Z, pushed half its thickness below the slope plane so its top
 * face lands exactly on it.
 *
 * The space underneath the slab is not solid. For a ramp resting on the ground
 * that is unreachable; for one placed in mid-air you can pass beneath it, which
 * is the honest behaviour for a thin ramp anyway.
 */
export interface CollisionProxy {
  /** Offset from the part's centre, in the part's local frame. */
  ox: number; oy: number; oz: number;
  /** Rotation relative to the part's own orientation. */
  qx: number; qy: number; qz: number; qw: number;
  hx: number; hy: number; hz: number;
}

/** Thickness of the slab standing in for a wedge's slope. */
export const WEDGE_PROXY_THICKNESS = 0.1;

/**
 * The collision proxy for a kind, or null when the part collides as its own box
 * (which is every kind except the wedge).
 */
export function collisionProxy(kind: PartKind): CollisionProxy | null {
  if (!kind.isWedge) return null;

  const hx = kind.length / 2;
  const hy = kind.thickness / 2;
  const hz = kind.width / 2;

  // Half the slope's length, and the angle it makes with +X.
  const half = Math.hypot(hx, hy);
  const theta = -Math.atan2(hy, hx);

  // Outward normal of the slope face, pointing up and along +X.
  const nx = hy / half;
  const ny = hx / half;

  const t = Math.min(WEDGE_PROXY_THICKNESS, kind.thickness * 0.5);
  const halfT = t / 2;

  return {
    // Sunk half a thickness along -normal, so the slab's top face is the slope.
    ox: -nx * halfT,
    oy: -ny * halfT,
    oz: 0,
    // Rotation about Z only.
    qx: 0,
    qy: 0,
    qz: Math.sin(theta / 2),
    qw: Math.cos(theta / 2),
    hx: half,
    hy: halfT,
    hz,
  };
}

/** Half-extents, the form the collision world and snapping both want. */
export function halfExtents(kind: PartKind): { hx: number; hy: number; hz: number } {
  return { hx: kind.length / 2, hy: kind.thickness / 2, hz: kind.width / 2 };
}

/**
 * Colorways.
 *
 * Kept as a small fixed palette rather than free color choice: a shared palette
 * keeps every player's fort looking like it belongs in the same backyard, and it
 * packs into a single byte for the network.
 */
export const COLORWAYS: readonly number[] = [
  0xc89f6a, // raw pine
  0xa87444, // cedar
  0x8a5a3b, // stained
  0xd9c3a0, // pale ply
  0xd8564f, // painted red
  0x4f8fd8, // painted blue
  0x63b04f, // painted green
  0xe8d44f, // painted yellow
];

export const OUTLINE_COLORS: Record<PartKind['material'], number> = {
  wood: 0x4a3122,
  ply: 0x5a4432,
  metal: 0x3a2c2a,
};
