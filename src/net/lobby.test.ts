/**
 * The lobby client, driven against the real server.
 *
 * Both halves in one process, joined by a pair of queues — the same shape
 * `session.test.ts` uses for the game. That is worth more than mocking the
 * server's replies, because the thing most likely to be wrong is a
 * disagreement between the two about what a message means, and a mock agrees
 * with whoever wrote it.
 *
 * What is tested here is only what the client adds: turning a stream of
 * messages into the small piece of state a screen draws, and doing something
 * sensible when the socket dies. The rules themselves belong to
 * `lobbyCore.test.ts` and are not repeated.
 */

import { describe, it, expect, vi } from 'vitest';
import { LobbyClient, lobbyUrl, type Link, type Matched } from './lobby.ts';
import { Lobby } from '../../server/lobbyCore.ts';
import { IdentityStore } from '../app/identity.ts';
import { decodeLobby, encodeLobby, LOBBY_VERSION } from './lobbyProtocol.ts';

function fakeStorage(): Storage {
  const raw = new Map<string, string>();
  return {
    get length(): number { return raw.size; },
    clear: () => raw.clear(),
    getItem: (k: string) => raw.get(k) ?? null,
    key: (i: number) => [...raw.keys()][i] ?? null,
    removeItem: (k: string) => { raw.delete(k); },
    setItem: (k: string, v: string) => { raw.set(k, v); },
  };
}

/**
 * One player: an identity, a client, and a link straight into a shared server.
 *
 * The link delivers synchronously, which is not what a socket does and is
 * exactly what a test wants — every assertion is about state that has already
 * settled rather than about a race.
 */
function connect(lobby: Lobby, id: string, name: string, now = 0): {
  client: LobbyClient;
  matches: Matched[];
  changes: number;
  drop: () => void;
} {
  vi.stubGlobal('localStorage', fakeStorage());
  const identity = new IdentityStore(`id.${id}`);
  // The store makes its own uuid; the test wants a readable one.
  Object.defineProperty(identity, 'playerId', { get: () => id });
  identity.setName(name);

  const matches: Matched[] = [];
  const box = { changes: 0 };
  const client = new LobbyClient(identity, () => { box.changes++; }, (m) => matches.push(m));

  const link: Link = {
    send: (text) => {
      const message = decodeLobby(text);
      if (message === null || !('t' in message)) return;
      if (message.t === 'hello') {
        lobby.hello(id, message.name, message.v, (out) => link.onMessage?.(encodeLobby(out)), now);
        return;
      }
      lobby.handle(id, message as never, now);
    },
    close: () => lobby.goodbye(id),
    onMessage: null,
    onOpen: null,
    onClose: null,
  };

  client.connect(link);
  link.onOpen?.();
  return {
    client, matches,
    get changes(): number { return box.changes; },
    drop: () => { lobby.goodbye(id); link.onClose?.(); },
  };
}

function makeLobby(): Lobby {
  let n = 0;
  return new Lobby(() => {
    n = (n * 1103515245 + 12345) & 0x7fffffff;
    return n / 0x7fffffff;
  });
}

describe('lobbyUrl', () => {
  it('hangs the lobby off whatever address the player typed', () => {
    expect(lobbyUrl('ws://localhost:8787')).toBe('ws://localhost:8787/lobby');
  });

  it('does not double a slash somebody left on the end', () => {
    expect(lobbyUrl('ws://localhost:8787/')).toBe('ws://localhost:8787/lobby');
    expect(lobbyUrl('ws://localhost:8787///')).toBe('ws://localhost:8787/lobby');
  });
});

describe('connecting', () => {
  it('learns its own code and remembers it for next time', () => {
    const lobby = makeLobby();
    const mia = connect(lobby, 'id-mia', 'mia');
    expect(mia.client.current.connected).toBe(true);
    expect(mia.client.current.code).toHaveLength(6);

    // Cached in the identity, so the screen can show a code before the socket
    // is up on the next run.
    const again = new IdentityStore('id.id-mia');
    expect(again.friendCode).toBe(mia.client.current.code);
  });

  it('waits for the socket to open before saying hello', () => {
    // A browser's WebSocket.send before `open` throws, and a lobby that threw
    // during connection would take the title screen down with it.
    const sent: string[] = [];
    const identity = (() => {
      vi.stubGlobal('localStorage', fakeStorage());
      return new IdentityStore('id.solo');
    })();
    const client = new LobbyClient(identity, () => {}, () => {});
    const link: Link = {
      send: (t) => sent.push(t), close: () => {},
      onMessage: null, onOpen: null, onClose: null,
    };
    client.connect(link);
    expect(sent, 'the client spoke before the socket opened').toHaveLength(0);

    link.onOpen?.();
    expect(sent).toHaveLength(1);
    expect(decodeLobby(sent[0]!)).toMatchObject({ t: 'hello', v: LOBBY_VERSION });
  });

  it('says what went wrong in words rather than in a code', () => {
    const lobby = makeLobby();
    const mia = connect(lobby, 'id-mia', 'mia');
    mia.client.addFriend('ZZZZZZ');
    expect(mia.client.current.problem).toContain('ZZZZZZ');
  });

  it('clears the problem once something worked', () => {
    const lobby = makeLobby();
    const mia = connect(lobby, 'id-mia', 'mia');
    const sam = connect(lobby, 'id-sam', 'sam');
    mia.client.addFriend('ZZZZZZ');
    expect(mia.client.current.problem).not.toBeNull();

    mia.client.addFriend(sam.client.current.code!);
    expect(mia.client.current.problem, 'a stale error sat next to a list that worked').toBeNull();
  });
});

