import { describe, it, expect, beforeEach } from 'vitest';
import { CollisionWorld } from '../physics/collisionWorld.ts';
import { ProjectileSystem } from '../game/projectiles.ts';
import type { Transport } from './transport.ts';
import { PartRenderer } from '../render/partRenderer.ts';
import { BuildSystem } from '../build/buildSystem.ts';
import { PLAY_HALF } from '../world/bounds.ts';
import { NEAR_RADIUS } from '../game/comms.ts';
import {
  BUILD_MIN, HEAD_MAX, buildOf, clampAppearance, headScaleOf, type Appearance,
} from '../game/appearance.ts';
import { CharacterController } from '../player/controller.ts';
import { ActorRoster, LOCAL_ACTOR_ID, type Actor } from '../game/actor.ts';
import { BUTTON, commandToIntent, makeCommand, type Command } from '../core/command.ts';
import type { ActorInput, GameMode } from '../game/gameMode.ts';
import { DT } from '../physics/constants.ts';
import { installFixtures } from '../world/neighborhood.ts';
import { neighborhoodSlabs } from '../world/neighborhood.ts';
import { Rng } from '../core/rng.ts';
import { loopbackPair } from './transport.ts';
import { decode, encode, PROTOCOL_VERSION, type RtcSignal } from './protocol.ts';
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
type Machine = SessionContext & { local: CharacterController };

