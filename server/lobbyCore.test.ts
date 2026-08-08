/**
 * Friends, parties and the queue, driven through the messages a browser sends.
 *
 * In-process against a callback, with no socket and no clock of its own —
 * `Lobby` takes `now` as a parameter and sends through a function, so every
 * rule here is exercised the way a real client exercises it, at whatever speed
 * a test wants. A test that stood up a server would be a test that gets skipped
 * in CI and then stops being true.
 *
 * The rules worth the most attention are the ones with two sides: a friendship
 * that has to be mutual or somebody is watching a stranger, a party that must
 * never be split by the matchmaker, and a leader who leaves.
 */

import { describe, it, expect } from 'vitest';
import { Lobby, IDLE_TIMEOUT_MS } from './lobbyCore.ts';
import {
  LOBBY_VERSION, MAX_PARTY, PLAIN_LOOK, targetFor,
} from '../src/net/lobbyProtocol.ts';
import type { LobbyServerMessage, PartyView, PublicPlayer } from '../src/net/lobbyProtocol.ts';

/** A connected player, with everything the lobby has ever said to them. */
class Client {
  readonly heard: LobbyServerMessage[] = [];
  code = '';

  constructor(readonly lobby: Lobby, readonly id: string, name: string, now = 0) {
    const code = lobby.hello(id, name, LOBBY_VERSION, (m) => this.heard.push(m), now);
    this.code = code ?? '';
  }

  /** The most recent message of a kind, which is the one that is still true. */
  last<T extends LobbyServerMessage['t']>(t: T): Extract<LobbyServerMessage, { t: T }> | undefined {
    for (let i = this.heard.length - 1; i >= 0; i--) {
      const m = this.heard[i]!;
      if (m.t === t) return m as Extract<LobbyServerMessage, { t: T }>;
    }
    return undefined;
  }

  get friends(): PublicPlayer[] {
    return this.last('friends')?.friends ?? [];
  }

  get party(): PartyView | null {
    return this.last('party')?.party ?? null;
  }

  presenceOf(code: string): string | undefined {
    return this.friends.find((f) => f.code === code)?.presence;
  }
}

/** A lobby whose codes are the same every run, so a failure is readable. */
function makeLobby(): Lobby {
  let n = 0;
  return new Lobby(() => {
    n = (n * 1103515245 + 12345) & 0x7fffffff;
    return n / 0x7fffffff;
  });
}

