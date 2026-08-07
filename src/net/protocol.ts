/**
 * What two machines say to each other.
 *
 * The whole protocol is in this file on purpose. A wire format spread across the
 * code that sends and the code that receives is a wire format where one side can
 * quietly stop agreeing with the other, and the symptom of that is not an error
 * — it is two players seeing different worlds, which is the single hardest class
 * of bug in a game to find.
 *
 * ## Host-authoritative, not server-authoritative
 *
 * One player's browser runs the simulation and everybody else's follows it. That
 * is a real trade — the host cannot be stopped from cheating, and if they close
 * the tab the round ends — bought for two things worth more at this stage:
 *
 * - **No deploy target.** A server-authoritative build needs somewhere to run
 *   the game, which is a hosting bill and an operations problem for a project
 *   that currently needs neither.
 * - **No float portability problem.** The determinism tests prove a round
 *   replays identically *in one process*. They say nothing about whether two
 *   different CPUs agree on a square root, and lockstep would depend on exactly
 *   that. With one authority, there is nothing to disagree about.
 *
 * The relay in `server/relay.mjs` moves bytes and knows nothing about the game,
 * so it stays a dozen lines and can be replaced by WebRTC without touching this.
 *
 * ## JSON, for now
 *
 * A snapshot of eight people is a few hundred bytes as JSON at twenty a second.
 * That is nothing against a browser's network stack, and being able to read the
 * traffic in devtools is worth more during the phase where the bugs are protocol
 * bugs. The shapes below are all flat tuples, so swapping in a binary encoder
 * later touches this file only.
 */

import type { PackedCommand } from '../core/command.ts';
import type { PlacementRecord } from '../build/buildSystem.ts';
import type { EmoteKind, PingKind } from '../game/comms.ts';
import type { Team } from '../game/actor.ts';

/** Bumped whenever a message shape changes. Mismatched peers are turned away. */
export const PROTOCOL_VERSION = 5;

/**
 * One step of a WebRTC handshake, on its way between two players.
 *
 * Voice does **not** travel over this connection. It travels peer to peer, and
 * all this carries is the paperwork two browsers need to find each other: an
 * offer, an answer, and the network routes each end thinks might work.
 *
 * The blobs are opaque strings on purpose. SDP is a large, versioned,
 * browser-generated format and modelling its fields here would be inventing a
 * second parser for something both ends already agree about — the host's job is
 * to carry it, not to read it.
 */
export type RtcSignal =
  | { k: 'offer' | 'answer'; sdp: string }
  /**
   * One ICE candidate, or null for the end-of-candidates marker.
   *
   * The null case is not an edge case to tidy away: it is how a browser says
   * "that is everywhere I can be reached", and dropping it makes the other end
   * wait out its own timeout before giving up on routes that will never come.
   */
  | { k: 'ice'; c: string | null; mid: string | null };

/**
 * One person in a snapshot, as a flat tuple.
 *
 * A tuple rather than an object because this is the only message that repeats
 * per person per snapshot, and the field names would be most of the bytes.
 */
export type PackedActor = [
  id: number,
  /** 0 = left, 1 = right. */
  team: number,
  x: number, y: number, z: number,
  vx: number, vy: number, vz: number,
  /** Where they are looking, for drawing them facing it. */
  yaw: number,
  /** Bit 0: on the ground. Bit 1: alive. Bit 2: stunned. */
  flags: number,
  /**
   * How soaked they are, 0..1.
   *
   * On the wire because it is on the shirt. A kid's colour washes out as they
   * get wet, and that is the whole reason the meter is worth having — it is how
   * you choose who to throw at. Left out, every guest sees a lawn full of people
   * at full colour and the one decision the mode is built around becomes a
   * guess.
   */
  wet: number,
];

export const ACTOR_FLAG = {
  onGround: 1 << 0,
  alive: 1 << 1,
  stunned: 1 << 2,
} as const;

export function teamToIndex(team: Team): number {
  return team === 'left' ? 0 : 1;
}

export function indexToTeam(index: number): Team {
  return index === 0 ? 'left' : 'right';
}

/**
 * An objective, as a flat tuple. Kind is 0 stash, 1 bucket, 2 flag.
 *
 * Sent rather than derived, even though a guest holds the same map constants and
 * could work out where the flag bases are. Half the markers move — a carried
 * flag, the bucket currently being channelled — and a guest that computed the
 * static half and was told the moving half would have two sources of truth for
 * one list, which is how the compass ends up pointing at a flag that is no
 * longer there.
 */
