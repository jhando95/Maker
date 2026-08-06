/**
 * How each person's fight is going.
 *
 * Every mode in the game grew the same six fields — `playerWet`, `tank` or
 * `ammo`, `charge`, `throwCooldown`, `playerSoakedFor`, and a flag for being out
 * of it — and every one of them is singular, because when they were written
 * there was one person to be wet. That is the whole obstacle to a guest playing
 * rather than watching: a second human arrives and there is exactly one tank for
 * two people to drink from.
 *
 * The fix is not clever. It is the same six fields with an id in front of them,
 * kept in one place so the three modes stop each having their own version of a
 * thing that was never mode-specific in the first place.
 *
 * ## What is here and what is not
 *
 * Here: the state a *person* carries through a fight, which is the same shape in
 * all three modes even though the numbers mean different things — `ammo` is
 * balloons in Fort Defense and litres in Water War, and neither mode has to care
 * what the other meant by it.
 *
 * Not here: anything about the round. No score, no flags, no phase. `Fighters`
 * is a bag of per-person numbers, and a mode that put its objective in here
 * would be handing the next mode a field it has to ignore.
 *
 * Also not here: bots. A kid has `Bot.hits` and a stun timer of its own and has
 * had since before any of this, and a bot is not a thing that carries a tank or
 * winds up a throw — it decides to throw and throws. Unifying them would mean
 * giving every kid four fields nothing reads, to spare one `kind !== 'ai'` test.
 */

import type { Actor } from './actor.ts';
import { makeWetness, resetWetness, tickWetness, type WetnessState } from './wetness.ts';

/** One person, mid-fight. */
export interface Fighter {
  readonly id: number;
  /** Their soaking meter, ticked and spent by the wetness module. */
  readonly wet: WetnessState;
  /**
   * Seconds still spent sitting this one out, or zero when in the fight.
   *
   * A number rather than a boolean plus a timer, because every mode that has
   * one counts it down and then does something — and two fields that must agree
   * is one field with a way to be wrong.
   */
  out: number;
  /** Balloons left, or litres in the tank. The mode decides which. */
  ammo: number;
  /** 0..1 wind-up on a throw. */
  charge: number;
  /** True while the button is held and the throw is winding up. */
  charging: boolean;
  /** Seconds until they may throw again. */
  cooldown: number;
}

/**
 * Is this somebody who fights, rather than something the mode is simulating?
 *
 * The line is where intent comes from: a keyboard or a socket on one side, a
 * behaviour tree on the other. It is deliberately not "is this the local
 * player", which is the test all this code used to make and the reason a guest
 * could not pick up a balloon.
 */
export function isFighter(who: Actor): boolean {
  return who.kind !== 'ai';
}

export class Fighters {
  private readonly byId = new Map<number, Fighter>();

  /**
   * @param startingAmmo what a fresh fighter turns up with — a full tank, a
   * pocket of balloons, or nothing in a mode that does not meter it.
   */
  constructor(private readonly startingAmmo = 0) {}

  /**
   * This person's state, made on demand.
   *
   * On demand rather than on join, because the alternative is a roster event
   * every mode has to subscribe to, and the first mode that forgets gets a
   * player who cannot be hit — a bug that looks like invincibility and is
   * really a missing map entry.
   */
  of(id: number): Fighter {
    let f = this.byId.get(id);
    if (f === undefined) {
      f = {
        id,
        wet: makeWetness(),
        out: 0,
        ammo: this.startingAmmo,
        charge: 0,
        charging: false,
        cooldown: 0,
      };
      this.byId.set(id, f);
    }
    return f;
  }

  has(id: number): boolean {
    return this.byId.has(id);
  }

  /** How wet somebody is, 0..1, and 0 for anyone who has never been in a fight. */
  wetnessOf(id: number): number {
    return this.byId.get(id)?.wet.value ?? 0;
  }

  /** True while they are soaked and sitting the next few seconds out. */
  isOut(id: number): boolean {
    return (this.byId.get(id)?.out ?? 0) > 0;
  }

  /**
   * Run the clocks, and say who just came back.
   *
   * The revival is handed out through a callback rather than returned as a list
   * because this runs every tick for everybody and almost always has nothing to
   * report — a list would be an allocation per tick to hold, nearly always, no
   * elements. What a mode does with somebody coming back (where they respawn,
   * what they respawn holding) is the mode's own rule, which is why this only
   * says that it happened.
   */
  tick(dt: number, revive?: (fighter: Fighter) => void): void {
    for (const f of this.byId.values()) {
      tickWetness(f.wet, dt);
      f.cooldown -= dt;
      if (f.out <= 0) continue;
      f.out -= dt;
      if (f.out <= 0) {
        f.out = 0;
        revive?.(f);
      }
    }
  }

  /** Put everybody back to how they start a round. */
  reset(): void {
    for (const f of this.byId.values()) {
      resetWetness(f.wet);
      f.out = 0;
      f.ammo = this.startingAmmo;
      f.charge = 0;
      f.charging = false;
      f.cooldown = 0;
    }
  }

  clear(): void {
    this.byId.clear();
  }

  forget(id: number): void {
    this.byId.delete(id);
  }

  get all(): Iterable<Fighter> {
    return this.byId.values();
  }

  get count(): number {
    return this.byId.size;
  }
}
