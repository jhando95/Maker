import { describe, it, expect } from 'vitest';
import {
  CommsLog, RateLimit, audible, cleanChat,
  CHAT_HISTORY, CHAT_LIFETIME, EMOTE_LIFETIME, NEAR_RADIUS, PING_LIFETIME, MAX_CHAT,
  type Listener,
} from './comms.ts';

const who = (id: number, team: 'left' | 'right', x = 0, z = 0): Listener => ({ id, team, x, z });

describe('who hears what', () => {
  it('keeps team chat inside the team', () => {
    // The rule that has to be enforced where it cannot be undone. A client that
    // received the other team's callouts and chose not to draw them is a client
    // somebody can replace.
    const speaker = who(1, 'left');
    expect(audible('team', speaker, who(2, 'left', 90, 90))).toBe(true);
    expect(audible('team', speaker, who(3, 'right', 0, 0.1))).toBe(false);
  });

  it('lets a shout carry to whoever is close, whatever side they are on', () => {
    // Proximity is the channel that ignores teams on purpose: shouting at
    // somebody across the fence is most of what makes a party game a party.
    const speaker = who(1, 'left');
    expect(audible('near', speaker, who(2, 'right', NEAR_RADIUS - 1, 0))).toBe(true);
    expect(audible('near', speaker, who(3, 'left', NEAR_RADIUS + 1, 0))).toBe(false);
  });

  it('measures the distance in the flat', () => {
    // Two people on a roof and under it are in the same conversation. Height is
    // not distance in a garden.
    const speaker = who(1, 'left', 0, 0);
    expect(audible('near', speaker, who(2, 'left', 3, 4))).toBe(true);
    expect(audible('near', speaker, who(3, 'left', NEAR_RADIUS, NEAR_RADIUS))).toBe(false);
  });

  it('always lets you hear yourself', () => {
    // Not vanity: it is the acknowledgement that the message went somewhere. A
    // player whose chat is silently failing otherwise has no way to tell.
    const alone = who(1, 'left', 500, 500);
    expect(audible('near', alone, alone)).toBe(true);
    expect(audible('team', alone, alone)).toBe(true);
  });

  it('does not reach across the house', () => {
    // The radius is tuned against the map rather than picked. The house is the
    // divider the whole game is built around, and a channel that reached
    // straight through it would say the divider is not there.
    const left = who(1, 'left', -20, 0);
    const right = who(2, 'right', 20, 0);
    expect(audible('near', left, right)).toBe(false);
  });
});

describe('cleanChat', () => {
  it('keeps ordinary words', () => {
    expect(cleanChat('behind you!')).toBe('behind you!');
  });

  it('drops control characters', () => {
    // Written by codepoint rather than as a literal, because a control
    // character typed into a source file makes the file itself unreadable —
    // a mistake this project has already made once.
    const nasty = `a${String.fromCodePoint(0)}b${String.fromCodePoint(0x1b)}c${String.fromCodePoint(0x9f)}d`;
    expect(cleanChat(nasty)).toBe('abcd');
  });

  it('collapses a message pasted with newlines into one line', () => {
    expect(cleanChat('one\ntwo\t\tthree   four')).toBe('one two three four');
  });

  it('is null for nothing at all', () => {
    expect(cleanChat('')).toBeNull();
    expect(cleanChat('   ')).toBeNull();
    expect(cleanChat(String.fromCodePoint(7))).toBeNull();
  });

  it('caps a wall of text', () => {
    const long = cleanChat('x'.repeat(MAX_CHAT * 3));
    expect(long).not.toBeNull();
    expect(long!.length).toBe(MAX_CHAT);
  });
});