describe('what everybody looks like', () => {
  /** Two friends, so one can watch the other change their shirt. */
  function pair(): { lobby: Lobby; mia: Client; sam: Client } {
    const lobby = makeLobby();
    const mia = new Client(lobby, 'id-mia', 'mia');
    const sam = new Client(lobby, 'id-sam', 'sam');
    lobby.handle(mia.id, { t: 'friend.add', code: sam.code }, 0);
    return { lobby, mia, sam };
  }

  const seenBySam = (r: { mia: Client; sam: Client }) =>
    r.sam.friends.find((f) => f.code === r.mia.code)!.look;

  it('shows a friend the colours they chose', () => {
    // The gap this closes: the lobby knew friend codes and names and drew a
    // list of strings, so the screen where you decide who to play with was the
    // one screen where nobody had a face.
    const r = pair();
    r.lobby.handle(r.mia.id, {
      t: 'look', look: { shirt: 0x112233, skin: 0x445566, hair: 0x778899 },
    }, 0);
    expect(seenBySam(r)).toEqual({ shirt: 0x112233, skin: 0x445566, hair: 0x778899 });
  });

  it('starts everybody as a plain kid rather than as a hole in the row', () => {
    // A default rather than an optional field, so no list has to decide what to
    // draw for somebody who has never opened the Locker.
    expect(seenBySam(pair())).toEqual(PLAIN_LOOK);
  });

  it('cleans what a client sends', () => {
    // Same rule as every other thing a client says about itself, and the value
    // that matters is one which *coerces* rather than one that fails to.
    // `Number('red')` is NaN and would be caught by any check at all; the
    // dangerous ones are `null`, `true` and `[]`, which come out as 0 and 1 —
    // a whole friend list gone black because somebody sent a null.
    const r = pair();
    r.lobby.handle(r.mia.id, {
      t: 'look', look: { shirt: 1e12, skin: null, hair: true } as never,
    }, 0);
    const look = seenBySam(r);
    expect(look.shirt).toBeLessThanOrEqual(0xffffff);
    expect(look.skin).toBe(PLAIN_LOOK.skin);
    expect(look.hair).toBe(PLAIN_LOOK.hair);
  });

  it('survives a client sending no look at all', () => {
    const r = pair();
    expect(() => r.lobby.handle(r.mia.id, { t: 'look', look: null as never }, 0)).not.toThrow();
    expect(seenBySam(r)).toEqual(PLAIN_LOOK);
  });

  it('tells a friend when somebody changes their shirt', () => {
    // Announced rather than left until the next reconnect, for the same reason
    // a rename is: somebody looking at the list right now is looking at the old
    // colour.
    const r = pair();
    r.lobby.handle(r.mia.id, {
      t: 'look', look: { shirt: 0x010203, skin: 0x040506, hair: 0x070809 },
    }, 0);
    expect(seenBySam(r).shirt).toBe(0x010203);
    r.lobby.handle(r.mia.id, {
      t: 'look', look: { shirt: 0xaabbcc, skin: 0x040506, hair: 0x070809 },
    }, 0);
    expect(seenBySam(r).shirt).toBe(0xaabbcc);
  });

  it('carries the look into a party view as well as a friend list', () => {
    // Two lists draw a face and both are fed from `publicOf`, so this is really
    // a check that there is one place that decides rather than two.
    const r = pair();
    r.lobby.handle(r.mia.id, {
      t: 'look', look: { shirt: 0xc0ffee, skin: 0x445566, hair: 0x778899 },
    }, 0);
    r.lobby.handle(r.mia.id, { t: 'party.invite', code: r.sam.code }, 0);
    const invite = r.sam.last('party.invited');
    expect(invite?.from.look.shirt).toBe(0xc0ffee);
  });
});

describe('joining', () => {
  it('mints a code and hands it back', () => {
    const lobby = makeLobby();
    const mia = new Client(lobby, 'id-mia', 'mia');
    expect(mia.code).toHaveLength(6);
    expect(mia.last('welcome')?.code).toBe(mia.code);
    expect(mia.last('welcome')?.name).toBe('mia');
  });

  it('gives two players different codes', () => {
    const lobby = makeLobby();
    expect(new Client(lobby, 'a', 'a').code).not.toBe(new Client(lobby, 'b', 'b').code);
  });

  it('gives the same player the same code tomorrow', () => {
    // The whole point of an identity. A code that changed between sessions
    // would quietly break every list the player is in.
    const lobby = makeLobby();
    const first = new Client(lobby, 'id-mia', 'mia').code;
    lobby.goodbye('id-mia');
    expect(new Client(lobby, 'id-mia', 'mia').code).toBe(first);
  });

  it('turns away a client speaking a different version', () => {
    const lobby = makeLobby();
    const heard: LobbyServerMessage[] = [];
    const code = lobby.hello('id', 'x', LOBBY_VERSION + 1, (m) => heard.push(m), 0);
    expect(code).toBeNull();
    expect(heard[0]).toEqual({ t: 'refused', why: 'version' });
  });

  it('lets a reopened tab take over rather than locking somebody out', () => {
    // Refusing the second connection would leave a player unable to reach their
    // own identity until a timeout expired, which is what closing and reopening
    // a tab looks like.
    const lobby = makeLobby();
    const first = new Client(lobby, 'id-mia', 'mia');
    const second = new Client(lobby, 'id-mia', 'mia');
    expect(second.code).toBe(first.code);
    expect(second.last('welcome')).toBeDefined();
  });

  it('cleans a name rather than taking it as typed', () => {
    const lobby = makeLobby();
    expect(new Client(lobby, 'id', '   ').last('welcome')?.name).toBe('kid');
    expect(new Client(lobby, 'id2', 'x'.repeat(80)).last('welcome')?.name).toHaveLength(16);
  });
});

