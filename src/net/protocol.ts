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
import type { Team } from '../game/actor.ts';

/** Bumped whenever a message shape changes. Mismatched peers are turned away. */
export const PROTOCOL_VERSION = 1;

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

/** Everything a client can say. */
export type ClientMessage =
  /** First thing sent. The host replies with `welcome` or `refused`. */
  | { t: 'hello'; version: number; name: string }
  /** One tick of input. Sent every tick; the newest wins if any are dropped. */
  | { t: 'cmd'; c: PackedCommand }
  /** "I would like to place this." The host decides. */
  | { t: 'build'; r: PlacementRecord }
  /** "I would like to take that down." */
  | { t: 'unbuild'; p: number };

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
  | { t: 'snap'; tick: number; ack: number; actors: PackedActor[] }
  /** Somebody built something. Includes the host's own placements. */
  | { t: 'built'; id: number; r: PlacementRecord }
  | { t: 'unbuilt'; p: number }
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
