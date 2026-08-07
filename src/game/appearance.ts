/**
 * What somebody chose to look like.
 *
 * The rig used to derive everybody's appearance from their actor id, and that
 * had one very good property: two machines that had never spoken agreed about
 * what a person looked like, and nobody had to send anything. A locker gives
 * that up on purpose — a chosen face is not a function of an id — so the thing
 * that replaces it has to earn its way back:
 *
 * - **It is plain data.** Numbers and small integers, no colours, no geometry,
 *   no three.js. The same record goes into localStorage, over a socket, and
 *   into the renderer, and none of those three can be handed an object that one
 *   of the others cannot read.
 * - **Every field is bounded, and the bound is enforced on the way in.** Not on
 *   the way out, and not by the screen that produced it. `clamp` is the only
 *   door, and everything that arrives from storage, from a wire, or from a
 *   slider goes through it. A appearance out of somebody else's browser is
 *   untrusted input in exactly the way a chat line is.
 * - **The default is still the seeded one.** A bot has never opened a locker
 *   and never will, and neither has a player who has not touched the screen, so
 *   `defaultAppearance(id)` is what everybody starts as and the lawn is as
 *   varied as it was.
 *
 * ## Why the limits are hard limits
 *
 * The shaping sliders are the part a player can get wrong for everybody else.
 * A head twice the size is a different game — it is a bigger target, it is
 * visible over a wall its owner is hiding behind, and it stops looking like the
 * same world. So the sliders run 0..1 and the range they map onto is stated
 * here, narrow, and applied by this file rather than by the screen: a client
 * that sends `headSize: 40` gets 1, not a giant.
 *
 * The one thing a player cannot choose at all is **height**, and that is the
 * same rule the rig already holds itself to. Joints are tied to `CAP_HEIGHT` so
 * the drawing and the capsule cannot disagree about how tall somebody is, and a
 * kid drawn taller than their own collision shape has feet that float and a
 * head that leans through walls.
 */

import { Rng } from '../core/rng.ts';

/** Skin, as hexes rather than as names. Warm to deep, five steps. */
export const SKIN_TONES = [0xf7ddc0, 0xf3cfa8, 0xe0a878, 0xb87a4e, 0x8a5636] as const;

export const HAIR_COLOURS = [
  0x1d1a19, 0x3a2a1c, 0x5d4037, 0x7a4a24, 0xa0522d, 0xc76b3a, 0xd9a441, 0xe8e0d0,
  0x8c3b3b, 0x3f5d8a, 0x2f7d5b, 0x7b4a8c,
] as const;

/**
 * Eyes, and the reason there are this many.
 *
 * An iris is about eight pixels across at the distance this game is played at,
 * so a subtle palette is one colour. These are picked to stay apart under a
 * three-band toon ramp, which flattens anything close together into the same
 * tone — the same reason the skin list is five steps and not fifteen.
 */
export const EYE_COLOURS = [
  0x4a2c17, 0x6b4423, 0x2f6b8a, 0x3f7d4f, 0x5a5f6b, 0x7a4a8c,
] as const;

/** Shirts, trousers and shoes all draw from one wardrobe of flat colours. */
export const CLOTH_COLOURS = [
  0x7a3fc8, 0xe07a4f, 0x3f6fc8, 0x2f9e6b, 0xd8b93f, 0xc8443f,
  0xe8e2d4, 0x46567a, 0x2b2b30, 0x8c5a3c, 0xd06fa8, 0x39a3b5,
] as const;

/**
 * Hair, as parameters over the one slab the rig already draws.
 *
 * Separate geometry per style would be a mesh and a draw call each, and the
 * silhouette of a cartoon haircut at this scale is carried almost entirely by
 * how tall it is, how far down the back it comes, and whether there is
 * something behind the head. So a style is five numbers, and the one that adds
 * a second piece — the bunch — is the only one that costs anything.
 *
 * `bald` is first on purpose: the list is an ordered menu, and "none" belongs
 * at the top of one.
 */
