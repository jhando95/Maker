/**
 * Two browsers, one lawn.
 *
 * This is the piece the whole project has been building toward, and it is
 * deliberately small — because the four changes before it did the work. The
 * character controller already took a `MoveIntent`; commands already existed as
 * serializable per-tick data; the roster already treated the player as one actor
 * among several; placements were already a plain record that was both the save
 * format and the wire format. What is left is the plumbing between them.
 *
 * ## How a tick works
 *
 * A session hangs off the existing fixed timestep with two calls. `beforeTick`
 * drains whatever arrived and applies it; `afterTick` publishes what just
 * happened. Nothing here runs on a render frame, and nothing here can be poked
 * at in the middle of a step — a socket that could deliver mid-tick is a socket
 * that can split one tick's inputs across two.
 *
 * ## What each side does
 *
 * **The host** is the authority. It runs everyone: its own player from the
 * keyboard, each guest from the last command they sent. It decides whether a
 * placement is legal, applies it, and tells everybody. Its world is *the* world.
 *
 * **A guest** predicts. It steps its own character from its own input
 * immediately, because waiting a round trip to move is the difference between a
 * game and a remote desktop. When a snapshot arrives saying where it really was
 * at tick T, it puts the body back there and replays every command since — so a
 * correction moves the character by the size of the error, not by the size of
 * the latency. Everyone else is interpolated between snapshots and never
 * simulated, because two machines running the same person is exactly the
 * disagreement this design exists to avoid.
 *
 * ## Why guests do not simulate anyone else
 *
 * It would look smoother between packets. It would also mean a guest's idea of
 * where you are drifts from the host's for as long as the packet is late, and
 * then snaps — and the drift is largest exactly when the network is worst, which
 * is when you least want your aim to be lying to you. Interpolating a hundred
 * milliseconds behind is honest: it is always showing something that really
 * happened.
 */

import { CharacterController, type ControllerState } from '../player/controller.ts';
import { commandToIntent, packCommand, unpackCommand, type Command } from '../core/command.ts';
import type { CollisionWorld } from '../physics/collisionWorld.ts';
import type { BuildSystem, PlacementRecord } from '../build/buildSystem.ts';
import { ActorRoster, opposing, type Actor, type Team } from '../game/actor.ts';
import {
  ACTOR_FLAG, PROTOCOL_VERSION, decode, indexToTeam, teamToIndex,
  type HostMessage, type PackedActor, type PackedRound,
} from './protocol.ts';
import type { GameMode } from '../game/gameMode.ts';
import { packRound } from './roundPacket.ts';
import type { Transport } from './transport.ts';

/**
 * How often the host publishes where everybody is.
 *
 * Twenty a second rather than sixty. Snapshots are the bulk of the traffic and
 * the client interpolates between them anyway, so tripling the rate would triple
 * the bandwidth to remove a delay the interpolation buffer reintroduces on
 * purpose.
 */
export const SNAPSHOT_HZ = 20;

/**
 * How far behind live a guest draws other people.
 *
 * Just over one snapshot interval. Less and a single late packet leaves nothing
 * to interpolate toward, so remote players stutter; much more and you are aiming
 * at where somebody used to be. This is the standard trade and it is a trade —
 * there is no setting of it that is free.
 */
export const INTERP_DELAY = 0.12;

/**
 * How far wrong a prediction has to be before it is worth correcting.
 *
 * Below this the client keeps its own answer. Snapping to the host on every
 * snapshot would jitter constantly on nothing but floating-point noise and the
 * fact that the host ran the tick a fraction of a second earlier — and a
 * character that twitches while standing still reads as a broken game far more
 * than a two-centimetre error ever could.
 */
export const RECONCILE_THRESHOLD = 0.06;

/** Guests, so a stray peer cannot exhaust memory on the host. */
export const MAX_PEERS = 7;

/**
 * How long a new connection has to introduce itself. Five seconds.
 *
 * Long enough that no real client misses it and short enough that something
 * which opened a socket and then said nothing cannot sit in the queue forever.
 */
export const HELLO_GRACE_TICKS = 300;

/** Unacknowledged commands a guest keeps for replay. Two seconds' worth. */
const COMMAND_HISTORY = 120;