describe('friends', () => {
  function pair(): { lobby: Lobby; mia: Client; sam: Client } {
    const lobby = makeLobby();
    const mia = new Client(lobby, 'id-mia', 'mia');
    const sam = new Client(lobby, 'id-sam', 'sam');
    return { lobby, mia, sam };
  }

  it('adds somebody by their code, both ways at once', () => {
    // Mutual immediately. A one-sided list would let somebody watch a
    // stranger's presence without that stranger knowing.
    const { lobby, mia, sam } = pair();
    lobby.handle(mia.id, { t: 'friend.add', code: sam.code }, 0);

    expect(mia.friends.map((f) => f.code)).toEqual([sam.code]);
    expect(sam.friends.map((f) => f.code)).toEqual([mia.code]);
  });

  it('accepts a code typed the way a person types one', () => {
    const { lobby, mia, sam } = pair();
    const typed = `${sam.code.slice(0, 3)}-${sam.code.slice(3)}`.toLowerCase();
    lobby.handle(mia.id, { t: 'friend.add', code: typed }, 0);
    expect(mia.friends).toHaveLength(1);
  });

  it('refuses a code nobody has', () => {
    const { lobby, mia } = pair();
    lobby.handle(mia.id, { t: 'friend.add', code: 'ZZZZZZ' }, 0);
    expect(mia.last('refused')?.why).toBe('unknown code');
    expect(mia.friends).toHaveLength(0);
  });

  it('refuses your own code, and says which mistake it was', () => {
    const { lobby, mia } = pair();
    lobby.handle(mia.id, { t: 'friend.add', code: mia.code }, 0);
    expect(mia.last('refused')?.why).toBe('that is you');
  });

  it('refuses a duplicate rather than listing somebody twice', () => {
    const { lobby, mia, sam } = pair();
    lobby.handle(mia.id, { t: 'friend.add', code: sam.code }, 0);
    lobby.handle(mia.id, { t: 'friend.add', code: sam.code }, 0);
    expect(mia.last('refused')?.why).toBe('already a friend');
    expect(mia.friends).toHaveLength(1);
  });

  it('removes from both sides, so nobody is left watching', () => {
    const { lobby, mia, sam } = pair();
    lobby.handle(mia.id, { t: 'friend.add', code: sam.code }, 0);
    lobby.handle(mia.id, { t: 'friend.remove', code: sam.code }, 0);
    expect(mia.friends).toHaveLength(0);
    expect(sam.friends, "sam can still see mia after mia removed sam").toHaveLength(0);
  });

  it('keeps a friend who has gone offline, and says that is what they are', () => {
    // A list that forgot somebody when they closed a tab would not be a list.
    const { lobby, mia, sam } = pair();
    lobby.handle(mia.id, { t: 'friend.add', code: sam.code }, 0);
    lobby.goodbye(sam.id);

    expect(mia.friends).toHaveLength(1);
    expect(mia.presenceOf(sam.code)).toBe('offline');
  });

  it('tells a friend when you arrive, without them asking', () => {
    const { lobby, mia, sam } = pair();
    lobby.handle(mia.id, { t: 'friend.add', code: sam.code }, 0);
    lobby.goodbye(sam.id);
    expect(mia.presenceOf(sam.code)).toBe('offline');

    const sam2 = new Client(lobby, 'id-sam', 'sam');
    expect(mia.presenceOf(sam2.code), 'mia was never told sam came back').toBe('online');
  });

  it('tells a friend when you change your name', () => {
    const { lobby, mia, sam } = pair();
    lobby.handle(mia.id, { t: 'friend.add', code: sam.code }, 0);
    lobby.handle(sam.id, { t: 'rename', name: 'samantha' }, 0);
    expect(mia.friends[0]?.name).toBe('samantha');
  });

  it('never puts a player id in anything it sends', () => {
    // A player id is a bearer credential and a friends list is on a screen.
    const { lobby, mia, sam } = pair();
    lobby.handle(mia.id, { t: 'friend.add', code: sam.code }, 0);
    const wire = JSON.stringify(mia.heard);
    expect(wire).not.toContain('id-sam');
    expect(wire).not.toContain('id-mia');
  });
});

