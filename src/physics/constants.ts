/**
 * Every physics magic number lives here.
 *
 * These values are interdependent — the capsule radius bounds the safe substep
 * length, which bounds the top speed; the step height must clear one board's
 * thickness. Changing one in isolation breaks a guarantee somewhere else, so
 * the relationships are written down next to the numbers.
 */

// ── Fixed timestep ───────────────────────────────────────────────────────────
/** Simulation rate. 60Hz always, whatever the display does. */
export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;
/** Longest single frame we will accumulate, in seconds. Guards the spiral of death. */
export const MAX_FRAME_DELTA = 0.25;

// ── Character capsule ────────────────────────────────────────────────────────
/** Chunky cartoon-kid proportions rather than realistic ones. */
export const CAP_RADIUS = 0.32;
export const CAP_HEIGHT = 1.7;
/** Half the spine length: (height - 2*radius) / 2. Spine runs feet+r to feet+h-r. */
export const CAP_HALF_SPINE = (CAP_HEIGHT - 2 * CAP_RADIUS) / 2;
export const CAP_HEIGHT_CROUCH = 1.1;
export const CAP_HALF_SPINE_CROUCH = (CAP_HEIGHT_CROUCH - 2 * CAP_RADIUS) / 2;
/** First-person eye position above the feet. */
export const EYE_HEIGHT = 1.55;
export const EYE_HEIGHT_CROUCH = 0.95;

// ── Collision tolerances ─────────────────────────────────────────────────────
/**
 * Gap held between the capsule and any surface. Never zero: resting exactly on
 * a surface makes every shallow contact flip between touching and not touching
 * from floating-point noise alone. 15mm is invisible and numerically calm.
 */
export const SKIN = 0.015;
/**
 * Contacts are gathered out to this distance, not just on overlap. Speculative
 * contacts let the solver see a surface before reaching it, and supply the
 * neighbouring face planes internal-edge removal needs.
 */
export const CONTACT_MARGIN = 0.04;
/**
 * Longest distance moved in one collision substep.
 *
 * Tunnelling through a part needs to cross 2*radius + thickness in a single
 * step. With the thinnest lumber at 40mm that is 0.68m, so capping at
 * radius/2 = 0.16m makes tunnelling geometrically impossible.
 */
export const MAX_SUBSTEP = CAP_RADIUS / 2;
/** Ceiling on substeps per tick. 8 * 0.16m * 60Hz covers 76.8 m/s. */
export const MAX_SUBSTEPS = 8;
/** Bisection iterations for the closest point on the capsule spine. */
export const BISECT_ITERS = 20;
/** Gauss-Seidel passes when resolving accumulated penetration. */
export const DEPEN_ITERS = 4;
/** Contacts solved per substep. */
export const MAX_CONTACTS = 8;
/** Accumulated clip planes when sliding, Quake-style. */
export const MAX_PLANES = 5;
/** Quake's PM_ClipVelocity overclip — pushes slightly off the plane to avoid re-collision. */
export const OVERCLIP = 1.001;
/** Two clip planes closer than this are treated as the same plane. */
export const PLANE_DUP_DOT = 0.99;

// ── Ground and slopes ────────────────────────────────────────────────────────
/**
 * Steepest walkable slope. cos(46 deg) ~= 0.695: any contact whose normal has a
 * larger Y component counts as ground.
 */
export const MAX_SLOPE_DEG = 46;
export const MIN_GROUND_NORMAL_Y = Math.cos((MAX_SLOPE_DEG * Math.PI) / 180);
/**
 * Ledge height the character climbs without jumping.
 *
 * Must comfortably clear one plank laid flat (40mm) and a stair riser built
 * from stacked lumber, or players will build stairs that snag.
 */
export const STEP_HEIGHT = 0.55;
/** How far below the feet we search for ground when descending, so stairs do not launch you. */
export const GROUND_SNAP_DISTANCE = 0.6;

// ── Movement ─────────────────────────────────────────────────────────────────
export const WALK_SPEED = 4.6;
export const SPRINT_SPEED = 7.4;
export const CROUCH_SPEED = 2.2;
export const AIR_SPEED = 5.0;

/** Ground acceleration and friction, in units of speed per second. */
export const GROUND_ACCEL = 60;
export const GROUND_FRICTION = 52;
/** Air control is deliberately weak but non-zero — enough to correct a jump, not to fly. */
export const AIR_ACCEL = 14;
export const AIR_FRICTION = 0.6;

export const GRAVITY = 23.0;
/**
 * Apex height of a standing jump.
 *
 * v = sqrt(2*g*h). At 1.15m this clears a standard platform height with margin,
 * which is what makes a hand-built staircase feel generous rather than exacting.
 */
export const JUMP_HEIGHT = 1.15;
export const JUMP_VELOCITY = Math.sqrt(2 * GRAVITY * JUMP_HEIGHT);
/** Terminal fall speed, so a long drop stays readable. */
export const MAX_FALL_SPEED = 40;

/** Grace window after walking off a ledge during which a jump still works. */
export const COYOTE_TIME = 0.12;
/** A jump pressed this long before landing fires on touchdown. */
export const JUMP_BUFFER_TIME = 0.15;

// ── Climbing ─────────────────────────────────────────────────────────────────
export const CLIMB_SPEED = 3.0;
/** How far ahead we look for a climbable surface. */
export const CLIMB_REACH = 0.6;
/** A surface counts as climbable when its normal is within this of horizontal. */
export const CLIMB_MAX_TILT_DEG = 30;

// ── Mantle ───────────────────────────────────────────────────────────────────
/**
 * The tallest ledge a kid can haul themselves over.
 *
 * This constant spent a long time here describing a mechanic nobody had
 * written — the note that replaced it said so, because the lumber budget had
 * been sized against it and the README published a table of measurements
 * explaining the design in terms of it. It is real now, and the reason to build
 * it was the same reason it was tempting to fake: **a wall wants more than one
 * meaningful height.**
 *
 * With only a step-up, every obstacle is either ankle-high or a wall, and the
 * whole of a player's decision about how tall to build is a single yes/no at
 * 0.55m. Three thresholds is a curve somebody can learn and play against:
 *
 * | height | what it costs to get past |
 * |---|---|
 * | up to `STEP_HEIGHT` | nothing; you walk over it |
 * | up to this | a jump press and `MANTLE_DURATION` of being a stationary target |
 * | above this | you go round, or you build |
 *
 * Chest height on a kid, which is the honest answer to "could you pull yourself
 * up that" and — not by accident — a course and a half of planks above the step.
 */
export const MANTLE_MAX_HEIGHT = 1.6;
/**
 * How long the pull-up takes.
 *
 * The cost, and the whole reason mantling does not simply delete walls. For
 * this long the player moves on a rail: no steering, no jump, no throwing, and
 * a soaker pointed at them cannot miss. Long enough to be a real decision in
 * front of somebody's fort, short enough not to feel like a cutscene.
 */
export const MANTLE_DURATION = 0.42;
/** Clearance required above a ledge before a mantle is allowed. */
export const MANTLE_CLEARANCE = CAP_HEIGHT * 0.9;
/** How far in front of the chest to look for something worth climbing. */
export const MANTLE_REACH = 0.75;
/** How far past the ledge edge the pull-up lands, so nobody ends on the lip. */
export const MANTLE_OVERSHOOT = CAP_RADIUS * 1.6;