/** IDs for people who are not the local player. Never zero — that is always you. */
const FIRST_REMOTE_ID = 1;

export type Role = 'host' | 'guest';

/** What the shell needs to show about the connection. */
export interface NetStatus {
  role: Role;
  connected: boolean;
  /** How many other people are in the world. */
  peers: number;
  /** Your own actor id, which is 0 on the host and assigned on a guest. */
  localId: number;
  message: string | null;
}

/** Everything a session needs from the game it is attached to. */
export interface SessionContext {
  world: CollisionWorld;
  build: BuildSystem;
  actors: ActorRoster;
  local: CharacterController;
  /** Tell the renderer the world changed, so static shadows refresh. */
  worldChanged(): void;
  /**
   * Where somebody on this side starts.
   *
   * Asked for rather than assumed, because the session has no business knowing
   * about this map — and because the obvious default is wrong in a way that is
   * hard to see: a guest spawned at the origin appears in the middle of the
   * house, wedged in the geometry, unable to move. Their commands arrive, the
   * host runs them, and nothing happens, which reads as a broken network rather
   * than a broken spawn.
   */
  spawnFor(team: Team): { x: number; y: number; z: number };
  /**
   * What the host is running, or null for free build. Never called on a guest.
   *
   * A getter rather than a field the shell writes on every round change, because
   * a mode is started and stopped from four places — the menu, a restart, a quit
   * to title, the debug API — and any one of them forgetting to tell the session
   * would leave guests playing a round that had ended.
   */
  mode?(): GameMode | null;
  /**
   * The host's round, as it stands. Only ever called on a guest.
   *
   * Handed out rather than applied here, because what a guest does with it is a
   * question about the shell — which mode object is live, whether the result
   * screen is up — and the session has no business answering that.
   */
  setRound?(round: PackedRound | null): void;
}

/** One snapshot of one actor, kept for interpolation. */
interface Sample {
  time: number;
  x: number; y: number; z: number;
  vx: number; vz: number;
  yaw: number;
  onGround: boolean;
}

/**
 * A guest the host is running.
 *
 * The command is stored rather than applied on arrival: it belongs to a tick,
 * and applying it the instant a packet lands would step that guest at whatever
 * rate their packets happen to arrive.
 */
interface Peer {
  id: number;
  transport: Transport;
  actor: Actor;
  latest: Command | null;
  /** The newest command tick actually run, echoed back so they can reconcile. */
  ack: number;
}

function makeRemoteActor(
  id: number, team: Team, controller: CharacterController, headingOf: () => number,
): Actor {
  return {
    id,
    kind: 'remote',
    team,
    controller,
    get heading(): number {
      return headingOf();
    },
  };
}

/**
 * The authority.
 *
 * Owns nobody's input but its own, and everybody's position.
 */
export class NetHost {
  readonly role: Role = 'host';
  private readonly peers = new Map<number, Peer>();
  private readonly headings = new Map<number, number>();
  private nextId = FIRST_REMOTE_ID;
  private tick = 0;
  private sinceSnapshot = 0;
  private message: string | null = null;

  constructor(private readonly ctx: SessionContext) {}

  /**
   * Take on a new connection.
   *
   * The transport arrives already open; whatever produced it — a relay socket, a
   * loopback pair in a test — is not this class's business.
   */
  accept(transport: Transport): void {
    this.pending.push({ transport, waited: 0, heard: [] });
  }

  /**
   * Connections that have not introduced themselves yet.
   *
   * They are waited on rather than required to have spoken already. The first
   * version assumed the hello had arrived by the time a transport reached the
   * host — true of the relay, which hands one over on its first message, and an
   * invariant held by exactly one caller. Anything else got "expected a hello"
   * and a closed socket on the very next tick.
   *
   * That is a race, not a rule, and it behaved like one: the scenario passed on
   * a fast machine and failed on CI, because adding one round trip between
   * opening the pipe and sending the hello was enough to let a tick land in the
   * gap. A real network has that gap by definition.
   */
  private readonly pending: Array<{
    transport: Transport;
    waited: number;
    heard: Array<ReturnType<typeof decode>>;
  }> = [];

