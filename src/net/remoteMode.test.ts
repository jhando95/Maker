/**
 * A round, played by more than one machine.
 *
 * The claim under test is not "the message arrives". It is that a guest is *in*
 * the round — that the phase, the clock, the score, the objectives, the wood and
 * the result all come from the one machine running the rules, and that the guest
 * never runs a rule of its own. The last part is the one worth guarding: a guest
 * that quietly simulated would look fine for about ten seconds and then be
 * playing a different game with the same name.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CollisionWorld } from '../physics/collisionWorld.ts';
import { ProjectileSystem } from '../game/projectiles.ts';
import { PartRenderer } from '../render/partRenderer.ts';
import { BuildSystem } from '../build/buildSystem.ts';
import { CharacterController } from '../player/controller.ts';
import { ActorRoster, LOCAL_ACTOR_ID, type Actor } from '../game/actor.ts';
import { makeCommand, commandToIntent } from '../core/command.ts';
import { DT } from '../physics/constants.ts';
import { Lumber } from '../build/lumber.ts';
import { loopbackPair } from './transport.ts';
import { NetHost, NetClient, SNAPSHOT_HZ, type SessionContext } from './session.ts';
import { RemoteMode } from './remoteMode.ts';
import { packRound } from './roundPacket.ts';
import type { PackedRound } from './protocol.ts';
import type {
  GameMode, Marker, ModeHud, ModeSelfHud, ModeSummary,
} from '../game/gameMode.ts';
import type { Bot } from '../game/bot.ts';

/** A mode with no rules, whose published state the test drives by hand. */
class StubMode implements GameMode {
  id = 'stub';
  name = 'Stub Round';
  finished = false;
  won = false;
  readonly bots: readonly Bot[] = [];
  buildingAllowed = true;
  playerSpeedScale = 1;
  lumber: Lumber | undefined = new Lumber(50);
  phase = 'BUILD';
  timer: number | null = 42;
  message: string | null = 'go';
  score: { left: number; right: number } | null = { left: 1, right: 2 };
  markerList: Marker[] = [];
  wet = new Map<number, number>();
  /** Counts ticks, so a guest that ran the rules would be caught by the number. */
  ticks = 0;

  start(): void {}
  fixedUpdate(): void { this.ticks++; }
  end(): void {}
  markers(): readonly Marker[] { return this.markerList; }
  summary(): ModeSummary {
    return { headline: 'The fort held!', lines: [{ label: 'raids', value: '3' }] };
  }

  wetnessOf(id: number): number { return this.wet.get(id) ?? 0; }

  /**
   * Deliberately different per person.
   *
   * Every number here is keyed on the id, so a guest that was shown the host's
   * HUD would still get plausible-looking values — and fail, which is the whole
   * point. A stub that answered the same for everybody could not tell the two
   * apart, and the bug being guarded against is precisely showing one person
   * somebody else's meters.
   */
  selfHud(id: number): ModeSelfHud {
    return {
      charge: 0.1 * (id + 1),
      wetness: 0.2 * (id + 1),
      ammo: { current: id + 1, max: 6, gauge: id === 0 },
      refill: 0.05 * (id + 1),
    };
  }

  streamFor(id: number): { x: number; y: number; z: number } | null {
    return id === 0 ? null : { x: id, y: 2, z: -3 };
  }

  speedScaleFor(id: number): number {
    return this.soaked.has(id) ? 0 : 1;
  }

  /** Whoever a test has decided is currently sitting one out. */
  readonly soaked = new Set<number>();

  hud(): ModeHud {
    return {
      phase: this.phase,
      timer: this.timer,
      primary: { label: 'supplies', value: '7' },
      secondary: null,
      score: this.score,
      message: this.message,
      charge: 0.5,
      wetness: 0.9,
      ammo: { current: 3, max: 6 },
      refill: 0.25,
      lumber: this.lumber?.available ?? null,
    };
  }
}

interface Machine extends SessionContext {
  local: CharacterController;
  /** What this machine believes is being played. */
  mode?(): GameMode | null;
}

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

