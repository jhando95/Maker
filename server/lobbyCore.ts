/**
 * Friends, parties and a queue — as rules, with no socket anywhere near them.
 *
 * Separated from `lobby.ts` for exactly the reason `transport.ts` separates the
 * game from its WebSocket: it lets every rule here be exercised in-process, and
 * a test that has to stand up a server is a test that gets skipped in CI and
 * then stops being true. Sending is a callback. Time is a parameter. Nothing in
 * this file knows what a socket is.
 *
 * ## Everything is addressed by friend code, never by player id
 *
 * A player id is a bearer credential — `identity.ts` is explicit that whoever
 * holds the string is you. A party list is something several people look at. So
 * ids stay in this file and in the `hello` that carried one, and every message
 * that leaves names people by their code.
 *
 * ## Players outlive their sockets
 *
 * A `Player` is kept after it disconnects, because a friends list that forgot
 * somebody the moment they closed a tab would not be a friends list. What it
 * loses is its `send`, which is what `presence` reports as `offline`.
 *
 * ## What is deliberately not here
 *
 * Persistence. The lobby's memory is the process's memory, so restarting the
 * server forgets every friendship. That is a real limitation and the right one
 * for now: a database is a deploy target, and the thing this is for is two
 * people on one network playing in the same afternoon. The seam is `Lobby`'s
 * own state — a store would replace the three maps below and nothing else.
 */

import {
  LOBBY_VERSION, MAX_FRIENDS, MAX_PARTY, QUEUE_MODES, targetFor,
  type LobbyClientMessage, type LobbyServerMessage, type PartyView,
  cleanLook, PLAIN_LOOK,
  type Look, type Presence, type PublicPlayer, type Refusal,
} from '../src/net/lobbyProtocol.ts';
import { CODE_ALPHABET, CODE_LENGTH, cleanName } from '../src/app/identity.ts';

/** How long a connection may go without saying anything before it is dropped. */
export const IDLE_TIMEOUT_MS = 45_000;

/** How often a queued party is told how it is getting on. */
export const QUEUE_TICK_MS = 1000;

export type Send = (message: LobbyServerMessage) => void;

interface Player {
  id: string;
  code: string;
  name: string;
  /** Friends by code, so a list survives the other person being offline. */
  friends: Set<string>;
  partyId: string | null;
  /** Parties that have asked for this player. */
  invites: Set<string>;
  /** Null when disconnected. The player stays; the socket does not. */
  send: Send | null;
  lastSeen: number;
  /** Set while in a match, so friends see `playing` rather than `online`. */
  playing: boolean;
  /** Three colours, so a friend list is a list of people rather than names. */
  look: Look;
}

interface Party {
  id: string;
  leader: string;
  /** Codes, in join order, leader first. */
  members: string[];
  /** The mode this party is queued for, or null. */
  queued: string | null;
  queuedAt: number;
}

/** Random source, injectable so a test gets the same codes every run. */
export type Random = () => number;

export class Lobby {
  private readonly players = new Map<string, Player>();
  private readonly byCode = new Map<string, string>();
  private readonly parties = new Map<string, Party>();
  private nextParty = 1;
  private nextRoom = 1;

  constructor(private readonly random: Random = Math.random) {}

  get size(): number {
    let n = 0;
    for (const p of this.players.values()) if (p.send !== null) n++;
    return n;
  }

