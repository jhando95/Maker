/**
 * Who is in the world.
 *
 * The game grew up around one player and a bag of bots, and the two were
 * different kinds of thing: a bot is an id and a controller and a team, while
 * the player was a bare `CharacterController` that main.ts happened to own. That
 * asymmetry is fine right up until a second person joins, at which point every
 * piece of code that says "the player" has to decide which one it meant.
 *
 * An actor is the smallest thing that makes them the same: an identity, a body,
 * and a side. Deliberately nothing else — no health, no wetness, no flag. Those
 * belong to whichever mode invented them, and putting them here would mean every
 * mode paying for every other mode's rules.
 *
 * The three kinds differ only in where their intent comes from. That is the
 * whole point: the simulation moves a body according to an intent and does not
 * care whether the intent arrived from a keyboard, a behaviour tree, or a socket.
 */

import type { CharacterController } from '../player/controller.ts';

/**
 * Which side of the house you are on.
 *
 * Lives here rather than in Capture the Flag, where it started, because the
 * map has two halves before any mode says so — the house divides the lot, and
 * left yard and right yard are facts about the world.
 */
export type Team = 'left' | 'right';

export function opposing(team: Team): Team {
  return team === 'left' ? 'right' : 'left';
}

/** Where an actor's intent comes from. */
export type ActorKind = 'local' | 'ai' | 'remote';

export interface Actor {
  readonly id: number;
  readonly kind: ActorKind;
  team: Team;
  readonly controller: CharacterController;
  /**
   * Still standing and worth aiming at.
   *
   * Optional because "can be taken out of the fight" is a rule some kinds of
   * actor have and others do not — a bot in Fort Defense goes down, a sandbox
   * player never does. Undefined reads as alive.
   */
  readonly alive?: boolean;
  /**
   * Visibly out of it for a moment, so the renderer can wash them out.
   *
   * Also optional, and for the same reason: it lets the drawing code ask one
   * question of everyone instead of testing what kind of thing each actor is
   * and reaching for a different field.
   */
  readonly stunned?: boolean;
  /** Facing, for drawing. Falls back to the controller's own heading. */
  readonly heading?: number;
}

/**
 * Whoever is running the simulation is id 0.
 *
 * Alone, that is you. In a session it is the host — and on a guest's machine
 * the local player is *not* id 0, because 0 is already taken by the person
 * whose browser is the authority. That is the one place this number stops being
 * "you", so code that means "the person at this keyboard" must ask the roster
 * (`actors.local.id`) rather than compare against this.
 *
 * Modes are the exception and may keep using it, because a mode only ever ticks
 * on the authority. Water War's projectile owner and Capture the Flag's flag
 * carrier both predate this and both remain correct for that reason.
 */
export const LOCAL_ACTOR_ID = 0;

/**
 * Everyone currently in the world, in one place.
 *
 * Assembled from three owners rather than replacing them: main.ts owns the local
 * player, the network layer will own remote players, and a mode owns its bots
 * for as long as its round lasts. A roster that tried to own all three would
 * have to be told about every spawn and every wave reset, and the first missed
 * call would leave a ghost that renders and blocks shots but never moves.
 *
 * So `refresh` rebuilds from those owners once a tick. It reuses its array, so
 * asking who is in the world costs nothing per frame.
 */
export class ActorRoster {
  /** Local first, then remotes, then the mode's bots. */
  readonly all: Actor[] = [];

  private readonly remotes: Actor[] = [];

  /**
   * The person at this keyboard. Not readonly, because a guest is renamed when
   * the host tells it what it is called.
   */
  local: Actor;

  constructor(local: Actor) {
    this.local = local;
    this.all.push(local);
  }

  addRemote(actor: Actor): void {
    if (actor.id === this.local.id) return;
    if (this.remotes.some((a) => a.id === actor.id)) return;
    this.remotes.push(actor);
    // Straight into `all` as well, rather than waiting for the next refresh.
    // Only a running mode calls refresh, so a person who joined a session with
    // no mode existed, collided and could be hit — and was in nobody's list, so
    // nothing ever drew them or told anyone about them.
    this.all.push(actor);
  }

  removeRemote(id: number): void {
    const at = this.remotes.findIndex((a) => a.id === id);
    if (at !== -1) this.remotes.splice(at, 1);
    const drawn = this.all.findIndex((a) => a.id === id && a.kind === 'remote');
    if (drawn !== -1) this.all.splice(drawn, 1);
  }

  /**
   * Take the identity the host handed out.
   *
   * A guest starts as id 0 like every other machine and stops being 0 the moment
   * it learns the host already is. The controller and the body are kept — only
   * the name changes — because everything pointing at that character (the
   * camera, the build system, the viewmodel) is holding the controller, not the
   * actor.
   *
   * It also decides what the player looks like, since appearance is seeded from
   * the id. Doing it here means a guest sees themselves exactly as everybody
   * else sees them, without anyone sending a description.
   */
  identifyLocal(id: number): void {
    if (this.local.id === id) return;
    const previous = this.local;
    const renamed: Actor = {
      ...previous,
      id,
      // Spreading an object loses a getter's laziness, so the one property that
      // is derived per frame is re-declared rather than snapshotted.
      get heading(): number {
        return previous.heading ?? 0;
      },
    };
    this.local = renamed;
    const at = this.all.indexOf(previous);
    if (at !== -1) this.all[at] = renamed;
    else this.all.unshift(renamed);
  }

  /** Rebuild in place from the mode's current bots. Allocates nothing. */
  refresh(bots: readonly Actor[]): void {
    this.all.length = 0;
    this.all.push(this.local);
    for (const remote of this.remotes) this.all.push(remote);
    for (const bot of bots) this.all.push(bot);
  }

  get(id: number): Actor | undefined {
    return this.all.find((a) => a.id === id);
  }

  /** True when two actors are on the same side, false if either is unknown. */
  friendly(a: number, b: number): boolean {
    const first = this.get(a);
    const second = this.get(b);
    return first !== undefined && second !== undefined && first.team === second.team;
  }
}