  get status(): NetStatus {
    return {
      role: 'host',
      connected: true,
      peers: this.peers.size,
      localId: this.ctx.actors.local.id,
      message: this.message,
    };
  }

  /** Drain the wire and apply what arrived. Runs at the top of a tick. */
  beforeTick(): void {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const waiting = this.pending[i]!;
      if (!waiting.transport.open) {
        this.pending.splice(i, 1);
        continue;
      }
      // Whatever arrived, kept — a `cmd` can beat a `hello` through a relay,
      // and one drain that threw the queue away would lose it.
      waiting.heard.push(...waiting.transport.drain());
      const hello = waiting.heard.find((m) => m !== null && m.t === 'hello');
      if (hello !== undefined && hello !== null && hello.t === 'hello') {
        this.pending.splice(i, 1);
        this.greet(waiting.transport, hello);
        continue;
      }
      if (++waiting.waited > HELLO_GRACE_TICKS) {
        this.pending.splice(i, 1);
        waiting.transport.send({ t: 'refused', reason: 'no hello' });
        waiting.transport.close();
      }
    }

    for (const peer of [...this.peers.values()]) {
      if (!peer.transport.open) {
        this.drop(peer.id);
        continue;
      }
      for (const message of peer.transport.drain()) {
        this.handle(peer, message);
      }
    }
  }

  private greet(transport: Transport, first: { version: number; name: string }): void {
    if (first.version !== PROTOCOL_VERSION) {
      transport.send({
        t: 'refused',
        reason: `this game speaks version ${PROTOCOL_VERSION}, you speak ${first.version}`,
      });
      transport.close();
      return;
    }
    if (this.peers.size >= MAX_PEERS) {
      transport.send({ t: 'refused', reason: 'the yard is full' });
      transport.close();
      return;
    }

    const id = this.nextId++;
    // Alternating sides rather than filling one: a lawn where everybody is on
    // your team is not a party game.
    const team: Team = this.peers.size % 2 === 0
      ? opposing(this.ctx.actors.local.team)
      : this.ctx.actors.local.team;

    const where = this.ctx.spawnFor(team);
    const controller = new CharacterController(this.ctx.world, where.x, where.y, where.z);
    const actor = makeRemoteActor(id, team, controller, () => this.headings.get(id) ?? 0);
    this.peers.set(id, { id, transport, actor, latest: null, ack: -1 });
    this.ctx.actors.addRemote(actor);

    transport.send({
      t: 'welcome',
      id,
      team,
      tick: this.tick,
      // The world as it stands. Somebody joining halfway through has to see what
      // everybody built before they arrived, or they are playing a different map.
      parts: this.ctx.build.serializeWithIds(),
    });
    this.message = `${first.name} joined`;
  }

  private handle(peer: Peer, message: ReturnType<typeof decode>): void {
    if (message === null) return;
    switch (message.t) {
      case 'cmd': {
        const command = unpackCommand(message.c);
        // Newest wins. An old command arriving late is input for a tick that has
        // already happened, and running it would rewind that player.
        if (peer.latest === null || command.tick > peer.latest.tick) peer.latest = command;
        break;
      }
      case 'build': {
        // The host decides. A guest asks; it does not place.
        //
        // Paid for out of the same pile the host builds from. This went through
        // `applyPlaceIfClear` directly at first, which is the natural thing to
        // write and quietly means guests build for free: in free build the pile
        // is infinite so nothing shows, and in a mode two people share a budget
        // that only one of them is spending. A shared pile has to be shared in
        // both directions or it is not a budget.
        if (!this.ctx.build.buyPlacement(message.r)) return;
        const id = this.ctx.build.lastPlacedId;
        if (id === null) return;
        this.ctx.worldChanged();
        this.broadcast({ t: 'built', id, r: message.r });
        break;
      }
      case 'unbuild': {
        if (!this.ctx.build.applyRemove(message.p)) return;
        this.ctx.worldChanged();
        this.broadcast({ t: 'unbuilt', p: message.p });
        break;
      }
      default:
        break;
    }
  }

  /**
   * Step every guest, then publish.
   *
   * Guests are stepped here rather than when their command arrives, so everybody
   * in the world advances on the same clock — including anyone whose packets are
   * late, who simply repeats their last input rather than freezing.
   */
  afterTick(dt: number): void {
    this.noticeRoundChange();

    for (const peer of this.peers.values()) {
      const command = peer.latest;
      if (command === null) continue;
      peer.actor.controller.step(dt, commandToIntent(command));
      this.headings.set(peer.id, command.yaw);
      peer.ack = command.tick;
    }

    this.tick++;
    this.sinceSnapshot += dt;
    if (this.sinceSnapshot >= 1 / SNAPSHOT_HZ) {
      this.sinceSnapshot = 0;
      this.publish();
    }
  }

  /**
   * Put everybody on their mark when a new round starts.
   *
   * Noticed rather than announced. A round is started and stopped from the menu,
   * a restart, a quit to title and the debug API, and a session that had to be
   * told by each of them would eventually be told by three of them — leaving one
   * path where guests spend a round standing wherever the last one left them,
   * quite possibly inside the fort they are meant to be attacking.
   *
   * The host's own player is repositioned by the shell, which already does it.
   * This is only for the people the host is running on their behalf.
   */
  private noticeRoundChange(): void {
    const id = this.ctx.mode?.()?.id ?? null;
    if (id === this.roundId) return;
    this.roundId = id;
    if (id === null) return;
    for (const peer of this.peers.values()) {
      const where = this.ctx.spawnFor(peer.actor.team);
      peer.actor.controller.teleport(where.x, where.y, where.z);
    }
  }

  private roundId: string | null = null;

  /** Tell everybody the host built something, so guests see it too. */
  announcePlacement(id: number, record: PlacementRecord): void {
    this.broadcast({ t: 'built', id, r: record });
  }

  announceRemoval(partId: number): void {
    this.broadcast({ t: 'unbuilt', p: partId });
  }

  private publish(): void {
    const mode = this.ctx.mode?.() ?? null;
    const actors: PackedActor[] = [];
    for (const who of this.ctx.actors.all) {
      // Bots are the host's own simulation and are published like anyone else:
      // a guest has to see them, and they are the same shape on the wire.
      actors.push(packActor(who, mode?.wetnessOf?.(who.id) ?? 0));
    }
    const round = packRound(mode);
    // One array, but each peer needs its own ack, so the message is per peer.
    for (const peer of this.peers.values()) {
      peer.transport.send({ t: 'snap', tick: this.tick, ack: peer.ack, actors, round });
    }
  }

  private broadcast(message: HostMessage): void {
    for (const peer of this.peers.values()) peer.transport.send(message);
  }

  private drop(id: number): void {
    const peer = this.peers.get(id);
    if (peer === undefined) return;
    this.peers.delete(id);
    this.headings.delete(id);
    this.ctx.actors.removeRemote(id);
    this.broadcast({ t: 'bye', id });
    this.message = 'somebody left';
  }

  close(): void {
    for (const peer of this.peers.values()) peer.transport.close();
    for (const id of [...this.peers.keys()]) this.ctx.actors.removeRemote(id);
    this.peers.clear();
  }
}