describe('parties', () => {
  function three(): { lobby: Lobby; mia: Client; sam: Client; dev: Client } {
    const lobby = makeLobby();
    return {
      lobby,
      mia: new Client(lobby, 'id-mia', 'mia'),
      sam: new Client(lobby, 'id-sam', 'sam'),
      dev: new Client(lobby, 'id-dev', 'dev'),
    };
  }

  function invite(lobby: Lobby, from: Client, to: Client): string {
    lobby.handle(from.id, { t: 'party.invite', code: to.code }, 0);
    const invited = to.last('party.invited');
    expect(invited, 'no invitation arrived').toBeDefined();
    return invited!.party;
  }

  it('makes a party on the first invitation and puts both people in it', () => {
    const { lobby, mia, sam } = three();
    const party = invite(lobby, mia, sam);
    lobby.handle(sam.id, { t: 'party.accept', party }, 0);

    expect(mia.party?.members.map((m) => m.code).sort()).toEqual([mia.code, sam.code].sort());
    expect(sam.party?.leaderCode).toBe(mia.code);
  });

  it('names who is asking, so an invitation is not from a stranger', () => {
    const { lobby, mia, sam } = three();
    invite(lobby, mia, sam);
    expect(sam.last('party.invited')?.from.name).toBe('mia');
    expect(sam.last('party.invited')?.from.code).toBe(mia.code);
  });

  it('leaves somebody out of the party until they accept', () => {
    const { lobby, mia, sam } = three();
    invite(lobby, mia, sam);
    expect(sam.party).toBeNull();
    expect(mia.party?.members).toHaveLength(1);
  });

  it('drops an invitation that was declined', () => {
    const { lobby, mia, sam } = three();
    const party = invite(lobby, mia, sam);
    lobby.handle(sam.id, { t: 'party.decline', party }, 0);
    lobby.handle(sam.id, { t: 'party.accept', party }, 0);
    expect(sam.party).toBeNull();
  });

  it('refuses an invitation nobody sent', () => {
    const { lobby, sam } = three();
    lobby.handle(sam.id, { t: 'party.accept', party: 'p999' }, 0);
    expect(sam.last('refused')?.why).toBe('malformed');
    expect(sam.party).toBeNull();
  });

  it('lets only the leader invite', () => {
    const { lobby, mia, sam, dev } = three();
    const party = invite(lobby, mia, sam);
    lobby.handle(sam.id, { t: 'party.accept', party }, 0);
    lobby.handle(sam.id, { t: 'party.invite', code: dev.code }, 0);
    expect(sam.last('refused')?.why).toBe('not the leader');
    expect(dev.last('party.invited')).toBeUndefined();
  });

  it('lets only the leader kick', () => {
    const { lobby, mia, sam, dev } = three();
    const party = invite(lobby, mia, sam);
    lobby.handle(sam.id, { t: 'party.accept', party }, 0);
    lobby.handle(dev.id, { t: 'party.kick', code: mia.code }, 0);
    expect(dev.last('refused')?.why).toBe('not in a party');
    expect(mia.party?.members).toHaveLength(2);
  });

  it('kicks somebody out and tells them so', () => {
    const { lobby, mia, sam } = three();
    const party = invite(lobby, mia, sam);
    lobby.handle(sam.id, { t: 'party.accept', party }, 0);
    lobby.handle(mia.id, { t: 'party.kick', code: sam.code }, 0);

    expect(sam.party, 'sam was not told they had been removed').toBeNull();
    expect(mia.party?.members).toHaveLength(1);
  });

  it('hands the party to somebody else when the leader leaves', () => {
    // Dissolving it round everybody else would punish the group for one
    // person's decision.
    const { lobby, mia, sam, dev } = three();
    const party = invite(lobby, mia, sam);
    lobby.handle(sam.id, { t: 'party.accept', party }, 0);
    lobby.handle(mia.id, { t: 'party.invite', code: dev.code }, 0);
    lobby.handle(dev.id, { t: 'party.accept', party }, 0);

    lobby.handle(mia.id, { t: 'party.leave' }, 0);
    expect(sam.party?.members).toHaveLength(2);
    expect(sam.party?.leaderCode).toBe(sam.code);
    expect(mia.party).toBeNull();
  });

  it('closes a party when the last person leaves', () => {
    const { lobby, mia, sam } = three();
    const party = invite(lobby, mia, sam);
    lobby.handle(sam.id, { t: 'party.accept', party }, 0);
    lobby.handle(sam.id, { t: 'party.leave' }, 0);
    lobby.handle(mia.id, { t: 'party.leave' }, 0);
    expect(mia.party).toBeNull();
    expect(sam.party).toBeNull();
  });

  it('will not hold more people than a yard has room for', () => {
    const lobby = makeLobby();
    const leader = new Client(lobby, 'id-0', 'leader');
    const rest = Array.from({ length: MAX_PARTY + 2 }, (_, i) =>
      new Client(lobby, `id-${i + 1}`, `kid${i + 1}`));

    for (const other of rest) {
      lobby.handle(leader.id, { t: 'party.invite', code: other.code }, 0);
      const invited = other.last('party.invited');
      if (invited !== undefined) lobby.handle(other.id, { t: 'party.accept', party: invited.party }, 0);
    }
    expect(leader.party?.members.length).toBeLessThanOrEqual(MAX_PARTY);
    expect(leader.last('refused')?.why).toBe('party is full');
  });

  it('moves somebody out of their old party when they accept a new one', () => {
    const { lobby, mia, sam, dev } = three();
    const first = invite(lobby, mia, sam);
    lobby.handle(sam.id, { t: 'party.accept', party: first }, 0);
    const second = invite(lobby, dev, sam);
    lobby.handle(sam.id, { t: 'party.accept', party: second }, 0);

    expect(sam.party?.leaderCode).toBe(dev.code);
    expect(mia.party?.members, 'sam is in two parties at once').toHaveLength(1);
  });
});