/**
 * A host and a guest, wired together, with the guest wearing a `RemoteMode`.
 *
 * The guest's side is assembled exactly the way `main.ts` assembles it — the
 * round packet goes through `setRound`, which builds or updates the remote mode
 * — so this exercises the seam rather than a rehearsal of it.
 */
function pair() {
  const hostCtx = makeMachine();
  const guestCtx = makeMachine();
  const stub = new StubMode();
  hostCtx.mode = () => (running ? stub : null);
  let running = true;

  const pipe = loopbackPair();
  const guest = new NetClient(guestCtx, pipe.client, 'guest');
  let remote: RemoteMode | null = null;
  guestCtx.setRound = (round: PackedRound | null) => {
    if (round === null || round.id === null) { remote = null; return; }
    if (remote === null) {
      remote = new RemoteMode((id) => guest.wetnessOf(id), () => guest.mine);
    }
    remote.apply(round);
  };

  const host = new NetHost(hostCtx);
  host.accept(pipe.host);

  let tick = 0;
  const step = (ticks: number, fire = false): void => {
    for (let i = 0; i < ticks; i++) {
      const command = makeCommand(tick++);
      host.beforeTick();
      guest.beforeTick();
      guestCtx.actors.local.controller.step(DT, commandToIntent(command));
      // The host runs its own rules every tick, as the shell does.
      if (running) stub.fixedUpdate();
      host.afterTick(DT);
      guest.afterTick(DT, command);
      void fire;
    }
  };

  return {
    hostCtx, guestCtx, host, guest, stub, step,
    get remote(): RemoteMode | null { return remote; },
    stop(): void { running = false; },
  };
}

/** Long enough for at least one snapshot to have been published. */
const SNAPSHOT_TICKS = Math.ceil(60 / SNAPSHOT_HZ) + 2;

describe('packing a round', () => {
  it('says nothing at all when nobody is playing anything', () => {
    expect(packRound(null)).toBeNull();
  });

  it('carries the phase, the clock, the score and the objectives', () => {
    const stub = new StubMode();
    stub.markerList = [
      { kind: 'flag', x: 1, y: 2, z: 3, color: 0x123456, active: true },
      { kind: 'bucket', x: -4, y: 0, z: 5, color: 0x654321, faded: true },
    ];
    const packed = packRound(stub)!;
    expect(packed.phase).toBe('BUILD');
    expect(packed.timer).toBe(42);
    expect(packed.score).toEqual([1, 2]);
    expect(packed.markers).toHaveLength(2);
    expect(packed.wood).toBe(50);
  });

  it('leaves out everything that is true of one player rather than the round', () => {
    // The stub reports a charge, a wetness, a tank and a refill channel, and
    // none of them belong to the round. A guest shown the host's tank is being
    // shown somebody else's tank, which is worse than being shown none.
    const packed = packRound(new StubMode())!;
    expect(Object.keys(packed)).not.toContain('wetness');
    expect(Object.keys(packed)).not.toContain('ammo');
    expect(Object.keys(packed)).not.toContain('charge');
    expect(Object.keys(packed)).not.toContain('refill');
  });

  it('reports the outcome the moment it is decided', () => {
    // Not when the shell gets round to showing it. The four-second pause before
    // the result screen is presentation, and each machine runs its own; sending
    // the outcome immediately means a guest whose connection hiccups over those
    // four seconds still learns how the round ended.
    const stub = new StubMode();
    expect(packRound(stub)!.over).toBeNull();
    stub.finished = true;
    stub.won = true;
    const over = packRound(stub)!.over!;
    expect(over.won).toBe(true);
    expect(over.headline).toBe('The fort held!');
    expect(over.lines).toEqual([['raids', '3']]);
  });

  it('says the pile is unmetered rather than sending a number for infinity', () => {
    const stub = new StubMode();
    stub.lumber = new Lumber(Infinity);
    expect(packRound(stub)!.wood).toBeNull();
  });
});

