/**
 * Everything one player says to another.
 *
 * Chat, pings and emotes look like three features and are one: somebody
 * produces a thing, some subset of the people in the world are entitled to
 * receive it, and it lives on their screen for a few seconds. Building them
 * separately would mean writing the audibility rule three times and getting it
 * subtly different three times — which is how a game ends up with team chat
 * that is private and team pings that are not.
 *
 * ## Two rules, and the difference between them matters
 *
 * **Who is entitled to hear this** is decided by the host, per recipient, and
 * nothing a client does can widen it. Team chat is not sent to the other team
 * at all. The tempting version broadcasts everything and lets each client show
 * what it should — which works perfectly until somebody runs a client that
 * does not, and then the other team has been reading your callouts all game.
 * A filter on the receiving end is a convention, not a rule.
 *
 * **Whether you want to hear it** is decided by the listener, locally, and
 * needs no wire traffic at all. Muting somebody is a statement about your own
 * screen. Sending it to the host would make it something the host has to
 * remember, something that has to survive a reconnect, and — worst — something
 * the muted player could in principle be told about.
 *
 * So: audibility travels, mutes do not.
 *
 * ## Why proximity is measured once
 *
 * A `near` line is audible to whoever was close enough **when it was said**.
 * Not continuously: a message that vanished from your log because the speaker
 * walked away would be a message you had already read, and one that appeared
 * late because they walked back is worse. Shouting is an event, and an event
 * happens at a time and a place.
 */

import type { Team } from './actor.ts';

/** Where something was said. */
export type Channel = 'team' | 'near';

/**
 * How far a `near` message carries, in metres.
 *
 * A little over half the lot, so the two gardens are separate conversations and
 * a shout across your own one always lands. Tuned against the map rather than
 * picked: the house is the divider this game is built around, and proximity
 * chat that reached straight through it would say the divider is not there.
 */
export const NEAR_RADIUS = 26;

/** What a ping means. Deliberately few — a wheel of twenty is a wheel nobody learns. */
export type PingKind = 'look' | 'here' | 'danger' | 'help';

/** What an emote is. Same reasoning. */
export type EmoteKind = 'wave' | 'yes' | 'no' | 'sorry' | 'nice' | 'oops';

/**
 * What each emote says on screen.
 *
 * Words rather than pictures, and that is a real decision rather than a
 * shortcut. A wheel of six symbols is six things to learn before the first one
 * works; six short words are legible the first time somebody sees one, in a
 * game whose whole visual language is already flat shapes and hard outlines.
 * Swapping in art later changes this table and nothing else.
 */
export const EMOTE_LABELS: Readonly<Record<EmoteKind, string>> = {
  wave: '👋 hi',
  yes: '👍 yes',
  no: '👎 no',
  sorry: '😅 sorry',
  nice: '🎉 nice!',
  oops: '💦 oops',
};

/** The order they appear in the wheel, which is also their number-key order. */
export const EMOTE_ORDER: readonly EmoteKind[] = ['wave', 'yes', 'no', 'nice', 'sorry', 'oops'];

/**
 * A colour each, for the wheel.
 *
 * Warm for the friendly half and cool for the awkward half, so the wheel can be
 * read by where a colour is before the word is: "yes" and "nice" are the ones
 * people reach for without looking, and they sit together in green.
 *
 * Beside the labels rather than in the UI, because these three tables describe
 * one thing — a table in `hud.ts` would be a fourth place to remember when a
 * seventh emote is added, and there is a test that walks all of them.
 */
export const EMOTE_COLORS: Readonly<Record<EmoteKind, string>> = {
  wave: '#f4a259',
  yes: '#7ddf64',
  no: '#e8697d',
  nice: '#5ec98a',
  sorry: '#9b8fe8',
  oops: '#6ec6ff',
};

