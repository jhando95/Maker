/**
 * What time it is, and what that does to the light.
 *
 * Every screenshot this game has ever taken is the same flat midday. The
 * premise is an afternoon in somebody's back garden, and the most evocative
 * thing a game about a back garden can do is get *late* — the light goes long
 * and gold, the shadows stretch across the lawn, the sky drains, and eventually
 * the streetlights come on and somebody's mum calls them in. A round that
 * starts in the afternoon and ends at dusk is the same round with a completely
 * different feeling attached to the end of it.
 *
 * ## It is presentation, and never anything else
 *
 * Nothing simulates the time. No mode reads it, no rule depends on it, nothing
 * collides with it, and it is never sent — a guest computes it from the round
 * timer it already receives, which means both machines reach the same sky from
 * the same number with no traffic at all. That is the same bargain the garden
 * items strike, and it is the reason this is cheap: the day is a function of a
 * clock everybody already has.
 *
 * ## What the toon ramp does to a sunset, which is the whole difficulty
 *
 * This is not a physically-based renderer and it must not be lit like one. The
 * shading is three hard bands with a one-pixel blend at each edge, and the
 * bands are positions on `dot(N, L)` — so what actually reads as "evening" is
 * not a dimmer sun, it is:
 *
 * - **a lower sun**, which is what stretches shadows and rakes the light across
 *   vertical faces that were flat at noon;
 * - **a warmer key against a cooler fill**, because the whole cartoon look
 *   lives in the warm/cool split and evening is when that split is widest;
 * - **an ambient floor that comes UP, not down.**
 *
 * That last one is counter-intuitive and it is the important one. Dim the fill
 * along with the key and everything in shadow lands in the bottom band together
 * — a lawn, a fence and a kid all become the same dark shape, and a game about
 * telling who is who across a garden stops working. So the hemisphere light
 * *gains* as the sun goes, which is also what really happens: at dusk the sky
 * is the brightest thing left and it is lighting everything.
 *
 * `daylight.test.ts` asserts both ends of that: the sun never dips below the
 * angle where a vertical wall stops catching it, and the gap between key and
 * fill never closes far enough for the three bands to collapse into two.
 */

/** Where in the afternoon we are: 0 is bright and high, 1 is the streetlights. */
export type DayTime = number;

/**
 * Named moments, so code and comments can say when they mean.
 *
 * The names are the point of the file: nobody should be writing `0.62` into a
 * mode and hoping the next person knows it means the light is going.
 */
export const AFTERNOON: DayTime = 0;
export const GOLDEN: DayTime = 0.62;
export const DUSK: DayTime = 1;

/** Everything the scene needs to look like a given time of day. */
export interface Daylight {
  /** Unit vector from the origin toward the sun. */
  sun: { x: number; y: number; z: number };
  sunColor: number;
  sunIntensity: number;
  skyTop: number;
  skyHorizon: number;
  fog: number;
  /** Fog distances. Evening haze closes in; midday does not. */
  fogNear: number;
  fogFar: number;
  /** Hemisphere fill: the sky half, the bounced-grass half, and how strong. */
  fillSky: number;
  fillGround: number;
  fillIntensity: number;
  /** True once the street lamps are fully on. */
  lampsLit: boolean;
  /**
   * How far up the lamps are, 0 to 1.
   *
   * Separate from `lampsLit` because a light that appears between one frame and
   * the next is a bug that looks like a bug, and because a sodium lamp really
   * does take a moment to come up — it flickers on dim and orange and reaches
   * full a good few seconds later. `lampsLit` is still the event, and still
   * lands where it always did: the ramp is behind it and finishes there.
   */
  lampGlow: number;
}

/**
 * The lowest the sun is allowed to get.
 *
 * A sun on the horizon is a scene where every vertical face is edge-on to the
 * key light and lands in the shadow band at once, which under a three-band ramp
 * is not "sunset", it is "the lights went out". Twelve degrees keeps a fence
 * post lit down one side, which is the thing that makes a long shadow read as a
 * long shadow rather than as darkness.
 */
export const MIN_SUN_ELEVATION = 0.21;

/** Where the sun sits at the top of the afternoon. Matches the old fixed one. */
const NOON_DIR = { x: 28, y: 34, z: 18 };

/** Linear blend between two packed sRGB colours, channel by channel. */
export function mixHex(a: number, b: number, t: number): number {
  const k = Math.min(1, Math.max(0, t));
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  const r = Math.round(ar + (br - ar) * k);
  const g = Math.round(ag + (bg - ag) * k);
  const bl = Math.round(ab + (bb - ab) * k);
  return (r << 16) | (g << 8) | bl;
}

/** Clamp a time into the range the rest of this file assumes. */
export function clampDay(t: number): DayTime {
  return Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0;
}

/**
 * The sun's elevation, as a unit vector, at a given time.
 *
 * Swung down and *round* rather than only down. A sun that only sinks keeps
 * pointing the same way across the map and the shadows merely get longer in a
 * direction the player has already learned; swinging it toward the west end of
 * the garden means the shape of the yard changes as the round runs, which is
 * the half of a sunset people actually notice.
 */
