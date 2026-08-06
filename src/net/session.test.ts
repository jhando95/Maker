import { describe, it, expect, beforeEach } from 'vitest';
import { CollisionWorld } from '../physics/collisionWorld.ts';
import { PartRenderer } from '../render/partRenderer.ts';
import { BuildSystem } from '../build/buildSystem.ts';
import { CharacterController } from '../player/controller.ts';
import { ActorRoster, LOCAL_ACTOR_ID, type Actor } from '../game/actor.ts';
import { commandToIntent, makeCommand, type Command } from '../core/command.ts';
import { DT } from '../physics/constants.ts';
import { installFixtures } from '../world/neighborhood.ts';
import { neighborhoodSlabs } from '../world/neighborhood.ts';
import { Rng } from '../core/rng.ts';
import { loopbackPair } from './transport.ts';
import { decode, encode, PROTOCOL_VERSION } from './protocol.ts';
import {
  NetHost, NetClient, SNAPSHOT_HZ, INTERP_DELAY, RECONCILE_THRESHOLD, MAX_PEERS,
  HELLO_GRACE_TICKS,
  type SessionContext,
} from './session.ts';

/**
 * One machine's whole game, minus the rendering.
 *
 * Two of these plus a loopback pair is a two-player session, which is the point:
 * every rule about joining, prediction and building is exercised through exactly
 * the code path a real socket uses. A test that stood up a server would be a test
 * that gets skipped in CI and then stops being true.
 */
function makeMachine(withMap = false): SessionContext & { local: CharacterController } {
  const world = new CollisionWorld();
  if (withMap) installFixtures(world, neighborhoodSlabs(new Rng('map')));
  const build = new BuildSystem(world, new PartRenderer());
  const local = new CharacterController(world, 0, 0.5, 0);
  const localActor: Actor = {
    id: LOCAL_ACTOR_ID, kind: 'local', team: 'left', controller: local, heading: 0,
  };
  const actors = new ActorRoster(localActor);
  return {
    world, build, actors, local,
    worldChanged: () => {},
    // Two metres apart and clear of everything, so a test measures the network
    // rather than the map.
    spawnFor: (team) => ({ x: team === 'left' ? -2 : 2, y: 0.5, z: 0 }),
  };
}

beforeEach(() => { sharedTick = 0; });

const plank = (x: number, y: number, z: number) => ({
  kind: 0, colorway: 0, x, y, z, qx: 0, qy: 0, qz: 0, qw: 1,
});

/**
 * Walk a host and a guest forward together, with the guest holding a command.
 *
 * The tick counter is shared across calls rather than restarting at zero in each
 * one. It restarted, once, and the guest replayed a stale entry whose tick number
 * happened to match the one being acknowledged — which looked exactly like a
 * broken prediction and was a broken harness. Tick numbers identify a moment; two
 * moments cannot have the same number.
 */
let sharedTick = 0;

function run(
  host: NetHost, hostCtx: SessionContext,
  client: NetClient, clientCtx: SessionContext,
  ticks: number, command?: Command,
): void {
  for (let i = 0; i < ticks; i++) {
    const tick = sharedTick++;
    host.beforeTick();
    client.beforeTick();
    // Stepped every tick whether or not there is input, and through the same
    // commandToIntent the host uses. Skipping the empty ticks left the guest
    // unaffected by gravity and friction on ticks the host applied both, and the
    // two bodies diverged for reasons that had nothing to do with the network.
    const now = command ?? makeCommand(tick);
    now.tick = tick;
    clientCtx.actors.local.controller.step(DT, commandToIntent(now));
    host.afterTick(DT);
    client.afterTick(DT, now);
  }
  void hostCtx;
}

describe('the wire format', () => {
  it('survives a round trip', () => {
    const message = { t: 'hello', version: PROTOCOL_VERSION, name: 'kid' } as const;
    expect(decode(encode(message))).toEqual(message);
  });

  it('returns null rather than throwing on rubbish', () => {
    // The thing on the other end of a socket is not under our control, and a
    // malformed frame must not take down the game loop.
    expect(decode('not json')).toBeNull();
    expect(decode('null')).toBeNull();
    expect(decode('42')).toBeNull();
    expect(decode('{"no":"tag"}')).toBeNull();
    expect(decode('[1,2,3]')).toBeNull();
  });
});

