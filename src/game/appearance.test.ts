/**
 * The limits, mostly.
 *
 * `clampAppearance` is the only door into this type, and everything that comes
 * through it arrives from somewhere nobody controls: a blob in a player's
 * localStorage, a message off a socket written by another browser, a slider in
 * a screen that could be edited from a console. So it is treated the way the
 * chat limiter and the placement check are treated — as the thing standing
 * between one player's choice and everybody else's game.
 *
 * The failure this guards against is quiet and one-sided. A head four times the
 * size does not throw. It is a bigger target, it is visible over the wall its
 * owner is hiding behind, and the cost is paid entirely by the people who did
 * not choose it.
 */

import { describe, it, expect } from 'vitest';
import {
  BROWS, BROWS_NONE, CLOTH_COLOURS, EYE_COLOURS, HAIR_COLOURS, HAIR_STYLES,
  HEAD_MAX, HEAD_MIN, BUILD_MAX, BUILD_MIN, MARK_SHAPES, MARK_SLOTS, MOUTHS,
  SKIN_TONES, blankMark, buildOf, clampAppearance, copyAppearance,
  defaultAppearance, headScaleOf, luma, markSizeOf, sameAppearance,
  MARK_MAX_SIZE, MARK_MIN_SIZE, HAIR_SKIN_CONTRAST,
} from './appearance.ts';

describe('clampAppearance', () => {
  it('takes anything at all and returns something drawable', () => {
    for (const junk of [
      undefined, null, 0, 'hello', [], true, NaN,
      { skin: 'blue' }, { marks: 7 }, { marks: { chest: 'star' } },
    ]) {
      const a = clampAppearance(junk);
      expect(Number.isFinite(a.headSize)).toBe(true);
      expect(SKIN_TONES[a.skin]).toBeDefined();
      expect(HAIR_COLOURS[a.hair]).toBeDefined();
      expect(HAIR_STYLES[a.hairStyle]).toBeDefined();
      expect(EYE_COLOURS[a.eyes]).toBeDefined();
      expect(BROWS[a.brows]).toBeDefined();
      expect(MOUTHS[a.mouth]).toBeDefined();
      for (const slot of MARK_SLOTS) {
        expect(MARK_SHAPES[a.marks[slot].shape]).toBeDefined();
        expect(CLOTH_COLOURS[a.marks[slot].colour]).toBeDefined();
      }
    }
  });

  it('refuses to make anybody bigger than the locker allows', () => {
    // The one that matters. Somebody sending `headSize: 40` is asking for an
    // advantage, not for a look, and the answer has to be the same head
    // everybody else can have rather than a slightly smaller giant.
    for (const attempt of [40, 1e9, Infinity, -Infinity, NaN, '999']) {
      const big = clampAppearance({ headSize: attempt, build: attempt });
      expect(headScaleOf(big)).toBeLessThanOrEqual(HEAD_MAX);
      expect(headScaleOf(big)).toBeGreaterThanOrEqual(HEAD_MIN);
      expect(buildOf(big)).toBeLessThanOrEqual(BUILD_MAX);
      expect(buildOf(big)).toBeGreaterThanOrEqual(BUILD_MIN);
    }
  });

  it('keeps the shaping range narrow enough to still be the same game', () => {
    // A limit that permits a head twice the size is not a limit. Stated as a
    // ratio so that widening the range is a decision somebody has to make here
    // rather than a constant they can nudge without noticing.
    expect(HEAD_MAX / HEAD_MIN).toBeLessThan(1.4);
    expect(BUILD_MAX / BUILD_MIN).toBeLessThan(1.5);
  });

  it('pulls an index into a palette that exists, from either end', () => {
    expect(clampAppearance({ skin: -5 }).skin).toBe(0);
    expect(clampAppearance({ skin: 999 }).skin).toBe(SKIN_TONES.length - 1);
    // A fractional index would read a hole out of the palette.
    expect(Number.isInteger(clampAppearance({ hair: 2.7 }).hair)).toBe(true);
  });

  it('bounds a painted mark as tightly as the body it goes on', () => {
    const painted = clampAppearance({
      marks: { chest: { shape: 999, colour: -1, size: 50, turn: -50 } },
    });
    const mark = painted.marks.chest;
    expect(MARK_SHAPES[mark.shape]).toBeDefined();
    expect(markSizeOf(mark)).toBeLessThanOrEqual(MARK_MAX_SIZE);
    expect(markSizeOf(mark)).toBeGreaterThanOrEqual(MARK_MIN_SIZE);
    expect(mark.turn).toBeGreaterThanOrEqual(0);
    expect(mark.turn).toBeLessThanOrEqual(1);
  });

  it('gives every slot a mark, so the renderer never reads undefined', () => {
    const a = clampAppearance({ marks: { chest: { shape: 3 } } });
    for (const slot of MARK_SLOTS) expect(a.marks[slot]).toBeDefined();
    expect(a.marks.back).toEqual(blankMark());
  });

  it('is idempotent — clamping a clamped appearance changes nothing', () => {
    // Which is what makes it safe to call at every boundary rather than
    // reasoning about which boundary already called it. It is applied in the
    // store, on the way onto a wire, on the way off one, and in the renderer.
    const once = clampAppearance({ headSize: 3, skin: 99, marks: { back: { shape: 4 } } });
    expect(clampAppearance(once)).toEqual(once);
  });

  it('never hands back a reference into what it was given', () => {
    const source = clampAppearance({});
    const copy = copyAppearance(source);
    copy.marks.chest.shape = 5;
    expect(source.marks.chest.shape).toBe(0);
  });
});

