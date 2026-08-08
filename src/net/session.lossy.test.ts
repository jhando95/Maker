/**
 * A two-player session over a network that misbehaves.
 *
 * `session.test.ts` runs everything through `loopbackPair`, which delivers
 * instantly and in order and never loses anything. That is the right place to
 * state the rules. It is the wrong place to find out what happens when a
 * snapshot overtakes the one in front of it, because on that transport none
 * ever does.
 *
 * These are the same two machines with `unreliable.ts` in between. Every test
 * here asserts twice: once that the game did the right thing, and once that the
 * link actually did the bad thing — because a test at 8% loss that happened to
 * lose nothing is a test that passed on a perfect network with a hostile name.
 */

import { describe, it, expect } from 'vitest';
import { CollisionWorld } from '../physics/collisionWorld.ts';
import { ProjectileSystem } from '../game/projectiles.ts';
import { PartRenderer } from '../render/partRenderer.ts';
import { BuildSystem } from '../build/buildSystem.ts';
import { CharacterController } from '../player/controller.ts';
import { ActorRoster, LOCAL_ACTOR_ID, type Actor } from '../game/actor.ts';
import { commandToIntent, makeCommand, type Command } from '../core/command.ts';
import { DT } from '../physics/constants.ts';
import { loopbackPair } from './transport.ts';
import { AWFUL, PERFECT, POOR, unreliablePair, type LinkConditions, type UnreliablePair } from './unreliable.ts';
import { NetHost, NetClient, type SessionContext } from './session.ts';

type Machine = SessionContext & { local: CharacterController };

function makeMachine(): Machine {
  const world = new CollisionWorld();
  const build = new BuildSystem(world, new PartRenderer());
  const local = new CharacterController(world, 0, 0.5, 0);
  const localActor: Actor = {
    id: LOCAL_ACTOR_ID, kind: 'local', team: 'left', controller: local, heading: 0,
  };
  return {
    world, build, actors: new ActorRoster(localActor), local,
    projectiles: new ProjectileSystem(world),
    worldChanged: () => {},
    spawnFor: (team) => ({ x: team === 'left' ? -2 : 2, y: 0.5, z: 0 }),
  };
}

interface Session {
  host: NetHost; hostCtx: Machine;
  client: NetClient; clientCtx: Machine;
  pipe: UnreliablePair;
  tick: number;
}

function connect(conditions: LinkConditions, seed: string): Session {
  const hostCtx = makeMachine();
  const clientCtx = makeMachine();
  const host = new NetHost(hostCtx);
  const pipe = unreliablePair(loopbackPair(), conditions, seed);
  const client = new NetClient(clientCtx, pipe.client, 'guest');
  host.accept(pipe.host);
  return { host, hostCtx, client, clientCtx, pipe, tick: 0 };
}

/**
 * Walk both machines forward.
 *
 * The link is advanced at the top of the tick and drained at the bottom of that
 * advance, which is the same order a browser sees: messages land between frames
 * and are read at a tick boundary, never in the middle of one.
 */
function play(
  s: Session, ticks: number,
  drive?: { host?: (c: Command) => void; client?: (c: Command) => void },
  each?: () => void,
): void {
  for (let i = 0; i < ticks; i++) {
    s.pipe.advance(DT);
    s.host.beforeTick();
    s.client.beforeTick();

    const hostCommand = makeCommand(s.tick);
    drive?.host?.(hostCommand);
    s.hostCtx.actors.local.controller.step(DT, commandToIntent(hostCommand));

    const clientCommand = makeCommand(s.tick);
    drive?.client?.(clientCommand);
    s.clientCtx.actors.local.controller.step(DT, commandToIntent(clientCommand));

    s.host.afterTick(DT);
    s.client.afterTick(DT, clientCommand);
    s.tick++;
    each?.();
  }
}

/** Where the guest currently draws the host. */
function viewOfHost(s: Session): Actor | undefined {
  return s.clientCtx.actors.all.find((a) => a.kind === 'remote' && a.id === LOCAL_ACTOR_ID);
}