describe('what the screen draws', () => {
  it('keeps the friends list the server sent', () => {
    const lobby = makeLobby();
    const mia = connect(lobby, 'id-mia', 'mia');
    const sam = connect(lobby, 'id-sam', 'sam');
    mia.client.addFriend(sam.client.current.code!);

    expect(mia.client.current.friends.map((f) => f.name)).toEqual(['sam']);
    expect(sam.client.current.friends.map((f) => f.name)).toEqual(['mia']);
  });

  it('holds an invitation until it is answered', () => {
    const lobby = makeLobby();
    const mia = connect(lobby, 'id-mia', 'mia');
    const sam = connect(lobby, 'id-sam', 'sam');

    mia.client.invite(sam.client.current.code!);
    expect(sam.client.current.invitations).toHaveLength(1);
    expect(sam.client.current.invitations[0]?.from.name).toBe('mia');

    sam.client.accept(sam.client.current.invitations[0]!.party);
    expect(sam.client.current.invitations, 'the card stayed after answering').toHaveLength(0);
    expect(sam.client.current.party?.members).toHaveLength(2);
  });

  it('drops a declined invitation without waiting for a reply', () => {
    // The server sends no acknowledgement for a decline — there is nothing
    // useful it could say — so a card that waited for one would sit there until
    // the next unrelated message arrived.
    const lobby = makeLobby();
    const mia = connect(lobby, 'id-mia', 'mia');
    const sam = connect(lobby, 'id-sam', 'sam');
    mia.client.invite(sam.client.current.code!);

    sam.client.decline(sam.client.current.invitations[0]!.party);
    expect(sam.client.current.invitations).toHaveLength(0);
    expect(sam.client.current.party).toBeNull();
  });

  it('does not stack three cards when a leader clicks invite three times', () => {
    const lobby = makeLobby();
    const mia = connect(lobby, 'id-mia', 'mia');
    const sam = connect(lobby, 'id-sam', 'sam');
    const code = sam.client.current.code!;
    mia.client.invite(code);
    mia.client.invite(code);
    mia.client.invite(code);
    expect(sam.client.current.invitations).toHaveLength(1);
  });

  it('tracks the queue and lets go of it on a match', () => {
    const lobby = makeLobby();
    const mia = connect(lobby, 'id-mia', 'mia');
    const sam = connect(lobby, 'id-sam', 'sam');

    mia.client.joinQueue('waterWar');
    expect(mia.client.current.queue?.mode).toBe('waterWar');
    expect(mia.client.current.queue?.needed).toBe(2);

    sam.client.joinQueue('waterWar');
    lobby.tick(1000);

    expect(mia.matches, 'no match reached the client').toHaveLength(1);
    expect(mia.matches[0]?.room).toBe(sam.matches[0]?.room);
    expect(mia.client.current.queue, 'the search kept spinning after matching').toBeNull();
    // Exactly one of them hosts.
    expect([mia.matches[0]!.host, sam.matches[0]!.host].filter(Boolean)).toHaveLength(1);
  });

  it('tells the screen every time something moves', () => {
    const lobby = makeLobby();
    const mia = connect(lobby, 'id-mia', 'mia');
    const before = mia.changes;
    const sam = connect(lobby, 'id-sam', 'sam');
    mia.client.addFriend(sam.client.current.code!);
    expect(mia.changes, 'the screen was never told to redraw').toBeGreaterThan(before);
  });
});

describe('when the socket dies', () => {
  it('stops claiming to be connected', () => {
    const lobby = makeLobby();
    const mia = connect(lobby, 'id-mia', 'mia');
    mia.drop();
    expect(mia.client.current.connected).toBe(false);
  });

  it('lets go of the queue and the party, which were never ours', () => {
    // They are the server's state. Keeping them on screen would show somebody a
    // search that is not running and a party that cannot hear them.
    const lobby = makeLobby();
    const mia = connect(lobby, 'id-mia', 'mia');
    const sam = connect(lobby, 'id-sam', 'sam');
    mia.client.invite(sam.client.current.code!);
    sam.client.accept(sam.client.current.invitations[0]!.party);
    mia.client.joinQueue('captureTheFlag');
    expect(mia.client.current.party).not.toBeNull();
    expect(mia.client.current.queue).not.toBeNull();

    mia.drop();
    expect(mia.client.current.party).toBeNull();
    expect(mia.client.current.queue).toBeNull();
  });

  it('keeps the friends list, which is worth showing greyed out', () => {
    // The one piece of state that survives, because a list you can look at
    // while offline is still a list, and it is what the reconnect will confirm.
    const lobby = makeLobby();
    const mia = connect(lobby, 'id-mia', 'mia');
    const sam = connect(lobby, 'id-sam', 'sam');
    mia.client.addFriend(sam.client.current.code!);

    mia.drop();
    expect(mia.client.current.friends).toHaveLength(1);
    expect(mia.client.current.code, 'the player forgot their own code').not.toBeNull();
  });

  it('sends nothing after disconnecting', () => {
    const lobby = makeLobby();
    const mia = connect(lobby, 'id-mia', 'mia');
    mia.client.disconnect();
    // No throw, and nothing reaches a server that is no longer listening.
    expect(() => mia.client.joinQueue('waterWar')).not.toThrow();
    expect(mia.client.current.queue).toBeNull();
  });
});