function packActor(who: Actor, wet: number): PackedActor {
  const b = who.controller;
  return [
    who.id,
    teamToIndex(who.team),
    round(b.x), round(b.y), round(b.z),
    round(b.vx), round(b.vy), round(b.vz),
    round(who.heading ?? 0, 1e-3),
    (b.onGround ? ACTOR_FLAG.onGround : 0)
    | (who.alive === false ? 0 : ACTOR_FLAG.alive)
    | (who.stunned === true ? ACTOR_FLAG.stunned : 0),
    round(wet, 1e-2),
  ];
}

/** Quantized on the way out: full float precision is bytes nobody can see. */
function round(v: number, step = 1e-3): number {
  return Math.round(v / step) * step;
}

/**
 * A guest.
 *
 * Predicts its own character and interpolates everybody else.
 */
export class NetClient {
  readonly role: Role = 'guest';
  private localId = -1;
  private connected = false;
  private message: string | null = 'connecting…';

  /**
   * Commands sent but not yet acknowledged, oldest first, each with the state it
   * produced.
   *
   * The state is what makes a correction rare instead of constant. The host is
   * always at least one tick behind — it cannot run a command it has not
   * received — so comparing its answer against where the guest is *now* finds a
   * disagreement every single snapshot, on a perfect connection, at rest. What
   * has to be compared is its answer against what this machine predicted for
   * *that same tick*, which is what this remembers.
   */
  private readonly unacked: { command: Command; state: ControllerState }[] = [];
  /** Where the last snapshot said each remote was, for interpolation. */
  private readonly samples = new Map<number, Sample[]>();
  private readonly remotes = new Map<number, Actor>();
  private readonly headings = new Map<number, number>();
  /** How soaked everybody is, by actor id, for the shirt colours. */
  private readonly wetness = new Map<number, number>();
  /** Seconds since the session started, the clock interpolation runs on. */
  private clock = 0;
  private corrections = 0;

