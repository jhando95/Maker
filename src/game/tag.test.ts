import { describe, it, expect, beforeEach } from 'vitest';
import { CollisionWorld } from '../physics/collisionWorld.ts';
import { PartRenderer } from '../render/partRenderer.ts';
import { BuildSystem } from '../build/buildSystem.ts';
import { CharacterController } from '../player/controller.ts';
import { CameraRig } from '../player/cameraRig.ts';
import { ProjectileSystem } from './projectiles.ts';
import {
  TagMode, COUNTDOWN_TIME, ROUND_TIME, TAG_RADIUS, TAG_COOLDOWN,
  THAW_RADIUS, THAW_TIME, KID_COUNT, IT_SPAWN,
} from './tag.ts';
import { sameForEveryone } from './gameMode.ts';
import type { GameEvent, GameMode, ModeContext } from './gameMode.ts';
import { Rng } from '../core/rng.ts';
import { ActorRoster, LOCAL_ACTOR_ID, FIRST_BOT_ID, type Actor } from './actor.ts';
import { DT } from '../physics/constants.ts';
import { neighborhoodSlabs, installFixtures } from '../world/neighborhood.ts';

const noInput = sameForEveryone();

/**
 * A world with the map in it.
 *
 * Tag is the one mode whose field is the map — the routing grid reaches out to
 * the turning head — so an empty world would let every test pass for a reason
 * the game never sees.
 */
function makeContext(): { ctx: ModeContext; events: GameEvent[]; world: CollisionWorld } {
  const world = new CollisionWorld();
  installFixtures(world, neighborhoodSlabs(new Rng('map')));
  const build = new BuildSystem(world, new PartRenderer());
  const player = new CharacterController(world, 0, 0.5, 0);
  const camera = new CameraRig(world, 1.6);
  const projectiles = new ProjectileSystem(world);
  const events: GameEvent[] = [];
  return {
    world,
    events,
    ctx: {
      world, build, player, camera, projectiles,
      actors: new ActorRoster({ id: LOCAL_ACTOR_ID, kind: 'local', team: 'left', controller: player }),
      rng: new Rng('tag-test'),
      emit: (e) => events.push(e),
      worldChanged: () => {},
    },
  };
}

function run(mode: TagMode, ctx: ModeContext, seconds: number): void {
  for (let i = 0; i < Math.round(seconds / DT) && !mode.finished; i++) {
    mode.fixedUpdate(DT, ctx, noInput);
  }
}

/** Skip the head start, which every test about the chase has to do. */
function toChase(mode: TagMode, ctx: ModeContext): void {
  run(mode, ctx, COUNTDOWN_TIME + DT);
}

/** A second person in the yard, so a test can be about two people. */
function addFriend(ctx: ModeContext, id: number, x: number, z: number): Actor {
  const actor: Actor = {
    id, kind: 'remote', team: 'left',
    controller: new CharacterController(ctx.world, x, 0.5, z),
  };
  ctx.actors.addRemote(actor);
  return actor;
}

/** Park somebody, which is how a test makes a tag happen on purpose. */
function put(who: { controller: CharacterController }, x: number, z: number): void {
  who.controller.teleport(x, 0.5, z);
}