/** Seconds a ping stays in the world. */
export const PING_LIFETIME = 6;
/** Seconds an emote floats over somebody's head. */
export const EMOTE_LIFETIME = 2.6;
/**
 * Seconds a chat line stays on screen.
 *
 * Long enough to read three of them, short enough that the corner is empty
 * again by the time it matters. The log is not a transcript — anybody who
 * wants one wants a different feature.
 */
export const CHAT_LIFETIME = 11;

/** How many lines are kept, however recent. */
export const CHAT_HISTORY = 6;

/**
 * How often one person may ping, in seconds.
 *
 * Pings are the one thing here that marks the world rather than the screen, so
 * they are also the one thing worth spamming. A rate limit on the *host* rather
 * than on the client, because a limit a client enforces on itself is a limit
 * only honest clients have.
 */
export const PING_COOLDOWN = 0.8;
/** The same, for the two that are only ever noise. */
export const SAY_COOLDOWN = 0.5;

/** The longest a chat line may be. */
export const MAX_CHAT = 120;

export interface ChatLine {
  /** Rising, so a log can be diffed and a renderer can key on it. */
  readonly seq: number;
  readonly from: number;
  readonly name: string;
  readonly channel: Channel;
  readonly text: string;
  /** Seconds since the log started, for expiry. */
  readonly at: number;
}

export interface WorldPing {
  readonly seq: number;
  readonly from: number;
  readonly kind: PingKind;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly at: number;
}

export interface WorldEmote {
  readonly from: number;
  readonly kind: EmoteKind;
  readonly at: number;
}

/** What the host needs to know about somebody to decide what they may hear. */
export interface Listener {
  readonly id: number;
  readonly team: Team;
  readonly x: number;
  readonly z: number;
}

/**
 * Is this listener entitled to a message sent on `channel` from `speaker`?
 *
 * The one place the rule is written. A speaker always hears themselves, which
 * is not vanity — it is the acknowledgement that the message went somewhere,
 * and without it a player whose chat is silently failing has no way to tell.
 */
export function audible(
  channel: Channel,
  speaker: Listener,
  listener: Listener,
  radius = NEAR_RADIUS,
): boolean {
  if (speaker.id === listener.id) return true;
  if (channel === 'team') return speaker.team === listener.team;
  const dx = speaker.x - listener.x;
  const dz = speaker.z - listener.z;
  return dx * dx + dz * dz <= radius * radius;
}

/** Trim, collapse and cap a line somebody typed. Returns null if there is nothing left. */
export function cleanChat(raw: string): string | null {
  let out = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    // Tab, newline and carriage return become a space; every other control
    // character goes. The distinction is not pedantry — deleting them all welds
    // words together, so a message pasted from two lines arrives as "onetwo".
    if (code === 9 || code === 10 || code === 13) {
      out += ' ';
      continue;
    }
    // C0, DEL and C1 out. Filtered by codepoint rather than by a regex over a
    // literal, because a control character written into a source file makes the
    // file itself unreadable — a mistake this project has already made once.
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue;
    out += ch;
  }
  out = out.replace(/\s+/g, ' ').trim();
  if (out.length === 0) return null;
  return out.length > MAX_CHAT ? out.slice(0, MAX_CHAT) : out;
}

/**
 * What one machine currently has to show.
 *
 * Held by the shell rather than by a mode, because none of this is a rule of
 * any game: you can ping in Free Build, and a round ending does not end a
 * conversation.
 */
export class CommsLog {
  private readonly lines: ChatLine[] = [];
  private readonly pings: WorldPing[] = [];
  private readonly emotes = new Map<number, WorldEmote>();
  /** Local, never sent. See the header. */
  private readonly muted = new Set<number>();
  private mutedChannels = new Set<Channel>();
  private clock = 0;
  private seq = 0;