export interface HairStyle {
  name: string;
  /** Multipliers on the slab. Zero width means no hair at all. */
  wide: number;
  tall: number;
  deep: number;
  /** How far up the skull it sits, as a fraction of the head's radius. */
  lift: number;
  /** And how far back. Positive is behind. */
  back: number;
  /** A bunch behind the head — a ponytail, a puff. Zero for none. */
  bunch: number;
}

export const HAIR_STYLES: readonly HairStyle[] = [
  { name: 'Shaved', wide: 0, tall: 0, deep: 0, lift: 0, back: 0, bunch: 0 },
  { name: 'Crop', wide: 1, tall: 0.55, deep: 1, lift: 0.4, back: 0.1, bunch: 0 },
  { name: 'Bowl', wide: 1.05, tall: 1, deep: 1.05, lift: 0.28, back: 0.12, bunch: 0 },
  { name: 'Mop', wide: 1.08, tall: 1.5, deep: 1.06, lift: 0.24, back: 0.1, bunch: 0 },
  { name: 'Flat top', wide: 1, tall: 1.15, deep: 0.92, lift: 0.42, back: 0.06, bunch: 0 },
  { name: 'Ponytail', wide: 1, tall: 0.8, deep: 1.02, lift: 0.3, back: 0.14, bunch: 0.62 },
  { name: 'Puffs', wide: 1.02, tall: 1.05, deep: 1.02, lift: 0.26, back: 0.1, bunch: 0.95 },
  { name: 'Long', wide: 1.04, tall: 0.9, deep: 1.15, lift: 0.2, back: 0.2, bunch: 1.25 },
];

/**
 * Brows, which are the difference between a face and a mask.
 *
 * Two dark bars over the eyes do more for "this is a person" than the eyes
 * themselves, and they are the only part of the face that carries a mood
 * without needing to animate: a flat pair reads calm, a raised pair reads
 * cheerful, an angled pair reads cross.
 */
export const BROWS = [
  { name: 'Flat', tilt: 0, lift: 0 },
  { name: 'Raised', tilt: 0, lift: 0.06 },
  { name: 'Cheerful', tilt: -0.34, lift: 0.03 },
  { name: 'Cross', tilt: 0.42, lift: -0.01 },
  { name: 'Worried', tilt: -0.5, lift: 0.02 },
  { name: 'None', tilt: 0, lift: 0 },
] as const;
/** The one that draws nothing, by index, so the rig does not match on a name. */
export const BROWS_NONE = BROWS.length - 1;

/** Mouths. Same trick as the brows: a shape, not a texture. */
export const MOUTHS = [
  { name: 'Neutral', wide: 1, tall: 1, curve: 0 },
  { name: 'Grin', wide: 1.35, tall: 0.9, curve: 0.5 },
  { name: 'Smirk', wide: 1.1, tall: 0.85, curve: 0.28 },
  { name: 'Frown', wide: 1, tall: 1, curve: -0.45 },
  { name: 'Small', wide: 0.7, tall: 0.9, curve: 0 },
] as const;

/**
 * Where a painted mark can go.
 *
 * Slots rather than free placement on the body. Dragging a decal around a
 * character in three dimensions needs a gizmo, a projection and a way to say
 * "not there", and what it buys over four good places to put something is very
 * little — every real shirt puts its mark on the chest or the back.
 */
export const MARK_SLOTS = ['chest', 'back', 'leftArm', 'rightArm'] as const;
export type MarkSlot = (typeof MARK_SLOTS)[number];

/**
 * The shapes a player can paint with.
 *
 * A grid of pixels would be the other way to do this, and it is the wrong one
 * here: it needs UVs the character geometry does not have, a texture atlas, a
 * per-instance attribute and a shader patch, all so that a sixteen-square
 * design can be smeared across a curved chest half a metre wide. Flat shapes in
 * flat colours are what this renderer draws well and what reads at forty
 * metres, which is the distance that matters.
 */