describe('a guest in somebody else\'s round', () => {
  let net: ReturnType<typeof pair>;
  beforeEach(() => { net = pair(); });

  it('is in the round without ever having started one', () => {
    net.step(SNAPSHOT_TICKS);
    expect(net.remote).not.toBeNull();
    expect(net.remote!.id).toBe('stub');
    expect(net.remote!.name).toBe('Stub Round');
  });

  it('sees the same phase, clock and score as the host', () => {
    net.stub.phase = 'RAID 2';
    // A tenth of a second, which is the quantisation the packet uses and the
    // resolution the HUD draws — sending more digits would be bytes spent on a
    // number nobody can read off a clock.
    net.stub.timer = 17.2;
    net.stub.score = { left: 3, right: 1 };
    net.step(SNAPSHOT_TICKS);
    const hud = net.remote!.hud();
    expect(hud.phase).toBe('RAID 2');
    expect(hud.timer).toBeCloseTo(17.2, 5);
    expect(hud.score).toEqual({ left: 3, right: 1 });
  });

  it('never runs the rules itself', () => {
    // The whole design in one number. `RemoteMode.fixedUpdate` is empty and the
    // guest calls it every tick like any other mode; if it ever stops being
    // empty, this is what says so.
    net.step(SNAPSHOT_TICKS);
    const before = net.stub.ticks;
    for (let i = 0; i < 30; i++) net.remote!.fixedUpdate();
    expect(net.stub.ticks).toBe(before);
  });

  it('draws the objectives the host published, not ones it worked out', () => {
    net.stub.markerList = [{ kind: 'flag', x: 5, y: 1, z: -6, color: 0x7a3fc8, active: true }];
    net.step(SNAPSHOT_TICKS);
    const markers = net.remote!.markers();
    expect(markers).toHaveLength(1);
    expect(markers[0]!.kind).toBe('flag');
    expect(markers[0]!.x).toBeCloseTo(5, 2);
    expect(markers[0]!.z).toBeCloseTo(-6, 2);
    expect(markers[0]!.active).toBe(true);

    // And follows one that moves, which is the case a guest computing its own
    // from the map constants would get wrong.
    net.stub.markerList = [{ kind: 'flag', x: -9, y: 1, z: 2, color: 0x7a3fc8 }];
    net.step(SNAPSHOT_TICKS);
    expect(net.remote!.markers()[0]!.x).toBeCloseTo(-9, 2);
  });

  it('is held to the same build gate', () => {
    net.step(SNAPSHOT_TICKS);
    expect(net.remote!.buildingAllowed).toBe(true);
    net.stub.buildingAllowed = false;
    net.step(SNAPSHOT_TICKS);
    expect(net.remote!.buildingAllowed).toBe(false);
  });

  it('learns how the round ended', () => {
    net.stub.finished = true;
    net.stub.won = false;
    net.step(SNAPSHOT_TICKS);
    expect(net.remote!.finished).toBe(true);
    expect(net.remote!.won).toBe(false);
    expect(net.remote!.summary().headline).toBe('The fort held!');
    expect(net.remote!.summary().lines).toEqual([{ label: 'raids', value: '3' }]);
  });

  it('leaves the round when the host stops playing one', () => {
    net.step(SNAPSHOT_TICKS);
    expect(net.remote).not.toBeNull();
    net.stop();
    net.step(SNAPSHOT_TICKS);
    expect(net.remote).toBeNull();
  });

  it('shows the guest their own meters, not the host\'s', () => {
    // These four fields were null, and the reason was sound: a needle
    // describing somebody else is not a meter. The fix was never to mirror the
    // host's — it was to ask the host the question per peer.
    //
    // The stub answers with values keyed on the actor id, so being shown the
    // host's numbers fails here rather than looking plausible.
    net.step(SNAPSHOT_TICKS);
    const id = net.guest.status.localId;
    expect(id, 'the guest never got an id, so this proves nothing').toBeGreaterThan(0);

    const hud = net.remote!.hud();
    expect(hud.charge).toBeCloseTo(0.1 * (id + 1), 5);
    expect(hud.wetness).toBeCloseTo(0.2 * (id + 1), 5);
    expect(hud.ammo).toEqual({ current: id + 1, max: 6, gauge: false });
    expect(hud.refill).toBeCloseTo(0.05 * (id + 1), 5);
  });

  it('draws the guest their own stream, computed by the host', () => {
    // A guest runs no stream — the authority does — so without this they hold
    // the trigger, watch the tank empty, and see no water.
    net.step(SNAPSHOT_TICKS);
    const id = net.guest.status.localId;
    expect(net.remote!.stream).toEqual({ x: id, y: 2, z: -3 });
  });

  it('says when the guest is out of it', () => {
    // Published so the HUD can say so, not so the client can act on it: the
    // host has already applied the penalty to the body it stepped.
    net.step(SNAPSHOT_TICKS);
    expect(net.remote!.playerIsOut).toBe(false);
    net.stub.soaked.add(net.guest.status.localId);
    net.step(SNAPSHOT_TICKS);
    expect(net.remote!.playerIsOut).toBe(true);
  });

  it('goes back to showing nothing when the mode has nothing to say', () => {
    // The old behaviour, kept as the honest fallback rather than deleted. A
    // mode with no tank and no meter reports none, and four nulls is the right
    // answer to a question with no answer.
    const bare = new RemoteMode(() => 0);
    const hud = bare.hud();
    expect(hud.charge).toBeNull();
    expect(hud.wetness).toBeNull();
    expect(hud.ammo).toBeNull();
    expect(hud.refill).toBeNull();
    expect(bare.stream).toBeNull();
  });

  it('does not slow its own body down twice', () => {
    // The host already runs the guest's body through the mode's speed rule. A
    // remote mode that also scaled would apply it again on the predicting
    // machine and guarantee a correction every snapshot for as long as anybody
    // was wet.
    net.step(SNAPSHOT_TICKS);
    expect(net.remote!.playerSpeedScale).toBe(1);
  });
});

