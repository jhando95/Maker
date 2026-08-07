import { describe, it, expect } from 'vitest';
import {
  AFTERNOON, DUSK, GOLDEN, LAMP_TIME, MIN_SUN_ELEVATION,
  clampDay, daylightAt, dayTimeForRound, mixHex, sunAt,
} from './daylight.ts';
import { DEFAULT_BANDS } from '../render/toonMaterial.ts';

const luma = (hex: number): number =>
  (0.2126 * ((hex >> 16) & 255) + 0.7152 * ((hex >> 8) & 255) + 0.0722 * (hex & 255)) / 255;

const times = [0, 0.2, 0.4, 0.55, 0.62, 0.8, 0.95, 1];

describe('the sun', () => {
  it('goes down as the afternoon does', () => {
    let last = Infinity;
    for (const t of times) {
      const y = sunAt(t).y;
      expect(y, `the sun rose again at ${t}`).toBeLessThan(last);
      last = y;
    }
  });

  it('never gets so low that a wall stops catching it', () => {
    // A sun on the horizon puts every vertical face edge-on to the key light,
    // and under a three-band ramp that is not "sunset" — it is "the lights went
    // out", all at once, everywhere. The floor is what keeps a fence post lit
    // down one side, which is the thing that makes a long shadow read as a long
    // shadow rather than as darkness.
    for (const t of times) {
      expect(sunAt(t).y, `the sun is under the floor at ${t}`)
        .toBeGreaterThanOrEqual(MIN_SUN_ELEVATION - 1e-9);
    }
  });

  it('swings round as well as down', () => {
    // A sun that only sinks keeps pointing the same way and the shadows merely
    // get longer in a direction the player already knows. Swinging it changes
    // the shape of the yard as the round runs, which is the half of a sunset
    // people actually notice.
    const noon = sunAt(AFTERNOON);
    const dusk = sunAt(DUSK);
    const noonAzimuth = Math.atan2(noon.z, noon.x);
    const duskAzimuth = Math.atan2(dusk.z, dusk.x);
    expect(Math.abs(duskAzimuth - noonAzimuth)).toBeGreaterThan(0.5);
  });

  it('stays a unit vector, so nothing has to normalise it again', () => {
    for (const t of times) {
      const s = sunAt(t);
      expect(Math.hypot(s.x, s.y, s.z)).toBeCloseTo(1, 6);
    }
  });

  it('does not jump at the top of the afternoon', () => {
    // The azimuth starts from the direction the map was lit and built against,
    // so opening a round must not snap the shadows to somewhere else.
    const s = sunAt(AFTERNOON);
    const wanted = { x: 28, y: 34, z: 18 };
    const len = Math.hypot(wanted.x, wanted.y, wanted.z);
    expect(s.x).toBeCloseTo(wanted.x / len, 5);
    expect(s.y).toBeCloseTo(wanted.y / len, 5);
    expect(s.z).toBeCloseTo(wanted.z / len, 5);
  });
});