describe('joining', () => {
  let hostCtx: SessionContext;
  let clientCtx: SessionContext;
  let host: NetHost;

  beforeEach(() => {
    hostCtx = makeMachine();
    clientCtx = makeMachine();
    host = new NetHost(hostCtx);
  });

  it('gives a guest an id, a side and the world as it stands', () => {
    // Somebody joining halfway through has to see what everybody built before
    // they arrived, or they are playing a different map.
    hostCtx.build.applyPlace(plank(3, 0.5, 3));
    hostCtx.build.applyPlace(plank(3, 0.5, 5));

    const pipe = loopbackPair();
    const client = new NetClient(clientCtx, pipe.client, 'guest');
    host.accept(pipe.host);
    run(host, hostCtx, client, clientCtx, 3);

    expect(client.status.connected).toBe(true);
    expect(client.status.localId).toBeGreaterThan(0);
    expect(clientCtx.world.partCount).toBe(2);
    // Opposite side to the host, so a lawn where everybody is on your team is
    // not what a party game turns into.
    expect(clientCtx.actors.local.team).toBe('right');
  });

  it('puts a joiner in the host roster and vice versa', () => {
    const pipe = loopbackPair();
    const client = new NetClient(clientCtx, pipe.client, 'guest');
    host.accept(pipe.host);
    run(host, hostCtx, client, clientCtx, SNAPSHOT_HZ);

    hostCtx.actors.refresh([]);
    expect(hostCtx.actors.all.length).toBe(2);
    expect(clientCtx.actors.all.length).toBe(2);
    expect(host.status.peers).toBe(1);
    expect(client.status.peers).toBe(1);
  });

  it('turns away a peer speaking a different protocol', () => {
    const pipe = loopbackPair();
    pipe.client.send({ t: 'hello', version: PROTOCOL_VERSION + 1, name: 'old build' });
    host.accept(pipe.host);
    host.beforeTick();

    const replies = pipe.client.drain();
    expect(replies).toHaveLength(1);
    expect(replies[0]!.t).toBe('refused');
    expect(host.status.peers).toBe(0);
  });

  it('waits for a hello that has not arrived yet', () => {
    // The failure this replaces was a race dressed as a rule. `greet` assumed
    // the hello had already arrived by the time a transport reached the host —
    // true of the relay, which hands one over on its first message, and an
    // invariant held by exactly one caller. Everything else got "expected a
    // hello" and a closed socket on the very next tick.
    //
    // It behaved exactly like a race, too: the browser scenario passed on a
    // fast machine and failed on CI, because one extra round trip between
    // opening the pipe and sending the hello was enough for a tick to land in
    // the gap. A real network has that gap by definition.
    const pipe = loopbackPair();
    host.accept(pipe.host);
    for (let i = 0; i < 20; i++) host.beforeTick();
    expect(pipe.client.drain()).toHaveLength(0);
    expect(pipe.client.open).toBe(true);

    pipe.client.send({ t: 'hello', version: PROTOCOL_VERSION, name: 'late' });
    host.beforeTick();
    const replies = pipe.client.drain();
    expect(replies[0]!.t).toBe('welcome');
    expect(host.status.peers).toBe(1);
  });

  it('keeps what arrived before the hello did', () => {
    // A command can beat a hello through a relay. One drain that threw the
    // queue away would swallow the introduction and hang the connection until
    // it timed out.
    const pipe = loopbackPair();
    host.accept(pipe.host);
    pipe.client.send({ t: 'cmd', c: [0, 0, 0, 0, 0, 0, 0] });
    host.beforeTick();
    pipe.client.send({ t: 'hello', version: PROTOCOL_VERSION, name: 'out of order' });
    host.beforeTick();
    expect(host.status.peers).toBe(1);
  });

  it('gives up on a connection that never introduces itself', () => {
    const pipe = loopbackPair();
    pipe.client.send({ t: 'cmd', c: [0, 0, 0, 0, 0, 0, 0] });
    host.accept(pipe.host);
    for (let i = 0; i <= HELLO_GRACE_TICKS + 1; i++) host.beforeTick();
    expect(pipe.client.drain()[0]!.t).toBe('refused');
    expect(host.status.peers).toBe(0);
  });

  it('has a limit, so a stray peer cannot exhaust the host', () => {
    const clients: NetClient[] = [];
    for (let i = 0; i < MAX_PEERS + 2; i++) {
      const ctx = makeMachine();
      const pipe = loopbackPair();
      clients.push(new NetClient(ctx, pipe.client, `kid${i}`));
      host.accept(pipe.host);
      host.beforeTick();
    }
    expect(host.status.peers).toBe(MAX_PEERS);
    expect(clients.length).toBe(MAX_PEERS + 2);
  });

  it('forgets a guest that goes away', () => {
    const pipe = loopbackPair();
    const client = new NetClient(clientCtx, pipe.client, 'guest');
    host.accept(pipe.host);
    run(host, hostCtx, client, clientCtx, 3);
    expect(host.status.peers).toBe(1);

    pipe.client.close();
    host.beforeTick();
    expect(host.status.peers).toBe(0);
    hostCtx.actors.refresh([]);
    expect(hostCtx.actors.all.length).toBe(1);
  });
});