  constructor(
    private readonly ctx: SessionContext,
    private readonly transport: Transport,
    name: string,
  ) {
    transport.send({ t: 'hello', version: PROTOCOL_VERSION, name });
  }

  get status(): NetStatus {
    return {
      role: 'guest',
      connected: this.connected,
      peers: this.remotes.size,
      localId: this.localId,
      message: this.message,
    };
  }

  /** How many times the host has had to correct us. For the debug overlay. */
  get correctionCount(): number {
    return this.corrections;
  }

  /**
   * How soaked somebody is, 0..1, as of the last snapshot.
   *
   * Includes the local player, whose own wetness is the host's business too — a
   * guest that decided for itself how wet it was would disagree with the machine
   * that is actually knocking it out of the fight.
   */
  wetnessOf(actorId: number): number {
    return this.wetness.get(actorId) ?? 0;
  }

  beforeTick(): void {
    if (!this.transport.open && this.connected) {
      this.connected = false;
      this.message = 'lost the connection';
    }
    for (const message of this.transport.drain()) this.handle(message);
  }

  private handle(message: ReturnType<typeof decode>): void {
    if (message === null) return;
    switch (message.t) {
      case 'welcome':
        this.localId = message.id;
        // Stop being id 0: the host already is. Everything pointing at this
        // character holds the controller rather than the actor, so only the name
        // changes.
        this.ctx.actors.identifyLocal(message.id);
        // Stand where this side stands, so a joiner does not spend the first
        // second of the game being corrected across the map.
        {
          const where = this.ctx.spawnFor(message.team);
          this.ctx.actors.local.controller.teleport(where.x, where.y, where.z);
        }
        this.connected = true;
        this.message = null;
        // Adopt the host's world wholesale. Merging would mean deciding which
        // of two disagreeing worlds is right, and the answer is always theirs.
        this.ctx.build.deserialize(message.parts.map(([, record]) => record));
        this.hostIds.clear();
        this.localIds.clear();
        // deserialize replays into an emptied store, so local ids run 0..n-1 in
        // the order the pairs arrived in. Written as an index rather than
        // inferred from the map's size, because those are the same number only
        // by accident and one duplicate host id would silently break the chain.
        message.parts.forEach(([hostId], index) => this.learn(index, hostId));
        this.ctx.worldChanged();
        this.ctx.actors.local.team = message.team;
        break;

      case 'refused':
        this.connected = false;
        this.message = message.reason;
        this.transport.close();
        break;

      case 'snap':
        this.applySnapshot(message.tick, message.ack, message.actors);
        // After the actors, so the shell sees a round whose objectives and
        // people came out of the same instant.
        this.ctx.setRound?.(message.round ?? null);
        break;

      case 'built': {
        if (!this.ctx.build.applyPlaceIfClear(message.r)) break;
        const local = this.ctx.build.lastPlacedId;
        if (local !== null) this.learn(local, message.id);
        this.ctx.worldChanged();
        break;
      }

      case 'unbuilt': {
        const local = this.localIds.get(message.p);
        if (local === undefined) break;
        this.ctx.build.applyRemove(local);
        this.forgetPart(local, message.p);
        this.ctx.worldChanged();
        break;
      }

      case 'bye':
        this.forget(message.id);
        break;

      default:
        break;
    }
  }

