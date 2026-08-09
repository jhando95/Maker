/**
 * Per-person combat state, and the two things it has to get right.
 *
 * It is a small class, and the temptation is to skip it. The reason not to is
 * that the bug it replaces was not in any of these lines — it was in the *shape*
 * of the code it replaces, where six numbers on a mode meant six numbers for
 * however many people were playing. That kind of mistake does not throw. It
 * shows up as one player's tank draining when somebody else fires, which reads
 * as a network problem and is not one.
 *
 * So the tests are about separation and about the revive callback, because
 * those are the two properties the old code could not have had.
 */

import { describe, it, expect } from 'vitest';
import { Fighters, isFighter } from './fighters.ts';
import { Bot, BOT_TIERS } from './bot.ts';
import { CollisionWorld } from '../physics/collisionWorld.ts';
import { CharacterController } from '../player/controller.ts';
import { Rng } from '../core/rng.ts';
import { soak } from './wetness.ts';
import { DT } from '../physics/constants.ts';
import type { Actor } from './actor.ts';

describe('Fighters', () => {
  it('keeps one tank per person', () => {
    // The whole point. Spending from one must not move the other, which is the
    // property a bare `private tank = TANK_MAX` on the mode could not have.
    const fighters = new Fighters(100);
    fighters.of(0).ammo -= 40;
    expect(fighters.of(0).ammo).toBe(60);
    expect(fighters.of(1).ammo).toBe(100);
  });

  it('makes somebody up the first time they are asked about', () => {
    // On demand rather than on join, so no mode has to subscribe to a roster
    // event it could forget — a missing entry would read as invincibility.
    const fighters = new Fighters(5);
    expect(fighters.has(3)).toBe(false);
    expect(fighters.of(3).ammo).toBe(5);
    expect(fighters.has(3)).toBe(true);
  });

  it('dries everybody off, not just whoever was asked about last', () => {
    const fighters = new Fighters();
    soak(fighters.of(0).wet, 0.5);
    soak(fighters.of(1).wet, 0.5);
    for (let i = 0; i < 240; i++) fighters.tick(DT);
    expect(fighters.wetnessOf(0)).toBe(0);
    expect(fighters.wetnessOf(1)).toBe(0);
  });

  it('says who came back, once, on the tick they came back', () => {
    // The revive is a callback rather than a returned list because it runs
    // every tick for everybody and almost always has nothing to say. What
    // matters is that it fires exactly once — a mode teleports somebody on it,
    // and twice would be a player who cannot leave their own spawn.
    const fighters = new Fighters();
    fighters.of(7).out = 0.1;
    const back: number[] = [];
    for (let i = 0; i < 60; i++) fighters.tick(DT, (f) => back.push(f.id));
    expect(back).toEqual([7]);
    expect(fighters.isOut(7)).toBe(false);
  });

  it('does not revive somebody who was never out', () => {
    const fighters = new Fighters();
    fighters.of(1);
    const back: number[] = [];
    for (let i = 0; i < 60; i++) fighters.tick(DT, (f) => back.push(f.id));
    expect(back).toEqual([]);
  });

  it('puts everybody back to the start of a round without losing them', () => {
    // Reset rather than clear, because everybody in the yard is still in it.
    // Dropping the map would give each of them a fresh entry the first time
    // they were asked about — the same numbers, one tick later, and a blank
    // HUD in between.
    const fighters = new Fighters(3);
    fighters.of(0).ammo = 0;
    soak(fighters.of(0).wet, 1);
    fighters.of(0).out = 5;
    fighters.reset();
    expect(fighters.count).toBe(1);
    expect(fighters.of(0).ammo).toBe(3);
    expect(fighters.wetnessOf(0)).toBe(0);
    expect(fighters.isOut(0)).toBe(false);
  });

  it('counts people and not kids', () => {
    // The line is where intent comes from, not who is at the keyboard. It is
    // deliberately not "is this the local player", which is the test all this
    // code used to make and the reason a guest could not pick up a balloon.
    const world = new CollisionWorld();
    const body = new CharacterController(world, 0, 0.5, 0);
    const local: Actor = { id: 0, kind: 'local', team: 'left', controller: body };
    const remote: Actor = { id: 1, kind: 'remote', team: 'right', controller: body };
    const kid = new Bot(100, world, new Rng('kid'), BOT_TIERS.normal!, 0, 0.5, 0);

    expect(isFighter(local)).toBe(true);
    expect(isFighter(remote)).toBe(true);
    expect(isFighter(kid)).toBe(false);
  });
});