export const MARK_SHAPES = [
  'none', 'stripe', 'band', 'circle', 'ring', 'star',
  'bolt', 'heart', 'splat', 'cross', 'chevron', 'diamond',
] as const;
export type MarkShape = (typeof MARK_SHAPES)[number];

export interface Mark {
  shape: number;
  colour: number;
  /** 0..1, mapped onto MARK_MIN_SIZE..MARK_MAX_SIZE. */
  size: number;
  /** 0..1, mapped onto a full turn. */
  turn: number;
}

/** How big a mark may be, in metres across. A chest is about 0.5m wide. */
export const MARK_MIN_SIZE = 0.06;
export const MARK_MAX_SIZE = 0.26;

/**
 * The limits, in one place.
 *
 * Every one of these is the answer to "how far can somebody go before they
 * stop being a kid in this game", and they are deliberately narrow. The
 * defaults the seeded generator produces sit comfortably inside them, so
 * nothing that exists today is at an edge.
 */
export const HEAD_MIN = 0.88;
export const HEAD_MAX = 1.16;
export const BUILD_MIN = 0.84;
export const BUILD_MAX = 1.2;

export interface Appearance {
  skin: number;
  hair: number;
  hairStyle: number;
  eyes: number;
  brows: number;
  mouth: number;
  shirt: number;
  trousers: number;
  shoes: number;
  /** 0..1 sliders. See HEAD_MIN and friends for what they map onto. */
  headSize: number;
  build: number;
  marks: Record<MarkSlot, Mark>;
}

/**
 * A slider, or the middle of its range.
 *
 * The fallback is a parameter because "missing" does not mean the same thing
 * for every slider. Half way is right for a head size or a build — it is the
 * middle of the range and the least surprising thing to inherit. It is wrong
 * for an angle, where the range wraps and half way means upside down, and a
 * mark that arrives with no rotation should have none rather than be inverted.
 */
const clamp01 = (v: unknown, fallback = 0.5): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return n < 0 ? 0 : n > 1 ? 1 : n;
};

const index = (v: unknown, length: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : 0;
  return n < 0 ? 0 : n >= length ? length - 1 : n;
};

/** The mark that means "nothing here". Shape 0 is `none`. */
export function blankMark(): Mark {
  return { shape: 0, colour: 0, size: 0.5, turn: 0 };
}

function clampMark(raw: unknown): Mark {
  const m = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<Mark>;
  return {
    shape: index(m.shape, MARK_SHAPES.length),
    colour: index(m.colour, CLOTH_COLOURS.length),
    size: clamp01(m.size),
    turn: clamp01(m.turn, 0),
  };
}

/**
 * The only way in.
 *
 * Takes anything at all — a parsed blob out of localStorage, a message off a
 * socket, a half-built object from a screen — and returns something the rig can
 * draw. Never throws and never returns a partial: a missing field takes its
 * default, an out-of-range one is pulled to the nearest edge, and an index into
 * a palette that has since shrunk lands on a colour that exists.
 *
 * This is the whole of the promise the file's header makes about limits, so it
 * is also the thing worth attacking in a test.
 */
export function clampAppearance(raw: unknown): Appearance {
  const a = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<Appearance>;
  const marks = (typeof a.marks === 'object' && a.marks !== null
    ? a.marks : {}) as Partial<Record<MarkSlot, Mark>>;
  return {
    skin: index(a.skin, SKIN_TONES.length),
    hair: index(a.hair, HAIR_COLOURS.length),
    hairStyle: index(a.hairStyle, HAIR_STYLES.length),
    eyes: index(a.eyes, EYE_COLOURS.length),
    brows: index(a.brows, BROWS.length),
    mouth: index(a.mouth, MOUTHS.length),
    shirt: index(a.shirt, CLOTH_COLOURS.length),
    trousers: index(a.trousers, CLOTH_COLOURS.length),
    shoes: index(a.shoes, CLOTH_COLOURS.length),
    headSize: clamp01(a.headSize),
    build: clamp01(a.build),
    marks: {
      chest: clampMark(marks.chest),
      back: clampMark(marks.back),
      leftArm: clampMark(marks.leftArm),
      rightArm: clampMark(marks.rightArm),
    },
  };
}