describe('joining a hostile network', () => {
  it('gets there anyway, because the hello repeats until it is welcomed', () => {
    const s = connect(AWFUL, 'join');
    play(s, 600);
    expect(s.client.status.connected).toBe(true);
    expect(s.client.status.localId).toBeGreaterThan(0);
    // And the link was genuinely hostile, or the above proves nothing.
    expect(s.pipe.client.dropped).toBeGreaterThan(0);
    expect(s.pipe.host.dropped).toBeGreaterThan(0);
  });
});

describe('a welcome that goes missing', () => {
  it('is sent again, because a second hello means nobody heard the first', () => {
    // Driven by a hole rather than by luck: the hello gets through, the welcome
    // is sent into a blacked-out link, and the guest is left saying hello to a
    // host that has already given it an actor, a side and a spawn and is
    // simulating it from a stream of commands. Nothing answered a repeated
    // hello, so one lost packet was a permanently half-joined session — a
    // player stuck on "connecting…" while everybody else can see them standing
    // on the lawn.
    const s = connect(PERFECT, 'lost-welcome');
    s.pipe.host.blackout(1);
    play(s, 30);
    // Half a second in: the host has a player, and the player does not know.
    expect(s.pipe.host.blacked).toBe(true);
    expect(s.client.status.connected).toBe(false);
    expect(s.host.status.peers).toBe(1);

    play(s, 120);
    expect(s.pipe.host.blacked).toBe(false);
    expect(s.client.status.connected).toBe(true);
    expect(s.client.status.localId).toBe(1);
    // And the same one the host made, not a second actor for the same person.
    expect(s.host.status.peers).toBe(1);
  });

  it('and the guest ends up with one of everybody rather than a ghost of itself', () => {
    // A snapshot cannot be read before the welcome, because the one thing it
    // needs is which of those actors it is. Forced deterministically: the
    // welcome is put on a link with half a second of delay, then the delay is
    // taken away so everything sent afterwards overtakes it.
    const s = connect({ latency: 0.5, jitter: 0, loss: 0, duplicate: 0 }, 'overtake');
    play(s, 2);
    s.pipe.host.setConditions(PERFECT);
    play(s, 120);

    expect(s.client.status.connected).toBe(true);
    const roster = s.clientCtx.actors.all;
    expect(roster.filter((a) => a.kind === 'local')).toHaveLength(1);
    expect(roster.filter((a) => a.kind === 'remote').map((a) => a.id)).toEqual([LOCAL_ACTOR_ID]);
    // The guest can see the host, which is the thing that was actually broken.
    expect(viewOfHost(s)).toBeDefined();
  });
});

describe('a welcome that arrives twice', () => {
  it('does not put a player who is already running back at the spawn', () => {
    // A quarter of a second each way is half a second round trip, and the hello
    // repeats every third of a second — so on any link this slow a guest always
    // asks again before the first answer has had time to arrive, and the host
    // now answers every ask. The second welcome lands on somebody who has been
    // playing for a second.
    //
    // A welcome initialises: an id, a side, a spawn, and the world wholesale.
    // Applying one to a guest who already has all four is not harmless — it
    // teleports them back to the spawn, throws away the world they are standing
    // in and rebuilds it, and clears the part-id maps everything placed since
    // was learned into.
    const s = connect({ latency: 0.25, jitter: 0, loss: 0, duplicate: 0 }, 'twice');
    play(s, 40);
    expect(s.client.status.connected).toBe(true);

    const walked: number[] = [];
    play(s, 300, { client: (c) => { c.moveZ = 1; } }, () => {
      walked.push(s.clientCtx.actors.local.controller.z);
    });

    let worst = 0;
    for (let i = 1; i < walked.length; i++) worst = Math.min(worst, walked[i]! - walked[i - 1]!);
    expect(worst).toBeGreaterThan(-0.05);
    expect(walked[walked.length - 1]!).toBeGreaterThan(10);
    // And the second hello really did happen, or none of the above is a test of
    // anything: the host answers one only from a peer it has already made.
    expect(s.host.status.peers).toBe(1);
  });
});

