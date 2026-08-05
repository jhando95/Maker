import { describe, it, expect } from 'vitest';
import {
  WEAPONS, WEAPON_ORDER, TANK_MAX, REFILL_RATE, REFILL_DRAW,
  streamPower, splashPower, waterPerSoak, SPLASH_POWER,
} from './waterKit.ts';
import {
  makeWetness, tickWetness, soak, isSoaked, wetStage, resetWetness,
  DRY_GRACE, DRY_RATE, MAX_INTAKE_PER_SECOND, SOAK_SCALING, INTAKE_BURST, SOAKED,
} from './wetness.ts';
import { SPLASH_RADIUS, THROW_SPEED_MAX, PROJECTILE_GRAVITY } from './projectiles.ts';

const DT = 1 / 60;

/** Run a stream onto a fresh target and report how long it took to soak. */
function secondsToSoak(power: number): number {
  const w = makeWetness();
  for (let i = 0; i < 60 * 30; i++) {
    tickWetness(w, DT);
    soak(w, power * DT);
    if (isSoaked(w)) return (i + 1) * DT;
  }
  return Infinity;
}

describe('the arsenal has three distinct roles', () => {
  it('no weapon is best at every range', () => {
    // The failure this whole kit was redesigned around: three weapons with a
    // total ordering are one weapon and two taxes.
    const soaker = WEAPONS.soaker;
    const balloon = WEAPONS.balloon;

    // Close in, the stream wins on both speed and water.
    expect(streamPower(soaker, 1)).toBeGreaterThan(0.5);
    // Past the stream's reach it does literally nothing, and the balloon is the
    // only thing that still reaches.
    expect(streamPower(soaker, 10)).toBe(0);
    expect(balloon.range).toBeGreaterThan(soaker.range);
  });

  it('the balloon takes two on target, not three', () => {
    // Three is a different weapon: at the throw cooldown it is four seconds of
    // uninterrupted hits on a target moving faster than the splash radius.
    expect(Math.ceil(1 / WEAPONS.balloon.power)).toBe(2);
  });

  it('the balloon does not claim range the physics cannot deliver', () => {
    // Flat range is v²/g. Advertising further would be a lie the projectile
    // system refuses to tell, and the player would read it as the weapon
    // misbehaving.
    const maxFlat = (THROW_SPEED_MAX * THROW_SPEED_MAX) / PROJECTILE_GRAVITY;
    expect(WEAPONS.balloon.range).toBeLessThanOrEqual(maxFlat);
  });

  it('the hose outranges both and never runs dry', () => {
    expect(WEAPONS.hose.range).toBeGreaterThan(WEAPONS.balloon.range);
    expect(WEAPONS.hose.cost).toBe(0);
    // Which has to be paid for by being pinned to a fixed point.
    expect(WEAPONS.hose.tethered).toBe(true);
    expect(WEAPONS.soaker.tethered).toBe(false);
    expect(WEAPONS.balloon.tethered).toBe(false);
  });

  it('every carried weapon can soak someone on one tank', () => {
    // The bucket died on exactly this test: 0.8 wetness for 55 water could
    // never finish anyone, so it was a setup tool for a weapon that shared its
    // tank, which is not a weapon.
    for (const id of WEAPON_ORDER) {
      const w = WEAPONS[id];
      if (w.tethered) continue;
      const ideal = w.continuous ? 0.5 : 0;
      expect(waterPerSoak(w, ideal), `${id} cannot soak on a full tank`)
        .toBeLessThanOrEqual(TANK_MAX);
    }
  });

  it('the stream is the more efficient of the two carried weapons up close', () => {
    // And that is fine — it has to walk into range to spend it.
    expect(waterPerSoak(WEAPONS.soaker, 1)).toBeLessThan(waterPerSoak(WEAPONS.balloon, 1));
  });

  it('a full tank is worth several soakings, not one', () => {
    // One-kill tanks make the mode a series of walks to the tap.
    expect(TANK_MAX / waterPerSoak(WEAPONS.soaker, 1)).toBeGreaterThan(2.5);
    expect(TANK_MAX / waterPerSoak(WEAPONS.balloon, 0)).toBeGreaterThan(3);
  });

  it('a stream loses pressure with distance rather than stopping dead', () => {
    const w = WEAPONS.soaker;
    const near = streamPower(w, 0.5);
    const mid = streamPower(w, w.range / 2);
    const far = streamPower(w, w.range * 0.95);
    expect(near).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(far);
    expect(far).toBeGreaterThan(0);
    expect(streamPower(w, w.range + 1)).toBe(0);
  });

  it('splash rewards a close miss without matching a hit', () => {
    expect(splashPower(0, SPLASH_RADIUS)).toBeCloseTo(SPLASH_POWER, 6);
    expect(splashPower(SPLASH_RADIUS, SPLASH_RADIUS)).toBe(0);
    expect(SPLASH_POWER).toBeLessThan(WEAPONS.balloon.power);
  });

  it('refilling gives far more than it costs the source, but is not free', () => {
    // Free refills make one fortified pool an unbeatable position, which is the
    // first thing anyone tries and the end of the mode.
    expect(REFILL_RATE).toBeGreaterThan(REFILL_DRAW * 3);
    expect(REFILL_DRAW).toBeGreaterThan(0);
  });
});