  /** Advance the clock and drop anything that has expired. */
  tick(dt: number): void {
    this.clock += dt;
    while (this.lines.length > 0 && this.clock - this.lines[0]!.at > CHAT_LIFETIME) {
      this.lines.shift();
    }
    for (let i = this.pings.length - 1; i >= 0; i--) {
      if (this.clock - this.pings[i]!.at > PING_LIFETIME) this.pings.splice(i, 1);
    }
    for (const [id, emote] of this.emotes) {
      if (this.clock - emote.at > EMOTE_LIFETIME) this.emotes.delete(id);
    }
  }

  /**
   * Take a line that has already been decided as audible.
   *
   * Returns false when it was dropped, which the caller uses to decide whether
   * to make a sound — a muted player's message must not announce itself, or the
   * mute is a mute of the words and not of the person.
   */
  say(from: number, name: string, channel: Channel, text: string): boolean {
    if (this.silenced(from, channel)) return false;
    const clean = cleanChat(text);
    if (clean === null) return false;
    this.lines.push({ seq: this.seq++, from, name, channel, text: clean, at: this.clock });
    while (this.lines.length > CHAT_HISTORY) this.lines.shift();
    return true;
  }

  ping(from: number, kind: PingKind, x: number, y: number, z: number): boolean {
    if (this.muted.has(from)) return false;
    this.pings.push({ seq: this.seq++, from, kind, x, y, z, at: this.clock });
    return true;
  }

  /**
   * One emote per person at a time.
   *
   * A queue would let somebody stack six and have them play out over fifteen
   * seconds after they stopped pressing anything, which reads as a broken
   * animation rather than as expression.
   */
  emote(from: number, kind: EmoteKind): boolean {
    if (this.muted.has(from)) return false;
    this.emotes.set(from, { from, kind, at: this.clock });
    return true;
  }

  private silenced(from: number, channel: Channel): boolean {
    return this.muted.has(from) || this.mutedChannels.has(channel);
  }

  /** Stop hearing one person, in every channel and in the world. */
  mute(id: number): void {
    this.muted.add(id);
    for (let i = this.pings.length - 1; i >= 0; i--) {
      if (this.pings[i]!.from === id) this.pings.splice(i, 1);
    }
    this.emotes.delete(id);
  }

  unmute(id: number): void {
    this.muted.delete(id);
  }

  isMuted(id: number): boolean {
    return this.muted.has(id);
  }

  /** Turn a whole channel off. Drops what is already on screen from it. */
  muteChannel(channel: Channel, off: boolean): void {
    if (off) this.mutedChannels.add(channel);
    else this.mutedChannels.delete(channel);
    if (!off) return;
    for (let i = this.lines.length - 1; i >= 0; i--) {
      if (this.lines[i]!.channel === channel) this.lines.splice(i, 1);
    }
  }

  isChannelMuted(channel: Channel): boolean {
    return this.mutedChannels.has(channel);
  }

  get chat(): readonly ChatLine[] {
    return this.lines;
  }

  get worldPings(): readonly WorldPing[] {
    return this.pings;
  }

  emoteOf(id: number): WorldEmote | undefined {
    return this.emotes.get(id);
  }

  get now(): number {
    return this.clock;
  }

  clear(): void {
    this.lines.length = 0;
    this.pings.length = 0;
    this.emotes.clear();
  }
}

/**
 * How often somebody is allowed to do a thing, kept per person.
 *
 * On the host, where it is a rule, rather than on the client, where it would be
 * a suggestion. Separate from `CommsLog` because the log is what one machine
 * shows and this is what the authority permits — the host runs both, a guest
 * runs only the first, and merging them would give every client a rate limiter
 * that governs nobody.
 */
export class RateLimit {
  private readonly last = new Map<number, number>();
  private clock = 0;

  constructor(private readonly gap: number) {}

  tick(dt: number): void {
    this.clock += dt;
  }

  /** True when this person may go again, and records that they did. */
  allow(id: number): boolean {
    const previous = this.last.get(id);
    if (previous !== undefined && this.clock - previous < this.gap) return false;
    this.last.set(id, this.clock);
    return true;
  }

  forget(id: number): void {
    this.last.delete(id);
  }
}