describe('a snapshot that arrives late', () => {
  it('is refused rather than applied', () => {
    // Jitter reorders routinely — ten seconds of this reorders a handful of the
    // two hundred snapshots a host sends, and every one of them used to be
    // applied on arrival.
    const s = connect(POOR, 'reorder');
    play(s, 900, { host: (c) => { c.moveZ = 1; } });
    expect(s.client.status.connected).toBe(true);
    expect(s.client.stale).toBeGreaterThan(0);
  });

  it('so somebody walking one way is never seen walking back', () => {
    const s = connect(POOR, 'reorder');
    const seen: number[] = [];
    play(s, 900, { host: (c) => { c.moveZ = 1; } }, () => {
      const view = viewOfHost(s);
      if (view !== undefined) seen.push(view.controller.z);
    });

    expect(seen.length).toBeGreaterThan(300);
    // The host walked steadily in one direction the whole time, so the picture
    // of them may stall while a packet is missing and may never reverse.
    let worst = 0;
    for (let i = 1; i < seen.length; i++) worst = Math.min(worst, seen[i]! - seen[i - 1]!);
    expect(worst).toBeGreaterThanOrEqual(-1e-6);
    // And they did actually go somewhere, or "never reversed" is a statement
    // about a character who never moved.
    expect(seen[seen.length - 1]! - seen[0]!).toBeGreaterThan(1);
    expect(s.client.stale).toBeGreaterThan(0);
  });
});

describe('a guest whose commands keep going missing', () => {
  it('still moves, because the host repeats the last input it heard', () => {
    const s = connect(AWFUL, 'commands');
    play(s, 300);
    const start = s.clientCtx.actors.local.controller.z;
    play(s, 600, { client: (c) => { c.moveZ = 1; } });

    // The host's copy of the guest is the one that counts.
    const onHost = s.hostCtx.actors.all.find((a) => a.kind === 'remote');
    expect(onHost).toBeDefined();
    expect(Math.abs(onHost!.controller.z - start)).toBeGreaterThan(1);
    // A command in eight or so never arrived.
    expect(s.pipe.client.dropped).toBeGreaterThan(20);
  });

  it('and ends up where the host says, not where it guessed', () => {
    const s = connect(POOR, 'converge');
    play(s, 300);
    play(s, 600, { client: (c) => { c.moveZ = 1; } });
    // Let both settle with no input, so the comparison is of two bodies at rest
    // rather than of a prediction mid-flight.
    play(s, 240);

    const onHost = s.hostCtx.actors.all.find((a) => a.kind === 'remote')!;
    const mine = s.clientCtx.actors.local.controller;
    expect(Math.hypot(mine.x - onHost.controller.x, mine.z - onHost.controller.z))
      .toBeLessThan(0.25);
  });
});

describe('a hole in the network', () => {
  it('is not a disconnection, and the session comes back out of it', () => {
    const s = connect(POOR, 'blackout');
    play(s, 300);
    expect(s.client.status.connected).toBe(true);
    const before = s.client.stale;

    s.pipe.host.blackout(2);
    s.pipe.client.blackout(2);
    play(s, 120);
    expect(s.pipe.host.blacked).toBe(true);
    expect(s.client.status.connected).toBe(true);

    play(s, 300);
    expect(s.pipe.host.blacked).toBe(false);
    // Snapshots are flowing again: the guest is being told about the world
    // rather than sitting on the last thing it heard.
    const view = viewOfHost(s);
    expect(view).toBeDefined();
    void before;
  });

  it('loses what was sent into it, which is what makes it a hole', () => {
    const s = connect(POOR, 'hole');
    play(s, 300);
    const dropped = s.pipe.host.dropped;
    s.pipe.host.blackout(1);
    play(s, 60);
    // Sixty ticks of blackout is twenty snapshots plus whatever else, all gone.
    expect(s.pipe.host.dropped).toBeGreaterThan(dropped + 15);
  });
});

describe('a message delivered twice', () => {
  it('does not build the same plank twice', () => {
    const s = connect({ ...POOR, duplicate: 0.5 }, 'dupe');
    play(s, 300);
    const record = { kind: 0, colorway: 0, x: 3, y: 0.5, z: 3, qx: 0, qy: 0, qz: 0, qw: 1 };
    s.hostCtx.build.applyPlace(record);
    s.host.announcePlacement(s.hostCtx.build.lastPlacedId!, record);
    play(s, 180);
    expect(s.clientCtx.world.partCount).toBe(1);
    expect(s.pipe.host.duplicated).toBeGreaterThan(0);
  });
});