describe('the queue', () => {
  function queued(mode = 'waterWar'): { lobby: Lobby; clients: Client[] } {
    const lobby = makeLobby();
    const clients = Array.from({ length: 6 }, (_, i) => new Client(lobby, `id-${i}`, `kid${i}`));
    void mode;
    return { lobby, clients };
  }

  it('matches enough solo players into a room together', () => {
    const { lobby, clients } = queued();
    const target = targetFor('waterWar');
    for (let i = 0; i < target; i++) {
      lobby.handle(clients[i]!.id, { t: 'queue.join', mode: 'waterWar' }, 0);
    }
    lobby.tick(1000);

    const matched = clients.slice(0, target).map((c) => c.last('matched'));
    expect(matched.every((m) => m !== undefined), 'somebody was left behind').toBe(true);
    // One room, and exactly one host in it.
    expect(new Set(matched.map((m) => m!.room)).size).toBe(1);
    expect(matched.filter((m) => m!.host)).toHaveLength(1);
    expect(matched[0]!.mode).toBe('waterWar');
  });

  it('does not match before there are enough people', () => {
    const { lobby, clients } = queued();
    lobby.handle(clients[0]!.id, { t: 'queue.join', mode: 'captureTheFlag' }, 0);
    lobby.tick(1000);
    expect(clients[0]!.last('matched')).toBeUndefined();
    expect(clients[0]!.last('queue')?.needed).toBe(targetFor('captureTheFlag'));
  });

  it('tells a waiting party how it is going', () => {
    const { lobby, clients } = queued();
    lobby.handle(clients[0]!.id, { t: 'queue.join', mode: 'captureTheFlag' }, 0);
    lobby.tick(5000);
    const status = clients[0]!.last('queue');
    expect(status?.waiting).toBe(1);
    expect(status?.seconds).toBe(5);
  });

  it('never splits a party across two matches', () => {
    // The rule the whole feature exists to keep. Being separated from the
    // friend you queued with is worse than waiting longer, so the matchmaker
    // overshoots the target rather than taking part of a party to hit it.
    const lobby = makeLobby();
    const a = new Client(lobby, 'id-a', 'a');
    const b = new Client(lobby, 'id-b', 'b');
    const c = new Client(lobby, 'id-c', 'c');

    lobby.handle(a.id, { t: 'party.invite', code: b.code }, 0);
    lobby.handle(b.id, { t: 'party.accept', party: b.last('party.invited')!.party }, 0);
    lobby.handle(a.id, { t: 'party.invite', code: c.code }, 0);
    lobby.handle(c.id, { t: 'party.accept', party: c.last('party.invited')!.party }, 0);

    // A party of three into a mode that wants two.
    lobby.handle(a.id, { t: 'queue.join', mode: 'waterWar' }, 0);
    lobby.tick(1000);

    const rooms = [a, b, c].map((x) => x.last('matched')?.room);
    expect(rooms.every((r) => r !== undefined), 'somebody in the party was not matched').toBe(true);
    expect(new Set(rooms).size, 'the party was split across rooms').toBe(1);
  });

  it('takes the whole party in when the leader queues', () => {
    const lobby = makeLobby();
    const a = new Client(lobby, 'id-a', 'a');
    const b = new Client(lobby, 'id-b', 'b');
    lobby.handle(a.id, { t: 'party.invite', code: b.code }, 0);
    lobby.handle(b.id, { t: 'party.accept', party: b.last('party.invited')!.party }, 0);

    lobby.handle(a.id, { t: 'queue.join', mode: 'waterWar' }, 0);
    lobby.tick(1000);
    expect(b.last('matched'), 'a member was left in the lobby').toBeDefined();
  });

  it('lets only the leader queue the party', () => {
    const lobby = makeLobby();
    const a = new Client(lobby, 'id-a', 'a');
    const b = new Client(lobby, 'id-b', 'b');
    lobby.handle(a.id, { t: 'party.invite', code: b.code }, 0);
    lobby.handle(b.id, { t: 'party.accept', party: b.last('party.invited')!.party }, 0);

    lobby.handle(b.id, { t: 'queue.join', mode: 'waterWar' }, 0);
    expect(b.last('refused')?.why).toBe('not the leader');
  });

  it('refuses a mode that does not exist rather than opening a queue nobody joins', () => {
    const { lobby, clients } = queued();
    lobby.handle(clients[0]!.id, { t: 'queue.join', mode: 'hopscotch' }, 0);
    expect(clients[0]!.last('refused')?.why).toBe('malformed');
    lobby.tick(1000);
    expect(clients[0]!.last('matched')).toBeUndefined();
  });

  it('lets somebody leave the queue', () => {
    const { lobby, clients } = queued();
    lobby.handle(clients[0]!.id, { t: 'queue.join', mode: 'waterWar' }, 0);
    lobby.handle(clients[0]!.id, { t: 'queue.leave' }, 0);
    expect(clients[0]!.last('queue.left')).toBeDefined();

    lobby.handle(clients[1]!.id, { t: 'queue.join', mode: 'waterWar' }, 0);
    lobby.tick(1000);
    expect(clients[0]!.last('matched'), 'somebody who left the queue was matched').toBeUndefined();
  });

  it('takes a party out of the queue when somebody in it disconnects', () => {
    // Otherwise a queue fills with people who have closed the tab, and everyone
    // still there is matched into a yard with nobody in it.
    const { lobby, clients } = queued();
    lobby.handle(clients[0]!.id, { t: 'queue.join', mode: 'waterWar' }, 0);
    lobby.goodbye(clients[0]!.id);

    lobby.handle(clients[1]!.id, { t: 'queue.join', mode: 'waterWar' }, 0);
    lobby.tick(1000);
    expect(clients[1]!.last('matched'), 'matched against somebody who had gone').toBeUndefined();
  });

  it('counts a party by who is actually there, not by who is on the list', () => {
    // The case the check above does *not* cover, and the one that needs a
    // filter rather than a queue exit. A member who dropped out before the
    // leader queued is still a member — the party was not in the queue at the
    // time, so nothing took it out — and counting them fills a match with a
    // seat nobody is sitting in.
    const lobby = makeLobby();
    const mia = new Client(lobby, 'id-mia', 'mia');
    const sam = new Client(lobby, 'id-sam', 'sam');
    const solo = new Client(lobby, 'id-solo', 'solo');

    lobby.handle(mia.id, { t: 'party.invite', code: sam.code }, 0);
    lobby.handle(sam.id, { t: 'party.accept', party: sam.last('party.invited')!.party }, 0);
    expect(mia.party?.members).toHaveLength(2);

    // Sam goes before anybody queues, so no queue exit fires.
    lobby.goodbye(sam.id);
    lobby.handle(mia.id, { t: 'queue.join', mode: 'waterWar' }, 0);
    lobby.tick(1000);

    // Water War wants two. Mia alone is one, so this must not have matched.
    expect(
      mia.last('matched'),
      'a party of one-plus-a-ghost was matched as a party of two',
    ).toBeUndefined();
    expect(mia.last('queue')?.waiting).toBe(1);

    // And with a real second person, it does.
    lobby.handle(solo.id, { t: 'queue.join', mode: 'waterWar' }, 0);
    lobby.tick(2000);
    expect(mia.last('matched')).toBeDefined();
    expect(solo.last('matched')?.room).toBe(mia.last('matched')?.room);
  });

  it('shows a friend as queued, then playing', () => {
    const lobby = makeLobby();
    const mia = new Client(lobby, 'id-mia', 'mia');
    const sam = new Client(lobby, 'id-sam', 'sam');
    lobby.handle(mia.id, { t: 'friend.add', code: sam.code }, 0);
    expect(mia.presenceOf(sam.code)).toBe('online');

    lobby.handle(sam.id, { t: 'queue.join', mode: 'captureTheFlag' }, 0);
    expect(mia.presenceOf(sam.code)).toBe('queued');

    lobby.setPlaying(sam.id, true);
    expect(mia.presenceOf(sam.code)).toBe('playing');
  });

  it('gives every match its own room', () => {
    const { lobby, clients } = queued();
    const target = targetFor('waterWar');
    const rooms = new Set<string>();
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < target; i++) {
        const c = clients[round * target + i];
        if (c === undefined) continue;
        lobby.handle(c.id, { t: 'queue.join', mode: 'waterWar' }, 0);
      }
      lobby.tick(1000 * (round + 1));
      for (let i = 0; i < target; i++) {
        const room = clients[round * target + i]?.last('matched')?.room;
        if (room !== undefined) rooms.add(room);
      }
    }
    expect(rooms.size, 'two matches were sent to the same room').toBe(3);
  });
});