export type PackedMarker = [
  kind: number,
  x: number, y: number, z: number,
  color: number,
  /** Bit 0: active. Bit 1: faded. */
  flags: number,
];

export const MARKER_FLAG = {
  active: 1 << 0,
  faded: 1 << 1,
} as const;

export const MARKER_KINDS = ['stash', 'bucket', 'flag'] as const;

/**
 * The round, as everybody watching it sees it.
 *
 * Everything here is true of the round rather than of one player, which is the
 * line that decides what belongs in this message. Phase, timer, score and the
 * objectives are the same on every screen; how wet *you* are and how much water
 * is in *your* tank are not, and travel in the actor snapshot instead.
 *
 * The wood is the exception that proves the rule, and it is deliberate: one pile
 * in the corner of the yard that everybody draws from. A per-player allowance
 * would mean two people building the same fort each hit their own limit at a
 * different moment, which is a strange thing to explain and a stranger thing to
 * play. A shared pile is also just what a pile of wood in a garden is.
 */
export interface PackedRound {
  /** Mode id, or null when nobody is playing anything. */
  id: string | null;
  name: string;
  phase: string;
  timer: number | null;
  msg: string | null;
  pri: [label: string, value: string] | null;
  sec: [label: string, value: string] | null;
  score: [left: number, right: number] | null;
  /** Whether placing parts is allowed right now. */
  build: boolean;
  /** The shared pile, or null when the mode does not meter wood. */
  wood: number | null;
  markers: PackedMarker[];
  /** Present once the round is decided, so a guest gets the result screen too. */
  over: { won: boolean; headline: string; lines: Array<[string, string]> } | null;
}

/**
 * How your own fight is going — and only ever yours.
 *
 * The counterpart to `PackedRound`, and the line between them is the whole
 * reason both exist. A round is the same on every screen and can be broadcast;
 * a tank has an owner. This message is built per peer, from the host's mode,
 * about that peer — which is why the snapshot is already sent one at a time.
 *
 * Before this, a guest's HUD showed four nulls where the personal meters go. It
 * was the honest answer to a question nobody was asking on their behalf: the
 * host knew how wet the guest was, because the host was the one soaking them,
 * and simply never said.
 */
export interface PackedSelf {
  /** 0..1 wind-up on a throw, or null when not charging. */
  charge: number | null;
  /** 0..1 soaked, or null in a mode without a meter. */
  wet: number | null;
  /** Current, max, and whether to draw it as a bar rather than pips. */
  ammo: [current: number, max: number, gauge: 0 | 1] | null;
  /** 0..1 on a refill channel, or null when not at a bucket. */
  refill: number | null;
  /**
   * Where your own hose is landing, or null.
   *
   * Sent because the host computes it. A guest holding the trigger runs no
   * stream of their own — the authority does — so without this they would see
   * their tank empty and no water leave it.
   */
  stream: [x: number, y: number, z: number] | null;
  /** True while you are soaked and sitting the next few seconds out. */
  out: boolean;
}

/** Everything a client can say. */
export type ClientMessage =
  /** First thing sent. The host replies with `welcome` or `refused`. */
  | { t: 'hello'; version: number; name: string }
  /** One tick of input. Sent every tick; the newest wins if any are dropped. */
  | { t: 'cmd'; c: PackedCommand }
  /** "I would like to place this." The host decides. */
  | { t: 'build'; r: PlacementRecord }
  /** "I would like to take that down." */
  | { t: 'unbuild'; p: number }
  /**
   * "I would like to put this whole blueprint down."
   *
   * One message rather than N `build`s, because a blueprint is one action. Sent
   * separately the host would validate each part on its own and place whichever
   * fitted, which gives a guest half a staircase and charges them for half a
   * staircase — and makes the outcome depend on the order packets happen to
   * arrive in. The records are absolute, already stamped and rotated by the
   * sender; the host re-checks every one of them and the total price.
   */
  | { t: 'stamp'; rs: PlacementRecord[] }
  /**
   * "Say this, on this channel."
   *
   * A request, like a placement, and for the same reason: who is entitled to
   * hear a line is the host's decision and cannot be the sender's. A client
   * that named its own recipients would be a client that could name the other
   * team.
   */
  | { t: 'say'; ch: 'team' | 'near'; m: string }
  /** "Mark this spot." The position is where the host says the player is aiming. */
  | { t: 'ping'; k: PingKind; x: number; y: number; z: number }
  | { t: 'emote'; k: EmoteKind }
  /**
   * "Pass this to that player." Voice handshaking, and nothing else.
   *
   * `to` is an actor id and may be the host's own. There is deliberately no
   * `from` field: the host stamps it from the connection the message arrived
   * on. A client that could name its own sender could introduce itself to the
   * whole yard as somebody else and negotiate a call in their name — the same
   * rule, and the same reason, as a client not naming its own chat recipients.
   */
  | { t: 'signal'; to: number; s: RtcSignal };

