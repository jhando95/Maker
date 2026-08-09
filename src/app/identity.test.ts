/**
 * Identity, and the four ways it could quietly stop being one.
 *
 * Almost nothing here is about the happy path, because the happy path is a uuid
 * in a JSON blob and there is not much to get wrong. What is worth testing is
 * what happens when the blob is damaged, when a player types a code the way a
 * person types rather than the way a machine stores one, and when storage is not
 * there at all — because in every one of those cases the tempting behaviour is
 * to issue a fresh id, and a fresh id makes somebody a stranger to everyone who
 * had added them.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  IdentityStore, cleanName, formatCode, isCodeShaped, normalizeCode,
  CODE_ALPHABET, CODE_LENGTH, MAX_NAME,
} from './identity.ts';

/** A localStorage that lives in a variable, so a test can damage it on purpose. */
function fakeStorage(): Storage & { raw: Map<string, string> } {
  const raw = new Map<string, string>();
  return {
    raw,
    get length(): number { return raw.size; },
    clear: () => raw.clear(),
    getItem: (k: string) => raw.get(k) ?? null,
    key: (i: number) => [...raw.keys()][i] ?? null,
    removeItem: (k: string) => { raw.delete(k); },
    setItem: (k: string, v: string) => { raw.set(k, v); },
  };
}

let store: ReturnType<typeof fakeStorage>;

beforeEach(() => {
  store = fakeStorage();
  vi.stubGlobal('localStorage', store);
});

describe('friend codes', () => {
  it('reads back however a person typed it', () => {
    // Somebody reads a code off a screen and somebody else types it in. They
    // will get the case wrong and the dash wrong, and refusing them over either
    // would be a bug wearing a validation message.
    for (const typed of ['k7q-2mx', 'K7Q2MX', ' K7Q - 2MX ', 'k7q 2mx']) {
      expect(normalizeCode(typed), typed).toBe('K7Q2MX');
    }
  });

  it('groups a code for reading aloud without changing what it is', () => {
    expect(formatCode('K7Q2MX')).toBe('K7Q-2MX');
    expect(normalizeCode(formatCode('K7Q2MX'))).toBe('K7Q2MX');
  });

  it('leaves something that is not a code alone rather than inventing a dash', () => {
    expect(formatCode('NOPE')).toBe('NOPE');
  });

  it('rejects the characters that exist to be confused', () => {
    // The whole point of the alphabet. A code containing O or I or L would be
    // read out over a game of tag and typed as 0 or 1, and the failure would
    // look like the other person getting it wrong.
    for (const c of 'OIL01AEU') {
      expect(CODE_ALPHABET.includes(c), `${c} should not be in the alphabet`).toBe(false);
    }
    expect(isCodeShaped('K7Q2MO')).toBe(false);
    expect(isCodeShaped('K7Q2M1')).toBe(false);
    expect(isCodeShaped('K7Q2MX')).toBe(true);
  });

  it('knows a code by its length as well as its letters', () => {
    expect(isCodeShaped('K7Q2M')).toBe(false);
    expect(isCodeShaped('K7Q2MXX')).toBe(false);
    expect(isCodeShaped('')).toBe(false);
    expect('K7Q2MX'.length).toBe(CODE_LENGTH);
  });
});

describe('names', () => {
  it('takes what somebody typed', () => {
    expect(cleanName('mia')).toBe('mia');
  });

  it('never returns an empty one', () => {
    // A nameless character in a party list is a gap somebody has to guess at.
    expect(cleanName('')).toBe('kid');
    expect(cleanName('   ')).toBe('kid');
  });

  it('drops control characters instead of refusing the name', () => {
    // They cannot be typed by accident, so anything containing them arrived
    // from a paste or a script. Silently dropping them is kinder than an error
    // nobody can act on. Built from codepoints rather than written as literals,
    // because a control character in a source file is invisible to read.
    const nul = String.fromCodePoint(0);
    const bell = String.fromCodePoint(7);
    const esc = String.fromCodePoint(0x1b);
    const del = String.fromCodePoint(0x7f);
    const c1 = String.fromCodePoint(0x9b);

    expect(cleanName(`mi${nul}a`)).toBe('mia');
    expect(cleanName(`${bell}mia${esc}`)).toBe('mia');
    expect(cleanName(`mia${del}`)).toBe('mia');
    expect(cleanName(`m${c1}ia`)).toBe('mia');
    // A newline is a control character too, and a name spanning two lines would
    // break every layout it appears in.
    expect(cleanName('mi\na')).toBe('mia');
  });

  it('cuts a very long name to something that fits over a head', () => {
    expect(cleanName('x'.repeat(200))).toHaveLength(MAX_NAME);
  });
});

describe('IdentityStore', () => {
  it('makes an id on first run and keeps it afterwards', () => {
    const first = new IdentityStore('test.id');
    const id = first.playerId;
    expect(id.length).toBeGreaterThan(8);
    expect(new IdentityStore('test.id').playerId).toBe(id);
  });

  it('does not hand out the same id to two browsers', () => {
    const a = new IdentityStore('test.a').playerId;
    const b = new IdentityStore('test.b').playerId;
    expect(a).not.toBe(b);
  });

  it('remembers a name and a code across a reload', () => {
    const first = new IdentityStore('test.id');
    first.setName('mia');
    first.setFriendCode('k7q-2mx');

    const reloaded = new IdentityStore('test.id');
    expect(reloaded.name).toBe('mia');
    // Stored normalized, so a comparison never has to know about the dash.
    expect(reloaded.friendCode).toBe('K7Q2MX');
  });

  it('keeps the id when the rest of the blob is rubbish', () => {
    // The important one. Every other field can be defaulted; issuing a new id
    // makes somebody a stranger to everyone who had added them, which is the
    // one failure a friends list cannot survive.
    store.raw.set('test.id', JSON.stringify({
      playerId: 'the-real-one', name: 42, friendCode: 'not a code',
    }));
    const loaded = new IdentityStore('test.id');
    expect(loaded.playerId).toBe('the-real-one');
    expect(loaded.name).toBe('kid');
    expect(loaded.friendCode).toBeNull();
  });

  it('starts over only when there is no usable id at all', () => {
    store.raw.set('test.id', JSON.stringify({ name: 'mia' }));
    const loaded = new IdentityStore('test.id');
    expect(loaded.playerId.length).toBeGreaterThan(8);
    expect(loaded.name).toBe('kid');
  });

  it('survives a blob that is not JSON', () => {
    store.raw.set('test.id', 'not json {{{');
    expect(new IdentityStore('test.id').playerId.length).toBeGreaterThan(8);
  });

  it('still works with no storage at all', () => {
    // Private browsing, or an origin with storage blocked. An identity that
    // lasts as long as the tab is a worse experience than a remembered one and
    // is not a broken one — but throwing here would take the whole app down on
    // boot, which is.
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    });
    const loaded = new IdentityStore('test.id');
    expect(loaded.playerId.length).toBeGreaterThan(8);
    expect(() => loaded.setName('mia')).not.toThrow();
    expect(loaded.name).toBe('mia');
  });

  it('writes the identity out the first time rather than only on a change', () => {
    // Otherwise a player who never opens settings gets a new id every run, and
    // the friends list they are in decays without anybody touching it.
    new IdentityStore('test.id');
    expect(store.raw.has('test.id')).toBe(true);
  });
});