  private forget(id: number): void {
    this.remotes.delete(id);
    this.samples.delete(id);
    this.headings.delete(id);
    this.wetness.delete(id);
    this.ctx.actors.removeRemote(id);
  }

  private applySnapshot(tick: number, ack: number, actors: PackedActor[]): void {
    void tick;
    const seen = new Set<number>();

    for (const packed of actors) {
      const [id, team, x, y, z, vx, , vz, yaw, flags, wet] = packed;
      seen.add(id);
      this.wetness.set(id, wet ?? 0);

      if (id === this.localId) {
        // Your own side can change under you — the host assigns it — so it is
        // read here rather than only on the welcome.
        this.ctx.actors.local.team = indexToTeam(team);
        this.reconcile(ack, x, y, z, packed);
        continue;
      }

      let actor = this.remotes.get(id);
      if (actor === undefined) {
        const controller = new CharacterController(this.ctx.world, x, y, z);
        actor = makeRemoteActor(id, indexToTeam(team), controller, () => this.headings.get(id) ?? 0);
        this.remotes.set(id, actor);
        this.ctx.actors.addRemote(actor);
      }
      actor.team = indexToTeam(team);
      this.headings.set(id, yaw);

      const buffer = this.samples.get(id) ?? [];
      buffer.push({
        time: this.clock, x, y, z, vx, vz, yaw,
        onGround: (flags & ACTOR_FLAG.onGround) !== 0,
      });
      // Two either side of the interpolation point is all that is ever read.
      while (buffer.length > 4) buffer.shift();
      this.samples.set(id, buffer);
    }

    // Anyone the host stopped mentioning is gone. A `bye` covers a clean
    // departure; this covers everything else, which on a network is most of them.
    for (const id of [...this.remotes.keys()]) {
      if (!seen.has(id)) this.forget(id);
    }
  }

  /**
   * Compare the host's answer with our own for the same tick, and fix it if they
   * differ.
   *
   * The replay is the whole trick. Without it, a correction would drag the
   * player back by a full round trip every snapshot; with it, the body ends up
   * where the *same inputs* would have put it, so the visible motion is only the
   * size of the actual disagreement.
   */
  private reconcile(ack: number, x: number, y: number, z: number, packed: PackedActor): void {
    const body = this.ctx.actors.local.controller;

    // What we thought had happened by the tick the host has just answered for.
    const at = this.unacked.findIndex((e) => e.command.tick === ack);
    const predicted = at === -1 ? null : this.unacked[at]!.state;

    // Everything up to and including that tick is settled either way.
    const pending = at === -1 ? [...this.unacked] : this.unacked.slice(at + 1);
    this.unacked.length = 0;
    this.unacked.push(...pending);

    // No record of that tick means we have nothing to compare against and
    // nothing to replay — which happens exactly once, on the first snapshot
    // after joining. Taking the host's word for it is the right answer there.
    const error = predicted === null
      ? Math.hypot(body.x - x, body.y - y, body.z - z)
      : Math.hypot(predicted.x - x, predicted.y - y, predicted.z - z);
    if (error < RECONCILE_THRESHOLD) return;

    const wasX = body.x, wasY = body.y, wasZ = body.z;
    this.corrections++;
    body.restore({
      ...body.capture(),
      x, y, z,
      vx: packed[5], vy: packed[6], vz: packed[7],
      onGround: (packed[9] & ACTOR_FLAG.onGround) !== 0,
      prevX: x, prevY: y, prevZ: z,
    });
    // Replay everything the host has not seen yet, at the same timestep it will
    // run them at, and record what each one now produces.
    for (const entry of this.unacked) {
      body.step(FIXED_DT, commandToIntent(entry.command));
      entry.state = body.capture();
    }
    // How far the player actually got moved. This — not how often a correction
    // happens — is what somebody would see, and a replay that works keeps it at
    // roughly nothing even while the host disagrees on every snapshot.
    this.lastCorrection = Math.hypot(body.x - wasX, body.y - wasY, body.z - wasZ);
    this.worstCorrection = Math.max(this.worstCorrection, this.lastCorrection);
  }