  /**
   * A code nobody else has.
   *
   * Assigned here rather than in the browser because the one property a friend
   * code must have is uniqueness, and nothing in a browser can promise that.
   * The retry loop is bounded: at six characters from a 28-letter alphabet
   * there are 481 million codes, so a collision means either a very large lobby
   * or a broken random source, and spinning forever on the second is worse than
   * giving up.
   */
  private mintCode(): string {
    for (let tries = 0; tries < 64; tries++) {
      let code = '';
      for (let i = 0; i < CODE_LENGTH; i++) {
        code += CODE_ALPHABET[Math.floor(this.random() * CODE_ALPHABET.length)] ?? '2';
      }
      if (!this.byCode.has(code)) return code;
    }
    // Deterministic fallback, so a broken random source degrades into a
    // still-unique code rather than into a hang or a duplicate.
    let n = this.byCode.size;
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) {
      code = (CODE_ALPHABET[n % CODE_ALPHABET.length] ?? '2') + code;
      n = Math.floor(n / CODE_ALPHABET.length);
    }
    return code;
  }

  /**
   * Somebody connected and said who they are.
   *
   * Returns the player's code, or null if they were turned away. A second
   * connection from the same id replaces the first rather than being refused —
   * that is what reopening a tab looks like, and refusing it would lock someone
   * out of their own identity until a timeout expired.
   */
  hello(id: string, name: string, version: number, send: Send, now: number): string | null {
    if (version !== LOBBY_VERSION) {
      send({ t: 'refused', why: 'version' });
      return null;
    }
    let player = this.players.get(id);
    if (player === undefined) {
      const code = this.mintCode();
      player = {
        id, code, name: cleanName(name),
        friends: new Set(), partyId: null, invites: new Set(),
        send, lastSeen: now, playing: false, look: PLAIN_LOOK,
      };
      this.players.set(id, player);
      this.byCode.set(code, id);
    } else {
      // Displace the old socket. Told rather than dropped silently, so the
      // older tab can say what happened instead of looking frozen.
      player.send?.({ t: 'refused', why: 'malformed', about: 'opened elsewhere' });
      player.send = send;
      player.name = cleanName(name);
      player.lastSeen = now;
    }

    send({ t: 'welcome', v: LOBBY_VERSION, code: player.code, name: player.name });
    this.sendFriends(player);
    this.sendParty(player);
    this.announcePresence(player);
    // Any invitation that arrived while they were away is still live.
    for (const partyId of player.invites) {
      const party = this.parties.get(partyId);
      const leader = party === undefined ? undefined : this.byPublicCode(party.leader);
      if (leader !== undefined) send({ t: 'party.invited', party: partyId, from: leader });
    }
    return player.code;
  }

  /** Their socket went away. They stay; their presence does not. */
  goodbye(id: string): void {
    const player = this.players.get(id);
    if (player === undefined) return;
    player.send = null;
    player.playing = false;
    this.leaveQueueOf(player);
    this.announcePresence(player);
  }

  /** Mark somebody as in a match, so friends see it. */
  setPlaying(id: string, playing: boolean): void {
    const player = this.players.get(id);
    if (player === undefined) return;
    player.playing = playing;
    this.announcePresence(player);
  }

  handle(id: string, message: LobbyClientMessage, now: number): void {
    const player = this.players.get(id);
    if (player === undefined) return;
    player.lastSeen = now;

    switch (message.t) {
      case 'ping': player.send?.({ t: 'pong' }); break;
      case 'rename': this.rename(player, message.name); break;
      case 'look': {
        player.look = cleanLook(message.look);
        // Everybody who has this player in a list, for the same reason a rename
        // does it: a friend who changed their shirt while you were looking at
        // them should not stay the old colour until one of you reconnects.
        this.announcePresence(player);
        this.broadcastParty(player.partyId);
        break;
      }
      case 'friend.add': this.addFriend(player, message.code); break;
      case 'friend.remove': this.removeFriend(player, message.code); break;
      case 'party.invite': this.invite(player, message.code); break;
      case 'party.accept': this.acceptInvite(player, message.party); break;
      case 'party.decline': this.declineInvite(player, message.party); break;
      case 'party.leave': this.leaveParty(player); break;
      case 'party.kick': this.kick(player, message.code); break;
      case 'queue.join': this.joinQueue(player, message.mode, now); break;
      case 'queue.leave': this.leaveQueue(player); break;
      default: break;
    }
  }

  // ── Friends ────────────────────────────────────────────────────────────────

  private rename(player: Player, name: string): void {
    player.name = cleanName(name);
    player.send?.({ t: 'welcome', v: LOBBY_VERSION, code: player.code, name: player.name });
    // Everyone who has them in a list, and everyone in their party, is looking
    // at the old name until told.
    this.announcePresence(player);
    this.broadcastParty(player.partyId);
  }

  private addFriend(player: Player, rawCode: string): void {
    const code = normalize(rawCode);
    if (code === player.code) return this.refuse(player, 'that is you', code);
    const otherId = this.byCode.get(code);
    if (otherId === undefined) return this.refuse(player, 'unknown code', code);
    if (player.friends.has(code)) return this.refuse(player, 'already a friend', code);
    if (player.friends.size >= MAX_FRIENDS) return this.refuse(player, 'rate limited', code);

    const other = this.players.get(otherId)!;
    // Mutual, immediately, with no request to accept.
    //
    // A one-sided list would let somebody watch a stranger's presence without
    // that stranger knowing, which is a worse property than the one a request
    // flow protects — and a request flow protects very little here, because a
    // friend code is only known to somebody you gave it to.
    player.friends.add(code);
    other.friends.add(player.code);
    this.sendFriends(player);
    this.sendFriends(other);
  }

  private removeFriend(player: Player, rawCode: string): void {
    const code = normalize(rawCode);
    if (!player.friends.has(code)) return this.refuse(player, 'not a friend', code);
    player.friends.delete(code);
    this.sendFriends(player);
    const other = this.lookup(code);
    if (other !== undefined) {
      // Removed on both sides, because the list is mutual. Leaving the other
      // half in place would show them a friend who cannot see them back.
      other.friends.delete(player.code);
      this.sendFriends(other);
    }
  }

  private sendFriends(player: Player): void {
    if (player.send === null) return;
    const friends: PublicPlayer[] = [];
    for (const code of player.friends) {
      const other = this.lookup(code);
      if (other !== undefined) friends.push(this.publicOf(other));
    }
    friends.sort((a, b) => rank(a.presence) - rank(b.presence) || a.name.localeCompare(b.name));
    player.send({ t: 'friends', friends });
  }

  /** Tell everyone who has this player in a list that something changed. */
  private announcePresence(player: Player): void {
    for (const code of player.friends) {
      const other = this.lookup(code);
      if (other?.send != null) this.sendFriends(other);
    }
  }

  // ── Parties ────────────────────────────────────────────────────────────────

  private invite(player: Player, rawCode: string): void {
    const code = normalize(rawCode);
    if (code === player.code) return this.refuse(player, 'that is you', code);
    const other = this.lookup(code);
    if (other === undefined) return this.refuse(player, 'unknown code', code);

    let party = player.partyId === null ? undefined : this.parties.get(player.partyId);
    if (party === undefined) {
      party = {
        id: `p${this.nextParty++}`, leader: player.code, members: [player.code],
        queued: null, queuedAt: 0,
      };
      this.parties.set(party.id, party);
      player.partyId = party.id;
      this.sendParty(player);
    }
    if (party.leader !== player.code) return this.refuse(player, 'not the leader', code);
    if (party.members.length >= MAX_PARTY) return this.refuse(player, 'party is full', code);
    if (party.members.includes(code)) return;

    other.invites.add(party.id);
    other.send?.({ t: 'party.invited', party: party.id, from: this.publicOf(player) });
  }

  private acceptInvite(player: Player, partyId: string): void {
    if (!player.invites.has(partyId)) return this.refuse(player, 'malformed', partyId);
    player.invites.delete(partyId);
    const party = this.parties.get(partyId);
    if (party === undefined) return this.refuse(player, 'malformed', partyId);
    if (party.members.length >= MAX_PARTY) return this.refuse(player, 'party is full', partyId);

    // Leaving whatever they were in first, or they would be in two.
    if (player.partyId !== null && player.partyId !== partyId) this.leaveParty(player);
    party.members.push(player.code);
    player.partyId = party.id;
    // Joining takes the party out of the queue rather than joining mid-search:
    // the matchmaker sizes a party when it enters, and a party that grew while
    // waiting would be matched against a number that is no longer true.
    if (party.queued !== null) party.queued = null;
    this.broadcastParty(party.id);
  }

  private declineInvite(player: Player, partyId: string): void {
    player.invites.delete(partyId);
  }

  private leaveParty(player: Player): void {
    const partyId = player.partyId;
    if (partyId === null) return this.refuse(player, 'not in a party');
    const party = this.parties.get(partyId);
    player.partyId = null;
    this.sendParty(player);
    if (party === undefined) return;

    party.members = party.members.filter((c) => c !== player.code);
    if (party.members.length === 0) {
      this.parties.delete(partyId);
      return;
    }
    // The leader leaving hands it to whoever has been there longest, rather
    // than dissolving the party round everybody else.
    if (party.leader === player.code) party.leader = party.members[0]!;
    party.queued = null;
    this.broadcastParty(partyId);
  }

  private kick(player: Player, rawCode: string): void {
    const code = normalize(rawCode);
    const party = player.partyId === null ? undefined : this.parties.get(player.partyId);
    if (party === undefined) return this.refuse(player, 'not in a party', code);
    if (party.leader !== player.code) return this.refuse(player, 'not the leader', code);
    if (code === player.code) return this.refuse(player, 'that is you', code);

    const other = this.lookup(code);
    party.members = party.members.filter((c) => c !== code);
    party.queued = null;
    if (other !== undefined) {
      other.partyId = null;
      this.sendParty(other);
    }
    this.broadcastParty(party.id);
  }

  private partyOf(player: Player): Party | undefined {
    return player.partyId === null ? undefined : this.parties.get(player.partyId);
  }

  private sendParty(player: Player): void {
    if (player.send === null) return;
    const party = this.partyOf(player);
    player.send({ t: 'party', party: party === undefined ? null : this.viewOf(party) });
  }

  private broadcastParty(partyId: string | null): void {
    if (partyId === null) return;
    const party = this.parties.get(partyId);
    if (party === undefined) return;
    const view = this.viewOf(party);
    for (const code of party.members) {
      this.lookup(code)?.send?.({ t: 'party', party: view });
    }
  }

  private viewOf(party: Party): PartyView {
    const members: PublicPlayer[] = [];
    for (const code of party.members) {
      const p = this.lookup(code);
      if (p !== undefined) members.push(this.publicOf(p));
    }
    return { id: party.id, leaderCode: party.leader, members };
  }

  // ── The queue ──────────────────────────────────────────────────────────────

  /**
   * Join the queue, taking your party with you.
   *
   * A solo player is queued as a party of one, made on the spot, so the
   * matchmaker below has exactly one kind of thing to reason about. Trying to
   * match a mixture of loose players and parties is where the off-by-one bugs
   * in this sort of code live.
   */
  private joinQueue(player: Player, mode: string, now: number): void {
    if (!QUEUE_MODES.includes(mode)) return this.refuse(player, 'malformed', mode);
    let party = this.partyOf(player);
    if (party === undefined) {
      party = {
        id: `p${this.nextParty++}`, leader: player.code, members: [player.code],
        queued: null, queuedAt: 0,
      };
      this.parties.set(party.id, party);
      player.partyId = party.id;
      this.sendParty(player);
    }
    if (party.leader !== player.code) return this.refuse(player, 'not the leader', mode);
    if (party.queued !== null) return this.refuse(player, 'already queued', mode);

    party.queued = mode;
    party.queuedAt = now;
    for (const code of party.members) {
      const p = this.lookup(code);
      if (p !== undefined) this.announcePresence(p);
    }
    this.reportQueue(party, now);
  }

  private leaveQueue(player: Player): void {
    const party = this.partyOf(player);
    if (party === undefined || party.queued === null) return this.refuse(player, 'not queued');
    if (party.leader !== player.code) return this.refuse(player, 'not the leader');
    this.stopQueue(party);
  }

  private leaveQueueOf(player: Player): void {
    const party = this.partyOf(player);
    if (party !== undefined && party.queued !== null) this.stopQueue(party);
  }

  private stopQueue(party: Party): void {
    party.queued = null;
    for (const code of party.members) {
      const p = this.lookup(code);
      if (p === undefined) continue;
      p.send?.({ t: 'queue.left' });
      this.announcePresence(p);
    }
  }

  /**
   * Gather waiting parties into matches, and say how the wait is going.
   *
   * Called on a timer rather than on every join, because a queue that only
   * reconsiders when somebody arrives leaves the last party waiting forever
   * after the person ahead of them disconnects.
   *
   * **A party is never split.** That is the one rule the whole feature exists
   * to keep — being separated from the friend you queued with is worse than
   * waiting longer — so the gather below overshoots the target rather than
   * taking part of a party to hit it exactly.
   */
  tick(now: number): void {
    for (const mode of QUEUE_MODES) {
      const target = targetFor(mode);
      const waiting = [...this.parties.values()]
        .filter((p) => p.queued === mode && this.livingMembers(p).length > 0)
        .sort((a, b) => a.queuedAt - b.queuedAt);

      let taken: Party[] = [];
      let count = 0;
      for (const party of waiting) {
        const size = this.livingMembers(party).length;
        // A party larger than the target still gets a match — of its own.
        taken.push(party);
        count += size;
        if (count >= target) {
          this.startMatch(mode, taken);
          taken = [];
          count = 0;
        }
      }
      // Whatever is left keeps waiting, and is told how it is going.
      for (const party of taken) this.reportQueue(party, now);
    }

    this.dropIdle(now);
  }

  private livingMembers(party: Party): Player[] {
    const out: Player[] = [];
    for (const code of party.members) {
      const p = this.lookup(code);
      if (p?.send != null) out.push(p);
    }
    return out;
  }

  private reportQueue(party: Party, now: number): void {
    if (party.queued === null) return;
    const mode = party.queued;
    const target = targetFor(mode);
    const waiting = [...this.parties.values()]
      .filter((p) => p.queued === mode)
      .reduce((n, p) => n + this.livingMembers(p).length, 0);
    const seconds = Math.max(0, Math.round((now - party.queuedAt) / 1000));
    for (const p of this.livingMembers(party)) {
      p.send?.({ t: 'queue', mode, waiting, needed: target, seconds });
    }
  }

  /**
   * Put a set of parties into a yard together.
   *
   * The host is the first player of the first party, which is the one that has
   * been waiting longest. Longest-waiting rather than best-connected because
   * there is nothing here that measures a connection, and inventing a
   * measurement that is really "whoever answered first" would be worse than an
   * honest arbitrary rule.
   */
  private startMatch(mode: string, parties: Party[]): void {
    const room = `q${this.nextRoom++}-${Math.floor(this.random() * 1e6).toString(36)}`;
    const everyone: Player[] = [];
    for (const party of parties) everyone.push(...this.livingMembers(party));
    if (everyone.length === 0) return;

    const players = everyone.map((p) => this.publicOf(p));
    const hostId = everyone[0]!.id;
    for (const player of everyone) {
      player.playing = true;
      player.send?.({ t: 'matched', room, host: player.id === hostId, mode, players });
    }
    for (const party of parties) party.queued = null;
    for (const player of everyone) this.announcePresence(player);
  }

  /**
   * Drop connections that have gone quiet.
   *
   * A socket held open by a laptop that has gone to sleep is indistinguishable
   * from a player who is present, and a queue full of sleeping laptops matches
   * nobody into a game they are awake for.
   */
  private dropIdle(now: number): void {
    for (const player of this.players.values()) {
      if (player.send === null) continue;
      if (now - player.lastSeen < IDLE_TIMEOUT_MS) continue;
      this.goodbye(player.id);
    }
  }

  // ── Odds and ends ──────────────────────────────────────────────────────────

  private lookup(code: string): Player | undefined {
    const id = this.byCode.get(code);
    return id === undefined ? undefined : this.players.get(id);
  }

  private byPublicCode(code: string): PublicPlayer | undefined {
    const p = this.lookup(code);
    return p === undefined ? undefined : this.publicOf(p);
  }

  private publicOf(player: Player): PublicPlayer {
    return {
      code: player.code,
      name: player.name,
      presence: this.presenceOf(player),
      look: player.look,
    };
  }

  private presenceOf(player: Player): Presence {
    if (player.send === null) return 'offline';
    if (player.playing) return 'playing';
    const party = this.partyOf(player);
    return party?.queued != null ? 'queued' : 'online';
  }

  private refuse(player: Player, why: Refusal, about?: string): void {
    player.send?.({ t: 'refused', why, ...(about === undefined ? {} : { about }) });
  }

  /** For tests and the status page. */
  codeOf(id: string): string | undefined {
    return this.players.get(id)?.code;
  }
}

function normalize(input: string): string {
  return String(input).toUpperCase().replace(/[^0-9A-Z]/g, '');
}

/** Online first, then queued, then playing, then offline. */
function rank(p: Presence): number {
  return p === 'online' ? 0 : p === 'queued' ? 1 : p === 'playing' ? 2 : 3;
}