describe('moving', () => {
  it('the host runs a guest from the commands they send', () => {
    const hostCtx = makeMachine();
    const clientCtx = makeMachine();
    const host = new NetHost(hostCtx);
    const pipe = loopbackPair();
    const client = new NetClient(clientCtx, pipe.client, 'guest');
    host.accept(pipe.host);
    run(host, hostCtx, client, clientCtx, 2);

    hostCtx.actors.refresh([]);
    const guestOnHost = hostCtx.actors.all.find((a) => a.kind === 'remote')!;
    const before = guestOnHost.controller.z;

    const command = makeCommand();
    command.moveZ = -1;
    run(host, hostCtx, client, clientCtx, 60, command);

    expect(guestOnHost.controller.z).toBeLessThan(before - 1);
  });

  it('a guest sees the host move without simulating them', () => {
    const hostCtx = makeMachine();
    const clientCtx = makeMachine();
    const host = new NetHost(hostCtx);
    const pipe = loopbackPair();
    const client = new NetClient(clientCtx, pipe.client, 'guest');
    host.accept(pipe.host);
    run(host, hostCtx, client, clientCtx, 4);

    // The host walks. Only the host runs this body.
    for (let i = 0; i < 90; i++) {
      host.beforeTick();
      hostCtx.local.step(DT, {
        right: 0, forward: -1, jump: false, sprint: false, crouch: false, climb: 0,
      });
      host.afterTick(DT);
      client.beforeTick();
      client.afterTick(DT, makeCommand(i));
    }

    const hostOnClient = clientCtx.actors.all.find((a) => a.id === LOCAL_ACTOR_ID
      && a.kind === 'remote');
    // The host arrives as a remote with the host's own id.
    const mirrored = hostOnClient ?? clientCtx.actors.get(LOCAL_ACTOR_ID);
    expect(mirrored).toBeDefined();
    // Interpolation runs behind live on purpose, so the mirror trails the truth
    // rather than matching it — but it must be following, not parked.
    const remote = [...clientCtx.actors.all].find((a) => a.kind === 'remote')!;
    expect(remote.controller.z).toBeLessThan(-1);
    expect(remote.controller.z).toBeGreaterThan(hostCtx.local.z - 1);
  });

  it('draws remotes behind live, which is what makes them smooth', () => {
    // The delay is the design, so it is stated as a test rather than left as a
    // number somebody might "optimise" to zero.
    expect(INTERP_DELAY).toBeGreaterThan(1 / SNAPSHOT_HZ);
    expect(INTERP_DELAY).toBeLessThan(0.25);
  });
});