describe('how wet everybody is', () => {
  it('reaches the machine that has to paint the shirts', () => {
    // Not a detail. Colour washing out is how you pick who to throw at, so a
    // guest without it is playing the mode with its one decision removed.
    const net = pair();
    net.stub.wet.set(0, 0.75);
    net.step(SNAPSHOT_TICKS);
    expect(net.guest.wetnessOf(0)).toBeCloseTo(0.75, 2);
    expect(net.remote!.wetnessOf(0)).toBeCloseTo(0.75, 2);
  });

  it('reads zero for somebody nobody has mentioned', () => {
    const net = pair();
    net.step(SNAPSHOT_TICKS);
    expect(net.guest.wetnessOf(999)).toBe(0);
  });
});

describe('the shared pile', () => {
  it('is the same pile on both machines', () => {
    const net = pair();
    net.step(SNAPSHOT_TICKS);
    expect(net.remote!.lumber.available).toBe(50);
    net.stub.lumber!.spend(20);
    net.step(SNAPSHOT_TICKS);
    expect(net.remote!.lumber.available).toBe(30);
  });

  it('is charged when a guest builds, not only when the host does', () => {
    // This is the bug the shared pile makes possible and easy to miss. A guest's
    // request went straight to `applyPlaceIfClear`, which validates and does not
    // charge — so in free build nothing showed, and in a round two people drew
    // from a budget only one of them was spending.
    const net = pair();
    const pile = net.stub.lumber!;
    net.hostCtx.build.setLumber(pile);
    net.step(SNAPSHOT_TICKS);

    const before = pile.available;
    net.guest.requestPlacement({ kind: 0, colorway: 0, x: 4, y: 0.5, z: 4, qx: 0, qy: 0, qz: 0, qw: 1 });
    net.step(SNAPSHOT_TICKS);
    expect(pile.available).toBeLessThan(before);
    expect(net.hostCtx.build.placedCount).toBe(1);
  });

  it('refuses a guest\'s placement once the yard is out of wood', () => {
    const net = pair();
    const pile = net.stub.lumber!;
    net.hostCtx.build.setLumber(pile);
    pile.set(0);
    net.step(SNAPSHOT_TICKS);

    net.guest.requestPlacement({ kind: 0, colorway: 0, x: 4, y: 0.5, z: 4, qx: 0, qy: 0, qz: 0, qw: 1 });
    net.step(SNAPSHOT_TICKS);
    expect(net.hostCtx.build.placedCount).toBe(0);
  });
});
