/**
 * What you fight with, and the tank it all comes out of.
 *
 * Three tools, and the split between them is deliberately the one thing a
 * building game can lean on: **whether cover stops it**.
 *
 * - The **soaker** is a stream. It travels in a straight line and a plank stops
 *   it dead, so it is the weapon that makes a wall worth building — against you
 *   as much as for you.
 * - The **balloon** arcs. It goes over the wall the soaker cannot get through,
 *   which is what stops a fort from being an answer to everything and keeps the
 *   player building a roof as well as a face.
 * - The **hose** only works near a water source, and in exchange it never runs
 *   dry and outranges both. It is why fortifying a source pays twice: the thing
 *   you are defending is also the thing that arms you.
 *
 * An earlier draft had a bucket instead of the hose. Working the numbers killed
 * it: at any cost that made it worth carrying it was a worse soaker with a
 * wind-up, and at any wetness that made it worth firing it was a soaker you
 * could not miss with. Two tools covering one role is one tool.
 *
 * All three draw on one tank, which is what makes choosing between them a
 * decision about how soon you next have to walk to water.
 */

export type WeaponId = 'soaker' | 'balloon' | 'hose';

export interface Weapon {
  readonly id: WeaponId;
  readonly name: string;
  /** One line for the picker. */
  readonly blurb: string;
  /** True when it fires continuously while held rather than per press. */
  readonly continuous: boolean;
  /** Water per second while streaming, or per throw for the balloon. */
  readonly cost: number;
  /** Metres. Beyond this a stream does nothing; a balloon simply falls short. */
  readonly range: number;
  /** Wetness per second at point blank, or per direct hit for the balloon. */
  readonly power: number;
  /** Seconds between shots, for the discrete ones. */
  readonly cooldown: number;
  /** Only usable within HOSE_TETHER of a water source. */
  readonly tethered: boolean;
}

/** Tank capacity, in the same units weapons cost. */
export const TANK_MAX = 100;

/**
 * How close you must be to a source to fill up, and to use the hose.
 *
 * Generous, because the alternative is standing on an exact spot while being
 * shot at, which is fiddly rather than tense.
 */
export const SOURCE_RADIUS = 3.2;

/** Tank filled per second while at a source. */
export const REFILL_RATE = 42;
/**
 * What filling costs the source.
 *
 * Much less than it gives you, but not nothing — free refills would make
 * standing in one pool with a hose an unbeatable position, and the whole mode
 * turns on that not being true.
 */
export const REFILL_DRAW = 9;

/** Wetness a balloon's splash delivers at the centre, falling to zero at the edge. */
export const SPLASH_POWER = 0.3;

/**
 * A direct balloon hit does NOT also take splash.
 *
 * Both existing modes union the direct target into the splash set, so a centre
 * hit lands direct + splash. That is the difference between two hits to soak
 * and three — a fifty per cent swing in the balloon's entire viability — and it
 * should be a decision rather than something inherited from a Set.
 */
export const DIRECT_HIT_TAKES_SPLASH = false;

export const WEAPONS: Readonly<Record<WeaponId, Weapon>> = {
  soaker: {
    id: 'soaker',
    name: 'Super Soaker',
    blurb: 'Steady stream. Blocked by anything solid.',
    continuous: true,
    // 100 tank / 17 per second = 5.9s of stream. At point blank that is four
    // soakings; at maximum range, a little over one. The falloff is the range
    // limit, not a hard cutoff, so the edge of the stream is a bad shot rather
    // than an impossible one.
    cost: 17,
    range: 8.5,
    power: 0.9,
    cooldown: 0,
    tethered: false,
  },
  balloon: {
    id: 'balloon',
    name: 'Water Balloon',
    blurb: 'Arcs over cover. Two on target does it.',
    continuous: false,
    // 12 per throw is eight per tank; at 0.55 a direct hit, two on target is a
    // soaking, so a full tank is four kills' worth if you can land half of them.
    cost: 12,
    // The projectile system's own ceiling: 20m/s at 32m/s² is 12.5m of flat
    // range. Claiming more would be a lie the physics refuses to tell.
    range: 12.5,
    power: 0.55,
    cooldown: 0.45,
    tethered: false,
  },
  hose: {
    id: 'hose',
    name: 'Garden Hose',
    blurb: 'Only near water — but it never runs out.',
    continuous: true,
    // Free, because it is plumbed in. The cost is that it holds you within a
    // few metres of a fixed point everyone else is walking towards.
    cost: 0,
    range: 13,
    power: 0.8,
    cooldown: 0,
    tethered: true,
  },
};

export const WEAPON_ORDER: readonly WeaponId[] = ['soaker', 'balloon', 'hose'];

/**
 * How much pressure a stream loses across its full reach.
 *
 * Not all of it. Falling to zero at the stated range sounds natural and is a
 * trap: with drying at 0.3/s, a stream that tapers to nothing spends most of
 * its advertised range delivering less than the target sheds, so the outer
 * three quarters of the weapon quietly does not work and nothing on screen says
 * so. Tapering to 40% keeps every metre of the range usable while still making
 * closing the distance worth doing.
 */
export const STREAM_FALLOFF = 0.6;

/**
 * Wetness per second a stream delivers at a given distance.
 *
 * Zero past the range — a jet of water has a reach and stops — with a pressure
 * ramp inside it.
 */
export function streamPower(weapon: Weapon, distance: number): number {
  if (distance >= weapon.range) return 0;
  return weapon.power * (1 - STREAM_FALLOFF * (distance / weapon.range));
}

/** Wetness a splash delivers at a given distance from the burst. */
export function splashPower(distance: number, radius: number): number {
  if (distance >= radius) return 0;
  return SPLASH_POWER * (1 - distance / radius);
}

/**
 * Seconds of sustained stream to soak a dry target at a distance.
 *
 * Only used by the balance tests, but it lives here so the number and the
 * weapon it describes cannot drift apart.
 */
export function timeToSoak(weapon: Weapon, distance: number): number {
  const rate = streamPower(weapon, distance);
  return rate <= 0 ? Infinity : 1 / rate;
}

/** How much of a full tank one soaking costs, at a distance. */
export function waterPerSoak(weapon: Weapon, distance: number): number {
  if (weapon.continuous) {
    const seconds = timeToSoak(weapon, distance);
    return seconds === Infinity ? Infinity : seconds * weapon.cost;
  }
  return Math.ceil(1 / weapon.power) * weapon.cost;
}