describe('TagMode', () => {
  let mode: TagMode;
  let ctx: ModeContext;
  let events: GameEvent[];

  beforeEach(() => {
    const made = makeContext();
    ctx = made.ctx;
    events = made.events;
    mode = new TagMode();
    mode.start(ctx);
  });

  describe('shape', () => {
    it('opens with a head start rather than a chase', () => {
      // The countdown is the whole of the mode's tutorial: everybody runs and
      // It watches where they go. Starting on the chase would put the player in
      // contact before they knew there was a street to run down.
      expect(mode.hud().phase).toBe('READY');
      expect(mode.hud().timer).toBeCloseTo(COUNTDOWN_TIME, 1);
    });

    it('cannot be tagged during the head start', () => {
      const friend = addFriend(ctx, 1, 0, 0);
      run(mode, ctx, DT * 2);
      put(friend, IT_SPAWN.x, IT_SPAWN.z);
      put(ctx.actors.local, IT_SPAWN.x, IT_SPAWN.z);
      run(mode, ctx, 1);
      expect(mode.isFrozen(1)).toBe(false);
    });

    it('never lets anybody build', () => {
      // Its own claim rather than a side effect. Three modes are about what you
      // made; this one is about where you can get to, and a wall would answer
      // the question by changing it.
      expect(mode.buildingAllowed).toBe(false);
      toChase(mode, ctx);
      expect(mode.buildingAllowed).toBe(false);
      // Through the interface the shell holds it by, because that is where the
      // absence has to be visible: `build.setLumber(mode.lumber)` is what hands
      // the budget over, and undefined there is what means "no pile".
      expect((mode as GameMode).lumber).toBeUndefined();
    });

    it('brings the neighbourhood kids', () => {
      expect(mode.bots.length).toBe(KID_COUNT);
      // And they are all runners, because there is exactly one chaser.
      for (const bot of mode.bots) expect(mode.isIt(bot.id)).toBe(false);
      expect(mode.isIt(LOCAL_ACTOR_ID)).toBe(true);
    });

    it('puts It in the back garden and the kids at the front', () => {
      // The spawn is the mode pointing at the street: the runners start facing
      // the gate with It behind them, so the first thing that happens is
      // everybody leaving the lot.
      expect(ctx.player.z).toBeCloseTo(IT_SPAWN.z, 1);
      for (const bot of mode.bots) expect(bot.z).toBeLessThan(0);
    });

    it('starts the round clock over when the chase begins', () => {
      // Two clocks on one field, and the handover is the thing worth checking:
      // the head start counts down to nothing and the round's own time is put
      // on the board in its place, rather than the two sharing a number.
      run(mode, ctx, 2);
      expect(mode.hud().timer).toBeCloseTo(COUNTDOWN_TIME - 2, 1);
      run(mode, ctx, COUNTDOWN_TIME - 2 + DT);
      expect(mode.hud().phase).toBe('TAG');
      expect(mode.hud().timer).toBeCloseTo(ROUND_TIME, 0);
    });
  });

  describe('tagging', () => {
    it('freezes somebody you walk into', () => {
      const friend = addFriend(ctx, 1, 40, 40);
      toChase(mode, ctx);
      expect(mode.isFrozen(1)).toBe(false);

      put(friend, 40, 40);
      put(ctx.actors.local, 40, 40 + TAG_RADIUS * 0.5);
      run(mode, ctx, DT * 2);
      expect(mode.isFrozen(1)).toBe(true);
    });

    it('does not freeze somebody just out of reach', () => {
      // The negative half, and the one that would otherwise pass for a mode
      // that freezes everybody in the world the moment the chase starts.
      const friend = addFriend(ctx, 1, 40, 40);
      toChase(mode, ctx);
      put(friend, 40, 40);
      put(ctx.actors.local, 40, 40 + TAG_RADIUS * 2);
      run(mode, ctx, DT * 2);
      expect(mode.isFrozen(1)).toBe(false);
    });

    it('cannot reach somebody standing on a roof above it', () => {
      // What the height check is for. The porch roof is the route this update
      // opened, and without this it would be the worst place on the map to
      // stand — tagged from below by somebody who cannot see you.
      const friend = addFriend(ctx, 1, 40, 40);
      toChase(mode, ctx);
      friend.controller.teleport(40, 3.2, 40);
      put(ctx.actors.local, 40, 40);
      run(mode, ctx, DT * 2);
      expect(mode.isFrozen(1)).toBe(false);
    });

    it('waits between tags, so a huddle does not go down at once', () => {
      const first = addFriend(ctx, 1, 40, 40);
      const second = addFriend(ctx, 2, 40, 40);
      toChase(mode, ctx);
      put(first, 40, 40);
      put(second, 40, 40);
      put(ctx.actors.local, 40, 40);
      run(mode, ctx, DT * 2);
      const down = [1, 2].filter((id) => mode.isFrozen(id));
      expect(down.length).toBe(1);

      // And the other one goes down once the cooldown is up, so this is a wait
      // rather than a rule that only one person can ever be frozen.
      run(mode, ctx, TAG_COOLDOWN + 0.1);
      expect(mode.isFrozen(1) && mode.isFrozen(2)).toBe(true);
    });

    it('stops a frozen player dead', () => {
      const friend = addFriend(ctx, 1, 40, 40);
      toChase(mode, ctx);
      expect(mode.speedScaleFor(1)).toBe(1);
      put(friend, 40, 40);
      put(ctx.actors.local, 40, 40);
      run(mode, ctx, DT * 2);
      expect(mode.speedScaleFor(1)).toBe(0);
    });

    it('says so on the HUD, to the person it happened to', () => {
      const friend = addFriend(ctx, 1, 40, 40);
      toChase(mode, ctx);
      put(friend, 40, 40);
      put(ctx.actors.local, 40, 40);
      run(mode, ctx, DT * 2);
      expect(mode.selfHud(1).wetness).toBe(1);
      expect(mode.selfHud(1).refill).toBe(0);
      // And says nothing to somebody it did not happen to.
      expect(mode.selfHud(2).wetness).toBeNull();
    });
  });

  describe('thawing', () => {
    /** One frozen kid at the origin and one rescuer, both far from anybody. */
    function frozenPair(): { frozen: Actor; rescuer: Actor } {
      const frozen = addFriend(ctx, 1, 40, 40);
      const rescuer = addFriend(ctx, 2, 40, 40);
      toChase(mode, ctx);
      put(frozen, 40, 40);
      put(ctx.actors.local, 40, 40);
      run(mode, ctx, DT * 2);
      expect(mode.isFrozen(1)).toBe(true);
      // Take It away, so the rescue is not immediately re-frozen.
      put(ctx.actors.local, -40, -40);
      put(rescuer, 40 + THAW_RADIUS * 0.4, 40);
      return { frozen, rescuer };
    }

    it('lets a friend stand next to you and get you up', () => {
      frozenPair();
      run(mode, ctx, THAW_TIME + 0.2);
      expect(mode.isFrozen(1)).toBe(false);
      expect(mode.speedScaleFor(1)).toBe(1);
    });

    it('takes the whole time, not a touch', () => {
      const { rescuer } = frozenPair();
      run(mode, ctx, THAW_TIME * 0.4);
      expect(mode.isFrozen(1)).toBe(true);
      expect(mode.selfHud(1).refill ?? 0).toBeGreaterThan(0.1);
      // Walk away half-done and it does not finish on its own.
      put(rescuer, -40, 40);
      run(mode, ctx, THAW_TIME * 0.5);
      expect(mode.isFrozen(1)).toBe(true);
    });

    it('bleeds back rather than resetting when the rescuer is driven off', () => {
      // The version that resets makes an interrupted rescue worthless, so the
      // decision becomes "only start one you can finish" — which is no decision
      // at all, because you cannot know.
      const { rescuer } = frozenPair();
      run(mode, ctx, THAW_TIME * 0.6);
      const part = mode.selfHud(1).refill ?? 0;
      expect(part).toBeGreaterThan(0.3);
      put(rescuer, -40, 40);
      run(mode, ctx, THAW_TIME * 0.2);
      const after = mode.selfHud(1).refill ?? 0;
      expect(after).toBeLessThan(part);
      expect(after).toBeGreaterThan(0);
    });

    it('cannot be done by somebody who is frozen themselves', () => {
      // Otherwise a pair goes down together and gets up together for free,
      // which turns being caught into a two-second inconvenience.
      const frozen = addFriend(ctx, 1, 40, 40);
      const other = addFriend(ctx, 2, 40, 40);
      toChase(mode, ctx);
      put(frozen, 40, 40);
      put(ctx.actors.local, 40, 40);
      run(mode, ctx, DT * 2);
      run(mode, ctx, TAG_COOLDOWN + 0.1);
      expect(mode.isFrozen(1) && mode.isFrozen(2)).toBe(true);

      put(ctx.actors.local, -40, -40);
      put(other, 40 + THAW_RADIUS * 0.4, 40);
      run(mode, ctx, THAW_TIME * 2);
      expect(mode.isFrozen(1)).toBe(true);
    });

    it('cannot be done by It, who is standing right there', () => {
      const frozen = addFriend(ctx, 1, 40, 40);
      toChase(mode, ctx);
      put(frozen, 40, 40);
      put(ctx.actors.local, 40, 40);
      run(mode, ctx, DT * 2);
      // It stays put. A chaser guarding a frozen kid is the whole point of
      // guarding one.
      run(mode, ctx, THAW_TIME * 2);
      expect(mode.isFrozen(1)).toBe(true);
    });
  });

  describe('the round ending', () => {
    it('is won the moment everybody is frozen at the same time', () => {
      const friend = addFriend(ctx, 1, 40, 40);
      // Clear the kids out, so this is about the rule and not about five bots.
      mode.bots.length = 0;
      toChase(mode, ctx);
      put(friend, 40, 40);
      put(ctx.actors.local, 40, 40);
      run(mode, ctx, 1);
      expect(mode.finished).toBe(true);
      expect(mode.won).toBe(true);
      expect(events.some((e) => e.type === 'roundWon')).toBe(true);
    });

    it('is lost when the clock runs out with anybody still running', () => {
      const friend = addFriend(ctx, 1, 60, 60);
      mode.bots.length = 0;
      toChase(mode, ctx);
      // Somewhere It is not, for the whole round.
      put(friend, 60, 60);
      put(ctx.actors.local, -60, -60);
      run(mode, ctx, ROUND_TIME + 1);
      expect(mode.finished).toBe(true);
      expect(mode.won).toBe(false);
      expect(events.some((e) => e.type === 'roundLost')).toBe(true);
    });

    it('does not call an empty lawn a win', () => {
      // `everyoneFrozen` over an empty set is vacuously true, which would end
      // the round on its first tick if nobody but It were in it.
      mode.bots.length = 0;
      toChase(mode, ctx);
      run(mode, ctx, 2);
      expect(mode.finished).toBe(false);
    });

    it('reports how long the round and the best runner lasted', () => {
      const friend = addFriend(ctx, 1, 60, 60);
      mode.bots.length = 0;
      toChase(mode, ctx);
      put(friend, 60, 60);
      put(ctx.actors.local, -60, -60);
      run(mode, ctx, 12);
      put(ctx.actors.local, 60, 60);
      run(mode, ctx, 1);
      expect(mode.finished).toBe(true);
      const lines = Object.fromEntries(mode.summary().lines.map((l) => [l.label, l.value]));
      expect(Number(lines['Round lasted']?.replace('s', ''))).toBeGreaterThanOrEqual(12);
      expect(Number(lines['Longest run']?.replace('s', ''))).toBeGreaterThanOrEqual(12);
    });
  });

  describe('what everybody else reads', () => {
    it('pins It, so a runner can see where the danger is', () => {
      toChase(mode, ctx);
      const pinned = mode.markers().filter((m) => m.kind === 'flag');
      expect(pinned.length).toBe(1);
      expect(pinned[0]!.x).toBeCloseTo(ctx.player.x, 3);
    });

    it('pins a frozen kid, so somebody knows where to go', () => {
      const friend = addFriend(ctx, 1, 40, 40);
      toChase(mode, ctx);
      expect(mode.markers().filter((m) => m.kind === 'bucket').length).toBe(0);
      put(friend, 40, 40);
      put(ctx.actors.local, 40, 40);
      run(mode, ctx, DT * 2);
      const waiting = mode.markers().filter((m) => m.kind === 'bucket');
      expect(waiting.length).toBe(1);
      expect(waiting[0]!.x).toBeCloseTo(40, 1);
    });

    it('counts who is still running', () => {
      const friend = addFriend(ctx, 1, 40, 40);
      mode.bots.length = 0;
      toChase(mode, ctx);
      expect(mode.hud().primary).toEqual({ label: 'Running', value: '1 / 1' });
      put(friend, 40, 40);
      put(ctx.actors.local, 40, 40);
      run(mode, ctx, DT * 2);
      expect(mode.hud().primary).toEqual({ label: 'Running', value: '0 / 1' });
    });

    it('washes out a frozen kid for the renderer', () => {
      toChase(mode, ctx);
      const kid = mode.bots[0]!;
      expect(mode.wetnessOf(kid.id)).toBe(0);
      put(kid, kid.x, kid.z);
      put(ctx.actors.local, kid.x, kid.z);
      run(mode, ctx, DT * 2);
      expect(mode.isFrozen(kid.id)).toBe(true);
      expect(mode.wetnessOf(kid.id)).toBe(1);
    });

    it('enrols somebody who joins after the round started', () => {
      // A person with no record is a person It cannot tag, which is a ghost who
      // wins by not existing.
      toChase(mode, ctx);
      const latecomer = addFriend(ctx, 3, 40, 40);
      run(mode, ctx, DT * 2);
      put(latecomer, 40, 40);
      put(ctx.actors.local, 40, 40);
      run(mode, ctx, DT * 2);
      expect(mode.isFrozen(3)).toBe(true);
    });
  });

  describe('the kids play it', () => {
    it('sends the runners away from the lot during the head start', () => {
      const before = mode.bots.map((b) => ({ x: b.x, z: b.z }));
      run(mode, ctx, COUNTDOWN_TIME - 0.2);
      // Somebody moved a real distance. Not all of them, because a bot can be
      // pinned against the fence by another one, and a test that demands every
      // kid move is a test about crowd density.
      const moved = mode.bots.filter((b, i) => (
        Math.hypot(b.x - before[i]!.x, b.z - before[i]!.z) > 4
      ));
      expect(moved.length).toBeGreaterThanOrEqual(3);
    });

    it('leaves the lot for the street, which no other mode does', () => {
      // The claim the whole mode is built on. If the kids will not follow the
      // field out of the gate then the cul-de-sac is still scenery.
      toChase(mode, ctx);
      run(mode, ctx, 22);
      const out = mode.bots.filter((b) => b.z < -26);
      expect(out.length, `kids at ${mode.bots.map((b) => b.z.toFixed(0)).join(', ')}`)
        .toBeGreaterThanOrEqual(1);
    });

    it('holds a frozen kid still', () => {
      toChase(mode, ctx);
      const kid = mode.bots[0]!;
      put(kid, kid.x, kid.z);
      put(ctx.actors.local, kid.x, kid.z);
      run(mode, ctx, DT * 2);
      expect(mode.isFrozen(kid.id)).toBe(true);
      const at = { x: kid.x, z: kid.z };
      // Move It off, so this is the freeze holding them and not the chase.
      put(ctx.actors.local, -60, -60);
      run(mode, ctx, 3);
      expect(Math.hypot(kid.x - at.x, kid.z - at.z)).toBeLessThan(0.5);
    });

    it('sends a free kid to get a frozen one', () => {
      // The behaviour that makes the mode a contest rather than a chase. It has
      // to be watched for over a few seconds, because a rescuer has to walk.
      toChase(mode, ctx);
      const victim = mode.bots[0]!;
      put(victim, 6, -16);
      put(ctx.actors.local, 6, -16);
      run(mode, ctx, DT * 2);
      expect(mode.isFrozen(victim.id)).toBe(true);
      // It walks well away, so the rescue is not judged too dangerous.
      put(ctx.actors.local, -60, 60);

      let closest = Infinity;
      for (let i = 0; i < Math.round(14 / DT); i++) {
        mode.fixedUpdate(DT, ctx, noInput);
        for (const bot of mode.bots) {
          if (bot.id === victim.id || mode.isFrozen(bot.id)) continue;
          closest = Math.min(closest, Math.hypot(bot.x - victim.x, bot.z - victim.z));
        }
      }
      expect(closest, 'somebody should have come for them').toBeLessThan(THAW_RADIUS);
    });
  });

  describe('ids', () => {
    it('gives its kids ids that cannot collide with a guest', () => {
      for (const bot of mode.bots) expect(bot.id).toBeGreaterThanOrEqual(FIRST_BOT_ID);
    });
  });
});