  private lastCorrection = 0;
  private worstCorrection = 0;

  /** The furthest a correction has ever visibly moved the player. */
  get worstCorrectionDistance(): number {
    return this.worstCorrection;
  }

  /**
   * Send this tick's input and advance the interpolation clock.
   *
   * The command is kept as well as sent, because it will have to be replayed
   * against whatever the host says next.
   */
  afterTick(dt: number, command: Command): void {
    this.clock += dt;
    if (!this.connected) return;

    // Copied, because the caller reuses one command object every tick and the
    // history has to survive the next one being written into it. The state is
    // captured after the caller has already stepped, so it is what this machine
    // predicts for this tick.
    const copy = { ...command };
    this.unacked.push({ command: copy, state: this.ctx.actors.local.controller.capture() });
    while (this.unacked.length > COMMAND_HISTORY) this.unacked.shift();
    this.transport.send({ t: 'cmd', c: packCommand(copy) });

    this.interpolate();
  }

  /** Ask the host to build. Nothing is placed locally until they say so. */
  requestPlacement(record: PlacementRecord): void {
    this.transport.send({ t: 'build', r: record });
  }

  /**
   * Ask the host to take down a part, named by *their* id for it.
   *
   * Translated rather than sent straight through: the id the player is pointing
   * at is this machine's, and the two allocations do not line up. Sending the
   * local number removes a different plank on everybody else's screen — and the
   * player who asked sees the right one vanish, which makes it look like a
   * rendering bug rather than a protocol one.
   */
  requestRemoval(localPartId: number): void {
    const hostId = this.hostIds.get(localPartId);
    if (hostId === undefined) return;
    this.transport.send({ t: 'unbuild', p: hostId });
  }

  /** Our id for a part, and theirs. */
  private readonly hostIds = new Map<number, number>();
  private readonly localIds = new Map<number, number>();

  private learn(local: number, host: number): void {
    this.hostIds.set(local, host);
    this.localIds.set(host, local);
  }

  private forgetPart(local: number, host: number): void {
    this.hostIds.delete(local);
    this.localIds.delete(host);
  }

  /**
   * Slide every remote toward where they were a moment ago.
   *
   * Deliberately behind live. Drawing the newest sample would mean drawing a
   * position and then jumping when the next packet disagrees; drawing between
   * two samples that have both arrived means always showing something that
   * really happened.
   */
  private interpolate(): void {
    const target = this.clock - INTERP_DELAY;
    for (const [id, actor] of this.remotes) {
      const buffer = this.samples.get(id);
      if (buffer === undefined || buffer.length === 0) continue;

      let a = buffer[0]!;
      let b = buffer[buffer.length - 1]!;
      for (let i = 0; i < buffer.length - 1; i++) {
        if (buffer[i]!.time <= target && buffer[i + 1]!.time >= target) {
          a = buffer[i]!;
          b = buffer[i + 1]!;
          break;
        }
      }

      const span = b.time - a.time;
      const t = span > 1e-6 ? Math.min(1, Math.max(0, (target - a.time) / span)) : 1;
      const body = actor.controller;
      body.prevX = body.x; body.prevY = body.y; body.prevZ = body.z;
      body.x = a.x + (b.x - a.x) * t;
      body.y = a.y + (b.y - a.y) * t;
      body.z = a.z + (b.z - a.z) * t;
      // Velocity is carried so the walk cycle knows how fast they are going. It
      // is never integrated here — the host owns where they end up.
      body.vx = a.vx + (b.vx - a.vx) * t;
      body.vz = a.vz + (b.vz - a.vz) * t;
      body.onGround = b.onGround;
      this.headings.set(id, shortestLerp(a.yaw, b.yaw, t));
    }
  }

  close(): void {
    for (const id of [...this.remotes.keys()]) this.ctx.actors.removeRemote(id);
    this.remotes.clear();
    this.transport.close();
  }
}

/** The fixed timestep, restated here so a replay steps exactly as the host did. */
const FIXED_DT = 1 / 60;

/** Interpolate an angle the short way round, so 350° to 10° is 20° and not 340°. */
function shortestLerp(from: number, to: number, t: number): number {
  const delta = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  return from + delta * t;
}