describe('the light itself', () => {
  it('warms as it goes', () => {
    // Not a claim about brightness — a claim about hue. What reads as evening
    // in a cartoon is the warm/cool split widening, not the exposure dropping.
    const warmth = (hex: number) => ((hex >> 16) & 255) - (hex & 255);
    expect(warmth(daylightAt(DUSK).sunColor))
      .toBeGreaterThan(warmth(daylightAt(AFTERNOON).sunColor));
    expect(warmth(daylightAt(GOLDEN).sunColor))
      .toBeGreaterThan(warmth(daylightAt(AFTERNOON).sunColor));
  });

  it('brings the fill UP as the key goes down', () => {
    // The counter-intuitive one, and the important one. Dim the fill along with
    // the key and everything in shadow lands in the bottom band together — a
    // lawn, a fence and a kid all become one dark shape, and a game about
    // telling who is who across a garden stops working.
    const day = daylightAt(AFTERNOON);
    const dusk = daylightAt(DUSK);
    expect(dusk.sunIntensity).toBeLessThan(day.sunIntensity);
    expect(dusk.fillIntensity).toBeGreaterThan(day.fillIntensity);
  });

  it('keeps enough key over fill for three bands to still be three', () => {
    // The shading is three hard steps on dot(N, L). If the fill ever catches
    // the key, the steps stop being visible and the whole world goes flat —
    // which is a cel-shaded game losing the only thing it has.
    for (const t of times) {
      const light = daylightAt(t);
      expect(light.sunIntensity / light.fillIntensity, `the bands collapse at ${t}`)
        .toBeGreaterThan(1.5);
    }
    // And the ramp it has to survive really does have three distinct steps.
    expect(DEFAULT_BANDS.band0).toBeLessThan(DEFAULT_BANDS.band1);
  });

  it('never turns the key light off', () => {
    for (const t of times) {
      expect(daylightAt(t).sunIntensity, `there is no sun at ${t}`).toBeGreaterThan(1);
    }
  });

  it('darkens the sky and warms the horizon, which is what a sunset is', () => {
    const day = daylightAt(AFTERNOON);
    const dusk = daylightAt(DUSK);
    expect(luma(dusk.skyTop)).toBeLessThan(luma(day.skyTop));
    const warmth = (hex: number) => ((hex >> 16) & 255) - (hex & 255);
    expect(warmth(dusk.skyHorizon)).toBeGreaterThan(warmth(day.skyHorizon));
  });

  it('keeps the fog the colour of the horizon it fades into', () => {
    // Any other colour and distant scenery dissolves into a band that does not
    // match the sky above it, which is the single most obvious way fog looks
    // like fog rather than like distance.
    for (const t of times) {
      const light = daylightAt(t);
      expect(light.fog, `fog and horizon disagree at ${t}`).toBe(light.skyHorizon);
    }
  });

  it('closes the haze in without hiding the horizon it paid for', () => {
    const day = daylightAt(AFTERNOON);
    const dusk = daylightAt(DUSK);
    expect(dusk.fogNear).toBeLessThan(day.fogNear);
    expect(dusk.fogFar).toBeLessThan(day.fogFar);
    // The far houses are about 90m out and the woods further. Fogging them away
    // would be paying for a horizon twice and then hiding it.
    expect(dusk.fogFar).toBeGreaterThan(120);
    expect(dusk.fogNear).toBeLessThan(dusk.fogFar);
  });

  it('lights the lamps late, so it lands as an event', () => {
    expect(daylightAt(AFTERNOON).lampsLit).toBe(false);
    expect(daylightAt(GOLDEN).lampsLit).toBe(false);
    expect(daylightAt(LAMP_TIME).lampsLit).toBe(true);
    expect(daylightAt(DUSK).lampsLit).toBe(true);
  });

  it('spends most of its change in the second half', () => {
    // A single lerp across the whole round spends four of its five minutes on a
    // sky nobody would call either afternoon or dusk. The interesting part of
    // an evening is all at the end of it.
    const early = luma(daylightAt(0.4).skyTop) - luma(daylightAt(0).skyTop);
    const late = luma(daylightAt(0.4).skyTop) - luma(daylightAt(0.8).skyTop);
    expect(Math.abs(late)).toBeGreaterThan(Math.abs(early) * 2);
  });
});

describe('mixHex', () => {
  it('returns each end at each end', () => {
    expect(mixHex(0x102030, 0xa0b0c0, 0)).toBe(0x102030);
    expect(mixHex(0x102030, 0xa0b0c0, 1)).toBe(0xa0b0c0);
  });

  it('blends channel by channel rather than as one number', () => {
    // Lerping the packed integer looks right for greys and is nonsense the
    // moment two channels move in opposite directions.
    expect(mixHex(0x000000, 0xff0000, 0.5)).toBe(0x800000);
    expect(mixHex(0xff0000, 0x0000ff, 0.5)).toBe(0x800080);
  });

  it('clamps rather than extrapolating off either end', () => {
    expect(mixHex(0x102030, 0xa0b0c0, -5)).toBe(0x102030);
    expect(mixHex(0x102030, 0xa0b0c0, 5)).toBe(0xa0b0c0);
  });
});

describe('the round clock', () => {
  it('runs the afternoon out across the round', () => {
    expect(dayTimeForRound(0, 300)).toBe(0);
    expect(dayTimeForRound(150, 300)).toBeCloseTo(0.5, 6);
    expect(dayTimeForRound(300, 300)).toBe(1);
  });

  it('stops at dusk rather than wrapping round to morning', () => {
    // A day that loops is a day. This is an afternoon, and the point of it is
    // that it ends.
    expect(dayTimeForRound(900, 300)).toBe(1);
  });

  it('sits in the afternoon when there is no round to measure', () => {
    expect(dayTimeForRound(50, 0)).toBe(AFTERNOON);
    expect(dayTimeForRound(50, -1)).toBe(AFTERNOON);
  });

  it('survives a clock that has gone strange', () => {
    expect(clampDay(NaN)).toBe(0);
    expect(clampDay(Infinity)).toBe(0);
    expect(clampDay(-3)).toBe(0);
    expect(clampDay(3)).toBe(1);
  });
});
