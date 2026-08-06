/**
 * The lobby, from the browser's side.
 *
 * Holds one long-lived socket for as long as the game is open, and turns the
 * messages on it into a small piece of state the screen can draw: your code,
 * your friends, your party, and whether you are in a queue. Everything it knows
 * came from the server, so there is nothing here that can be right when the
 * server is wrong.
 *
 * ## Separate from the game's connection, deliberately
 *
 * This socket is not the one a match runs on. The lobby hands over a room name
 * and steps back; the game then opens its own connection to the relay and
 * speaks a protocol the lobby has never heard of. Two consequences worth
 * stating, because both are the point:
 *
 * - The lobby can drop mid-match without touching the match. A friends list
 *   going quiet is not a reason for a round to end.
 * - The game's wire format can change without this file moving, exactly as it
 *   already can without the relay moving.
 *
 * ## The link is injected
 *
 * A `Link` rather than a `WebSocket`, so the whole client can be driven in a
 * test by two queues — the same trade `transport.ts` makes for the game, and
 * for the same reason: a test that needs a server is a test that gets skipped
 * in CI and then stops being true.
 */

import type { IdentityStore } from '../app/identity.ts';
import {
  LOBBY_VERSION, decodeLobby, encodeLobby,
  type LobbyClientMessage, type PartyView, type PublicPlayer, type Refusal,
} from './lobbyProtocol.ts';

/** Whatever carries text both ways. A WebSocket satisfies this; so does a queue. */
export interface Link {
  send(text: string): void;
  close(): void;
  onMessage: ((text: string) => void) | null;
  onOpen: (() => void) | null;
  onClose: (() => void) | null;
}

/** An invitation waiting to be answered. */
export interface Invitation {
  party: string;
  from: PublicPlayer;
}

/** What the queue is doing, or null when not in one. */
export interface QueueState {
  mode: string;
  waiting: number;
  needed: number;
  seconds: number;
}

/** Everything the lobby screen draws. */
export interface LobbyState {
  connected: boolean;
  /** Your own code, once the server has said. */
  code: string | null;
  name: string;
  friends: PublicPlayer[];
  party: PartyView | null;
  invitations: Invitation[];
  queue: QueueState | null;
  /** The last refusal, for showing next to whatever was refused. */
  problem: string | null;
}

/** A match, handed over for the game to connect to. */
export interface Matched {
  room: string;
  host: boolean;
  mode: string;
  players: PublicPlayer[];
}

/** Heartbeat interval. Comfortably inside the server's idle timeout. */
export const PING_MS = 15_000;

/** `ws://host:port` becomes `ws://host:port/lobby`. */
export function lobbyUrl(base: string): string {
  const trimmed = base.replace(/\/+$/, '');
  return `${trimmed}/lobby`;
}

/** A refusal, as a line a player can act on. */
function explain(why: Refusal, about?: string): string {
  switch (why) {
    case 'version': return 'This game is a different version from the lobby.';
    case 'unknown code': return `Nobody here has the code ${about ?? ''}`.trim();
    case 'that is you': return 'That is your own code.';
    case 'already a friend': return 'They are already on your list.';
    case 'not a friend': return 'They are not on your list.';
    case 'party is full': return 'That party is full.';
    case 'not in a party': return 'You are not in a party.';
    case 'not the leader': return 'Only whoever started the party can do that.';
    case 'already queued': return 'You are already in the queue.';
    case 'not queued': return 'You are not in the queue.';
    case 'rate limited': return 'That is more than the lobby will hold.';
    default: return 'The lobby did not understand that.';
  }
}

export class LobbyClient {
  private link: Link | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  private readonly state: LobbyState = {
    connected: false,
    code: null,
    name: 'kid',
    friends: [],
    party: null,
    invitations: [],
    queue: null,
    problem: null,
  };

  /**
   * @param onChange called whenever anything the screen draws has moved.
   * @param onMatched called once per match, with the room to go and play in.
   */
  constructor(
    private readonly identity: IdentityStore,
    private readonly onChange: (state: Readonly<LobbyState>) => void,
    private readonly onMatched: (match: Matched) => void,
  ) {
    this.state.code = identity.friendCode;
    this.state.name = identity.name;
  }

  get current(): Readonly<LobbyState> {
    return this.state;
  }

  /**
   * Attach a link and introduce ourselves.
   *
   * The hello waits for the socket to open rather than being sent immediately,
   * because a browser's `WebSocket.send` before `open` throws — and a lobby that
   * threw during connection would take the title screen down with it.
   */
  connect(link: Link): void {
    this.disconnect();
    this.link = link;
    link.onOpen = (): void => {
      link.send(encodeLobby({
        t: 'hello', v: LOBBY_VERSION, id: this.identity.playerId, name: this.identity.name,
      }));
    };
    link.onMessage = (text): void => this.receive(text);
    link.onClose = (): void => {
      this.state.connected = false;
      // The queue and the party are the server's state, not ours. Keeping them
      // on screen after the socket died would show somebody a search that is
      // not running and a party that cannot hear them.
      this.state.queue = null;
      this.state.party = null;
      this.state.invitations.length = 0;
      this.changed();
    };
    this.timer = setInterval(() => this.say({ t: 'ping' }), PING_MS);
  }

