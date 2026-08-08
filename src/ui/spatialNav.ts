/**
 * Moving a highlight around a screen with a stick, a d-pad or four arrow keys.
 *
 * Every menu in this project is click-only. There is a gamepad layer, and it
 * drives the *game*: a player on a controller has to put it down and find the
 * mouse to change a setting, pick a mode or hold a blueprint. On a PC that is a
 * papercut. For any console build it is the whole job — a console port is not a
 * port of the renderer, it is the entire interface learning to be driven by a
 * stick and two buttons — and the cost of that grows with every screen added, so
 * it is cheaper now than it will ever be again.
 *
 * ## Why direction rather than an order
 *
 * The obvious implementation is a list and a cursor: next, previous, wrap. It is
 * wrong here for a reason visible on the Blueprints screen, where a row is a name
 * and then Hold, Rename and Delete side by side. In a flat list, "down" from the
 * name lands on Hold, and getting to the next blueprint means pressing down four
 * times. What a player means by down is *the next row*, and by right *the next
 * button on this one* — and neither is a position in the DOM, they are positions
 * on the screen.
 *
 * So this works on rectangles. It costs a `getBoundingClientRect` per candidate
 * on a key press, which is nothing, and it means a screen never has to declare
 * its own layout twice: the rule is read off the pixels the player is looking at.
 *
 * ## The one judgement in it
 *
 * Given "down", several things are below. Which one is *the* one is decided by
 * distance, with anything that overlaps the current item horizontally treated as
 * perfectly aligned. That is what makes a column of buttons behave like a column
 * even when they are different widths, and what stops a wide row two hundred
 * pixels away from stealing the highlight from a narrow one directly underneath.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Direction = 'up' | 'down' | 'left' | 'right';

/**
 * How much a sideways offset counts against a candidate.
 *
 * Three, so a thing directly below beats a thing below and a third as far again
 * off to one side. Only applies to candidates that do not overlap at all — see
 * the class comment.
 */
export const CROSS_WEIGHT = 3;

/** Below a pixel apart on the axis of travel is not travel. */
const EPS = 1;

interface Span { near: number; far: number; centre: number }

function alongAxis(rect: Rect, vertical: boolean): Span {
  const near = vertical ? rect.y : rect.x;
  const size = vertical ? rect.height : rect.width;
  return { near, far: near + size, centre: near + size / 2 };
}

function overlaps(a: Span, b: Span): boolean {
  return a.near < b.far && b.near < a.far;
}

/**
 * Which rectangle the highlight should move to, or null if there is nothing
 * that way.
 *
 * `wrap` brings it round to the far side rather than stopping — right for a
 * menu, where a list of six that stops dead at both ends makes a player press a
 * key that does nothing twice per screen.
 */
export function nextInDirection(
  rects: readonly Rect[], from: number, direction: Direction, wrap = false,
): number | null {
  const current = rects[from];
  if (current === undefined) return null;

  const vertical = direction === 'up' || direction === 'down';
  const forward = direction === 'down' || direction === 'right';
  const main = alongAxis(current, vertical);
  const cross = alongAxis(current, !vertical);

  let best: number | null = null;
  let bestScore = Infinity;
  let furthest: number | null = null;
  let furthestScore = -Infinity;

  for (let i = 0; i < rects.length; i++) {
    if (i === from) continue;
    const rect = rects[i]!;
    const theirMain = alongAxis(rect, vertical);
    const theirCross = alongAxis(rect, !vertical);

    // Signed so one expression covers all four directions: positive is "the way
    // we are going".
    const travel = (theirMain.centre - main.centre) * (forward ? 1 : -1);
    const sideways = overlaps(cross, theirCross)
      ? 0
      : Math.abs(theirCross.centre - cross.centre);

    if (travel > EPS) {
      const score = travel + sideways * CROSS_WEIGHT;
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    } else if (wrap) {
      // Going backwards is how far round the wrap has to come: the further
      // behind, the better a wrap target it is.
      const score = -travel - sideways * CROSS_WEIGHT;
      if (score > furthestScore) {
        furthestScore = score;
        furthest = i;
      }
    }
  }

  return best ?? furthest;
}

/**
 * How far a stick must be pushed before it counts as a direction.
 *
 * Deliberately much higher than the aiming deadzone. Aiming wants every bit of
 * a small push; a menu wants a decision, and a stick resting at 0.3 that scrolls
 * a settings list on its own is worse than one that needs a shove.
 */
export const NAV_DEADZONE = 0.6;

/** How long a direction must be held before it starts repeating. */
export const FIRST_REPEAT = 0.42;

/** And how often after that. */
export const REPEAT = 0.13;

/**
 * A held stick or key, as a series of discrete steps.
 *
 * A menu moves one item per press. A stick has no presses — it is a number that
 * is 0.9 for as long as somebody holds it — so something has to decide when
 * holding it means "again". Without this, one flick of the stick travels the
 * whole settings screen in a fifth of a second.
 *
 * The first step is immediate, because a menu that waits before responding at
 * all feels broken rather than deliberate. The delay is only before the
 * *second*.
 */
export class StepRepeat {
  private held = 0;
  private until = 0;

  /**
   * Feed the axis and the frame time; get -1, 0 or 1.
   *
   * Takes `dt` rather than reading a clock so the same sequence of frames always
   * produces the same sequence of steps, on any machine and in a test.
   */
  step(axis: number, dt: number): -1 | 0 | 1 {
    const direction = axis > NAV_DEADZONE ? 1 : axis < -NAV_DEADZONE ? -1 : 0;
    if (direction === 0) {
      this.held = 0;
      this.until = 0;
      return 0;
    }
    // Reversing counts as letting go: pushing up straight after down should
    // move once immediately, not wait out whatever was left of a repeat.
    if (direction !== this.held) {
      this.held = direction;
      this.until = FIRST_REPEAT;
      return direction;
    }
    this.until -= dt;
    if (this.until > 0) return 0;
    this.until = REPEAT;
    return direction;
  }

  /** Forget what is being held, so re-opening a menu does not resume a repeat. */
  reset(): void {
    this.held = 0;
    this.until = 0;
  }
}
