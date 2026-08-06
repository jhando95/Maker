/**
 * What a player and the lobby say to each other.
 *
 * A second wire format, deliberately kept apart from the game's, and the split
 * is the most important decision in this whole area.
 *
 * ## Why this is not part of the relay
 *
 * `server/relay.mjs` knows about rooms and sockets and **never parses a game
 * message**. That property is load-bearing rather than tidy: the game protocol
 * can change entirely without the server moving, and a bug in the server cannot
 * corrupt a round, because the server has no idea what a round is.
 *
 * Friends, parties and a queue need the opposite — a server that knows what a
 * player is, remembers them between sockets, and makes decisions about them. Put
 * that in the relay and the relay stops being a pipe.
 *
 * So there are two endpoints on one process:
 *
 * | | knows about | lives for |
 * |---|---|---|
 * | `/relay?room=…` | sockets, rooms, opaque bytes | one match |
 * | `/lobby` | players, friends, parties, a queue | the whole session |
 *
 * **The lobby's only output is a room name.** It gathers people, decides who
 * hosts, mints a room and steps back; the game then connects to `/relay` exactly
 * as it does today, speaking a protocol the lobby has never heard of. A lobby
 * outage cannot interrupt a match already in progress, because once a match
 * starts the lobby is not in the path.
 *
 * ## Its own version number, on purpose
 *
 * `PROTOCOL_VERSION` in `protocol.ts` is bumped whenever a snapshot or a command
 * changes shape, which is often. None of that is any of the lobby's business, and
 * a shared number would turn every gameplay change into a reason for a friends
 * list to refuse a connection.
 *
 * ## Nothing here is trusted
 *
 * Every message below arrives from a browser. The server re-checks names, code
 * shapes, party membership and who is allowed to do what, and never takes a
 * client's word for who it is beyond the bearer id it presented — which is
 * exactly as strong as `identity.ts` says it is, and no stronger.
 */

/** Bumped when a message below changes shape. Independent of the game's. */
export const LOBBY_VERSION = 1;

/** What somebody is doing, as far as their friends can see. */
export type Presence = 'offline' | 'online' | 'queued' | 'playing';

/** A person, as everyone else sees them. Never carries a player id. */
export interface PublicPlayer {
  /** The short shareable code. This is the handle everything else refers to. */
  code: string;
  name: string;
  presence: Presence;
}

/**
 * A party, as its members see it.
 *
 * Members are listed by code rather than by id, for the same reason every other
 * message here is: a player id is a credential, and a party list is shown on a
 * screen. Sending ids round a party would hand every member the ability to be
 * every other member.
 */
export interface PartyView {
  /** Opaque handle, minted by the server. */
  id: string;
  /** Whose party it is. Only they may queue it. */
  leaderCode: string;
  members: PublicPlayer[];
}

/** Why something was refused, in words a player can act on. */
export type Refusal =
  | 'version'
  | 'unknown code'
  | 'that is you'
  | 'already a friend'
  | 'not a friend'
  | 'party is full'
  | 'not in a party'
  | 'not the leader'
  | 'already queued'
  | 'not queued'
  | 'rate limited'
  | 'malformed';

/** How many people may be in one party. */
export const MAX_PARTY = 4;

/** How many friends one player may keep. A list, not a social network. */
export const MAX_FRIENDS = 100;

/** Everything a player can say to the lobby. */
export type LobbyClientMessage =
  /**
   * First thing sent, and the only message carrying a player id.
   *
   * The id is the bearer credential from `identity.ts`. The server maps it to a
   * friend code, minting one on first sight.
   */
  | { t: 'hello'; v: number; id: string; name: string }
  /** Change what everyone calls you. */
  | { t: 'rename'; name: string }
  | { t: 'friend.add'; code: string }
  | { t: 'friend.remove'; code: string }
  /** Ask somebody to join your party. Creates one if you are not in a party. */
  | { t: 'party.invite'; code: string }
  | { t: 'party.accept'; party: string }
  | { t: 'party.decline'; party: string }
  | { t: 'party.leave' }
  /** Leader only. */
  | { t: 'party.kick'; code: string }
  /** Join the queue for a mode. Takes your whole party if you lead one. */
  | { t: 'queue.join'; mode: string }
  | { t: 'queue.leave' }
  /**
   * Still here.
   *
   * Sent on a timer rather than relying on the socket, because a socket held
   * open by a laptop that has gone to sleep is indistinguishable from a player
   * who is present — and a queue full of sleeping laptops never matches anyone.
   */
  | { t: 'ping' };

/** Everything the lobby can say to a player. */
export type LobbyServerMessage =
  /** You are known. Carries the code the server assigned you. */
  | { t: 'welcome'; v: number; code: string; name: string }
  | { t: 'refused'; why: Refusal; about?: string }
  /** Your whole friends list, with presence. Sent on change, not on a timer. */
  | { t: 'friends'; friends: PublicPlayer[] }
  /** Your party, or null once you are not in one. */
  | { t: 'party'; party: PartyView | null }
  /** Somebody wants you in their party. */
  | { t: 'party.invited'; party: string; from: PublicPlayer }
  /** Where you are in the queue, or null once you are not in it. */
  | { t: 'queue'; mode: string; waiting: number; needed: number; seconds: number }
  | { t: 'queue.left' }
  /**
   * A match. This is the lobby's entire purpose and its last word on the
   * subject: after this the client connects to the relay and plays.
   */
  | { t: 'matched'; room: string; host: boolean; mode: string; players: PublicPlayer[] }
  | { t: 'pong' };

export type LobbyMessage = LobbyClientMessage | LobbyServerMessage;

export function encodeLobby(message: LobbyMessage): string {
  return JSON.stringify(message);
}

/**
 * Parse a message, or return null.
 *
 * Null rather than throwing, for the same reason the game's decoder does it: the
 * thing on the other end is not under our control, and a malformed frame must
 * not take down a server that several people are waiting in.
 */
export function decodeLobby(raw: string): LobbyMessage | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    if (typeof (parsed as { t?: unknown }).t !== 'string') return null;
    return parsed as LobbyMessage;
  } catch {
    return null;
  }
}

/**
 * How many players a mode wants before it will start.
 *
 * Small on purpose. A party game that needs eight people to begin is a party
 * game nobody plays, and every mode here already fills the field with bots — so
 * two humans is a real match and four is a good one.
 */
export const MODE_TARGET: Readonly<Record<string, number>> = {
  captureTheFlag: 4,
  fortDefense: 2,
  waterWar: 2,
};

/** The modes the queue will accept, so a typo cannot open an unmatched queue. */
export const QUEUE_MODES = Object.keys(MODE_TARGET);

export function targetFor(mode: string): number {
  return MODE_TARGET[mode] ?? 2;
}