describe('prediction and reconciliation', () => {
  it('leaves a good prediction alone rather than twitching', () => {
    // Snapping on every snapshot would jitter on nothing but the host having run
    // the tick a fraction earlier, and a character that twitches while standing
    // still reads as a broken game far more than a two-centimetre error does.
    const hostCtx = makeMachine();
    const clientCtx = makeMachine();
    const host = new NetHost(hostCtx);
    const pipe = loopbackPair();
    const client = new NetClient(clientCtx, pipe.client, 'guest');
    host.accept(pipe.host);
    run(host, hostCtx, client, clientCtx, 4);

    const command = makeCommand();
    command.moveZ = -1;
    run(host, hostCtx, client, clientCtx, 120, command);

    // Not "never corrects" — the host is always at least a tick behind, so it
    // legitimately disagrees. What matters is that a correction does not *move*
    // anybody: the replay puts the body back where the same inputs had already
    // taken it. That is the difference between a working prediction and a
    // rubber band, and it is a distance, not a count.
    expect(client.worstCorrectionDistance).toBeLessThan(0.02);
  });

  it('pulls a wrong prediction back to where the host says it was', () => {
    const hostCtx = makeMachine();
    const clientCtx = makeMachine();
    const host = new NetHost(hostCtx);
    const pipe = loopbackPair();
    const client = new NetClient(clientCtx, pipe.client, 'guest');
    host.accept(pipe.host);
    run(host, hostCtx, client, clientCtx, 4);

    // Shove the guest's own body somewhere the host never agreed to — which is
    // what a dropped packet, a cheat or a bug all look like from here.
    clientCtx.local.teleport(0, 0.5, -25);
    run(host, hostCtx, client, clientCtx, 30);

    expect(client.correctionCount).toBeGreaterThan(0);
    hostCtx.actors.refresh([]);
    const truth = hostCtx.actors.all.find((a) => a.kind === 'remote')!.controller;
    const error = Math.hypot(
      clientCtx.local.x - truth.x, clientCtx.local.y - truth.y, clientCtx.local.z - truth.z,
    );
    expect(error).toBeLessThan(0.5);
  });

  it('replays unacknowledged input, so a correction is not a rubber band', () => {
    // The whole trick. Without the replay, a correction drags the player back by
    // a full round trip on every snapshot; with it, the body ends up where the
    // same inputs would have put it.
    const hostCtx = makeMachine();
    const clientCtx = makeMachine();
    const host = new NetHost(hostCtx);
    const pipe = loopbackPair();
    const client = new NetClient(clientCtx, pipe.client, 'guest');
    host.accept(pipe.host);
    run(host, hostCtx, client, clientCtx, 4);

    const command = makeCommand();
    command.moveZ = -1;
    run(host, hostCtx, client, clientCtx, 90, command);

    hostCtx.actors.refresh([]);
    const truth = hostCtx.actors.all.find((a) => a.kind === 'remote')!.controller;
    // The guest is *ahead* of the host, by roughly what it has not been told
    // about yet. Behind would mean the prediction is not running at all.
    expect(clientCtx.local.z).toBeLessThanOrEqual(truth.z + 1e-6);
    expect(Math.abs(clientCtx.local.z - truth.z)).toBeLessThan(1.0);
  });

  it('has a correction threshold big enough to ignore noise and small enough to matter', () => {
    expect(RECONCILE_THRESHOLD).toBeGreaterThan(0.01);
    expect(RECONCILE_THRESHOLD).toBeLessThan(0.25);
  });
});

