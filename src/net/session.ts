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
import {
  aimOf, commandToIntent, packCommand, pressed, unpackCommand, type Command,
} from '../core/command.ts';
import type { CollisionWorld } from '../physics/collisionWorld.ts';
import type { BuildSystem, PlacementRecord } from '../build/buildSystem.ts';
import { MAX_REACH } from '../build/snapping.ts';
import { CAP_HEIGHT } from '../physics/constants.ts';
import { ActorRoster, FIRST_REMOTE_ID, opposing, type Actor, type Team } from '../game/actor.ts';
import {
  ACTOR_FLAG, PROTOCOL_VERSION, decode, indexToTeam, teamToIndex,
  type HostMessage, type PackedActor, type PackedRound, type PackedSelf,
  type RtcSignal,
} from './protocol.ts';
import { SignalBudget } from '../voice/voiceRules.ts';
import { clampAppearance, type Appearance } from '../game/appearance.ts';
import { addTag, clampTag, type TagRecord } from '../game/spray.ts';
import { MAX_BLUEPRINT_PARTS } from '../build/blueprint.ts';
import { IDLE_INPUT, type ActorInput, type GameMode } from '../game/gameMode.ts';
import type { ProjectileSystem } from '../game/projectiles.ts';
import { applyItems } from '../game/itemField.ts';
import { enforceBounds, inBounds } from '../world/bounds.ts';
import {
  RateLimit, SAY_COOLDOWN, PING_COOLDOWN, audible, cleanChat,
  type Channel, type EmoteKind, type Listener, type PingKind,
} from '../game/comms.ts';
import { cleanName } from '../app/identity.ts';
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
  /**
   * Balloons in flight, so a host can publish them and a guest can be shown
   * them. The same object main.ts hands the mode — there is one per game.
   */
  projectiles: ProjectileSystem;
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
  /**
   * Something somebody said, pinged or did, already decided as audible.
   *
   * Handed to the shell rather than applied here for the same reason `setRound`
   * is: what a machine *does* with a chat line — which log, which sound, which
   * corner — is a question about presentation, and the session has no business
   * answering it. Both sides call this: the host on its own relay, a guest when
   * a message arrives.
   */
  heard?(event: HeardEvent): void;
  /**
   * One step of a voice handshake arrived for this machine.
   *
   * Separate from `heard` rather than folded into it, and the reason is the
   * same one that keeps modes out of the renderer: `heard` is presentation —
   * something to put on a screen — and this is not. Nothing about a signal is
   * ever shown to anybody; it goes to a peer connection or nowhere.
   */
  signalled?(from: number, signal: RtcSignal): void;
  /**
   * Somebody is wearing this.
   *
   * Separate from `heard` because an outfit is not an event — it is a fact that
   * stays true, and something that arrives once and holds does not belong on
   * the channel carrying things which appear for four seconds and go.
   */
  /**
   * Somebody is wearing this, or has left and is wearing nothing.
   *
   * Null means "forget them" rather than "put them in the default", which is a
   * distinction the renderer already draws: an id with no chosen appearance
   * falls back to the seeded one, and that is what a departed peer should cost.
   */
  wearing?(id: number, appearance: Appearance | null): void;
  /**
   * Somebody sprayed this, already clamped and stamped with who.
   *
   * The one path a mark reaches a wall by, on every machine including the one
   * that sprayed it. A client that painted optimistically and then took this as
   * well would have the tag twice, and the caps are the host's to apply — a
   * sprayer cannot know whether their twelfth evicted their own first until the
   * host says so.
   */
  sprayed?(tag: TagRecord): void;
  /**
   * Something came down somewhere, loudly enough to be worth hearing.
   *
   * A cue rather than a fact: nothing is removed by this, and a machine that
   * ignored it would still have the right world. It is here because the
   * removals arrive one at a time and a guest cannot otherwise tell a tower
   * falling from somebody taking a plank back.
   */
  crashed?(x: number, y: number, z: number, parts: number): void;
}