  disconnect(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.link?.close();
    this.link = null;
    this.state.connected = false;
    this.state.queue = null;
    this.state.party = null;
    this.state.invitations.length = 0;
  }

  private say(message: LobbyClientMessage): void {
    if (this.link === null) return;
    this.link.send(encodeLobby(message));
  }

  // ── Things the screen asks for ──────────────────────────────────────────────

  rename(name: string): void {
    this.identity.setName(name);
    this.state.name = this.identity.name;
    this.say({ t: 'rename', name: this.identity.name });
    this.changed();
  }

  addFriend(code: string): void { this.say({ t: 'friend.add', code }); }
  removeFriend(code: string): void { this.say({ t: 'friend.remove', code }); }
  invite(code: string): void { this.say({ t: 'party.invite', code }); }
  leaveParty(): void { this.say({ t: 'party.leave' }); }
  kick(code: string): void { this.say({ t: 'party.kick', code }); }
  joinQueue(mode: string): void { this.say({ t: 'queue.join', mode }); }
  leaveQueue(): void { this.say({ t: 'queue.leave' }); }

  accept(party: string): void {
    this.say({ t: 'party.accept', party });
    this.forgetInvitation(party);
  }

  decline(party: string): void {
    this.say({ t: 'party.decline', party });
    this.forgetInvitation(party);
  }

  /**
   * Dropped locally as well as on the server.
   *
   * The server sends no acknowledgement for either answer — there is nothing
   * useful it could say — so a card that waited for one would sit on screen
   * until the next unrelated message arrived.
   */
  private forgetInvitation(party: string): void {
    const at = this.state.invitations.findIndex((i) => i.party === party);
    if (at !== -1) {
      this.state.invitations.splice(at, 1);
      this.changed();
    }
  }

  // ── What the server says ───────────────────────────────────────────────────

  private receive(text: string): void {
    const message = decodeLobby(text);
    if (message === null) return;

    switch (message.t) {
      case 'welcome':
        this.state.connected = true;
        this.state.code = message.code;
        this.state.name = message.name;
        this.state.problem = null;
        // Cached so the screen can show a code before the socket is up next
        // time. The server owns it; this is only a copy.
        this.identity.setFriendCode(message.code);
        break;

      case 'refused':
        this.state.problem = explain(message.why, message.about);
        // A version mismatch is the one refusal that is not about something the
        // player just tried, and the connection is over rather than retryable.
        if (message.why === 'version') this.state.connected = false;
        break;

      case 'friends':
        this.state.friends = message.friends;
        this.state.problem = null;
        break;

      case 'party':
        this.state.party = message.party;
        break;

      case 'party.invited':
        // Replaced rather than appended when the same party asks twice, or a
        // leader clicking invite three times stacks three identical cards.
        this.forgetInvitationQuietly(message.party);
        this.state.invitations.push({ party: message.party, from: message.from });
        break;

      case 'queue':
        this.state.queue = {
          mode: message.mode, waiting: message.waiting,
          needed: message.needed, seconds: message.seconds,
        };
        break;

      case 'queue.left':
        this.state.queue = null;
        break;

      case 'matched':
        this.state.queue = null;
        this.onMatched({
          room: message.room, host: message.host,
          mode: message.mode, players: message.players,
        });
        break;

      case 'pong':
      default:
        return;
    }
    this.changed();
  }

  private forgetInvitationQuietly(party: string): void {
    const at = this.state.invitations.findIndex((i) => i.party === party);
    if (at !== -1) this.state.invitations.splice(at, 1);
  }

  private changed(): void {
    this.onChange(this.state);
  }
}

/** A `Link` over a real browser WebSocket. */
export function socketLink(url: string): Link {
  const socket = new WebSocket(url);
  const link: Link = {
    send: (text) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(text);
    },
    close: () => socket.close(),
    onMessage: null,
    onOpen: null,
    onClose: null,
  };
  socket.addEventListener('open', () => link.onOpen?.());
  socket.addEventListener('close', () => link.onClose?.());
  // An error on a WebSocket is always followed by a close, so it is reported
  // through the same path rather than as a second kind of failure to handle.
  socket.addEventListener('error', () => link.onClose?.());
  socket.addEventListener('message', (event: MessageEvent) => {
    if (typeof event.data === 'string') link.onMessage?.(event.data);
  });
  return link;
}