describe('going quiet', () => {
  it('drops a connection that stops saying anything', () => {
    // A socket held open by a sleeping laptop is indistinguishable from a
    // player who is there, and a queue full of them matches nobody.
    const lobby = makeLobby();
    const mia = new Client(lobby, 'id-mia', 'mia', 0);
    const sam = new Client(lobby, 'id-sam', 'sam', 0);
    lobby.handle(mia.id, { t: 'friend.add', code: sam.code }, 0);

    lobby.handle(mia.id, { t: 'ping' }, IDLE_TIMEOUT_MS * 2);
    lobby.tick(IDLE_TIMEOUT_MS * 2 + 1);
    expect(mia.presenceOf(sam.code), 'a silent connection stayed online').toBe('offline');
  });

  it('keeps somebody who is still saying hello', () => {
    const lobby = makeLobby();
    const mia = new Client(lobby, 'id-mia', 'mia', 0);
    const sam = new Client(lobby, 'id-sam', 'sam', 0);
    lobby.handle(mia.id, { t: 'friend.add', code: sam.code }, 0);

    for (let t = 0; t < IDLE_TIMEOUT_MS * 3; t += IDLE_TIMEOUT_MS / 2) {
      lobby.handle(sam.id, { t: 'ping' }, t);
      lobby.handle(mia.id, { t: 'ping' }, t);
      lobby.tick(t);
    }
    expect(mia.presenceOf(sam.code)).toBe('online');
  });
});
