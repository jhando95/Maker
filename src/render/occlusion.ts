/**
 * Where the light does not reach, answered by a graph that already exists.
 *
 * This renderer is a toon ramp, an outline pass and a static shadow map, and it
 * has no ambient occlusion — so the inside of a fort is exactly as bright as
 * the open lawn, and a box stacked against a wall meets it without a seam. The
 * usual fixes are a screen-space pass, which is a whole pipeline stage, or a
 * bake, which needs the texture pipeline this project deliberately does not
 * have.
 *
 * But the game already computes something better suited to it than either. The
 * structural model asks, on every placement and removal, which parts touch
 * which — that is what decides whether a tower stands. A part's contact count
 * is an occlusion estimate: a plank with six neighbours is boxed in, a plank
 * with one is out in the open. So the joint graph built to answer "does it
 * fall down" also answers "is it enclosed", and the answer is already sitting
 * in memory when the light wants it.
 *
 * The delivery is a byte per part and no new pass: every part mesh already
 * carries an `instanceColor` buffer (allocated at construction, for a shader
 * warm-up reason), so darkening a part is a multiply into a buffer that is
 * uploaded when parts change anyway.
 *
 * ## The shape of the curve
 *
 * Flat at first, then linear, then a floor. One contact is not enclosure — a
 * plank on the lawn touches the ground, a shelf touches its wall, and neither
 * should dim — so darkening starts at the second contact. It stops at a floor
 * rather than falling to black because this is a *cue*, and a cartoon fort with
 * a black interior reads as a rendering bug rather than as shade.
 */

/** Contacts that cost nothing. The ground counts as a contact; see above. */
export const FREE_CONTACTS = 1;

/** Contacts at which a part is as dark as it is going to get. */
export const FULLY_ENCLOSED = 6;

/**
 * How dark fully enclosed gets, as a fraction removed from the colour.
 *
 * A quarter. Chosen against the toon ramp rather than in the abstract: the ramp
 * has three bands about 35% apart, so a quarter is visible everywhere without
 * ever pushing a lit face down a whole band — which would read as a material
 * change, not a shadow.
 */
export const MAX_DARKEN = 0.25;

/**
 * The brightness multiplier for a part with this many contacts.
 *
 * `strength` scales the whole effect and is the developer-panel knob; 0 turns
 * it off, 1 is the shipped look. Clamped, because a slider is not a validator.
 */
export function shadeFor(contacts: number, strength = 1): number {
  // NaN falls through both Math.min and Math.max, and NaN * anything is a part
  // painted NaN — which three.js renders as black, the exact failure the floor
  // exists to prevent. An unanswerable strength means no effect, not all of it.
  const s = Number.isNaN(strength) ? 0 : Math.max(0, Math.min(1, strength));
  const past = Math.max(0, contacts - FREE_CONTACTS);
  const enclosure = Math.min(1, past / (FULLY_ENCLOSED - FREE_CONTACTS));
  return 1 - MAX_DARKEN * s * enclosure;
}
