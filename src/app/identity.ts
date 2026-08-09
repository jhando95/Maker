/**
 * Who you are, across tabs and across days.
 *
 * The game has never needed this. A session was two browsers that happened to
 * type the same room name into the same relay, and when the tab closed there was
 * nothing left over. A friends list cannot work that way: "add mia" has to mean
 * something tomorrow, which means somebody has to still be the same somebody.
 *
 * ## Three things, and only one of them is a secret
 *
 * - **`playerId`** is a uuid made here on first run and kept in localStorage. It
 *   is never displayed, and it is what the lobby recognises you by.
 * - **`friendCode`** is short, unambiguous and typable, and it is **assigned by
 *   the server** rather than made here — because the one property a friend code
 *   must have is uniqueness, and nothing in a browser can promise that. It is
 *   cached once the server has said what it is, so the screen can show it before
 *   the socket is up.
 * - **`name`** is whatever you want to be called. Not unique, not checked, not
 *   load-bearing.
 *
 * ## This is not authentication, and it is worth saying so out loud
 *
 * `playerId` is a bearer credential: whoever holds the string is you. It sits in
 * localStorage, where any script on the origin can read it, and it travels to
 * the lobby in the clear over `ws://` on a development server with no TLS.
 * Copying it would let somebody else answer to your friend code.
 *
 * That is a deliberate trade, not an oversight, and it is affordable only
 * because **nothing of value hangs off identity**. There is no inventory, no
 * progression, no purchase and no private message. A friend code buys a place in
 * somebody's list and a way to be invited to a game of tag. If any of those
 * things ever change, this file is the thing that has to be replaced first, and
 * accounts are the replacement.
 */

const STORAGE_KEY = 'maker.identity.v1';

/**
 * Characters a friend code is built from.
 *
 * Crockford's alphabet minus the vowels: no `O` to confuse with `0`, no `I` or
 * `L` to confuse with `1`, and no vowels at all so a random six characters
 * cannot spell something someone has to read out over a game of tag. Kept here
 * as well as on the server because the client validates what a player types
 * before spending a round trip on it.
 */
export const CODE_ALPHABET = '23456789BCDFGHJKMNPQRSTVWXYZ';

/** How many characters a code has, not counting the dash. */
export const CODE_LENGTH = 6;

/** `K7Q-2MX` — grouped for reading aloud, stored and compared without the dash. */
export function formatCode(code: string): string {
  const bare = normalizeCode(code);
  if (bare.length !== CODE_LENGTH) return bare;
  return `${bare.slice(0, 3)}-${bare.slice(3)}`;
}

/**
 * What a typed code really is.
 *
 * Upper-cased, dashes and spaces dropped. Somebody reading a code off a screen
 * to somebody typing it into one will get the case wrong and the dash wrong, and
 * refusing them over either would be a bug wearing a validation message.
 */
export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

/** Could this be a friend code at all? Checked before spending a round trip. */
export function isCodeShaped(input: string): boolean {
  const bare = normalizeCode(input);
  return bare.length === CODE_LENGTH && [...bare].every((c) => CODE_ALPHABET.includes(c));
}

/**
 * The longest a name may be.
 *
 * Short enough to sit over a character's head without covering the game, and
 * enforced here as well as on the server — the client so a player finds out
 * while typing, the server because a client is not something to trust.
 */
export const MAX_NAME = 16;

/**
 * A name, cleaned up.
 *
 * Control characters removed rather than rejected: they cannot be typed by
 * accident, so anything containing them arrived from a paste or a script, and
 * silently dropping them is kinder than an error nobody can act on. Empty names
 * become a default, because a nameless character in a party list is a gap
 * somebody has to guess at.
 */
export function cleanName(input: string): string {
  const stripped = [...input]
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      // C0, DEL and C1. Written as a codepoint test rather than a regex literal
      // because a control character inside a source file is invisible to whoever
      // reads it next, and a character class that is wrong by one is impossible
      // to see.
      return !(code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f));
    })
    .join('')
    .trim()
    .slice(0, MAX_NAME);
  return stripped.length === 0 ? 'kid' : stripped;
}

export interface Identity {
  /** Never shown. The lobby knows you by this. */
  readonly playerId: string;
  /** What other people call you. */
  name: string;
  /** Assigned by the server; null until it has said. */
  friendCode: string | null;
}

/**
 * A uuid, from the platform where there is one.
 *
 * `crypto.randomUUID` needs a secure context, which `http://localhost` is and a
 * plain-http address on a LAN is not — and a LAN address is exactly how two
 * people on the same network would play. So there is a fallback, and it draws
 * from `crypto.getRandomValues` rather than `Math.random`: the id is the only
 * thing standing between a player and somebody else's friend code, thin as that
 * is, and a predictable one would be thinner still.
 */
function newPlayerId(): string {
  const c: Crypto | undefined = globalThis.crypto;
  if (c?.randomUUID !== undefined) return c.randomUUID();
  if (c?.getRandomValues !== undefined) {
    const bytes = c.getRandomValues(new Uint8Array(16));
    return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // No crypto at all. Rather than silently issuing a guessable id, say so in the
  // value itself, so anything that ends up looking at one knows what it has.
  return `insecure-${Date.now().toString(36)}`;
}

/**
 * The identity for this browser, made on first run and kept afterwards.
 *
 * A class rather than a module-level value, so a test can have one without
 * touching the page's, and so the storage key is injectable for the same reason.
 */
export class IdentityStore {
  private identity: Identity;

  constructor(private readonly key = STORAGE_KEY) {
    this.identity = this.load();
  }

  get current(): Readonly<Identity> {
    return this.identity;
  }

  get playerId(): string {
    return this.identity.playerId;
  }

  get name(): string {
    return this.identity.name;
  }

  setName(name: string): void {
    this.identity.name = cleanName(name);
    this.save();
  }

  /**
   * Remember what the server called us.
   *
   * Cached so the screen can show a code before the socket is up. It is the
   * server's to assign and this is only a copy, so a disagreement is always
   * resolved the server's way — which is what happens naturally, because this is
   * only ever written from what it sent.
   */
  setFriendCode(code: string | null): void {
    this.identity.friendCode = code === null ? null : normalizeCode(code);
    this.save();
  }

  get friendCode(): string | null {
    return this.identity.friendCode;
  }

  private load(): Identity {
    const fresh: Identity = { playerId: newPlayerId(), name: 'kid', friendCode: null };
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(this.key);
    } catch {
      // Private browsing or a blocked origin. A fresh identity every run is a
      // worse experience than a remembered one and is not a broken one.
      return fresh;
    }
    if (raw === null) {
      this.identity = fresh;
      this.save();
      return fresh;
    }

    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return fresh;
      const record = parsed as Record<string, unknown>;
      const id = record['playerId'];
      // A stored blob with no usable id is not an identity, whatever else is in
      // it. Taking the name off it and issuing a new id would silently make
      // somebody a stranger to everyone who had added them.
      if (typeof id !== 'string' || id.length === 0) return fresh;
      const name = record['name'];
      const code = record['friendCode'];
      return {
        playerId: id,
        name: typeof name === 'string' ? cleanName(name) : 'kid',
        friendCode: typeof code === 'string' && isCodeShaped(code) ? normalizeCode(code) : null,
      };
    } catch {
      return fresh;
    }
  }

  private save(): void {
    try {
      localStorage.setItem(this.key, JSON.stringify(this.identity));
    } catch {
      // Storage unavailable; this identity lasts as long as the tab does.
    }
  }
}