describe('building together', () => {
  it('a guest asks and the host decides', () => {
    const hostCtx = makeMachine();
    const clientCtx = makeMachine();
    const host = new NetHost(hostCtx);
    const pipe = loopbackPair();
    const client = new NetClient(clientCtx, pipe.client, 'guest');
    host.accept(pipe.host);
    run(host, hostCtx, client, clientCtx, 3);

    client.requestPlacement(plank(4, 0.5, 4));
    run(host, hostCtx, client, clientCtx, 3);

    expect(hostCtx.world.partCount).toBe(1);
    expect(clientCtx.world.partCount).toBe(1);
  });

  it('refuses a guest placement that would overlap, on both machines', () => {
    // The authority is what stops two people building into the same space from
    // opposite sides of a wall and getting two different worlds.
    const hostCtx = makeMachine();
    const clientCtx = makeMachine();
    const host = new NetHost(hostCtx);
    const pipe = loopbackPair();
    const client = new NetClient(clientCtx, pipe.client, 'guest');
    host.accept(pipe.host);
    run(host, hostCtx, client, clientCtx, 3);

    hostCtx.build.applyPlace(plank(4, 0.5, 4));
    host.announcePlacement(hostCtx.build.lastPlacedId!, plank(4, 0.5, 4));
    run(host, hostCtx, client, clientCtx, 2);
    expect(clientCtx.world.partCount).toBe(1);

    client.requestPlacement(plank(4, 0.5, 4));
    run(host, hostCtx, client, clientCtx, 3);

    expect(hostCtx.world.partCount).toBe(1);
    expect(clientCtx.world.partCount).toBe(1);
  });

  it('a removal reaches everybody', () => {
    const hostCtx = makeMachine();
    const clientCtx = makeMachine();
    const host = new NetHost(hostCtx);
    const pipe = loopbackPair();
    const client = new NetClient(clientCtx, pipe.client, 'guest');
    host.accept(pipe.host);
    run(host, hostCtx, client, clientCtx, 3);

    client.requestPlacement(plank(4, 0.5, 4));
    run(host, hostCtx, client, clientCtx, 3);
    const id = hostCtx.build.lastPlacedId!;

    client.requestRemoval(id);
    run(host, hostCtx, client, clientCtx, 3);

    expect(hostCtx.world.partCount).toBe(0);
    expect(clientCtx.world.partCount).toBe(0);
  });

  it('translates part ids, so a guest removes the plank they are pointing at', () => {
    // Two machines allocate ids independently: the host's store has gaps where
    // things were taken down and a fresh guest's does not. Sending the local
    // number removes a different plank on everybody else's screen — and the
    // right one vanishes for the player who asked, so it reads as a rendering
    // bug rather than a protocol one.
    const hostCtx = makeMachine();
    const clientCtx = makeMachine();

    // Give the host a store with a hole in it, which is what makes the ids
    // diverge in the first place.
    hostCtx.build.applyPlace(plank(2, 0.5, 2));
    hostCtx.build.applyPlace(plank(2, 0.5, 5));
    hostCtx.build.applyPlace(plank(2, 0.5, 8));
    hostCtx.build.applyRemove(hostCtx.build.serializeWithIds()[0]![0]);
    expect(hostCtx.world.partCount).toBe(2);

    const host = new NetHost(hostCtx);
    const pipe = loopbackPair();
    const client = new NetClient(clientCtx, pipe.client, 'guest');
    host.accept(pipe.host);
    run(host, hostCtx, client, clientCtx, 3);
    expect(clientCtx.world.partCount).toBe(2);

    // The guest points at what it calls part 0 — which is not what the host
    // calls part 0.
    const guestIds = clientCtx.build.serializeWithIds();
    const hostIds = hostCtx.build.serializeWithIds();
    expect(guestIds[0]![0]).not.toBe(hostIds[0]![0]);

    const doomed = guestIds[0]![1];
    client.requestRemoval(guestIds[0]![0]);
    run(host, hostCtx, client, clientCtx, 3);

    expect(hostCtx.world.partCount).toBe(1);
    expect(clientCtx.world.partCount).toBe(1);
    // And it is the same plank on both machines, not merely the same count.
    const left = hostCtx.build.serialize()[0]!;
    expect(left.z).not.toBeCloseTo(doomed.z, 3);
    expect(clientCtx.build.serialize()[0]!.z).toBeCloseTo(left.z, 3);
  });

  it('two guests end up with the same world as the host', () => {
    // The property that actually matters, stated directly. Everything else here
    // is a mechanism for producing it.
    const hostCtx = makeMachine();
    const a = makeMachine();
    const b = makeMachine();
    const host = new NetHost(hostCtx);
    const pipeA = loopbackPair();
    const pipeB = loopbackPair();
    const clientA = new NetClient(a, pipeA.client, 'a');
    const clientB = new NetClient(b, pipeB.client, 'b');
    host.accept(pipeA.host);
    host.accept(pipeB.host);

    const tick = (n: number): void => {
      for (let i = 0; i < n; i++) {
        host.beforeTick();
        clientA.beforeTick();
        clientB.beforeTick();
        host.afterTick(DT);
        clientA.afterTick(DT, makeCommand(i));
        clientB.afterTick(DT, makeCommand(i));
      }
    };
    tick(4);

    clientA.requestPlacement(plank(6, 0.5, 6));
    clientB.requestPlacement(plank(6, 0.5, 9));
    hostCtx.build.applyPlace(plank(6, 0.5, 12));
    host.announcePlacement(hostCtx.build.lastPlacedId!, plank(6, 0.5, 12));
    tick(6);

    expect(hostCtx.world.partCount).toBe(3);
    expect(a.world.partCount).toBe(3);
    expect(b.world.partCount).toBe(3);
  });
});

describe('the loopback transport', () => {
  it('round-trips through the encoder, so a field that would not survive a socket fails here', () => {
    const pipe = loopbackPair();
    const command = makeCommand(7);
    pipe.client.send({ t: 'cmd', c: [command.tick, 1, 2, 0, 0.5, 0, 3] });
    const got = pipe.host.drain();
    expect(got).toHaveLength(1);
    expect(got[0]).toEqual({ t: 'cmd', c: [7, 1, 2, 0, 0.5, 0, 3] });
  });

  it('empties on drain, so nothing is applied twice', () => {
    const pipe = loopbackPair();
    pipe.client.send({ t: 'unbuild', p: 1 });
    expect(pipe.host.drain()).toHaveLength(1);
    expect(pipe.host.drain()).toHaveLength(0);
  });

  it('goes quiet when either end closes', () => {
    const pipe = loopbackPair();
    pipe.host.close();
    pipe.client.send({ t: 'unbuild', p: 1 });
    expect(pipe.host.drain()).toHaveLength(0);
  });
});