describe('defaultAppearance', () => {
  it('is the same on every machine that ever draws that id', () => {
    // The property the locker gives up for players and keeps for everybody
    // else: nobody sends what a bot looks like, and two clients that have never
    // spoken still agree.
    for (const id of [0, 1, 7, 41, 900]) {
      expect(sameAppearance(defaultAppearance(id), defaultAppearance(id))).toBe(true);
    }
  });

  it('makes a lawn of people rather than a lawn of one person', () => {
    const seen = new Set<string>();
    for (let id = 0; id < 24; id++) {
      const a = defaultAppearance(id);
      seen.add(`${a.skin}/${a.hair}/${a.hairStyle}/${a.eyes}`);
    }
    expect(seen.size).toBeGreaterThan(12);
  });

  it('never puts hair the colour of the skin under it', () => {
    // Both palettes contain warm browns, so picking from each independently
    // eventually lands mid-brown on mid-brown and the head becomes one
    // featureless lump — which is what the first kid this game ever drew
    // looked like. Checked across far more ids than a round ever has.
    for (let id = 0; id < 500; id++) {
      const a = defaultAppearance(id);
      const gap = Math.abs(luma(SKIN_TONES[a.skin]!) - luma(HAIR_COLOURS[a.hair]!));
      expect(gap, `kid ${id} has hair the colour of their head`)
        .toBeGreaterThanOrEqual(HAIR_SKIN_CONTRAST - 1e-9);
    }
  });

  it('never shaves anybody or takes their brows off by accident', () => {
    // Both exist as choices. Neither should turn up on a bot: one kid in eight
    // with no hair reads as a bug in the hair rather than as a haircut.
    for (let id = 0; id < 300; id++) {
      const a = defaultAppearance(id);
      expect(HAIR_STYLES[a.hairStyle]!.wide, `kid ${id} was born shaved`).toBeGreaterThan(0);
      expect(a.brows, `kid ${id} has no eyebrows`).toBeLessThan(BROWS_NONE);
    }
  });

  it('paints nobody by default', () => {
    // Paint is a thing somebody did, and a bot with a star on its chest is a
    // bot that looks like a player.
    for (let id = 0; id < 50; id++) {
      for (const slot of MARK_SLOTS) {
        expect(defaultAppearance(id).marks[slot].shape).toBe(0);
      }
    }
  });

  it('lands comfortably inside the limits rather than at their edges', () => {
    // If the seeded generator produced values at the clamp boundaries, the
    // limits would be doing nothing and nobody would notice until somebody
    // moved them.
    for (let id = 0; id < 200; id++) {
      const a = defaultAppearance(id);
      expect(a.headSize).toBeGreaterThanOrEqual(0);
      expect(a.headSize).toBeLessThanOrEqual(1);
      expect(a.build).toBeGreaterThanOrEqual(0);
      expect(a.build).toBeLessThanOrEqual(1);
    }
  });
});

describe('the palettes', () => {
  it('has a shape called none, first, so zero means unpainted', () => {
    // Every blank mark is `{ shape: 0 }`, including the one `clampAppearance`
    // invents for a missing slot. If `none` stopped being first, every
    // unpainted kid would silently acquire a stripe.
    expect(MARK_SHAPES[0]).toBe('none');
  });

  it('keeps the eye colours apart under a three-band ramp', () => {
    // An iris is about eight pixels across at the distance this is played at,
    // and toon shading flattens anything close together into the same tone. A
    // palette that reads as one colour is a palette with one entry.
    const seen = new Set(EYE_COLOURS.map((c) => luma(c).toFixed(2)));
    expect(seen.size).toBeGreaterThan(3);
  });

  it('has a hair style that draws nothing, and it is not the default', () => {
    expect(HAIR_STYLES[0]!.wide).toBe(0);
    expect(HAIR_STYLES.filter((h) => h.wide === 0)).toHaveLength(1);
  });

  it('has one brow that draws nothing, and the renderer knows which', () => {
    expect(BROWS_NONE).toBe(BROWS.length - 1);
    expect(BROWS[BROWS_NONE]!.name).toBe('None');
  });
});