describe('wetness', () => {
  it('starts dry', () => {
    const w = makeWetness();
    expect(w.value).toBe(0);
    expect(isSoaked(w)).toBe(false);
  });

  it('rises with hits and reports what actually landed', () => {
    const w = makeWetness();
    tickWetness(w, DT);
    const landed = soak(w, 0.005);
    expect(landed).toBeCloseTo(0.005, 6);
    expect(w.value).toBeCloseTo(0.005, 6);
  });

  it('never exceeds soaked', () => {
    const w = makeWetness();
    for (let i = 0; i < 600; i++) {
      tickWetness(w, DT);
      soak(w, 1);
    }
    expect(w.value).toBe(1);
    expect(isSoaked(w)).toBe(true);
  });

  it('wet clothes soak faster', () => {
    const dry = makeWetness();
    tickWetness(dry, DT);
    const onDry = soak(dry, 0.004);

    const damp = makeWetness();
    damp.value = 0.8;
    // Under fire, or the tick dries it a hair first and the ratio is off.
    damp.grace = DRY_GRACE;
    tickWetness(damp, DT);
    const onDamp = soak(damp, 0.004);

    expect(onDamp).toBeGreaterThan(onDry);
    expect(onDamp / onDry).toBeCloseTo(1 + 0.8 * SOAK_SCALING, 3);
  });

  it('a single hit lands whole, whatever the tick rate', () => {
    // The bug this pins: the cap used to be a per-tick allowance, so a balloon's
    // 0.55 arrived as 0.9*dt — 0.015 at 60Hz, and less the faster you ticked.
    // A weapon's power must not depend on the simulation's frame rate.
    for (const rate of [30, 60, 144]) {
      const w = makeWetness();
      tickWetness(w, 1 / rate);
      expect(soak(w, WEAPONS.balloon.power)).toBeCloseTo(WEAPONS.balloon.power, 6);
    }
  });

  it('holds exactly one direct hit, so a volley is not a delete button', () => {
    // The bucket has to be big enough for one balloon and no bigger. Sized to
    // the arsenal, so adding a heavier throw has to face this decision again.
    expect(INTAKE_BURST).toBeGreaterThanOrEqual(WEAPONS.balloon.power);

    const w = makeWetness();
    tickWetness(w, DT);
    soak(w, WEAPONS.balloon.power);
    // Second balloon in the same tick, from the kid standing next to the first.
    expect(soak(w, WEAPONS.balloon.power)).toBeLessThan(WEAPONS.balloon.power * 0.5);
    expect(isSoaked(w)).toBe(false);
  });

  it('caps how fast one person can be soaked, however many are throwing', () => {
    // Six attackers must be hard, not instant. Without this the player is
    // deleted in under two seconds of exposure and never learns why. The floor
    // is the opening hit plus the sustained rate for the rest of the meter —
    // the extra five kids buy the opening hit, and nothing after it.
    const soakTime = (attackers: number): number => {
      const w = makeWetness();
      let seconds = 0;
      for (let i = 0; i < 60 * 10 && !isSoaked(w); i++) {
        tickWetness(w, DT);
        for (let k = 0; k < attackers; k++) soak(w, 1);
        seconds += DT;
      }
      expect(isSoaked(w)).toBe(true);
      return seconds;
    };

    const floor = (SOAKED - INTAKE_BURST) / MAX_INTAKE_PER_SECOND;
    expect(soakTime(6)).toBeGreaterThanOrEqual(floor);
    // And the sixth attacker is worth nothing the first one did not already do.
    expect(soakTime(6)).toBeCloseTo(soakTime(1), 2);
  });

  it('does not dry while under fire', () => {
    const w = makeWetness();
    tickWetness(w, DT);
    soak(w, 0.5);
    const after = w.value;
    // Hit again well inside the grace window.
    for (let i = 0; i < 30; i++) {
      tickWetness(w, DT);
      soak(w, 0.0001);
    }
    expect(w.value).toBeGreaterThanOrEqual(after);
  });

  it('dries quickly once you break off', () => {
    // Slow drying is not more punishing, it is just bookkeeping — with five
    // attackers you never get the uninterrupted window it needs, so it stops
    // being a mechanic and becomes a number that is always near one.
    const w = makeWetness();
    tickWetness(w, DT);
    soak(w, 0.9);

    let seconds = 0;
    for (let i = 0; i < 60 * 30; i++) {
      tickWetness(w, DT);
      seconds += DT;
      if (w.value <= 0.001) break;
    }
    expect(seconds).toBeLessThan(6);
    expect(seconds).toBeGreaterThan(DRY_GRACE);
  });

  it('waits out the grace before drying at all', () => {
    const w = makeWetness();
    tickWetness(w, DT);
    soak(w, 0.6);
    const start = w.value;
    for (let i = 0; i < Math.floor((DRY_GRACE * 0.8) / DT); i++) tickWetness(w, DT);
    expect(w.value).toBeCloseTo(start, 6);
  });

  it('a capped hit still counts as being under fire', () => {
    // Otherwise standing in a stream while capped quietly starts you drying,
    // and the stream reads as broken.
    const w = makeWetness();
    tickWetness(w, DT);
    soak(w, 5);
    const capped = soak(w, 5);
    expect(capped).toBe(0);
    expect(w.grace).toBeCloseTo(DRY_GRACE, 6);
  });

  it('reads as four stages so it can be drawn', () => {
    expect(wetStage(0)).toBe('dry');
    expect(wetStage(0.3)).toBe('damp');
    expect(wetStage(0.7)).toBe('wet');
    expect(wetStage(1)).toBe('drenched');
  });

  it('resets clean', () => {
    const w = makeWetness();
    tickWetness(w, DT);
    soak(w, 0.7);
    resetWetness(w);
    expect(w.value).toBe(0);
    expect(w.grace).toBe(0);
  });
});

