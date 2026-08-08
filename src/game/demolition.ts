/**
 * When a kid gives up going round and starts pulling the wall apart.
 *
 * Bots have never touched the build system. Not "rarely" — there is not one
 * reference to it from `bot.ts` or from any mode, which means that in a game
 * whose first line of README is *party games played inside the things you
 * build*, the opposition could not interact with anything the player built
 * except by walking into it. A fort was a shape that made pathfinding fail.
 *
 * ## Why it hangs off the bot's last resort rather than off a timer
 *
 * `Bot.update` already ends with a branch it reaches only when every diversion
 * it tried was blocked — a kid pressed against a wall with genuinely no way
 * round. That branch is the one honest place for this: a bot only starts
 * pulling when the fort is *working*, so a weak fort is still beaten by walking
 * round it and a good one is beaten by taking a piece out. It cannot trivialise
 * a bad wall, because a bad wall never triggers it.
 *
 * And with support in, the consequence is not "one plank is missing". Pulling a
 * load-bearing part brings down what it was holding, so a fort that is one
 * clever post away from collapse is a different object from a fort of the same
 * part count with three ways down. That is the first time in this project that
 * *where* you put the wood has mattered more than how much of it there is.
 *
 * ## What this file is and is not
 *
 * Arithmetic and choice, with no world in it: how long a pull takes, whether a
 * given part may be pulled at all, and which of several is worth pulling. The
 * bot supplies what it can see and the mode does the demolishing, because the
 * mode is the thing the host runs — a bot that reached into `BuildSystem`
 * itself would be a second authority over the shape of the world.
 */

/** Seconds of standing there hauling on it before a part comes away. */
export const PULL_TIME = 2.6;

/**
 * How far a kid can reach.
 *
 * Shorter than the player's own reach, on purpose. A bot that can pull
 * something from four metres away is picking the fort apart from outside it,
 * which is not the picture — the picture is a kid with both hands on a plank.
 */
export const PULL_REACH = 1.35;

/** A part a bot is considering, as much of it as this file needs to know. */
export interface Pullable {
  id: number;
  /** Metres from the bot to the part. */
  distance: number;
  /** True for the house, the fence, the treehouse — anything nobody built. */
  fixed: boolean;
  /** How many parts would come down with it, this one included. */
  brings: number;
}

/**
 * May this be pulled at all?
 *
 * The map is not the player's to demolish and it is not a bot's either. A kid
 * who could take the fence apart would eventually take the house apart, and the
 * level would have a hole in it that nobody put there.
 */
export function canPull(part: Pullable): boolean {
  return !part.fixed && part.distance <= PULL_REACH && part.brings > 0;
}

/**
 * Which one to haul on.
 *
 * The most load-bearing thing within reach, and that choice is the whole
 * design. Pulling the nearest part makes a fort a hit-point pool and the answer
 * to it is more planks; pulling the part that brings the most down makes a fort
 * a structure and the answer to it is a second way to the ground. Ties go to
 * the nearer one, and then to the lower id, so two machines watching the same
 * fort never disagree about which plank went.
 */
export function bestTarget(parts: readonly Pullable[]): Pullable | null {
  let best: Pullable | null = null;
  for (const part of parts) {
    if (!canPull(part)) continue;
    if (best === null) { best = part; continue; }
    if (part.brings !== best.brings) {
      if (part.brings > best.brings) best = part;
      continue;
    }
    if (part.distance !== best.distance) {
      if (part.distance < best.distance) best = part;
      continue;
    }
    if (part.id < best.id) best = part;
  }
  return best;
}

/**
 * How far through a pull, 0 to 1.
 *
 * Reset rather than carried when the target changes: a kid who shuffles along a
 * wall trying one plank after another should not arrive at the fourth one with
 * three seconds of credit. `progress` is per-plank effort, not a stopwatch.
 */
export function pullProgress(elapsed: number): number {
  return Math.min(1, Math.max(0, elapsed / PULL_TIME));
}

/** Is it off yet? */
export function pulledFree(elapsed: number): boolean {
  return elapsed >= PULL_TIME;
}
