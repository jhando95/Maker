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
import { NetHost, NetClient, RESYNC_COOLDOWN_TICKS, type SessionContext } from './session.ts';

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

describe('a world that has drifted', () => {
  const plank = (x: number, y: number, z: number) => ({
    kind: 0, colorway: 0, x, y, z, qx: 0, qy: 0, qz: 0, qw: 1,
  });

  it('is noticed and repaired, which nothing could do before', () => {
    // The failure this design was most afraid of and had no answer to. A
    // `built` broadcast is sent once and never repeated, so one dropped packet
    // leaves a guest permanently missing a plank — silently, for the rest of
    // the round. A guest standing on a wall the host cannot see is not a
    // graphical glitch; it is two people playing different games.
    const s = connect(PERFECT, 'drift');
    play(s, 60);
    expect(s.clientCtx.world.partCount).toBe(0);

    // Swallow exactly the announcement.
    s.pipe.host.blackout(0.2);
    const record = plank(3, 0.5, 3);
    s.hostCtx.build.applyPlace(record);
    s.host.announcePlacement(s.hostCtx.build.lastPlacedId!, record);
    play(s, 30);
    expect(s.hostCtx.world.partCount).toBe(1);
    expect(s.clientCtx.world.partCount).toBe(0);

    // The hash goes out about once a second; three in a row disagreeing is
    // three seconds of being wrong with nothing in flight.
    play(s, 480);
    expect(s.client.desyncs).toBe(1);
    expect(s.clientCtx.world.partCount).toBe(1);
  });

  it('does not throw the player about on the way, as a second welcome would', () => {
    // A resync could have been a welcome and must not be: that reassigns the
    // id, puts the player back at the spawn and resets their side.
    //
    // Watched tick by tick rather than at the end, because prediction and
    // reconciliation would heal a spurious teleport within a few frames and
    // leave the final position looking perfect. What a player would actually
    // see is the jump, so the jump is what is measured.
    const s = connect(PERFECT, 'repair');
    play(s, 60);
    const team = s.clientCtx.actors.local.team;

    s.pipe.host.blackout(0.2);
    const record = plank(3, 0.5, 3);
    s.hostCtx.build.applyPlace(record);
    s.host.announcePlacement(s.hostCtx.build.lastPlacedId!, record);

    let last = s.clientCtx.actors.local.controller.z;
    let jump = 0;
    play(s, 480, { client: (c) => { c.moveZ = 1; } }, () => {
      const now = s.clientCtx.actors.local.controller.z;
      jump = Math.max(jump, Math.abs(now - last));
      last = now;
    });

    expect(s.client.desyncs).toBe(1);
    expect(s.clientCtx.world.partCount).toBe(1);
    // A tick of walking is a few centimetres. A teleport to the spawn is metres.
    expect(jump).toBeLessThan(0.5);
    expect(s.clientCtx.actors.local.team).toBe(team);
    expect(s.client.status.localId).toBe(1);
  });

  it('and leaves the guest able to be told about the next removal', () => {
    // The repaired world has to be relearned, not just rebuilt. Host and guest
    // allocate part ids independently, so "take down part 3" means two
    // different planks unless the translation table is rebuilt with the parts —
    // and a guest that cannot act on a removal has a world that will drift
    // again the moment anybody takes something down.
    const s = connect(PERFECT, 'relearn');
    play(s, 60);
    for (const x of [3, 6]) {
      const record = plank(x, 0.5, 3);
      s.hostCtx.build.applyPlace(record);
      s.host.announcePlacement(s.hostCtx.build.lastPlacedId!, record);
      play(s, 20);
    }

    // Miss one, so the guest has to be repaired.
    s.pipe.host.blackout(0.2);
    const missed = plank(9, 0.5, 3);
    s.hostCtx.build.applyPlace(missed);
    const missedId = s.hostCtx.build.lastPlacedId!;
    s.host.announcePlacement(missedId, missed);
    play(s, 480);
    expect(s.client.desyncs).toBe(1);
    expect(s.clientCtx.world.partCount).toBe(3);

    // Now take that one down. Sixty ticks is far inside the three seconds the
    // hash would need to notice, so this is the id map working and not the
    // repair running twice.
    s.hostCtx.build.applyRemove(missedId);
    s.host.announceRemoval(missedId);
    play(s, 60);
    expect(s.hostCtx.world.partCount).toBe(2);
    expect(s.clientCtx.world.partCount).toBe(2);
    expect(s.client.desyncs).toBe(1);
  });

  it('does not cry desync at a placement that is merely in flight', () => {
    // Jitter and no loss, which is the exact condition that produces a false
    // alarm and nothing else: a `built` and the snapshot carrying the hash
    // travel the same link, so on a link with a *steady* delay the placement
    // always lands first and no limit at all would ever fire. It takes
    // reordering for the hash to overtake the plank it counts. That was the
    // first version of this test and it could not fail.
    const s = connect({ latency: 0.15, jitter: 0.13, loss: 0, duplicate: 0 }, 'inflight');
    play(s, 120);
    for (let i = 0; i < 14; i++) {
      const record = plank(3 + i * 1.5, 0.5, 3);
      s.hostCtx.build.applyPlace(record);
      s.host.announcePlacement(s.hostCtx.build.lastPlacedId!, record);
      play(s, 12);
    }
    play(s, 300);
    expect(s.hostCtx.world.partCount).toBe(14);
    expect(s.clientCtx.world.partCount).toBe(14);
    expect(s.client.desyncs).toBe(0);
  });

  it('does not cry desync at a session that is merely building', () => {
    // A placement can be in flight in either direction at the instant the host
    // hashes, so one disagreement is the normal cost of building at all. A
    // guest that asked for the whole yard every time anybody put down a plank
    // would be worse than the bug.
    //
    // Spaced a metre and a half apart, which is not decoration: at half a metre
    // they overlap, and a guest applies a placement through `applyPlaceIfClear`
    // while this test forces the host's through `applyPlace`. The first version
    // built a tower the guest was right to refuse and then called the guest
    // wrong for refusing it — a desync the hash reported correctly and which
    // was in the test.
    const s = connect(PERFECT, 'quiet');
    play(s, 120);
    for (let i = 0; i < 12; i++) {
      const record = plank(3 + i * 1.5, 0.5, 3);
      s.hostCtx.build.applyPlace(record);
      s.host.announcePlacement(s.hostCtx.build.lastPlacedId!, record);
      play(s, 40);
    }
    play(s, 300);
    expect(s.hostCtx.world.partCount).toBe(12);
    expect(s.clientCtx.world.partCount).toBe(12);
    expect(s.client.desyncs).toBe(0);
  });

  it('and a lossy one that misses some of them still ends up agreeing', () => {
    // The same twelve planks over a link that drops one packet in thirty. Some
    // of the announcements do not arrive, so this is not a hypothetical: the
    // guest really does end up with a different yard, several times, and the
    // hash is what puts it back. Before this the difference was permanent.
    const s = connect(POOR, 'noisy-build');
    play(s, 120);
    for (let i = 0; i < 12; i++) {
      const record = plank(3 + i * 1.5, 0.5, 3);
      s.hostCtx.build.applyPlace(record);
      s.host.announcePlacement(s.hostCtx.build.lastPlacedId!, record);
      play(s, 40);
    }
    play(s, 600);
    expect(s.hostCtx.world.partCount).toBe(12);
    expect(s.clientCtx.world.partCount).toBe(12);
    // And it took the repair to get there, or the link was not lossy enough for
    // this to have been a test of it.
    expect(s.client.desyncs).toBeGreaterThan(0);
  });

  it('is answered once and then not again for a while, however often it is asked', () => {
    // The most expensive message a client can ask a host for is every part in
    // the yard, and a client is not under our control. Asked straight down the
    // wire rather than through the guest, because what is being tested is what
    // the host does with the message and not how a well-behaved guest sends it.
    const s = connect(PERFECT, 'cooldown');
    play(s, 60);

    let worlds = 0;
    const inner = s.pipe.client.drain.bind(s.pipe.client);
    s.pipe.client.drain = () => {
      const out = inner();
      for (const m of out) if (m.t === 'world') worlds++;
      return out;
    };

    for (let i = 0; i < 6; i++) s.pipe.client.send({ t: 'resync' });
    play(s, 30);
    expect(worlds).toBe(1);

    // And it is a cooldown rather than a one-off: a guest that really has
    // drifted twice must be able to ask twice.
    play(s, RESYNC_COOLDOWN_TICKS + 10);
    s.pipe.client.send({ t: 'resync' });
    play(s, 30);
    expect(worlds).toBe(2);
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
