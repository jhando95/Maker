/**
 * Applying the garden's items to whoever is standing on them.
 *
 * Kept apart from `items.ts` for the usual reason — that file says where they
 * are and what they are worth, this one says what happens — and apart from the
 * character controller for a sharper one: the controller is the movement rules
 * everybody agrees on, and an item is a thing the *world* does to a body. A
 * trampoline that lived inside the controller would be a trampoline every
 * `CharacterController` in the project carried around with it, including the
 * ones a test makes in an empty world.
 *
 * ## Everybody runs this, and that is the point
 *
 * The effect is a pure function of position, so it needs no authority. The host
 * runs it over every actor it simulates; a guest runs it over the one body it
 * predicts. Both reach the same answer on the same tick from the same inputs,
 * so a bounce never produces a correction and nothing about it is ever sent.
 *
 * That property is why every item here changes velocity and nothing else. The
 * first thing that needs to be *consumed* — a balloon crate, a power-up somebody
 * can take first — stops being expressible this way, because two machines cannot
 * both decide who got it. That one goes through the host as a message, and it
 * will not live in this file.
 */

import { ITEMS, SLIDE_SPEED, TRAMPOLINE_SPEED, onItem, type Item } from '../world/items.ts';
import type { CharacterController } from '../player/controller.ts';

/**
 * Push one body through whatever it is standing on.
 *
 * Takes the item list so a test can supply its own; the map's is the default.
 * Returns the item that acted, or null, which is what the audio and the
 * renderer hang a bounce off — otherwise the only way to notice one is to watch
 * the velocity and guess.
 *
 * No `dt`, which is worth a sentence because it used to take one. Both effects
 * state a velocity outright rather than accelerating toward one, so neither has
 * a rate in it and neither can drift with the timestep. Anything added here
 * that does need a `dt` is a thing that integrates, and integrating is how two
 * machines running the same tick end up disagreeing by a rounding error — so
 * that item wants a hard look before it gets its parameter back.
 */
export function applyItems(
  body: CharacterController,
  items: readonly Item[] = ITEMS,
): Item | null {
  for (const item of items) {
    if (!onItem(item, body.x, body.y, body.z)) continue;

    if (item.kind === 'trampoline') {
      // Only on the way down or at rest. Without this a player who holds jump
      // on a trampoline is re-launched every tick they are still inside the
      // window, which is not a higher bounce — it is an escape from gravity.
      if (body.vy > 0.5) continue;
      body.vy = TRAMPOLINE_SPEED;
      body.onGround = false;
      return item;
    }

    // A slide only works with your feet on it. Sailing over one at head height
    // and being yanked sideways would be baffling.
    if (!body.onGround) continue;

    // Set, not eased, and only along the slide's own axis.
    //
    // The first version eased toward the target the way the controller eases
    // toward a walk, and measured on the map it produced 2.2 metres of travel
    // where eleven metres a second should have produced thirteen. The reason is
    // the order this runs in. `step` happens first, and a body with no input on
    // it is a body the controller is actively stopping: it blends the velocity
    // toward zero at `GROUND_ACCEL` and then applies `GROUND_FRICTION` on top,
    // which between them take about a third of it every tick. A ten-percent
    // pull toward eleven does not beat that — it settles at about two and a
    // half, which is slower than walking. A slip-n-slide slower than walking is
    // not a weak item, it is a broken one.
    //
    // Setting the along-axis component sidesteps the argument entirely: the
    // brakes get whatever they take, and then the slide says what the speed is.
    // It stays a pure function of position and velocity, so the host and a
    // guest predicting itself still agree without a message.
    const along = { x: -Math.sin(item.ry), z: -Math.cos(item.ry) };
    const speed = body.vx * along.x + body.vz * along.z;
    // Never a brake. Arriving faster than the slide keeps what you brought,
    // and arriving backwards is turned round — you cannot run up one, which is
    // what makes stepping onto it a decision rather than a free upgrade.
    if (speed < SLIDE_SPEED) {
      const add = SLIDE_SPEED - speed;
      body.vx += along.x * add;
      body.vz += along.z * add;
    }
    return item;
  }
  return null;
}