/** A slider, in the units the rig wants. */
export const headScaleOf = (a: Appearance): number =>
  HEAD_MIN + a.headSize * (HEAD_MAX - HEAD_MIN);
export const buildOf = (a: Appearance): number =>
  BUILD_MIN + a.build * (BUILD_MAX - BUILD_MIN);
export const markSizeOf = (m: Mark): number =>
  MARK_MIN_SIZE + m.size * (MARK_MAX_SIZE - MARK_MIN_SIZE);

/**
 * What somebody looks like before anybody has chosen anything.
 *
 * Seeded by id, so a bot is a person rather than a mannequin and two machines
 * that have never spoken still agree about one — which is the property the
 * locker gives up for players and keeps for everybody else.
 *
 * The hair is chosen from what actually contrasts with the skin already picked,
 * rather than from the whole palette and hoping. Both palettes contain warm
 * browns, so picking independently eventually lands mid-brown on mid-brown and
 * the head becomes one featureless lump — which is what the first kid ever
 * drawn by this game looked like.
 */
export function defaultAppearance(id: number): Appearance {
  const rng = new Rng(`kid-${id}`);
  const pick = (length: number): number => Math.floor(rng.next() * length);

  const skin = pick(SKIN_TONES.length);
  const readable: number[] = [];
  for (let i = 0; i < HAIR_COLOURS.length; i++) {
    if (Math.abs(luma(HAIR_COLOURS[i]!) - luma(SKIN_TONES[skin]!)) >= HAIR_SKIN_CONTRAST) {
      readable.push(i);
    }
  }
  return {
    skin,
    // Never empty — the darkest and lightest entries are far apart — but the
    // fallback is here because editing a palette should not be able to crash a
    // character.
    hair: readable.length > 0 ? readable[pick(readable.length)]! : 0,
    // Never Shaved by default. It is a choice somebody makes, and a lawn where
    // one kid in eight has no hair at all reads as a bug in the hair.
    hairStyle: 1 + pick(HAIR_STYLES.length - 1),
    eyes: pick(EYE_COLOURS.length),
    brows: pick(BROWS_NONE),
    mouth: pick(MOUTHS.length),
    // Shirt and trousers only matter off the field: in a mode with sides the
    // shirt is the team's, because being able to tell who is who is worth more
    // than being able to tell who is you.
    shirt: pick(CLOTH_COLOURS.length),
    trousers: 7,
    shoes: 6,
    headSize: rng.next(),
    build: rng.next(),
    marks: {
      chest: blankMark(), back: blankMark(),
      leftArm: blankMark(), rightArm: blankMark(),
    },
  };
}

/**
 * Rough perceived brightness, for keeping hair off skin.
 *
 * Kept here rather than in the renderer because it is a fact about the palette,
 * and the palette lives here now.
 */
export function luma(hex: number): number {
  return (0.2126 * ((hex >> 16) & 255) + 0.7152 * ((hex >> 8) & 255) + 0.0722 * (hex & 255)) / 255;
}

/** Enough of a gap that a hairline is a line rather than a suggestion. */
export const HAIR_SKIN_CONTRAST = 0.24;

/** Deep-copy, because a preset handed out by reference is a preset that edits itself. */
export function copyAppearance(a: Appearance): Appearance {
  return clampAppearance(JSON.parse(JSON.stringify(a)) as unknown);
}

/** Whether two appearances would draw identically. */
export function sameAppearance(a: Appearance, b: Appearance): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