export function sunAt(t: DayTime): { x: number; y: number; z: number } {
  const k = clampDay(t);
  // Start from the noon direction's own azimuth so nothing jumps at t = 0.
  const azimuth = Math.atan2(NOON_DIR.z, NOON_DIR.x) + k * 0.85;
  const flat = Math.hypot(NOON_DIR.x, NOON_DIR.z);
  const noonElevation = Math.atan2(NOON_DIR.y, flat);
  const elevation = noonElevation + (Math.asin(MIN_SUN_ELEVATION) - noonElevation) * k;
  const cos = Math.cos(elevation);
  return {
    x: Math.cos(azimuth) * cos,
    y: Math.sin(elevation),
    z: Math.sin(azimuth) * cos,
  };
}

/** Midday white through afternoon gold to the deep orange of a low sun. */
const SUN_HIGH = 0xfff4d6;
const SUN_GOLD = 0xffd79a;
const SUN_LOW = 0xff9d5c;

const SKY_TOP_DAY = 0x5bb8e8;
const SKY_TOP_DUSK = 0x2e4a7a;
const SKY_HORIZON_DAY = 0xdcf1fb;
const SKY_HORIZON_DUSK = 0xf7b27a;

/**
 * The fill, which goes *up*.
 *
 * See the header. The sky half also swings from a pale daylight blue to the
 * violet a real dusk sky throws, which is the single cheapest thing that makes
 * an evening look like an evening rather than like a screenshot with the
 * brightness turned down.
 */
const FILL_SKY_DAY = 0xbfe6ff;
const FILL_SKY_DUSK = 0x8f9ede;
const FILL_GROUND_DAY = 0x7fa84a;
const FILL_GROUND_DUSK = 0x4a5a3c;

/** When the lamps come on. Late, so it lands as an event rather than a fade. */
export const LAMP_TIME = 0.82;

/**
 * How long the lamps take to warm up, as a fraction of the afternoon.
 *
 * About eighteen seconds of a five-minute round. Long enough that nothing pops,
 * short enough that it still reads as the lights coming on rather than as the
 * sky doing something. It runs *up to* `LAMP_TIME` rather than away from it, so
 * the moment the lamps are at full is the moment the name says.
 */
export const LAMP_WARMUP = 0.06;

/**
 * How far up the lamps are at a given time.
 *
 * Written backwards from `LAMP_TIME` rather than forwards from the start of the
 * ramp, and that is not a style choice: `0.82 - 0.06` is `0.7599999999999999`
 * in binary, so counting up from it lands on `0.9999999999999991` at the one
 * moment the constant is named for. Counting down from `LAMP_TIME` puts the
 * exact answer at the end that has a name, and leaves the float dust at the
 * start, where it is clamped to zero anyway.
 */
export function lampGlowAt(t: DayTime): number {
  const k = clampDay(t);
  const glow = 1 - (LAMP_TIME - k) / LAMP_WARMUP;
  // Snapped rather than clamped, because the dust at the bottom is positive:
  // `1 - 0.06000000000000005 / 0.06` is 9e-16, and 9e-16 is not "off". Off is
  // a count of zero instances, and anything above zero pays for the whole draw
  // to blend nothing over the picture — for a full quantised step, since 0.76
  // is exactly one of the hundredths `setDaylight` lands on.
  if (!(glow > 1e-6)) return 0;
  return Math.min(1, glow);
}

export function daylightAt(t: DayTime): Daylight {
  const k = clampDay(t);
  // Two segments rather than one, because the interesting part of an evening is
  // all in its second half: the light barely moves for the first hour and then
  // goes in twenty minutes. A single lerp spends most of the round on a sky
  // nobody would call either afternoon or dusk.
  const late = Math.max(0, (k - 0.45) / 0.55);

  return {
    sun: sunAt(k),
    sunColor: k < 0.55
      ? mixHex(SUN_HIGH, SUN_GOLD, k / 0.55)
      : mixHex(SUN_GOLD, SUN_LOW, (k - 0.55) / 0.45),
    // Down, but not out — and never past the point where the lit band stops
    // existing. Half of what is lost here comes back on the fill below.
    sunIntensity: 2.6 - 1.15 * late,
    skyTop: mixHex(SKY_TOP_DAY, SKY_TOP_DUSK, late),
    skyHorizon: mixHex(SKY_HORIZON_DAY, SKY_HORIZON_DUSK, late),
    fog: mixHex(SKY_HORIZON_DAY, SKY_HORIZON_DUSK, late),
    // Haze closes in as it cools. Not far: the horizon is most of what this map
    // spent its scenery budget on and fogging it out would be paying twice.
    fogNear: 45 - 12 * late,
    fogFar: 190 - 45 * late,
    fillSky: mixHex(FILL_SKY_DAY, FILL_SKY_DUSK, late),
    fillGround: mixHex(FILL_GROUND_DAY, FILL_GROUND_DUSK, late),
    fillIntensity: 0.5 + 0.45 * late,
    lampsLit: k >= LAMP_TIME,
    lampGlow: lampGlowAt(k),
  };
}

/**
 * Where in the afternoon a round of the given length has got to.
 *
 * The clock is the round's own, which is what makes this free: a guest is
 * already told how long is left, so both machines land on the same sky from the
 * same number and nothing about the light is ever sent.
 *
 * It stops at `DUSK` rather than wrapping. A day that loops is a day, and this
 * is an afternoon — the point of it is that it ends.
 */
export function dayTimeForRound(elapsed: number, roundLength: number): DayTime {
  if (!(roundLength > 0)) return AFTERNOON;
  return clampDay(elapsed / roundLength);
}