function makeMachine(withMap = false): Machine {
  const world = new CollisionWorld();
  if (withMap) installFixtures(world, neighborhoodSlabs(new Rng('map')));
  const build = new BuildSystem(world, new PartRenderer());
  const local = new CharacterController(world, 0, 0.5, 0);
  const localActor: Actor = {
    id: LOCAL_ACTOR_ID, kind: 'local', team: 'left', controller: local, heading: 0,
  };
  const actors = new ActorRoster(localActor);
  return {
    world, build, actors, local, projectiles: new ProjectileSystem(world),
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
    pipe.client.send({ t: 'cmd', c: [0, 0, 0, 0, 0, 0, 0, 0] });
    host.beforeTick();
    pipe.client.send({ t: 'hello', version: PROTOCOL_VERSION, name: 'out of order' });
    host.beforeTick();
    expect(host.status.peers).toBe(1);
  });

  it('gives up on a connection that never introduces itself', () => {
    const pipe = loopbackPair();
    pipe.client.send({ t: 'cmd', c: [0, 0, 0, 0, 0, 0, 0, 0] });
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

  it('refuses a placement the guest could not have reached', () => {
    // The exploit this closes, stated plainly: a guest is a program, and a
    // program does not have to use the snapper. `MAX_REACH` lives on the
    // client, so it constrains an honest player and nobody else — a
    // hand-written `build` message names any coordinates it likes, and until
    // this check the host placed a part there and charged a plank for it. A
    // staircase in somebody else's fort, a box around another player, a wall
    // across a flag base from the far side of the lot.
    const hostCtx = makeMachine();
    const clientCtx = makeMachine();
    const host = new NetHost(hostCtx);
    const pipe = loopbackPair();
    const client = new NetClient(clientCtx, pipe.client, 'guest');
    host.accept(pipe.host);
    run(host, hostCtx, client, clientCtx, 3);

    // The guest spawns at (2, 0.5, 0); this is thirty metres away.
    client.requestPlacement(plank(32, 0.5, 0));
    run(host, hostCtx, client, clientCtx, 3);
    expect(hostCtx.world.partCount).toBe(0);
    expect(clientCtx.world.partCount).toBe(0);

    // And the same guest can still build beside itself, so this is a reach
    // limit rather than a refusal to let guests build at all.
    client.requestPlacement(plank(4, 0.5, 0));
    run(host, hostCtx, client, clientCtx, 3);
    expect(hostCtx.world.partCount).toBe(1);
    expect(clientCtx.world.partCount).toBe(1);
  });

  it('refuses a placement outside the world', () => {
    // The other half, and a different rule in a different place: reach is about
    // who asked, bounds are about where. A guest standing at the edge of the
    // map is within arm's length of the outside of it.
    const hostCtx = makeMachine();
    const clientCtx = makeMachine();
    const host = new NetHost(hostCtx);
    const pipe = loopbackPair();
    const client = new NetClient(clientCtx, pipe.client, 'guest');
    host.accept(pipe.host);
    run(host, hostCtx, client, clientCtx, 3);

    // Put the guest's body on the boundary, so reach cannot be what refuses it.
    const guest = hostCtx.actors.all.find((a) => a.kind === 'remote')!;
    guest.controller.teleport(PLAY_HALF - 1, 0.5, 0);
    client.requestPlacement(plank(PLAY_HALF + 2, 0.5, 0));
    run(host, hostCtx, client, clientCtx, 3);
    expect(hostCtx.world.partCount).toBe(0);
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

    // Each of the three builds beside itself. It used to be three planks in a
    // row out at (6, 6), (6, 9) and (6, 12), which nobody noticed was ten to
    // twelve metres from the guest asking for it — further than the client's own
    // snapper would ever have allowed, so the test was exercising a placement no
    // player could make. Measured: guest A sits at (2, 0), guest B at (-2, 0).
    clientA.requestPlacement(plank(5, 0.5, 2));
    clientB.requestPlacement(plank(-5, 0.5, 2));
    hostCtx.build.applyPlace(plank(0, 0.5, 4));
    host.announcePlacement(hostCtx.build.lastPlacedId!, plank(0, 0.5, 4));
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
    pipe.client.send({ t: 'cmd', c: [command.tick, 1, 2, 0, 0.5, 0, 3, 1] });
    const got = pipe.host.drain();
    expect(got).toHaveLength(1);
    expect(got[0]).toEqual({ t: 'cmd', c: [7, 1, 2, 0, 0.5, 0, 3, 1] });
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

describe('fighting together', () => {
  /**
   * A host with one guest attached, and nothing else.
   *
   * Deliberately without a mode by default: most of what is under test here is
   * the session reading a command it already had, which is a question about
   * this file rather than about anybody's rules.
   */
  function joined(): {
    host: NetHost; hostCtx: Machine; client: NetClient; clientCtx: Machine; id: number;
  } {
    const hostCtx = makeMachine();
    const clientCtx = makeMachine();
    const pipe = loopbackPair();
    const host = new NetHost(hostCtx);
    const client = new NetClient(clientCtx, pipe.client, 'kid');
    host.accept(pipe.host);
    run(host, hostCtx, client, clientCtx, 3);
    return { host, hostCtx, client, clientCtx, id: client.status.localId };
  }

  /**
   * One tick, sampling the guest's input where the game samples it.
   *
   * Which is between `beforeTick` and `afterTick` — the mode runs there, and
   * `afterTick` is what rolls the held-trigger memory forward. Sampling after
   * it instead reports every press as already handled, which is what the first
   * version of these tests did and why they read as a broken edge detector.
   */
  function tickSampling(
    host: NetHost, hostCtx: Machine, client: NetClient, clientCtx: Machine,
    id: number, command: Command,
  ): ActorInput {
    const tick = sharedTick++;
    command.tick = tick;
    host.beforeTick();
    client.beforeTick();
    const sampled = host.inputOf(id);
    clientCtx.actors.local.controller.step(DT, commandToIntent(command));
    host.afterTick(DT);
    client.afterTick(DT, command);
    void hostCtx;
    return sampled;
  }

  it('turns a held trigger into a press exactly once', () => {
    // A command carries a *held* bit and a mode asks about edges. A host that
    // derived neither would give every guest a throw that never charges and
    // never leaves their hand; one that reported a press every tick would make
    // a cooldown-gated weapon read as spam.
    const { host, hostCtx, client, clientCtx, id } = joined();
    const firing = makeCommand(0);
    firing.buttons = BUTTON.fire;

    const seen: Array<[boolean, boolean, boolean]> = [];
    for (let i = 0; i < 4; i++) {
      const input = tickSampling(host, hostCtx, client, clientCtx, id, firing);
      seen.push([input.fire, input.firePressed, input.fireReleased]);
    }
    // Nothing on the first tick: the command sent at the end of it has not been
    // drained yet. Then the press, once, and held from there on.
    expect(seen[0]).toEqual([false, false, false]);
    expect(seen[1]).toEqual([true, true, false]);
    expect(seen[2]).toEqual([true, false, false]);
    expect(seen[3]).toEqual([true, false, false]);

    // And letting go is a release, once.
    const idle = makeCommand(0);
    tickSampling(host, hostCtx, client, clientCtx, id, idle);
    const after = tickSampling(host, hostCtx, client, clientCtx, id, idle);
    expect([after.fire, after.firePressed, after.fireReleased]).toEqual([false, false, true]);
    const later = tickSampling(host, hostCtx, client, clientCtx, id, idle);
    expect([later.fire, later.firePressed, later.fireReleased]).toEqual([false, false, false]);
  });

  it("points a guest's aim where the guest was looking", () => {
    // The vector has to be the one the guest's own crosshair is drawn on, or
    // they aim at one thing and hit another. Held to the camera's own
    // expression by command.test, which is where that convention lives.
    const { host, hostCtx, client, clientCtx, id } = joined();
    const looking = makeCommand(0);
    looking.yaw = Math.PI / 2;
    looking.pitch = 0;

    tickSampling(host, hostCtx, client, clientCtx, id, looking);
    const aim = tickSampling(host, hostCtx, client, clientCtx, id, looking);
    expect(aim.aimX).toBeCloseTo(-1, 5);
    expect(aim.aimZ).toBeCloseTo(0, 5);
  });

  it('carries which weapon a guest is holding, every tick rather than once', () => {
    // A held weapon is a state, not an event. Sent on change, one dropped
    // packet leaves the two machines disagreeing about what is in somebody's
    // hands until the next time they touch the wheel.
    const { host, hostCtx, client, clientCtx, id } = joined();
    const holding = makeCommand(0);
    holding.slot = 2;
    run(host, hostCtx, client, clientCtx, 4, holding);
    expect(host.inputOf(id).slot).toBe(2);
  });

  it('says nothing about somebody who has sent no command yet', () => {
    // Idle rather than stale or undefined: a peer whose packets have not
    // arrived should stand still, not repeat whatever the last person did.
    const { host } = joined();
    expect(host.inputOf(999).fire).toBe(false);
    expect(host.inputOf(999).firePressed).toBe(false);
  });

  it('stops a soaked guest, by the same rule that stops a soaked host', () => {
    // Left out at first, and nothing said so: the host stepped every guest at
    // full speed regardless of what the mode thought of them, which made being
    // knocked out of the fight a purely cosmetic thing to happen to anybody who
    // was not the authority.
    const hostCtx = makeMachine();
    const clientCtx = makeMachine();
    const stopped = new Set<number>();
    // The thinnest thing `packRound` will accept, plus the one rule under test.
    const mode: GameMode = {
      id: 'stub', name: 'Stub', finished: false, won: false,
      bots: [], buildingAllowed: true, playerSpeedScale: 1,
      start: () => {}, fixedUpdate: () => {}, end: () => {},
      markers: () => [],
      summary: () => ({ headline: '', lines: [] }),
      hud: () => ({
        phase: 'STUB', timer: null, primary: null, secondary: null, message: null,
        charge: null, wetness: null, ammo: null, refill: null,
      }),
      speedScaleFor: (id: number) => (stopped.has(id) ? 0 : 1),
    };
    hostCtx.mode = () => mode;

    const pipe = loopbackPair();
    const host = new NetHost(hostCtx);
    const client = new NetClient(clientCtx, pipe.client, 'kid');
    host.accept(pipe.host);
    run(host, hostCtx, client, clientCtx, 3);

    const id = client.status.localId;
    const walking = makeCommand(0);
    walking.moveZ = -1;

    const body = (): { x: number; z: number } => {
      const them = hostCtx.actors.get(id)!;
      return { x: them.controller.x, z: them.controller.z };
    };
    const from = body();
    run(host, hostCtx, client, clientCtx, 30, walking);
    const walked = Math.hypot(body().x - from.x, body().z - from.z);
    expect(walked, 'the guest never moved, so the next check proves nothing')
      .toBeGreaterThan(0.5);

    stopped.add(id);
    const held = body();
    run(host, hostCtx, client, clientCtx, 30, walking);
    const coasted = Math.hypot(body().x - held.x, body().z - held.z);
    // Not zero, and it should not be: the controller decelerates rather than
    // stopping dead, so a body already moving carries about a tenth of a metre
    // into the stop. What matters is that it is a stop and not a stroll.
    expect(coasted).toBeLessThan(walked / 3);
    expect(coasted).toBeLessThan(0.25);
  });

  it('shows a guest the balloons in the air, where they actually are', () => {
    // A guest runs no projectile simulation, so without this the yard is
    // silent: kids wind up, throw, and nothing crosses the lawn until the guest
    // is suddenly wet. A balloon in flight is the only warning this game gives.
    const { host, hostCtx, client, clientCtx } = joined();
    hostCtx.projectiles.spawn(3, 2, -5, 0, 0, -1, 12, 0);
    expect(clientCtx.projectiles.activeCount, 'the guest started with balloons').toBe(0);

    run(host, hostCtx, client, clientCtx, 8);
    expect(clientCtx.projectiles.activeCount).toBe(1);

    // The position, not just the count. A mirror that reported a balloon at the
    // origin would satisfy a count and put every throw in the same place.
    const where = only(clientCtx);
    expect(where[0]).toBeCloseTo(3, 2);
    expect(where[2]).toBeCloseTo(-5, 2);

    // And it follows. The host's own projectiles move when a mode ticks them;
    // here they are stepped by hand, at the real timestep, because the subject
    // is the mirror rather than the ballistics.
    for (let i = 0; i < 6; i++) hostCtx.projectiles.update(DT, []);
    run(host, hostCtx, client, clientCtx, 8);
    expect(only(clientCtx)[2], 'the guest is still drawing the old position')
      .toBeLessThan(-5);
  });

  /** Where the one balloon a machine can see is. Fails loudly if there is not exactly one. */
  function only(ctx: Machine): [number, number, number] {
    const seen: Array<[number, number, number]> = [];
    ctx.projectiles.forEachActive((_i, x, y, z) => seen.push([x, y, z]));
    expect(seen, 'expected exactly one balloon').toHaveLength(1);
    return seen[0]!;
  }

  it("takes a guest's balloons away again when they land", () => {
    // The mirror is the whole of a guest's knowledge of what is in the air, so
    // a balloon it never clears is one that hangs in the sky forever.
    const { host, hostCtx, client, clientCtx } = joined();
    hostCtx.projectiles.spawn(0, 2, 0, 0, 0, -1, 12, 0);
    run(host, hostCtx, client, clientCtx, 8);
    expect(clientCtx.projectiles.activeCount).toBe(1);

    hostCtx.projectiles.clear();
    run(host, hostCtx, client, clientCtx, 8);
    expect(clientCtx.projectiles.activeCount).toBe(0);
  });
});

describe('saying hello', () => {
  /**
   * A transport that is not open yet, which is what a real WebSocket is.
   *
   * Every other test here uses a loopback pair, and a loopback is open on the
   * tick it is made. That is why this went unnoticed: `SocketTransport.send`
   * drops anything sent before the socket opens, `NetClient` sent its only
   * hello from the constructor, and so on a real connection the hello was
   * thrown away every single time.
   */
  function laterTransport(): { transport: Transport; open(): void; sent: string[] } {
    const sent: string[] = [];
    let isOpen = false;
    const inbox: ReturnType<typeof decode>[] = [];
    const transport: Transport = {
      get open(): boolean { return isOpen; },
      send: (m: { t: string }) => { if (isOpen) sent.push(m.t); },
      drain: () => inbox.splice(0, inbox.length) as never,
      close: () => { isOpen = false; },
    };
    return { transport, open: () => { isOpen = true; }, sent };
  }

  it('keeps saying hello until somebody answers', () => {
    // Two failures, one fix. The socket is still connecting when the client is
    // made, and a relay drops a guest's message when no host has joined the
    // room yet — which is routine now that a lobby hands both machines the
    // same room at the same instant.
    const ctx = makeMachine();
    const late = laterTransport();
    const client = new NetClient(ctx, late.transport, 'kid');

    // Nothing while it is still connecting, and no throw either.
    for (let i = 0; i < 10; i++) client.beforeTick();
    expect(late.sent, 'spoke into a socket that was not open').toHaveLength(0);

    late.open();
    for (let i = 0; i < 120; i++) client.beforeTick();
    expect(late.sent.filter((t) => t === 'hello').length,
      'the client gave up before anybody could welcome it').toBeGreaterThan(1);
  });

  it('stops once it has been welcomed', () => {
    // A guest that kept introducing itself forever would be a small flood from
    // every player in the game, for the whole game.
    const hostCtx = makeMachine();
    const clientCtx = makeMachine();
    const pipe = loopbackPair();
    const host = new NetHost(hostCtx);
    const client = new NetClient(clientCtx, pipe.client, 'kid');
    host.accept(pipe.host);
    run(host, hostCtx, client, clientCtx, 4);
    expect(client.status.connected).toBe(true);

    const before = host.status.peers;
    run(host, hostCtx, client, clientCtx, 200);
    expect(host.status.peers, 'a welcomed guest introduced itself again').toBe(before);
  });
});

describe('talking to each other', () => {
  /** A host, two guests, and a record of everything each machine was told. */
  function room(): {
    host: NetHost; hostCtx: Machine; heard: Record<string, unknown[]>;
    a: NetClient; b: NetClient; aCtx: Machine; bCtx: Machine;
    tick(n: number): void;
  } {
    const heard: Record<string, unknown[]> = { host: [], a: [], b: [] };
    const make = (key: string): Machine => {
      const m = makeMachine();
      m.heard = (e) => heard[key]!.push(e);
      return m;
    };
    const hostCtx = make('host');
    const aCtx = make('a');
    const bCtx = make('b');
    const host = new NetHost(hostCtx);
    const pa = loopbackPair();
    const pb = loopbackPair();
    const a = new NetClient(aCtx, pa.client, 'ali');
    const b = new NetClient(bCtx, pb.client, 'bo');
    host.accept(pa.host);
    host.accept(pb.host);
    const tick = (n: number): void => {
      for (let i = 0; i < n; i++) {
        host.beforeTick();
        a.beforeTick();
        b.beforeTick();
        host.afterTick(DT);
        a.afterTick(DT, makeCommand(sharedTick));
        b.afterTick(DT, makeCommand(sharedTick++));
      }
    };
    tick(4);
    return { host, hostCtx, heard, a, b, aCtx, bCtx, tick };
  }

  /** Where the host thinks somebody is. Teams alternate: guest 1 right, guest 2 left. */
  function put(ctx: Machine, id: number, x: number, z: number): void {
    ctx.actors.get(id)!.controller.teleport(x, 0.5, z);
  }

  it('carries a proximity line to somebody standing near', () => {
    const r = room();
    put(r.hostCtx, 1, 3, 0);
    r.a.say('near', 'oi');
    r.tick(4);
    expect(r.heard.a).toContainEqual(
      expect.objectContaining({ kind: 'say', channel: 'near', text: 'oi' }),
    );
  });

  it('does not carry it to somebody across the map', () => {
    const r = room();
    put(r.hostCtx, 1, 0, 0);
    put(r.hostCtx, 2, 0, NEAR_RADIUS + 20);
    r.a.say('near', 'oi');
    r.tick(4);
    expect(r.heard.b).toHaveLength(0);
  });

  it('keeps team chat off the other team, on the wire and not on the screen', () => {
    // The claim the whole design turns on. Guests alternate sides, so guest 1
    // and guest 2 are opponents — and the message must not be *sent* to the
    // other one, because a client that received it and chose not to draw it is
    // a client somebody can replace.
    const r = room();
    put(r.hostCtx, 1, 0, 0);
    put(r.hostCtx, 2, 0, 0);
    expect(r.hostCtx.actors.get(1)!.team).not.toBe(r.hostCtx.actors.get(2)!.team);

    r.a.say('team', 'they are round the back');
    r.tick(4);
    expect(r.heard.a).toContainEqual(expect.objectContaining({ text: 'they are round the back' }));
    expect(r.heard.b).toHaveLength(0);
  });

  it('reaches a teammate on the far side of the world', () => {
    // The other half: team chat ignores distance entirely, or it is proximity
    // chat with extra steps.
    const r = room();
    put(r.hostCtx, 1, -50, -50);
    put(r.hostCtx, 0, 50, 50);
    r.a.say('team', 'help');
    r.tick(4);
    const mates = r.hostCtx.actors.get(1)!.team === r.hostCtx.actors.local.team;
    expect(mates ? r.heard.host : r.heard.a).toContainEqual(
      expect.objectContaining({ text: 'help' }),
    );
  });

  it('lets the host be heard too', () => {
    // The host is a player, not a switchboard. Its own line goes through the
    // same relay so there is one copy of the rule and the host cannot be
    // accidentally exempt from it.
    const r = room();
    put(r.hostCtx, 0, 0, 0);
    put(r.hostCtx, 1, 2, 0);
    r.host.say('near', 'over here');
    r.tick(3);
    expect(r.heard.host).toContainEqual(expect.objectContaining({ text: 'over here' }));
    expect(r.heard.a).toContainEqual(expect.objectContaining({ text: 'over here' }));
  });

  it('names the speaker from what they said at the handshake', () => {
    // A guest has no roster of names; the host took them at the handshake and
    // is the only machine that knows who is who.
    const r = room();
    put(r.hostCtx, 1, 1, 0);
    r.a.say('near', 'hello');
    r.tick(4);
    expect(r.heard.a).toContainEqual(expect.objectContaining({ name: 'ali' }));
  });

  it('drops an empty line rather than showing a blank name tag', () => {
    const r = room();
    r.a.say('near', '   ');
    r.tick(4);
    expect(r.heard.a).toHaveLength(0);
  });

  it('rations somebody hammering the key', () => {
    // On the host, where it is a rule. A limit a client enforces on itself is
    // a limit only honest clients have.
    const r = room();
    put(r.hostCtx, 1, 1, 0);
    for (let i = 0; i < 10; i++) r.a.say('near', `spam ${i}`);
    r.tick(4);
    expect(r.heard.a.length).toBeLessThan(4);
  });

  it('sends a ping to the team and nobody else', () => {
    // A mark on the world is a callout, and callouts are tactics.
    const r = room();
    put(r.hostCtx, 1, 0, 0);
    put(r.hostCtx, 2, 1, 0);
    r.a.ping('danger', 4, 0, 4);
    r.tick(4);
    expect(r.heard.a).toContainEqual(
      expect.objectContaining({ kind: 'ping', pingKind: 'danger', x: 4, z: 4 }),
    );
    expect(r.heard.b).toHaveLength(0);
  });

  it('refuses a ping outside the world', () => {
    // The position is a number a client chose. A ping four hundred metres out
    // is a chevron on everybody's compass pointing at nothing for six seconds.
    const r = room();
    put(r.hostCtx, 1, 0, 0);
    r.a.ping('look', 4000, 0, 4000);
    r.tick(4);
    expect(r.heard.a).toHaveLength(0);
  });

  it('performs an emote at whoever can see it', () => {
    // The opposite rule to a ping: an emote is done at the people in front of
    // you, whichever side they are on.
    const r = room();
    put(r.hostCtx, 1, 0, 0);
    put(r.hostCtx, 2, 2, 0);
    r.a.emote('wave');
    r.tick(4);
    expect(r.heard.b).toContainEqual(
      expect.objectContaining({ kind: 'emote', emoteKind: 'wave' }),
    );
  });

  it('does not perform one across the map', () => {
    const r = room();
    put(r.hostCtx, 1, 0, 0);
    put(r.hostCtx, 2, 0, NEAR_RADIUS + 20);
    r.a.emote('wave');
    r.tick(4);
    expect(r.heard.b).toHaveLength(0);
  });
});

describe('what everybody is wearing', () => {
  /**
   * A host, two guests, and every outfit each machine was told about.
   *
   * Its own room helper for the same reason the voice one is: what this records
   * is `wearing`, which is a fact that stays true, and folding it in with the
   * channel that carries things appearing for four seconds would be the first
   * step toward an outfit being treated as an event.
   */
  function dressers(): {
    host: NetHost; a: NetClient; b: NetClient;
    aId: number; bId: number;
    /** A's socket, for sending things a well-behaved client would not. */
    aSocket: Transport;
    got: Record<string, Array<{ id: number; a: Appearance | null }>>;
    tick(n: number): void;
  } {
    const got: Record<string, Array<{ id: number; a: Appearance | null }>> = {
      host: [], a: [], b: [],
    };
    const make = (key: string): Machine => {
      const m = makeMachine();
      m.wearing = (id, appearance) => got[key]!.push({ id, a: appearance });
      return m;
    };
    const host = new NetHost(make('host'));
    const pa = loopbackPair();
    const pb = loopbackPair();
    const a = new NetClient(make('a'), pa.client, 'ali');
    const b = new NetClient(make('b'), pb.client, 'bo');
    host.accept(pa.host);
    host.accept(pb.host);
    const tick = (n: number): void => {
      for (let i = 0; i < n; i++) {
        host.beforeTick();
        a.beforeTick();
        b.beforeTick();
        host.afterTick(DT);
        a.afterTick(DT, makeCommand(sharedTick));
        b.afterTick(DT, makeCommand(sharedTick++));
      }
    };
    tick(4);
    // Read back rather than assumed: ids go in the order the *hellos* land, not
    // the order the transports were accepted. Assuming it cost eight failing
    // tests once already, in the voice room below.
    return {
      host, a, b, aId: a.status.localId, bId: b.status.localId,
      aSocket: pa.client, got, tick,
    };
  }

  const outfit = (skin: number): Appearance => clampAppearance({ skin, hairStyle: 3 });

  it('tells everybody what one guest put on', () => {
    // The whole point. An appearance is the one piece of presentation a late
    // arrival cannot derive for itself, which is exactly what a locker gives up
    // in exchange for letting somebody choose.
    const r = dressers();
    r.a.wear(outfit(3));
    r.tick(4);
    expect(r.got.b.filter((w) => w.id === r.aId)).toHaveLength(1);
    expect(r.got.b.at(-1)!.a!.skin).toBe(3);
    // And back to the sender, so a guest sees themselves in what the host
    // agreed to rather than in what they asked for.
    expect(r.got.a.some((w) => w.id === r.aId && w.a?.skin === 3)).toBe(true);
  });

  it('will not let anybody arrive larger than the locker allows', () => {
    // Sent straight down the socket rather than through `NetClient.wear`, and
    // that is the whole point of the test. The client clamps too, so a polite
    // guest can never produce this — and a test that goes through the polite
    // path proves the client's clamp twice and the host's not at all.
    //
    // The thing being defended against is a modified client, and what it buys
    // is not cosmetic: a head four times the size is a bigger target and is
    // visible over the wall its owner is hiding behind, and the cost is paid
    // entirely by the people who did not choose it.
    const r = dressers();
    r.aSocket.send({
      t: 'wear',
      a: { ...outfit(1), headSize: 900, build: -900 } as Appearance,
    });
    r.tick(4);

    // Read off the *host*, which is the machine under test. Reading it off the
    // other guest proves nothing: the receiving client clamps on arrival too,
    // so it would pass with the host's own clamp deleted — which is exactly
    // what happened when this was written the obvious way.
    const asHostSeesIt = r.got.host.at(-1)!.a!;
    expect(asHostSeesIt.skin).toBe(1);
    expect(headScaleOf(asHostSeesIt)).toBeLessThanOrEqual(HEAD_MAX);
    expect(buildOf(asHostSeesIt)).toBeGreaterThanOrEqual(BUILD_MIN);

    // And the far guest, which is the belt to that pair of braces.
    const asPeerSeesIt = r.got.b.at(-1)!.a!;
    expect(headScaleOf(asPeerSeesIt)).toBeLessThanOrEqual(HEAD_MAX);
    expect(buildOf(asPeerSeesIt)).toBeGreaterThanOrEqual(BUILD_MIN);
  });

  it('stamps the wearer itself rather than believing the message', () => {
    // There is no `from` on a `wear`, for the same reason chat and voice have
    // none: a client that could name its own sender could dress somebody else.
    const r = dressers();
    r.a.wear(outfit(4));
    r.tick(4);
    for (const told of r.got.b) expect(told.id).not.toBe(r.bId);
    expect(r.got.b.some((w) => w.id === r.aId)).toBe(true);
  });

  it('tells a newcomer what the people already here are wearing', () => {
    // The half that is easy to forget, and it only shows up with three people
    // in the yard: without it a locker works perfectly for whoever hosted, and
    // everybody who joined after you is a stranger in default clothes.
    const got: Array<{ id: number; a: Appearance | null }> = [];
    const host = new NetHost(makeMachine());
    const pa = loopbackPair();
    const early = new NetClient(makeMachine(), pa.client, 'ali');
    host.accept(pa.host);
    const run = (n: number, extra?: NetClient): void => {
      for (let i = 0; i < n; i++) {
        host.beforeTick();
        early.beforeTick();
        extra?.beforeTick();
        host.afterTick(DT);
        early.afterTick(DT, makeCommand(sharedTick));
        extra?.afterTick(DT, makeCommand(sharedTick++));
      }
    };
    run(4);
    early.wear(outfit(2));
    run(4);

    const late = makeMachine();
    late.wearing = (id, appearance) => got.push({ id, a: appearance });
    const pb = loopbackPair();
    const guest = new NetClient(late, pb.client, 'bo');
    host.accept(pb.host);
    run(6, guest);

    expect(
      got.some((w) => w.id === early.status.localId && w.a?.skin === 2),
      'a late arrival should be told what everybody already here is wearing',
    ).toBe(true);
  });

  it('tells everybody to forget an outfit when its owner leaves', () => {
    // Null rather than a default, which is a distinction the renderer already
    // draws: an id nobody has dressed falls back to the seeded look, and that
    // is exactly what somebody who has gone should cost.
    const r = dressers();
    r.a.wear(outfit(4));
    r.tick(4);
    r.a.close();
    r.tick(6);
    expect(r.got.b.some((w) => w.id === r.aId && w.a === null)).toBe(true);
  });

  it('forgets somebody who left, so their outfit is not handed to the next guest', () => {
    const r = dressers();
    r.a.wear(outfit(4));
    r.tick(4);
    r.a.close();
    r.tick(4);

    const got: Array<{ id: number; a: Appearance | null }> = [];
    const late = makeMachine();
    late.wearing = (id, appearance) => got.push({ id, a: appearance });
    const pc = loopbackPair();
    const guest = new NetClient(late, pc.client, 'cai');
    r.host.accept(pc.host);
    for (let i = 0; i < 6; i++) {
      r.host.beforeTick();
      guest.beforeTick();
      r.host.afterTick(DT);
      guest.afterTick(DT, makeCommand(sharedTick++));
    }
    expect(got.some((w) => w.id === r.aId)).toBe(false);
  });
});

describe('getting two browsers introduced for voice', () => {
  /**
   * A host, two guests, and every voice signal each machine was handed.
   *
   * Deliberately a second room helper rather than a parameter on the first: what
   * the chat room records is `heard`, which is presentation, and what this
   * records is `signalled`, which is not. Folding them together would be the
   * first step toward the shell treating a WebRTC offer as something to draw.
   */
  function callers(): {
    host: NetHost; a: NetClient; b: NetClient;
    /**
     * The ids the host actually handed out, read back rather than assumed.
     *
     * Assumed first, and it was wrong: ids go in the order the *hellos* land,
     * not the order the transports were accepted, so `a` came out as 2. Every
     * assertion below then addressed a signal to the machine that sent it and
     * was correctly dropped — eight tests failing for one wrong constant, which
     * is what hardcoding a value the system chooses buys you.
     */
    aId: number; bId: number;
    got: Record<string, Array<{ from: number; s: RtcSignal }>>;
    tick(n: number): void;
  } {
    const got: Record<string, Array<{ from: number; s: RtcSignal }>> = {
      host: [], a: [], b: [],
    };
    const make = (key: string): Machine => {
      const m = makeMachine();
      m.signalled = (from, s) => got[key]!.push({ from, s });
      return m;
    };
    const host = new NetHost(make('host'));
    const pa = loopbackPair();
    const pb = loopbackPair();
    const a = new NetClient(make('a'), pa.client, 'ali');
    const b = new NetClient(make('b'), pb.client, 'bo');
    host.accept(pa.host);
    host.accept(pb.host);
    const tick = (n: number): void => {
      for (let i = 0; i < n; i++) {
        host.beforeTick();
        a.beforeTick();
        b.beforeTick();
        host.afterTick(DT);
        a.afterTick(DT, makeCommand(sharedTick));
        b.afterTick(DT, makeCommand(sharedTick++));
      }
    };
    tick(4);
    return { host, a, b, aId: a.status.localId, bId: b.status.localId, got, tick };
  }

  const offer = (sdp: string): RtcSignal => ({ k: 'offer', sdp });

  it('carries an offer from one guest to the other', () => {
    // The whole reason signalling goes through the host: guest A and guest B
    // have no route to each other until this handshake gives them one.
    const r = callers();
    r.a.signal(r.bId, offer('from-ali'));
    r.tick(4);
    expect(r.got.b).toHaveLength(1);
    expect(r.got.b[0]!.s).toEqual(offer('from-ali'));
  });

  it('stamps the sender itself rather than believing the message', () => {
    // There is no `from` on the wire for exactly this reason. If a client could
    // name its own sender it could open a call in somebody else's name, which
    // is the same rule that stops it naming its own chat recipients.
    const r = callers();
    r.a.signal(r.bId, offer('x'));
    r.tick(4);
    expect(r.got.b[0]!.from).toBe(r.aId);
  });

  it('does not send it to anybody else', () => {
    const r = callers();
    r.a.signal(r.bId, offer('x'));
    r.tick(4);
    expect(r.got.a).toHaveLength(0);
    expect(r.got.host).toHaveLength(0);
  });

  it('delivers a signal addressed to the host to the host', () => {
    // The host is a player with a voice, not a switchboard. Addressed to id 0,
    // it stops there instead of being forwarded to nobody.
    const r = callers();
    r.a.signal(LOCAL_ACTOR_ID, offer('hello-host'));
    r.tick(4);
    expect(r.got.host).toHaveLength(1);
    expect(r.got.host[0]!).toEqual({ from: r.aId, s: offer('hello-host') });
    expect(r.got.b).toHaveLength(0);
  });

  it('lets the host place a call of its own', () => {
    const r = callers();
    r.host.signal(r.bId, offer('from-host'));
    r.tick(4);
    expect(r.got.b).toHaveLength(1);
    expect(r.got.b[0]!).toEqual({ from: LOCAL_ACTOR_ID, s: offer('from-host') });
  });

  it('drops a signal addressed to somebody who is not here', () => {
    // Routine rather than exceptional: a peer can leave in the gap between
    // another peer deciding to dial them and the offer arriving.
    const r = callers();
    expect(() => {
      r.a.signal(99, offer('x'));
      r.tick(4);
    }).not.toThrow();
    expect(r.got.a).toHaveLength(0);
    expect(r.got.b).toHaveLength(0);
    expect(r.got.host).toHaveLength(0);
  });

  it('drops a signal somebody addressed to themselves', () => {
    const r = callers();
    r.a.signal(r.aId, offer('x'));
    r.tick(4);
    expect(r.got.a).toHaveLength(0);
  });

  it('carries candidates and the end-of-candidates marker alike', () => {
    // The null candidate is how a browser says "that is everywhere I can be
    // reached". Dropped, the far end waits out its own timeout instead.
    const r = callers();
    r.a.signal(r.bId, { k: 'ice', c: 'candidate:1 1 udp', mid: '0' });
    r.a.signal(r.bId, { k: 'ice', c: null, mid: null });
    r.tick(4);
    expect(r.got.b.map((g) => g.s)).toEqual([
      { k: 'ice', c: 'candidate:1 1 udp', mid: '0' },
      { k: 'ice', c: null, mid: null },
    ]);
  });

  it('lets a whole ICE burst through', () => {
    const r = callers();
    for (let i = 0; i < 20; i++) r.a.signal(r.bId, { k: 'ice', c: `c${i}`, mid: '0' });
    r.tick(4);
    expect(r.got.b).toHaveLength(20);
  });

  it('stops one guest flooding the yard through the host', () => {
    // Without this the host is an amplifier: one guest pushes arbitrary bytes
    // at every other guest at whatever rate their connection allows.
    const r = callers();
    for (let i = 0; i < 400; i++) r.a.signal(r.bId, { k: 'ice', c: `c${i}`, mid: '0' });
    r.tick(4);
    expect(r.got.b.length).toBeGreaterThan(0);
    expect(r.got.b.length).toBeLessThan(400);
  });

  it('does not let one guest flooding stop another connecting', () => {
    // The limiter must not itself become the denial of service.
    const r = callers();
    for (let i = 0; i < 400; i++) r.a.signal(r.bId, { k: 'ice', c: `c${i}`, mid: '0' });
    r.tick(4);
    const before = r.got.a.length;
    r.b.signal(r.aId, offer('bo-calling'));
    r.tick(4);
    expect(r.got.a.length).toBe(before + 1);
  });
});
