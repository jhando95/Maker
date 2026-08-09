import { describe, it, expect } from 'vitest';
import { CollisionWorld } from '../physics/collisionWorld.ts';
import { PartRenderer } from '../render/partRenderer.ts';
import { BuildSystem } from '../build/buildSystem.ts';
import { CharacterController } from '../player/controller.ts';
import { CameraRig } from '../player/cameraRig.ts';
import { ProjectileSystem } from '../game/projectiles.ts';
import { CaptureTheFlagMode, FIRST_SETUP_TIME } from '../game/captureTheFlag.ts';
import { WaterWarMode, BUILD_TIME } from '../game/waterWar.ts';
import { ActorRoster, LOCAL_ACTOR_ID } from '../game/actor.ts';
import { Rng } from './rng.ts';
import { DT } from '../physics/constants.ts';
import { neighborhoodSlabs, installFixtures } from '../world/neighborhood.ts';
import { BUTTON, commandToIntent, makeCommand, type Command } from './command.ts';
import { hashBodies, playback, record, StateHash } from './replay.ts';
import { sameForEveryone } from '../game/gameMode.ts';
import type { GameMode, ModeContext } from '../game/gameMode.ts';

const noInput = sameForEveryone({ fire: false, firePressed: false, fireReleased: false });

/**
 * A scripted minute at the keyboard.
 *
 * Deterministic by construction — driven off the tick number rather than any
 * randomness — so the recording is the same every run and a failure means the
 * simulation moved, not the input.
 */
function script(ticks: number): Command[] {
  const out: Command[] = [];
  for (let tick = 0; tick < ticks; tick++) {
    const c = makeCommand(tick);
    c.moveZ = Math.sin(tick / 37) * 0.9;
    c.moveX = Math.cos(tick / 53) * 0.9;
    c.yaw = tick / 90;
    c.buttons =
      (tick % 71 === 0 ? BUTTON.jump : 0) |
      (tick % 13 < 6 ? BUTTON.sprint : 0);
    out.push(c);
  }
  return out;
}

function walkThrough(commands: readonly Command[]): number {
  const world = new CollisionWorld();
  installFixtures(world, neighborhoodSlabs(new Rng('map')));
  const player = new CharacterController(world, -10, 0.5, 5);
  for (const c of commands) player.step(DT, commandToIntent(c));
  return hashBodies([player.sample(1)]);
}

function makeContext(seed: string): { ctx: ModeContext; world: CollisionWorld } {
  const world = new CollisionWorld();
  installFixtures(world, neighborhoodSlabs(new Rng('map')));
  const build = new BuildSystem(world, new PartRenderer());
  const player = new CharacterController(world, -10, 0.5, 5);
  return {
    world,
    ctx: {
      world, build, player,
      actors: new ActorRoster({ id: LOCAL_ACTOR_ID, kind: 'local', team: 'left', controller: player }),
      camera: new CameraRig(world, 1.6),
      projectiles: new ProjectileSystem(world),
      rng: new Rng(seed),
      emit: () => {},
      worldChanged: () => {},
    },
  };
}

/** Everything a divergence would show up in: the player, and every bot. */
function hashMode(mode: GameMode, ctx: ModeContext): number {
  const hash = new StateHash();
  hash.add(hashBodies([ctx.player.sample(1)]));
  for (const bot of mode.bots) {
    hash.add(bot.id).add(hashBodies([bot.controller.sample(1)]));
  }
  return hash.digest;
}

function playRound(make: () => GameMode, seed: string, seconds: number): number {
  const { ctx } = makeContext(seed);
  const mode = make();
  mode.start(ctx);
  for (let i = 0; i < Math.round(seconds / DT); i++) mode.fixedUpdate(DT, ctx, noInput);
  return hashMode(mode, ctx);
}

