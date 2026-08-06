import { describe, it, expect } from 'vitest';
import { CollisionWorld } from '../physics/collisionWorld.ts';
import { CharacterController } from '../player/controller.ts';
import { ActorRoster, LOCAL_ACTOR_ID, opposing, type Actor } from './actor.ts';
import { Bot, BOT_TIERS } from './bot.ts';
import { Rng } from '../core/rng.ts';

const world = new CollisionWorld();

function actor(id: number, kind: Actor['kind'], team: Actor['team']): Actor {
  return { id, kind, team, controller: new CharacterController(world, 0, 0.5, 0) };
}

function roster(): ActorRoster {
  return new ActorRoster(actor(LOCAL_ACTOR_ID, 'local', 'left'));
}

function bot(id: number): Bot {
  return new Bot(id, world, new Rng(`bot-${id}`), BOT_TIERS.normal!, 0, 0.5, 0);
}

describe('teams', () => {
  it('has exactly two sides, and each is the other one back', () => {
    expect(opposing('left')).toBe('right');
    expect(opposing('right')).toBe('left');
    expect(opposing(opposing('left'))).toBe('left');
  });
});

describe('ActorRoster', () => {
  it('always contains the local player', () => {
    const list = roster();
    expect(list.all.length).toBe(1);
    expect(list.get(LOCAL_ACTOR_ID)?.kind).toBe('local');
  });

  it('picks up the mode bots it is refreshed with', () => {
    const list = roster();
    list.refresh([bot(1), bot(2)]);
    expect(list.all.map((a) => a.id)).toEqual([LOCAL_ACTOR_ID, 1, 2]);
  });

  it('drops bots the mode no longer has, so a cleared wave leaves no ghosts', () => {
    // The failure this guards is specific: a roster told about spawns but not
    // about a wave reset keeps an actor that renders and blocks shots but never
    // moves. Rebuilding from the mode's own list makes that unrepresentable.
    const list = roster();
    list.refresh([bot(1), bot(2)]);
    list.refresh([]);
    expect(list.all.map((a) => a.id)).toEqual([LOCAL_ACTOR_ID]);
  });

  it('keeps remote players across a refresh, because the mode does not own them', () => {
    const list = roster();
    list.addRemote(actor(7, 'remote', 'right'));
    list.refresh([bot(1)]);
    expect(list.all.map((a) => a.id)).toEqual([LOCAL_ACTOR_ID, 7, 1]);
    // And still there after the bots turn over.
    list.refresh([]);
    expect(list.get(7)?.kind).toBe('remote');
  });

  it('ignores a remote that joined twice', () => {
    const list = roster();
    list.addRemote(actor(7, 'remote', 'right'));
    list.addRemote(actor(7, 'remote', 'right'));
    list.refresh([]);
    expect(list.all.filter((a) => a.id === 7).length).toBe(1);
  });

  it('forgets a remote that left', () => {
    const list = roster();
    list.addRemote(actor(7, 'remote', 'right'));
    list.removeRemote(7);
    list.refresh([]);
    expect(list.get(7)).toBeUndefined();
  });

  it('reuses its array rather than handing out a new one each tick', () => {
    // Called once per tick for the whole session; a fresh array every time is
    // sixty allocations a second for a question with the same answer.
    const list = roster();
    const before = list.all;
    list.refresh([bot(1)]);
    expect(list.all).toBe(before);
  });

  it('knows who is on whose side', () => {
    const list = roster();
    const ally = bot(1);
    ally.team = 'left';
    const enemy = bot(2);
    enemy.team = 'right';
    list.refresh([ally, enemy]);

    expect(list.friendly(LOCAL_ACTOR_ID, 1)).toBe(true);
    expect(list.friendly(LOCAL_ACTOR_ID, 2)).toBe(false);
    // An id nobody has is not friendly to anyone, rather than throwing into a
    // caller that is deciding whether to throw a balloon.
    expect(list.friendly(LOCAL_ACTOR_ID, 99)).toBe(false);
  });
});

describe('Bot as an actor', () => {
  it('is an actor without needing a wrapper', () => {
    const b = bot(1);
    const asActor: Actor = b;
    expect(asActor.id).toBe(1);
    expect(asActor.kind).toBe('ai');
    expect(asActor.controller).toBe(b.controller);
  });

  it('starts on the side opposite the player, which is what every mode assumed', () => {
    expect(bot(1).team).toBe('right');
  });
});