describe('CommsLog', () => {
  it('shows what was said', () => {
    const log = new CommsLog();
    expect(log.say(2, 'kid', 'team', 'over here')).toBe(true);
    expect(log.chat).toHaveLength(1);
    expect(log.chat[0]).toMatchObject({ from: 2, name: 'kid', channel: 'team', text: 'over here' });
  });

  it('forgets a line after a while', () => {
    const log = new CommsLog();
    log.say(2, 'kid', 'near', 'hello');
    log.tick(CHAT_LIFETIME - 1);
    expect(log.chat).toHaveLength(1);
    log.tick(2);
    expect(log.chat).toHaveLength(0);
  });

  it('keeps only the last few lines however recent', () => {
    // The log is a corner of the screen, not a transcript. Anybody who wants
    // one wants a different feature.
    const log = new CommsLog();
    for (let i = 0; i < CHAT_HISTORY + 4; i++) log.say(2, 'kid', 'near', `line ${i}`);
    expect(log.chat).toHaveLength(CHAT_HISTORY);
    expect(log.chat[log.chat.length - 1]!.text).toBe(`line ${CHAT_HISTORY + 3}`);
  });

  it('drops a message with nothing in it', () => {
    const log = new CommsLog();
    expect(log.say(2, 'kid', 'near', '   ')).toBe(false);
    expect(log.chat).toHaveLength(0);
  });

  describe('muting a person', () => {
    it('stops their chat', () => {
      const log = new CommsLog();
      log.mute(7);
      expect(log.say(7, 'loud', 'near', 'blah')).toBe(false);
      expect(log.chat).toHaveLength(0);
    });

    it('says so in the return, so nothing announces them', () => {
      // A muted player's message must not make a sound, or the mute is a mute
      // of the words and not of the person — which is not what anybody means
      // by it.
      const log = new CommsLog();
      log.mute(7);
      expect(log.say(7, 'loud', 'near', 'blah')).toBe(false);
      expect(log.ping(7, 'danger', 1, 0, 1)).toBe(false);
      expect(log.emote(7, 'wave')).toBe(false);
    });

    it('stops their pings and emotes too, not only their words', () => {
      const log = new CommsLog();
      expect(log.ping(7, 'look', 1, 0, 1)).toBe(true);
      log.emote(7, 'wave');
      log.mute(7);
      expect(log.worldPings).toHaveLength(0);
      expect(log.emoteOf(7)).toBeUndefined();
    });

    it('lets them back', () => {
      const log = new CommsLog();
      log.mute(7);
      log.unmute(7);
      expect(log.isMuted(7)).toBe(false);
      expect(log.say(7, 'loud', 'near', 'hello again')).toBe(true);
    });

    it('leaves everybody else alone', () => {
      const log = new CommsLog();
      log.mute(7);
      expect(log.say(8, 'friend', 'near', 'hello')).toBe(true);
    });
  });

  describe('muting a channel', () => {
    it('stops that channel and no other', () => {
      const log = new CommsLog();
      log.muteChannel('near', true);
      expect(log.say(2, 'kid', 'near', 'nope')).toBe(false);
      expect(log.say(2, 'kid', 'team', 'yes')).toBe(true);
    });

    it('clears what is already on screen from it', () => {
      // Otherwise turning proximity chat off leaves the thing you turned it off
      // for sitting there for another ten seconds.
      const log = new CommsLog();
      log.say(2, 'kid', 'near', 'noise');
      log.say(3, 'mate', 'team', 'plan');
      log.muteChannel('near', true);
      expect(log.chat).toHaveLength(1);
      expect(log.chat[0]!.channel).toBe('team');
    });

    it('can be turned back on', () => {
      const log = new CommsLog();
      log.muteChannel('team', true);
      expect(log.isChannelMuted('team')).toBe(true);
      log.muteChannel('team', false);
      expect(log.say(2, 'kid', 'team', 'back')).toBe(true);
    });
  });

  describe('pings', () => {
    it('goes in the world and comes out again', () => {
      const log = new CommsLog();
      log.ping(1, 'danger', 3, 1, 4);
      expect(log.worldPings).toHaveLength(1);
      expect(log.worldPings[0]).toMatchObject({ kind: 'danger', x: 3, y: 1, z: 4 });
      log.tick(PING_LIFETIME + 0.1);
      expect(log.worldPings).toHaveLength(0);
    });

    it('lets one person leave several', () => {
      // Unlike an emote: three pings are three places worth looking at, and
      // collapsing them to the newest would lose two of them.
      const log = new CommsLog();
      log.ping(1, 'look', 0, 0, 0);
      log.ping(1, 'look', 9, 0, 9);
      expect(log.worldPings).toHaveLength(2);
    });
  });

  describe('emotes', () => {
    it('floats and then stops', () => {
      const log = new CommsLog();
      log.emote(4, 'wave');
      expect(log.emoteOf(4)?.kind).toBe('wave');
      log.tick(EMOTE_LIFETIME + 0.1);
      expect(log.emoteOf(4)).toBeUndefined();
    });

    it('replaces rather than queues', () => {
      // A queue lets somebody stack six and have them play out long after they
      // stopped pressing anything, which reads as a broken animation.
      const log = new CommsLog();
      log.emote(4, 'wave');
      log.emote(4, 'oops');
      expect(log.emoteOf(4)?.kind).toBe('oops');
      log.tick(EMOTE_LIFETIME * 0.9);
      expect(log.emoteOf(4)?.kind).toBe('oops');
    });

    it('is one per person, not one in the world', () => {
      const log = new CommsLog();
      log.emote(4, 'wave');
      log.emote(5, 'nice');
      expect(log.emoteOf(4)?.kind).toBe('wave');
      expect(log.emoteOf(5)?.kind).toBe('nice');
    });
  });
});

describe('RateLimit', () => {
  it('lets the first one through', () => {
    expect(new RateLimit(1).allow(3)).toBe(true);
  });

  it('refuses a second one too soon', () => {
    const limit = new RateLimit(1);
    limit.allow(3);
    limit.tick(0.5);
    expect(limit.allow(3)).toBe(false);
  });

  it('allows one once the gap has passed', () => {
    const limit = new RateLimit(1);
    limit.allow(3);
    limit.tick(1.1);
    expect(limit.allow(3)).toBe(true);
  });

  it('limits each person separately', () => {
    // One player spamming must not silence everybody else, which is what a
    // single shared clock would do.
    const limit = new RateLimit(1);
    limit.allow(3);
    expect(limit.allow(4)).toBe(true);
  });

  it('does not start the clock until somebody goes', () => {
    const limit = new RateLimit(1);
    limit.tick(5);
    expect(limit.allow(3)).toBe(true);
    expect(limit.allow(3)).toBe(false);
  });

  it('forgets somebody who left', () => {
    const limit = new RateLimit(1);
    limit.allow(3);
    limit.forget(3);
    expect(limit.allow(3)).toBe(true);
  });
});