/** Something to show the person at this keyboard. */
export type HeardEvent =
  | { kind: 'say'; from: number; name: string; channel: Channel; text: string }
  | { kind: 'ping'; from: number; pingKind: PingKind; x: number; y: number; z: number }
  | { kind: 'emote'; from: number; emoteKind: EmoteKind };

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
  /**
   * Whether their trigger was down on the tick before this one.
   *
   * Kept because a command carries a *held* bit and a mode asks about edges —
   * `firePressed` and `fireReleased` are what start and finish a wind-up. A
   * host that derived neither would give every guest a throw that never
   * charges and never leaves their hand.
   */
  wasFiring: boolean;
  /**
   * What they called themselves at the handshake.
   *
   * Kept because chat needs it and nothing else did — the name arrived in
   * `hello`, was used for one status line and thrown away. A guest has no
   * roster of names, so the host is the only machine that can put one on a
   * message.
   */
  name: string;
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
    this.peers.set(id, {
      id, transport, actor, latest: null, ack: -1, wasFiring: false,
      name: cleanName(first.name),
    });
    this.ctx.actors.addRemote(actor);

    this.introduce(this.peers.get(id)!);
    this.message = `${first.name} joined`;
  }

  /**
   * Everything a guest needs in order to start playing, sent to that guest.
   *
   * Its own function because it is sent twice: once when the peer is created,
   * and again whenever that peer says hello a second time.
   *
   * A second hello means one thing — "I never got your answer" — because a
   * client repeats it only until it is welcomed. Nothing answered it, and a
   * host that does not answer it turns one lost packet into a permanently
   * half-joined session: the host has already made the actor, given it a side
   * and a spawn, and is simulating it from a stream of commands, while the
   * guest sits on "connecting…" forever, never learning which of the people in
   * the yard it is. On a loopback the welcome cannot be lost, which is why this
   * survived every test until there was a link that could lose one.
   *
   * Everything here is idempotent by construction. `welcome` carries the world
   * wholesale and a guest adopts it rather than merging; `wearing` and
   * `sprayed` are last-writer-wins on an id. So the cost of answering a hello
   * nobody needed answered is one message, and the cost of not answering one is
   * a player who cannot play.
   */
  private introduce(peer: Peer): void {
    peer.transport.send({
      t: 'welcome',
      id: peer.id,
      team: peer.actor.team,
      tick: this.tick,
      // The world as it stands. Somebody joining halfway through has to see what
      // everybody built before they arrived, or they are playing a different map.
      parts: this.ctx.build.serializeWithIds(),
    });

    // What everybody already here is wearing.
    //
    // Sent to the newcomer only, and this is the half that is easy to forget:
    // the other half — telling everybody what the newcomer wears — happens when
    // their own `wear` arrives, which it will, because a client sends one the
    // moment it is welcomed. Without this, a locker works perfectly for whoever
    // hosted and everybody who joined after you is a stranger in default
    // clothes, which is a bug you only see with three people in the yard.
    for (const [wornBy, appearance] of this.worn) {
      peer.transport.send({ t: 'wearing', id: wornBy, a: appearance });
    }

    // And what is already painted on the fences. One message each rather than a
    // list on `welcome`, so a newcomer applies paint through exactly the path
    // every later mark takes — a second path is a second thing to get wrong,
    // and this one would only be wrong for people who joined late.
    for (const tag of this.painted) {
      peer.transport.send({ t: 'sprayed', tag });
    }
  }

  private handle(peer: Peer, message: ReturnType<typeof decode>): void {
    if (message === null) return;
    switch (message.t) {
      // "I never got your answer." A client stops saying hello the moment it is
      // welcomed, so a second one from somebody already in the yard can only
      // mean the first welcome went missing. Say it again.
      case 'hello':
        this.introduce(peer);
        break;

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
        //
        // And within arm's reach of the person asking. Until this line a guest
        // could name any coordinates in the world and the host would place a
        // part there: a staircase in somebody else's yard, a box around another
        // player, a wall across a flag base from forty metres away. The client
        // enforces `MAX_REACH` on itself, which stops an honest player and
        // nobody else — a hand-written message goes nowhere near the snapper.
        if (!this.withinReach(peer, message.r)) return;
        if (!this.ctx.build.buyPlacement(message.r)) return;
        const id = this.ctx.build.lastPlacedId;
        if (id === null) return;
        this.ctx.worldChanged();
        this.broadcast({ t: 'built', id, r: message.r });
        break;
      }
      case 'stamp': {
        // Every part within reach of the person asking, and the whole thing or
        // none of it — the same two rules as a single placement, applied to a
        // set. Checking only the anchor would let a guest hang a blueprint's
        // far end anywhere the blueprint is long, which is a bigger hole than
        // the one `withinReach` was added to close.
        if (message.rs.length === 0 || message.rs.length > MAX_BLUEPRINT_PARTS) return;
        for (const r of message.rs) if (!this.withinReach(peer, r, NetHost.BLUEPRINT_SPAN)) return;
        const ids = this.ctx.build.stamp(message.rs);
        if (ids.length === 0) return;
        this.ctx.worldChanged();
        // Broadcast one at a time, because that is the message a client already
        // knows how to apply. The atomicity that matters is the host's decision,
        // and it has been made by the time any of these go out.
        for (let i = 0; i < ids.length; i++) {
          this.broadcast({ t: 'built', id: ids[i]!, r: message.rs[i]! });
        }
        break;
      }
      case 'unbuild': {
        // What the guest asked for, plus whatever it was holding up. The host
        // is the only machine that works that out — see `applyRemove`.
        const down = this.ctx.build.demolish(message.p);
        if (down.length === 0) return;
        this.ctx.worldChanged();
        for (const id of down) this.broadcast({ t: 'unbuilt', p: id });
        break;
      }
      case 'say': {
        const text = cleanChat(message.m);
        if (text === null) return;
        if (!this.sayLimit.allow(peer.id)) return;
        this.relaySaid(peer.id, peer.name, message.ch, text);
        break;
      }
      case 'ping': {
        if (!this.pingLimit.allow(peer.id)) return;
        // Clamped into the world, because the position is a number a client
        // chose. A ping four hundred metres out is a chevron on the compass
        // pointing at nothing, for everybody, for six seconds.
        if (!inBounds(message.x, message.z)) return;
        this.relayPinged(peer.id, message.k, message.x, message.y, message.z);
        break;
      }
      case 'emote': {
        if (!this.sayLimit.allow(peer.id)) return;
        this.relayEmoted(peer.id, message.k);
        break;
      }
      case 'signal': {
        if (!this.signalBudget.allow(peer.id)) return;
        this.relaySignal(peer.id, message.to, message.s);
        break;
      }
      case 'spray': {
        this.paint(peer.id, message.tag);
        return;
      }
      case 'wear': {
        // Rate-limited on the chat budget rather than a new one. An outfit
        // changes when somebody closes a menu, which is exactly the cadence a
        // chat line arrives at, and one limiter that covers both is one thing
        // to reason about instead of two.
        if (!this.sayLimit.allow(peer.id)) return;
        this.dressPeer(peer.id, message.a);
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
  /**
   * What a guest is trying to do this tick, in the shape a mode asks for.
   *
   * The command already carried everything needed — a fire bit, a yaw and a
   * pitch — and the host threw all three away, stepping the body and nothing
   * else. That is what "a guest cannot fight" actually was: not a missing
   * message, a message nobody read.
   *
   * Called during the mode's tick, before `afterTick` rolls `wasFiring`
   * forward, so the edges belong to the tick being simulated.
   */
  inputOf(actorId: number): ActorInput {
    const peer = this.peers.get(actorId);
    const command = peer?.latest;
    if (peer === undefined || command === undefined || command === null) return IDLE_INPUT;
    const firing = pressed(command, 'fire');
    const aim = aimOf(command);
    return {
      fire: firing,
      firePressed: firing && !peer.wasFiring,
      fireReleased: !firing && peer.wasFiring,
      aimX: aim.x, aimY: aim.y, aimZ: aim.z,
      slot: command.slot,
    };
  }

  afterTick(dt: number): void {
    this.noticeRoundChange();
    // Advanced on the tick rather than on a frame: a rate limit measured in
    // rendered frames is a rate limit that is looser on a fast machine.
    this.sayLimit.tick(dt);
    this.pingLimit.tick(dt);
    this.signalBudget.tick(dt);

    const mode = this.ctx.mode?.() ?? null;
    for (const peer of this.peers.values()) {
      const command = peer.latest;
      if (command === null) continue;
      // Soaked guests walk slowly, or stop, by the same rule as a soaked host.
      // Left out at first, which made being knocked out of the fight a purely
      // cosmetic thing to happen to anybody who was not the authority.
      const scale = mode?.speedScaleFor?.(peer.id) ?? 1;
      peer.actor.controller.step(dt, commandToIntent(command, scale));
      // The same item pass the guest just ran on its own prediction. Both sides
      // compute it from position alone, so they agree without a message.
      applyItems(peer.actor.controller);
      // And the same boundary, for the same reason. The host is the authority on
      // where a guest is, so this is the copy that decides — but the guest runs
      // it too, so leaning on the wall does not produce a correction a tick.
      enforceBounds(peer.actor.controller);
      this.headings.set(peer.id, command.yaw);
      peer.ack = command.tick;
      peer.wasFiring = pressed(command, 'fire');
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
    const balloons: Array<[number, number, number]> = [];
    this.ctx.projectiles.forEachActive((_index, x, y, z) => {
      balloons.push([round3(x), round3(y), round3(z)]);
    });
    // One array, but each peer needs its own ack — and now its own tank, which
    // is the other reason this message could never have been a broadcast.
    for (const peer of this.peers.values()) {
      peer.transport.send({
        t: 'snap',
        tick: this.tick,
        ack: peer.ack,
        actors,
        round,
        you: packSelf(mode, peer.id),
        balloons,
      });
    }
  }

  /**
   * Could this guest plausibly have placed that, from where they are?
   *
   * Deliberately loose, and the looseness is the design rather than a shortcut.
   * Three things sit between what the guest saw and what the host knows:
   *
   * - **Reach is measured from the eye**, not the feet, and the host has a body
   *   position. That is `CAP_HEIGHT` of slop before anything else.
   * - **The guest was somewhere else when they aimed.** The message crossed a
   *   network; at a sprint that is metres. `MOVED` covers a fifth of a second
   *   of running, which is a long round trip.
   * - **A part has size.** `MAX_REACH` is to the candidate's centre, and a
   *   plank's own half-length is not nothing.
   *
   * Erring tight would drop legal placements from anybody with a slow
   * connection, and a plank that silently fails to appear is a much worse bug
   * than a generous bound — it is indistinguishable from the game being broken.
   * Erring loose still turns "anywhere in the world" into "within about nine
   * metres of yourself", which is the whole of the exploit.
   *
   * This is a reach check and not a line-of-sight check on purpose. Whether a
   * placement is *legal* — overlapping, out of the world, unaffordable — is
   * already decided by `buyPlacement`, and that decision belongs there.
   */
  private static readonly REACH_SLACK_MOVED = 2;

  /**
   * Rate limits, on the host, where they are rules.
   *
   * A limit a client enforces on itself is a limit only honest clients have.
   * Pings get their own and a longer one, because a ping marks the *world* for
   * six seconds and is therefore the one thing here worth spamming — chat and
   * emotes only clutter a corner.
   */
  private readonly sayLimit = new RateLimit(SAY_COOLDOWN);
  private readonly pingLimit = new RateLimit(PING_COOLDOWN);
  /**
   * And a bucket rather than a gap for voice handshaking, because ICE arrives
   * in bursts. See `SignalBudget`; the shape of the traffic is the reason.
   */
  private readonly signalBudget = new SignalBudget();
  /**
   * What everybody is wearing, including the host.
   *
   * Kept because a late arrival cannot derive it — that is the property a
   * locker gives up — so somebody has to remember it, and the host is the only
   * one who sees every join.
   */
  private readonly worn = new Map<number, Appearance>();
  /**
   * Every mark in the yard, as the host believes it.
   *
   * Kept here rather than read back out of the game for the same reason `worn`
   * is: a late joiner has to be told, and the thing that tells them has to be
   * the thing that decided. Maintained with `addTag`, so it is exactly the list
   * every client will have after applying the same messages in the same order —
   * a copy that merely accumulated would drift the first time a cap evicted
   * something.
   */
  private painted: TagRecord[] = [];
  private hostName = 'the host';

  /**
   * How far past arm's reach a stamped part may land.
   *
   * A blueprint is a thing with a size: the top of a staircase is legitimately
   * several metres up and several along from the spot you put it down on, so
   * the single-plank reach rule refuses every blueprint taller than a person.
   * This is the allowance for that, and it is a real widening of what a guest
   * can ask for — bounded, stated, and much smaller than the alternative of
   * checking only the anchor, which would let a blueprint of any span put its
   * far end anywhere at all.
   */
  private static readonly BLUEPRINT_SPAN = 12;

  private withinReach(peer: Peer, record: PlacementRecord, extra = 0): boolean {
    const body = peer.actor.controller;
    const limit = MAX_REACH + CAP_HEIGHT + NetHost.REACH_SLACK_MOVED + extra;
    const dx = record.x - body.x;
    const dy = record.y - body.y;
    const dz = record.z - body.z;
    return dx * dx + dy * dy + dz * dz <= limit * limit;
  }

  /**
   * Where somebody is, in the shape the audibility rule wants.
   *
   * The host's own player is a listener too, and the one that is easiest to
   * forget: leave it out and the person hosting is the only one who never hears
   * anything, which reads as their own chat being broken.
   */
  private listenerFor(id: number): Listener | null {
    const actor = this.ctx.actors.get(id);
    if (actor === undefined) return null;
    return { id, team: actor.team, x: actor.controller.x, z: actor.controller.z };
  }

  /**
   * Send a line to everybody entitled to it, and nobody else.
   *
   * Per recipient rather than broadcast, which is the whole of how team chat
   * stays private. Broadcasting and letting each client show what it should
   * works perfectly until somebody runs a client that does not — and a filter
   * on the receiving end is a convention rather than a rule.
   *
   * `heard` goes back to the shell so the host's own screen shows what the host
   * said. The host is a player, not a switchboard.
   */
  private relaySaid(from: number, name: string, ch: 'team' | 'near', text: string): void {
    const speaker = this.listenerFor(from);
    if (speaker === null) return;
    for (const peer of this.peers.values()) {
      const listener = this.listenerFor(peer.id);
      if (listener === null || !audible(ch, speaker, listener)) continue;
      peer.transport.send({ t: 'said', from, name, ch, m: text });
    }
    const here = this.listenerFor(this.ctx.actors.local.id);
    if (here !== null && audible(ch, speaker, here)) {
      this.ctx.heard?.({ kind: 'say', from, name, channel: ch, text });
    }
  }

  /** Pings are team-only: a mark on the world is a callout, and callouts are tactics. */
  private relayPinged(from: number, k: PingKind, x: number, y: number, z: number): void {
    const speaker = this.listenerFor(from);
    if (speaker === null) return;
    for (const peer of this.peers.values()) {
      const listener = this.listenerFor(peer.id);
      if (listener === null || !audible('team', speaker, listener)) continue;
      peer.transport.send({ t: 'pinged', from, k, x, y, z });
    }
    const here = this.listenerFor(this.ctx.actors.local.id);
    if (here !== null && audible('team', speaker, here)) {
      this.ctx.heard?.({ kind: 'ping', from, pingKind: k, x, y, z });
    }
  }

  /** Emotes are the opposite: they are performed at whoever can see you. */
  private relayEmoted(from: number, k: EmoteKind): void {
    const speaker = this.listenerFor(from);
    if (speaker === null) return;
    for (const peer of this.peers.values()) {
      const listener = this.listenerFor(peer.id);
      if (listener === null || !audible('near', speaker, listener)) continue;
      peer.transport.send({ t: 'emoted', from, k });
    }
    const here = this.listenerFor(this.ctx.actors.local.id);
    if (here !== null && audible('near', speaker, here)) {
      this.ctx.heard?.({ kind: 'emote', from, emoteKind: k });
    }
  }

  /**
   * Carry one step of a voice handshake from one player to another.
   *
   * Unlike chat, this is addressed rather than broadcast, and unlike chat there
   * is no audibility rule to apply — an offer is between two people by
   * construction, and the host's job is to be a post box. What it must still do
   * is the one thing a post box does: **stamp the sender itself.** `from` is
   * taken from the connection the message arrived on and never from the message,
   * so a client cannot open a call in somebody else's name.
   *
   * A signal addressed to nobody is dropped in silence. That is not defensive
   * tidiness — it is routine, because a peer can leave in the gap between
   * another peer deciding to dial them and the offer arriving.
   */
  private relaySignal(from: number, to: number, s: RtcSignal): void {
    if (to === from) return;
    if (to === this.ctx.actors.local.id) {
      this.ctx.signalled?.(from, s);
      return;
    }
    this.peers.get(to)?.transport.send({ t: 'signalled', from, s });
  }

  /** The host's own end of a handshake. Same post box, one fewer hop. */
  signal(to: number, s: RtcSignal): void {
    this.relaySignal(this.ctx.actors.local.id, to, s);
  }

  /**
   * The host saying something itself.
   *
   * Goes through the same relay as a guest's, so there is exactly one copy of
   * the audibility rule and the host cannot accidentally be exempt from it.
   */
  say(ch: 'team' | 'near', raw: string): void {
    const text = cleanChat(raw);
    if (text === null) return;
    const me = this.ctx.actors.local.id;
    if (!this.sayLimit.allow(me)) return;
    this.relaySaid(me, this.hostName, ch, text);
  }

  ping(k: PingKind, x: number, y: number, z: number): void {
    const me = this.ctx.actors.local.id;
    if (!this.pingLimit.allow(me) || !inBounds(x, z)) return;
    this.relayPinged(me, k, x, y, z);
  }

  emote(k: EmoteKind): void {
    const me = this.ctx.actors.local.id;
    if (!this.sayLimit.allow(me)) return;
    this.relayEmoted(me, k);
  }

  /**
   * Put somebody in something and tell everybody, host included.
   *
   * Clamped here rather than trusted, because a client is the one thing on the
   * far side of this that nobody controls, and the limits exist precisely so
   * that what one player chooses cannot change the game for everybody else.
   * A head twice the size is a bigger target and is visible over the wall its
   * owner is hiding behind.
   */
  /**
   * Somebody sprayed. Clamp it, cap it, tell everybody.
   *
   * `by` is stamped from the connection rather than taken from the message, so
   * a client cannot spend somebody else's twelve marks — the cap is per player
   * and a sprayer who could name themselves could evict a rival's paint.
   */
  private paint(by: number, raw: unknown): void {
    const tag = clampTag(raw, by);
    const { tags } = addTag(this.painted, tag);
    this.painted = tags;
    this.broadcast({ t: 'sprayed', tag });
    this.ctx.sprayed?.(tag);
  }

  /** This machine sprayed. Same path as a guest's, so the caps cannot differ. */
  spray(raw: unknown): void {
    this.paint(this.ctx.actors.local.id, raw);
  }

  /**
   * Tell everybody a structure fell.
   *
   * Not called from the removal path on purpose. The host decides a collapse in
   * one place and makes the noise in one place, and this hangs off the noise —
   * so a removal that is *not* worth hearing does not become one on the wire
   * just because it happened to be networked.
   */
  crash(x: number, y: number, z: number, parts: number): void {
    this.broadcast({ t: 'crash', x, y, z, n: parts });
  }

  /** A part came down, so the paint on it did too. Keeps the replay honest. */
  unpaint(gone: ReadonlySet<number>): void {
    if (gone.size === 0) return;
    this.painted = this.painted.filter((t) => t.part < 0 || !gone.has(t.part));
  }

  private dressPeer(id: number, appearance: Appearance): void {
    const safe = clampAppearance(appearance);
    this.worn.set(id, safe);
    this.broadcast({ t: 'wearing', id, a: safe });
    this.ctx.wearing?.(id, safe);
  }

  /** The host's own outfit, which travels by exactly the same path. */
  wear(appearance: Appearance): void {
    this.dressPeer(this.ctx.actors.local.id, appearance);
  }

  private broadcast(message: HostMessage): void {
    for (const peer of this.peers.values()) peer.transport.send(message);
  }

  private drop(id: number): void {
    const peer = this.peers.get(id);
    if (peer === undefined) return;
    this.peers.delete(id);
    this.headings.delete(id);
    this.signalBudget.forget(id);
    this.ctx.actors.removeRemote(id);
    this.worn.delete(id);
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

const round3 = (v: number): number => round(v);

/**
 * One peer's own numbers, taken from the mode that is actually running them.
 *
 * Asked of the mode rather than assembled here, because what a tank is and
 * whether there is one at all is a rule — Water War meters litres, Capture the
 * Flag counts balloons, Fort Defense has a refill channel and no soaking meter.
 * A session that decided any of that would be a fourth opinion on the subject.
 */
function packSelf(mode: GameMode | null, actorId: number): PackedSelf | null {
  const self = mode?.selfHud?.(actorId);
  if (self === undefined) return null;
  const stream = mode?.streamFor?.(actorId) ?? null;
  return {
    charge: self.charge,
    wet: self.wetness,
    ammo: self.ammo === null
      ? null
      : [self.ammo.current, self.ammo.max, self.ammo.gauge === true ? 1 : 0],
    refill: self.refill,
    stream: stream === null ? null : [round3(stream.x), round3(stream.y), round3(stream.z)],
    out: (mode?.speedScaleFor?.(actorId) ?? 1) <= 0,
  };
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

  /**
   * The newest snapshot instant applied, so an older one can be recognised.
   *
   * The host's counter only ever goes up within a session and is never reset by
   * a round change, which is what makes a plain comparison safe here rather
   * than something that has to reason about wrapping.
   */
  private newestSnap = -1;

  /**
   * Snapshots dropped for arriving late, which is a network measurement rather
   * than an error. A guest seeing a lot of these has a link that reorders, and
   * knowing that is the difference between blaming the network and blaming the
   * game.
   */
  stale = 0;

  /**
   * How often to say hello again while waiting to be welcomed.
   *
   * A third of a second, which is frequent enough that a player does not
   * notice and rare enough that a host cannot be flooded by one.
   */
  private static readonly HELLO_RETRY_TICKS = 20;

  private helloIn = 0;
  private readonly name: string;

  constructor(
    private readonly ctx: SessionContext,
    private readonly transport: Transport,
    name: string,
  ) {
    this.name = name;
    transport.send({ t: 'hello', version: PROTOCOL_VERSION, name });
    // The retry counter starts wound up, because this *was* the first hello.
    // Left at zero it fired again on the very next tick — a repeat a sixtieth
    // of a second after the original, which cannot possibly mean the original
    // was lost, and which the host now answers with a second welcome.
    this.helloIn = NetClient.HELLO_RETRY_TICKS;
  }

  /**
   * Say hello again, until somebody says welcome.
   *
   * Sent once from the constructor at first, and that is wrong in two ways that
   * only appear on a real socket. A fresh `WebSocket` is still `CONNECTING`
   * when the constructor runs, and `SocketTransport.send` drops anything sent
   * before it opens — so on a real connection the only hello was thrown away
   * every single time. And even sent after opening, a relay drops a guest's
   * message when no host has joined the room yet, which is routine now that a
   * lobby hands both machines the same room at the same instant.
   *
   * Neither showed up for a long time because every test and scenario used a
   * loopback or an in-page transport, and both of those are open on the tick
   * they are made. Retrying fixes both without either side needing to know
   * which one happened.
   */
  private sayHello(): void {
    if (this.connected || !this.transport.open) return;
    if (this.helloIn > 0) { this.helloIn--; return; }
    this.helloIn = NetClient.HELLO_RETRY_TICKS;
    this.transport.send({ t: 'hello', version: PROTOCOL_VERSION, name: this.name });
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

  /**
   * This machine's own tank, wind-up and soaking, as of the last snapshot.
   *
   * Read through by `RemoteMode` rather than copied into it, for the same
   * reason as wetness: a second copy is one more thing that can be a frame
   * behind the meter it is drawing.
   */
  private self: PackedSelf | null = null;

  get mine(): PackedSelf | null {
    return this.self;
  }

  beforeTick(): void {
    if (!this.transport.open && this.connected) {
      this.connected = false;
      this.message = 'lost the connection';
    }
    this.sayHello();
    for (const message of this.transport.drain()) this.handle(message);
  }

  private handle(message: ReturnType<typeof decode>): void {
    if (message === null) return;
    switch (message.t) {
      case 'welcome':
        // Once is enough. A welcome initialises a guest — its id, its side, its
        // spawn and the whole world — and doing that twice is not doing it
        // twice as well: it yanks a player who has been running for two seconds
        // back to the spawn, throws away the world they are standing in and
        // rebuilds it, and clears the part-id maps that everything placed since
        // was learned into.
        //
        // A second one is not a fault, which is why this drops it quietly
        // rather than complaining. The host now answers a repeated hello with a
        // fresh welcome, because a repeat means the first went missing — and on
        // a link slower than the retry interval a guest will always ask again
        // before the answer has had time to arrive.
        if (this.connected) break;
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
        // Nothing can be read from a snapshot before the welcome, because the
        // one thing a guest needs in order to read one is which of those actors
        // it is. Without that `applySnapshot` treats every id as somebody else:
        // it builds a remote for the guest's own future id, and asks the roster
        // for a remote with the host's id — which the roster refuses, because
        // an unwelcomed guest is still id 0 and so is the host. The refusal is
        // silent and the client records the remote as made, so it never asks
        // again. The guest ends up drawing a ghost of itself and never seeing
        // the host at all, for the rest of the session.
        //
        // On a loopback the welcome always wins that race, which is why this
        // survived every test until a link that reorders was pointed at it.
        if (this.localId < 0) break;
        // A snapshot is a picture of one instant, and an older picture arriving
        // after a newer one is not news — it is a rewind.
        //
        // Nothing rejected one until a link that reorders was built to look:
        // `applySnapshot` took the tick and opened with `void tick`. Ten
        // seconds of two-player traffic at 120ms with 40ms of jitter reordered
        // seven of two hundred snapshots, and every one of them was applied.
        // What that costs is not subtle — an interpolation sample stamped
        // *now* carrying where somebody was two frames ago, a reconciliation
        // against a stale acknowledgement, a round rolled backwards, and an
        // actor who joined in the gap forgotten and immediately re-added.
        //
        // Dropped whole rather than in part, because everything in a snapshot
        // describes one instant: taking the actors from an old one and the
        // round from a new one is a third world that never existed.
        if (message.tick <= this.newestSnap) {
          this.stale++;
          break;
        }
        this.newestSnap = message.tick;
        this.applySnapshot(message.tick, message.ack, message.actors);
        this.self = message.you ?? null;
        // Shown rather than simulated. Nothing here integrates or collides —
        // the host owns which balloon hit whom, and a guest that ran its own
        // physics on them would have a second opinion about it.
        this.ctx.projectiles.mirror(message.balloons ?? []);
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

      case 'said':
        this.ctx.heard?.({
          kind: 'say', from: message.from, name: message.name,
          channel: message.ch, text: message.m,
        });
        break;

      case 'pinged':
        this.ctx.heard?.({
          kind: 'ping', from: message.from, pingKind: message.k,
          x: message.x, y: message.y, z: message.z,
        });
        break;

      case 'emoted':
        this.ctx.heard?.({ kind: 'emote', from: message.from, emoteKind: message.k });
        break;

      case 'signalled':
        this.ctx.signalled?.(message.from, message.s);
        break;

      case 'crash':
        this.ctx.crashed?.(message.x, message.y, message.z, message.n);
        return;
      case 'sprayed':
        this.ctx.sprayed?.(clampTag(message.tag, message.tag?.by ?? 0));
        return;
      case 'wearing':
        // Clamped again on arrival, even though the host clamped it before
        // sending. The host is another browser: it is the authority on the
        // simulation and it is not thereby a trusted source of bounded numbers,
        // and this is the cheapest possible place to say so.
        this.ctx.wearing?.(message.id, clampAppearance(message.a));
        break;

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
    // Including what they were wearing. Ids are not reused inside one session,
    // so this cannot currently show up — but every other per-peer thing above
    // is dropped here, and a wardrobe entry that outlives its owner is exactly
    // the shape of ghost this list exists to prevent.
    this.ctx.wearing?.(id, null);
    this.ctx.actors.removeRemote(id);
  }

  private applySnapshot(tick: number, ack: number, actors: PackedActor[]): void {
    void tick;
    // The tick is the caller's business — it decides whether this snapshot is
    // news at all before getting here, and by the time it does the answer is
    // yes. Kept in the signature because a snapshot without its instant on it
    // is the shape of the bug that was here.
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
   * Ask to be heard.
   *
   * Nothing appears on this screen until the host says it may — not even the
   * player's own line. That is a real half-second of latency on your own chat
   * and it is the right trade: echoing locally and then receiving the host's
   * copy shows everything twice, and suppressing the copy means keeping a
   * record of what you have already shown. One authority, one arrival.
   */
  say(ch: Channel, text: string): void {
    const clean = cleanChat(text);
    if (clean !== null) this.transport.send({ t: 'say', ch, m: clean });
  }

  ping(k: PingKind, x: number, y: number, z: number): void {
    this.transport.send({ t: 'ping', k, x, y, z });
  }

  emote(k: EmoteKind): void {
    this.transport.send({ t: 'emote', k });
  }

  /**
   * Ask the host to put a whole blueprint down.
   *
   * One message, and nothing is drawn locally until the host says so — the same
   * discipline as a single placement. A guest that stamped optimistically and
   * was refused would have to un-draw a staircase, and the frame where it
   * existed is the frame somebody screenshots.
   */
  /** Tell the host what I look like. */
  /**
   * Ask the host to put a mark down. Nothing happens here until it says so.
   *
   * No optimistic paint, deliberately. Prediction is worth its complexity for
   * movement, where a round trip is the difference between responsive and
   * unplayable; a mark on a fence is not something anybody is reacting to, and
   * predicting it would mean reconciling a cap that only the host can apply.
   */
  spray(raw: unknown): void {
    this.transport.send({ t: 'spray', tag: clampTag(raw, 0) });
  }

  wear(appearance: Appearance): void {
    this.transport.send({ t: 'wear', a: clampAppearance(appearance) });
  }

  stampBlueprint(records: readonly PlacementRecord[]): void {
    this.transport.send({ t: 'stamp', rs: records.map((r) => ({ ...r })) });
  }

  /**
   * Hand a step of a voice handshake to the host, to be passed on.
   *
   * `to` may be another guest. This machine has no route to them — the mesh is
   * peer-to-peer once it is up, but getting it up needs somebody both ends can
   * already reach, and the host is the only such party.
   */
  signal(to: number, s: RtcSignal): void {
    this.transport.send({ t: 'signal', to, s });
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