/** Everything a host can say. */
export type HostMessage =
  /**
   * You are in. Carries the world as it stands, because a client that joins
   * halfway through has to see what everybody built before they arrived.
   */
  | {
    t: 'welcome'; id: number; team: Team; tick: number;
    /**
     * The world with the host's own ids attached.
     *
     * Pairs rather than bare records, because two machines allocate part ids
     * independently: the host's store has gaps where things were taken down and
     * a fresh client's does not, so "remove part 7" would mean two different
     * planks. The client keeps a translation table built from these.
     */
    parts: Array<[number, PlacementRecord]>;
  }
  | { t: 'refused'; reason: string }
  /**
   * Where everybody is, and which of your commands I have run.
   *
   * `ack` is what makes prediction work: the client replays everything after it
   * onto the authoritative state, so its own character does not rubber-band by
   * the round trip on every single snapshot.
   */
  | {
    t: 'snap'; tick: number; ack: number; actors: PackedActor[];
    /**
     * What is being played, or null for free build.
     *
     * Carried on the snapshot rather than sent on change, which is the less
     * obvious choice and the right one: half of it — a carried flag's position,
     * a timer, a channel's progress — changes every tick anyway, so an
     * on-change message would fire at snapshot rate regardless and add a second
     * ordering to reason about. Riding along means the objectives a guest draws
     * are always from the same instant as the people they are drawn among.
     */
    round: PackedRound | null;
    /** How the fight is going for the one peer this copy is addressed to. */
    you: PackedSelf | null;
    /**
     * Every balloon in the air, as bare positions.
     *
     * A guest runs no projectile simulation — `RemoteMode.fixedUpdate` is empty
     * — so without this the yard is silent: kids wind up, throw, and nothing
     * crosses the lawn until a guest is suddenly wet. A balloon in flight is the
     * only warning this game gives, so leaving it out does not cost polish, it
     * costs the ability to dodge.
     *
     * Positions only, at snapshot rate, with no identity attached. Every balloon
     * is the same blue sphere, so nobody can tell which is which and numbering
     * them would buy nothing. It does mean one steps twenty times a second
     * rather than sixty, which is visible — and a great deal better than
     * invisible.
     */
    balloons: Array<[x: number, y: number, z: number]>;
  }
  /** Somebody built something. Includes the host's own placements. */
  | { t: 'built'; id: number; r: PlacementRecord }
  | { t: 'unbuilt'; p: number }
  /**
   * Somebody said something, and you are entitled to have heard it.
   *
   * Sent to one peer at a time rather than broadcast, which is the whole of how
   * team chat stays private: the other team is not sent the message, so there
   * is nothing for a modified client to decide not to draw. The name travels
   * with it because a guest has no roster of names — the host took them at the
   * handshake and is the only one that knows who is who.
   */
  | { t: 'said'; from: number; name: string; ch: 'team' | 'near'; m: string }
  /** Somebody marked a spot. Same per-recipient rule as `said`. */
  | { t: 'pinged'; from: number; k: PingKind; x: number; y: number; z: number }
  | { t: 'emoted'; from: number; k: EmoteKind }
  /**
   * Voice handshaking on its way to you, with the sender the host vouches for.
   *
   * The counterpart to the client's `rtc`, and the asymmetry is the point: the
   * client says who it is talking *to* and the host says who it came *from*.
   * Neither end gets to assert both.
   */
  | { t: 'signalled'; from: number; s: RtcSignal }
  | { t: 'bye'; id: number };

export type NetMessage = ClientMessage | HostMessage;

export function encode(message: NetMessage): string {
  return JSON.stringify(message);
}

/**
 * Parse a message, or return null.
 *
 * Null rather than throwing, because the thing on the other end of a socket is
 * not under our control and a malformed frame must not take down the game loop.
 * Every caller treats null as "ignore this", which is the only safe reading.
 */
export function decode(raw: string): NetMessage | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    if (typeof (parsed as { t?: unknown }).t !== 'string') return null;
    return parsed as NetMessage;
  } catch {
    return null;
  }
}