describe('StateHash', () => {
  it('changes when the state does', () => {
    expect(new StateHash().add(1).digest).not.toBe(new StateHash().add(2).digest);
  });

  it('ignores differences too small to be a divergence', () => {
    // Quantised deliberately. The point is to catch a simulation that took a
    // different path, not to fail a run because the same arithmetic in a
    // different order landed a bit apart.
    expect(new StateHash().add(1.00001).digest).toBe(new StateHash().add(1.000012).digest);
  });

  it('depends on the order things were added in', () => {
    // Two worlds with the same bodies in different places are different worlds.
    expect(new StateHash().add(1).add(2).digest).not.toBe(new StateHash().add(2).add(1).digest);
  });

  it('notices a body that is somewhere else', () => {
    const a = hashBodies([{ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 }]);
    const b = hashBodies([{ x: 0.5, y: 0, z: 0, vx: 0, vy: 0, vz: 0 }]);
    expect(a).not.toBe(b);
  });

  it('notices a body going somewhere else from the same place', () => {
    // Position alone would call these identical, and they diverge next tick.
    const a = hashBodies([{ x: 0, y: 0, z: 0, vx: 1, vy: 0, vz: 0 }]);
    const b = hashBodies([{ x: 0, y: 0, z: 0, vx: -1, vy: 0, vz: 0 }]);
    expect(a).not.toBe(b);
  });
});

describe('recording', () => {
  it('copies each command, because the live loop reuses one object', () => {
    // The bug this exists to prevent: keeping the reference gives a recording of
    // a thousand ticks that all say whatever the last one said.
    const rec = record('seed');
    const live = makeCommand(0);
    live.moveX = 1;
    rec.push(live);
    live.tick = 1;
    live.moveX = -1;
    rec.push(live);

    const played = [...playback(rec.finish())];
    expect(played[0]!.moveX).toBe(1);
    expect(played[1]!.moveX).toBe(-1);
  });

  it('round-trips a scripted minute unchanged', () => {
    const commands = script(60 * 60);
    const rec = record('seed');
    for (const c of commands) rec.push(c);
    expect([...playback(rec.finish())]).toEqual(commands);
  });

  it('keeps the seed, since replaying under another one means nothing', () => {
    expect(record('round-1').finish().seed).toBe('round-1');
  });
});

describe('the simulation is a function of its inputs', () => {
  it('walks the same route twice from the same commands', () => {
    const commands = script(60 * 20);
    expect(walkThrough(commands)).toBe(walkThrough(commands));
  });

  it('walks a different route from different commands', () => {
    // Or the check above passes for the boring reason that the hash is constant.
    const a = script(60 * 20);
    const b = script(60 * 20).map((c) => ({ ...c, moveX: -c.moveX }));
    expect(walkThrough(a)).not.toBe(walkThrough(b));
  });

  it('replays a recording rather than the commands it was made from', () => {
    // The whole point: what survives the round trip has to drive the same run.
    const commands = script(60 * 20);
    const rec = record('seed');
    for (const c of commands) rec.push(c);
    expect(walkThrough([...playback(rec.finish())])).toBe(walkThrough(commands));
  });
});

describe('a whole round is reproducible', () => {
  // The tests above only exercise one body against static geometry. These run
  // the modes, which is where nondeterminism actually creeps in: bot decisions,
  // spawn positions, tier rolls, respawn ordering. A stray Math.random anywhere
  // under here fails this at the commit that introduces it rather than as a
  // desync between two people a month later.
  //
  // Checked by planting one. A `Math.random()` jitter on a bot's movement fails
  // both of these immediately. The same call added to a state *timer* at 1e-6
  // does not, because it moves nobody far enough to survive the hash's
  // thousandth-of-a-unit quantum — so this catches nondeterminism that changes
  // what happens, not nondeterminism that merely exists. That is the intended
  // trade: the quantum is what stops float noise from failing honest runs, and
  // an unobservable difference is one that cannot desync two players either.
  it('plays Capture the Flag identically twice from the same seed', () => {
    const seconds = FIRST_SETUP_TIME + 25;
    expect(playRound(() => new CaptureTheFlagMode(), 'ctf-seed', seconds))
      .toBe(playRound(() => new CaptureTheFlagMode(), 'ctf-seed', seconds));
  });

  it('plays Capture the Flag differently from a different seed', () => {
    const seconds = FIRST_SETUP_TIME + 25;
    expect(playRound(() => new CaptureTheFlagMode(), 'ctf-seed', seconds))
      .not.toBe(playRound(() => new CaptureTheFlagMode(), 'other-seed', seconds));
  });

  it('plays Water War identically twice from the same seed', () => {
    const seconds = BUILD_TIME + 25;
    expect(playRound(() => new WaterWarMode(), 'war-seed', seconds))
      .toBe(playRound(() => new WaterWarMode(), 'war-seed', seconds));
  });
});