describe('time to soak, at the ranges these are meant for', () => {
  it('the stream kills fast up close and slowly at the edge', () => {
    const close = secondsToSoak(streamPower(WEAPONS.soaker, 1));
    const far = secondsToSoak(streamPower(WEAPONS.soaker, WEAPONS.soaker.range * 0.9));
    expect(close).toBeLessThan(1.5);
    // Closing the distance has to be worth doing, without the far end being
    // useless — which is the balance the falloff floor exists to strike.
    expect(far).toBeGreaterThan(close * 1.4);
    expect(far).toBeLessThan(Infinity);
  });

  it('a full tank of stream outlasts a single soaking several times over', () => {
    const seconds = TANK_MAX / WEAPONS.soaker.cost;
    expect(seconds).toBeGreaterThan(4);
    expect(seconds).toBeLessThan(9);
  });

  it('the drying rate cannot outpace a stream at any usable range', () => {
    // If it could, there would be a distance at which the weapon simply does
    // not work and nothing on screen would say so.
    const edge = streamPower(WEAPONS.soaker, WEAPONS.soaker.range * 0.9);
    expect(edge).toBeGreaterThan(DRY_RATE * 1.2);
  });

  it('one balloon every few seconds is not enough to pin someone', () => {
    // A cheap sustain lock — hit once per drying window and they never recover
    // — would make the meter a formality.
    const perSecond = WEAPONS.balloon.power / 3;
    expect(perSecond).toBeLessThan(DRY_RATE);
  });

  it('the intake cap is loose enough that one attacker is never throttled', () => {
    // The cap exists for crossfire, not to quietly nerf the weapon you are
    // holding when you fight someone one-to-one.
    expect(WEAPONS.soaker.power).toBeLessThanOrEqual(MAX_INTAKE_PER_SECOND);
  });
});
