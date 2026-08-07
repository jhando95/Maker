/**
 * The kids.
 *
 * Everybody in this world — the local player, another person over the wire, and
 * every bot a mode spawns — is drawn by this one class. That is a deliberate
 * rule rather than tidiness: the game is about looking across a lawn and knowing
 * who is who, and the moment the player is drawn by different code from
 * everyone else, the player stops looking like a person in the same world.
 *
 * It replaces two separate things. Bots were a torso, a head and four limbs
 * assembled inline in the mode renderer; the local player, visible in third
 * person, was a blue capsule with a yellow ball on top. Those had drifted so far
 * apart that a screenshot of the two together looked like a bug.
 *
 * ## What makes them read
 *
 * **The outline.** Every solid thing in this world has ink drawn round it by the
 * renderer's inverted-hull pass, and until now the characters were the one thing
 * that did not — the single most important thing on screen was the only thing
 * not drawn in the game's own style. Every silhouette part carries a shell now.
 *
 * **A face.** Two eyes and a mouth are a few hundred bytes of geometry and they
 * do more than everything else here put together. A capsule has no front; a head
 * with a face has a front, and "which way is that kid facing" stops being a
 * guess. Two eyes on their own is a doll — the mouth is what makes it a person,
 * and it is one more box.
 *
 * **Being different from each other.** Skin, hair colour, hair shape, head size
 * and build vary by actor id, so six kids on a lawn are six kids rather than six
 * copies. Seeded from the id rather than randomised, so the same kid looks the
 * same every time you see them — including on two machines that have never
 * spoken.
 *
 * **Being alive when nothing is happening.** A kid standing still used to be
 * perfectly rigid, and a group of them read as a row of statues. They breathe
 * now, out of phase with each other, which costs a sine and about a centimetre.
 *
 * ## Why instanced, and what that costs
 *
 * A pool of thirty-eight instanced meshes, ten of which are outline shells, each
 * one draw call however many people are in the world — with no allocation when a
 * wave arrives and no shader compiled mid-round, the two things that produce a
 * visible hitch at exactly the wrong moment.
 *
 * **The pool is not the cost.** Twelve of those thirty-eight are painted
 * shapes, and a shape nobody on the field is wearing has a count of zero and
 * draws nothing — which is the whole reason a palette of twelve is affordable
 * to offer. An undecorated kid is 27 draws and 1,840 triangles; one with a
 * ponytail and all four marks painted is 31 and 1,892. The whole cast, empty
 * lawn to full, is free at zero because `finish` lowers `count` rather than
 * parking unused slots out of sight.
 *
 * Measured on the yard with three kids in it: 237 draw calls became 244 when
 * the face grew a sclera, an iris, a pupil and a pair of brows.
 *
 * The cost is that a part can only be posed by a matrix and tinted by one
 * colour. So there are no bendable knees and no per-vertex anything: a limb is a
 * rigid box on a pivot. At this scale, with this outline, that is the look
 * anyway.
 */

import * as THREE from 'three';
import { createToonMaterial, createOutlineMaterial } from './toonMaterial.ts';
import { chamferedBox, blob } from './geometry.ts';
import { markGeometries } from './markShapes.ts';
import { Rng } from '../core/rng.ts';
import { CAP_HEIGHT, CAP_RADIUS } from '../physics/constants.ts';
import {
  BROWS, BROWS_NONE, CLOTH_COLOURS, EYE_COLOURS, HAIR_COLOURS, HAIR_STYLES,
  MARK_SHAPES, MARK_SLOTS, MOUTHS, SKIN_TONES,
  buildOf, clampAppearance, defaultAppearance, headScaleOf, markSizeOf,
  type Appearance, type HairStyle, type Mark, type MarkShape,
} from '../game/appearance.ts';

/**
 * Where a kid's joints are, as fractions of the collision capsule.
 *
 * Tied to CAP_HEIGHT rather than written as numbers so the drawing and the
 * thing that collides can never disagree about how tall somebody is — a
 * character whose feet float or sink is the first thing anyone notices.
 */
export const HIP_Y = CAP_HEIGHT * 0.42;
export const TORSO_TOP = CAP_HEIGHT * 0.79;
/**
 * The head's centre, raised from 0.905 because the chin was inside the shirt.
 *
 * At 0.905 the bottom of a scale-1 head sat four centimetres *below* the top of
 * the torso, so a kid seen close up had no chin at all — the skull went
 * straight into the collar. At 0.92 it overlaps by one and a half, which is a
 * jaw resting on a collar rather than a head pushed into a body.
 *
 * The gap that opens for a small head is what the neck is for; see NECK_R.
 */
export const HEAD_Y = CAP_HEIGHT * 0.92;
const LEG_LEN = HIP_Y - 0.09;
const ARM_LEN = CAP_HEIGHT * 0.32;
const HIP_X = CAP_RADIUS * 0.44;
/*
 * Where the arm meets the shoulder, which has been wrong in both directions.
 *
 * At 0.92 of the capsule radius the shoulders sat inside a torso half-width of
 * 0.275 and the arms were buried in the body — a kid with legs and no arms. At
 * 1.2 they cleared it by five centimetres and floated, visibly unattached. The
 * number that is actually meant is the torso's own half-width plus half an arm,
 * which is what this is.
 */
const SHOULDER_X = CAP_RADIUS * 1.04;
const SHOULDER_Y = TORSO_TOP - 0.05;

const TORSO_W = CAP_RADIUS * 1.68;
const TORSO_D = CAP_RADIUS * 1.1;
/** Half an arm, across. Marks on a sleeve are placed against this. */
const ARM_R = 0.0675;
/**
 * How far a painted mark floats off the surface it is painted on.
 *
 * Not zero, because a flat polygon coplanar with a chamfered box z-fights, and
 * z-fighting on a chest at four metres is the most visible artefact this
 * renderer can produce. Not much more than zero either, or the mark visibly
 * hovers when seen from the side.
 */
const MARK_LIFT = 0.008;

/**
 * A head about a quarter of the body.
 *
 * Cartoon proportions on purpose. Eleven-year-olds in a garden drawn at adult
 * proportions read as small adults, and the whole reason the head is this big is
 * that it is where the face is — the part of a character a player actually
 * looks at.
 */
export const HEAD_R = 0.235;
/**
 * A neck, which there was not one of.
 *
 * It exists for the small heads rather than for the look. `headScale` runs down
 * to 0.92, and at that size a head centred at `HEAD_Y` clears the top of the
 * torso by two centimetres — so before this, the smallest kids were heads
 * floating over their own shoulders, and the only reason nobody saw it is that
 * the head used to be sunk far enough for even the smallest to reach.
 *
 * Uninked, and for the same reason the hands and eyes are: it is small, it is
 * pressed between two things that already carry a shell, and a rim of ink round
 * it would draw a collar nobody asked for.
 */
const NECK_R = 0.072;
/**
 * Hair, narrower than the skull it sits on.
 *
 * Wider than the head and it stops being hair and becomes a hat brim, which is
 * what the first version was — a slab overhanging the face on every side.
 */
const HAIR_W = HEAD_R * 1.78;
const HAIR_H = HEAD_R * 0.62;
/**
 * Deeper than it was, because from behind these were bald.
 *
 * At 1.72 the slab reached about six-sevenths of the way across a head two
 * radii deep, and it was pushed forward as well — so the back of every skull
 * was bare skin from the crown down. Front on nobody could tell; the back is
 * the view you have of somebody running away from you, which in a game about
 * chasing is most of the views there are.
 */
const HAIR_D = HEAD_R * 2.02;

/**
 * Where a feature sits, as a fraction of the head's radius **along its own
 * direction from the centre**.
 *
 * The distinction is the bug this replaced. The eyes were placed at the offset
 * `(±0.37r, -0.14r, -0.97r)`, which reads as "just inside the surface" and is
 * not: that vector is 1.048r long, so an eye whose own radius was another
 * 0.25r stood a third of a head proud of the skull. Face on it looked fine.
 * In profile it was a black ball stuck to the temple, which is exactly the kind
 * of thing that only a screenshot from the side ever finds.
 *
 * So a direction is chosen, normalised, and *then* scaled — and the number
 * below means what it says at last.
 */
const FACE_SEAT = 1.0;
/** Eyes: out from the middle of the face, and a little below centre. */
const EYE_AIM = { x: 0.35, y: -0.12, z: -1 };
/**
 * Big, and deliberately so — but not as big as they were.
 *
 * At 0.055 an eye was very nearly half the head's radius across, which is fine
 * at the four to thirty metres a round is played at and reads as goggles the
 * moment anybody stands next to you. The job they do at distance is "which way
 * is that kid facing", and most of that is carried by the silhouette anyway:
 * the hair sits back, the shoes point forward. So they only have to be visible,
 * not enormous.
 */
const EYE_R = 0.046;
/**
 * How flat an eye is.
 *
 * A sphere on a sphere is a bead. Squashing it along the face's own normal
 * makes it read as painted on from every angle, which is what a cel-shaded
 * face wants, and it is what keeps the profile clean no matter how proud the
 * centre sits.
 */
const EYE_FLATTEN = 0.26;

/**
 * An eye in three parts, which is what makes it look like an eye.
 *
 * One dark disc is a dot, and a face made of dots is a doll — which is exactly
 * what these were. What reads as human is the *white*, because a sclera is the
 * only part of a face that is nearly the brightest thing on it, and because a
 * dark pupil inside a light field is the thing an eye is. The iris between them
 * carries the only piece of colour anybody chooses about their own face.
 *
 * Three stacked discs rather than one textured one: this renderer has no UVs on
 * its character geometry and no texture pipeline, on purpose, and three flat
 * shapes at 0.6% of a frame is a much better trade than acquiring one.
 */
const IRIS_R = EYE_R * 0.62;
const PUPIL_R = EYE_R * 0.3;
/**
 * How far each layer stands in front of the one behind it.
 *
 * **Derived rather than chosen**, and the difference is a face that works. The
 * three discs are squashed spheres, so the front of each one is its centre plus
 * its own half-depth — and a smaller disc has a *smaller* half-depth. Picking
 * the offsets by eye put the iris six millimetres forward of a sclera whose
 * surface was already fifteen in front of its own centre, so the iris sat
 * exactly level with the white and the two z-fought: the eyes came out as
 * plain white ovals with no iris and no pupil in them at all, which is a doll
 * again by a different route.
 *
 * So each lift is "clear the front of the layer behind, then a step". The step
 * is the only free number here, and it is small enough not to read as a bead
 * and large enough that a depth buffer can tell the layers apart.
 */
const EYE_STEP = 0.0035;
const halfDepth = (radius: number): number => radius * EYE_FLATTEN;
const IRIS_OUT = halfDepth(EYE_R) - halfDepth(IRIS_R) + EYE_STEP;
const PUPIL_OUT = IRIS_OUT + halfDepth(IRIS_R) - halfDepth(PUPIL_R) + EYE_STEP;
/** Whites, not white: a pure white sclera on a toon ramp is a hole in the face. */
const SCLERA = 0xf2ece2;
const PUPIL = 0x140f0d;

/**
 * Brows, which are the difference between a face and a mask.
 *
 * They do more for "this is a person" than the eyes underneath them, and they
 * are the only part of a face that carries a mood without animating. A bar
 * each, tilted by the chosen style.
 */
const BROW_AIM = { x: 0.35, y: 0.2, z: -1 };
const BROW_W = 0.072;
const BROW_H = 0.02;
const BROW_D = 0.03;
/** A mouth, which there was not one of. Two dots is a doll, not a kid. */
const MOUTH_AIM = { x: 0, y: -0.44, z: -1 };
const MOUTH_W = 0.092;
const MOUTH_H = 0.024;
const MOUTH_D = 0.03;
/** Dark, but warmer than the eyes: a black slot in a face reads as a wound. */
const MOUTH_INK = 0x53312c;

/** Metres of ground per complete stride. Shorter than an adult's, they are kids. */
const STRIDE_LENGTH = 1.45;
/** Radians a leg swings at full tilt. */
const SWING_MAX = 0.68;
/** Arms swing a little less than legs, or it reads as a march. */
const ARM_SWING = 0.58;
/** Speed at which the lean and the stride are considered full. */
const FULL_SPEED = 6.0;
/** How far a running kid tips into it. */
const LEAN_MAX = 0.2;

/**
 * A standing kid still breathes.
 *
 * Four of them waiting on a lawn were four statues in identical poses, which is
 * the single loudest thing wrong with a group shot — more than any proportion,
 * because a person who is completely still is not a person. It costs a sine and
 * a millimetre or two of lift.
 *
 * The phase is per kid, taken from the same seeded look, so a group does not
 * inhale together. Legs are deliberately left out of it: feet on the ground do
 * not move, and a walk cycle that never quite settles is the thing the stride's
 * easing exists to prevent.
 */
const IDLE_RATE = 1.5;
const IDLE_LIFT = 0.009;
/** How much the arms drift with the breath. Radians. */
const IDLE_SWAY = 0.035;
const TAU = Math.PI * 2;

/*
 * The palettes, the contrast rule that keeps hair off skin, and the seeded
 * default all moved to `appearance.ts` when appearance stopped being a function
 * of an actor id. They are facts about what a player may choose, and this file
 * is only the thing that draws the choice.
 */
/** Everything the batch needs to draw one person. */
export interface CharacterPose {
  /** Stable identity: picks skin, hair and build, and keys the stride. */
  id: number;
  /** Feet position. */
  x: number; y: number; z: number;
  /** Which way they are facing, radians. */
  facing: number;
  /** Ground speed, for the walk cycle and the lean. */
  speed: number;
  /** False while airborne, which changes the pose entirely. */
  onGround: boolean;
  /** Shirt colour, already blended for how wet and how stunned they are. */
  shirt: THREE.Color;
  /** Slumped and washed out; skips the walk cycle. */
  stunned?: boolean;
}

/** One instanced part and its ink shell. */
interface Part {
  mesh: THREE.InstancedMesh;
  outline: THREE.InstancedMesh | null;
}

/**
 * How a kid is put together, ready to draw.
 *
 * The render-side half of an `Appearance`: the same choices with the colours
 * turned into `THREE.Color`s and the sliders turned into the multipliers the
 * matrices want. Split from the data because an `Appearance` has to survive a
 * socket and localStorage, and a `THREE.Color` survives neither.
 *
 * Cached and keyed by actor id rather than rebuilt, because the alternative is
 * allocating six colours per kid per frame.
 */
export interface Look {
  readonly appearance: Appearance;
  skin: THREE.Color;
  hair: THREE.Color;
  eyes: THREE.Color;
  shirt: THREE.Color;
  trousers: THREE.Color;
  shoes: THREE.Color;
  style: HairStyle;
  brows: number;
  mouth: number;
  headScale: number;
  /**
   * How stocky, across the shoulders and through the chest.
   *
   * Everything about a kid used to be the same size but a different colour, so
   * a line of them read as one child recoloured. Width is the safe axis to vary
   * and height is not: the joints are tied to `CAP_HEIGHT` precisely so the
   * drawing and the thing that collides cannot disagree, and a kid drawn taller
   * than their own capsule has feet that float. There is deliberately no height
   * slider in the locker, for exactly that reason.
   */
  build: number;
  /** Where in a breath they are, so a group of them does not inhale together. */
  idlePhase: number;
}

const lookCache = new Map<number, Look>();
/**
 * What people have actually chosen, as opposed to what their id says.
 *
 * Empty for everybody who has never opened a locker — which is every bot, and
 * every player until they do — so the lawn stays exactly as varied as it was
 * before any of this existed, and nothing had to be sent for that to be true.
 */
const wardrobe = new Map<number, Appearance>();

const colour = (hex: number): THREE.Color =>
  new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

/**
 * Put somebody in what they chose, or back in what their id says.
 *
 * The cached `Look` is dropped rather than mutated, because a `Look` is handed
 * out by reference and something may be holding one — a colour that changes
 * underneath its holder is the kind of bug that surfaces three frames later
 * somewhere else entirely.
 */
export function dress(id: number, appearance: Appearance | null): void {
  if (appearance === null) wardrobe.delete(id);
  else wardrobe.set(id, clampAppearance(appearance));
  lookCache.delete(id);
}

/** What somebody is wearing, chosen or seeded. */
export function wearing(id: number): Appearance {
  return wardrobe.get(id) ?? defaultAppearance(id);
}

/** Forget every chosen appearance. Leaving a session, or a test starting over. */
export function undressAll(): void {
  wardrobe.clear();
  lookCache.clear();
}

export function lookFor(id: number): Look {
  const cached = lookCache.get(id);
  if (cached !== undefined) return cached;

  const appearance = wearing(id);
  const look: Look = {
    appearance,
    skin: colour(SKIN_TONES[appearance.skin] ?? SKIN_TONES[0]),
    hair: colour(HAIR_COLOURS[appearance.hair] ?? HAIR_COLOURS[0]),
    eyes: colour(EYE_COLOURS[appearance.eyes] ?? EYE_COLOURS[0]),
    shirt: colour(CLOTH_COLOURS[appearance.shirt] ?? CLOTH_COLOURS[0]),
    trousers: colour(CLOTH_COLOURS[appearance.trousers] ?? CLOTH_COLOURS[0]),
    shoes: colour(CLOTH_COLOURS[appearance.shoes] ?? CLOTH_COLOURS[0]),
    style: HAIR_STYLES[appearance.hairStyle] ?? HAIR_STYLES[1]!,
    brows: appearance.brows,
    mouth: appearance.mouth,
    headScale: headScaleOf(appearance),
    build: buildOf(appearance),
    // Not part of the appearance: nobody chooses where in a breath they are,
    // and two people who picked the same outfit should still not inhale
    // together. Seeded by id, which is the one thing that is always different.
    idlePhase: new Rng(`breath-${id}`).next() * TAU,
  };
  lookCache.set(id, look);
  return look;
}

/** Ink, matching the outline the world's parts are drawn with. */
const INK = 0x2b201c;
/**
 * A shade heavier than the world's 0.02.
 *
 * Characters are the thing you are actually looking for on a lawn, and at the
 * distance you usually see them the pixel clamp has already pulled the line to
 * its floor — so the extra world thickness is what buys a visible edge at close
 * range without the far ones getting fatter.
 */
const OUTLINE_THICKNESS = 0.03;

/** Per-kid animation state, carried between frames. See `CharacterBatch.state`. */
interface KidState {
  stride: number;
  lean: number;
  idle: number;
  /** The last frame this kid was posed on. Anything older is not here any more. */
  seen: number;
}

export class CharacterBatch {
  readonly group = new THREE.Group();

  private readonly torso: Part;
  private readonly head: Part;
  private readonly hair: Part;
  /** Left then right. */
  private readonly arms: Part[] = [];
  private readonly legs: Part[] = [];
  private readonly shoes: Part[] = [];
  private readonly bunch: Part;
  /**
   * One mesh per paintable shape, each holding every mark of that shape being
   * worn by anybody on screen.
   *
   * Per shape rather than per body slot, because instances share a geometry:
   * a slot that could hold any shape would need a mesh per shape anyway. This
   * way a shape nobody has chosen has a count of zero and costs nothing, and
   * the usual case — a lawn where two or three marks are in use — is two or
   * three draw calls rather than twelve.
   */
  private readonly marks = new Map<MarkShape, THREE.InstancedMesh>();
  /** How many instances of each shape have been written this frame. */
  private readonly markCount = new Map<MarkShape, number>();
  private readonly neck: THREE.InstancedMesh;
  private readonly mouth: THREE.InstancedMesh;
  private readonly hands: THREE.InstancedMesh;
  /** Sclera, iris and pupil — three stacked discs, two of each per person. */
  private readonly eyes: THREE.InstancedMesh;
  private readonly irises: THREE.InstancedMesh;
  private readonly pupils: THREE.InstancedMesh;
  private readonly brows: THREE.InstancedMesh;

  private readonly outlineMaterials: THREE.ShaderMaterial[] = [];
  private readonly parts: Part[] = [];

  /**
   * What the rig remembers about one kid between frames.
   *
   * `stride` advances by distance travelled rather than by wall-clock, so feet
   * keep pace with the ground instead of sliding — the difference between a
   * walk cycle and a character skating along with their legs waving. `lean` and
   * the slump are eased rather than snapped, or every stop is a jolt. `idle` is
   * a breath, and is the one of the three that runs on the clock, because
   * breathing is not a function of how far you walked.
   *
   * One record rather than a map per field: three `Map.get`s per kid per frame
   * to assemble three numbers that are always wanted together, and three places
   * to forget somebody from instead of one.
   */
  private readonly state = new Map<number, KidState>();
  /** Which frame we are on, so `finish` can tell who was not drawn. */
  private frame = 0;

  private readonly matrix = new THREE.Matrix4();
  private readonly pos = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();
  private readonly euler = new THREE.Euler();
  private readonly one = new THREE.Vector3(1, 1, 1);
  private readonly scratchScale = new THREE.Vector3(1, 1, 1);
  /** Scratch for placing things in the head's frame. Hoisted; this runs per kid per frame. */
  private readonly offset = new THREE.Vector3();
  private readonly head3 = new THREE.Vector3();
  /** A second rotation, for the face parts that turn within the head's frame. */
  private readonly browQuat = new THREE.Quaternion();
  private readonly markSpin = new THREE.Quaternion();
  /** The torso and arms as they were actually posed, for hanging paint off. */
  private readonly torsoAt = new THREE.Vector3();
  private readonly torsoTurn = new THREE.Quaternion();
  private readonly armAt = new THREE.Vector3();
  private readonly armTurn = new THREE.Quaternion();
  private readonly markColour = new THREE.Color();


  private drawn = 0;

  constructor(readonly capacity: number) {
    this.group.name = 'characters';
    const rng = new Rng('kid-geometry');

    // Bodies. Every one of these is modelled so the instance matrix places a
    // *joint*, not a centre — see limbGeometry.
    this.torso = this.makePart(
      'torso', chamferedBox(TORSO_W, TORSO_TOP - HIP_Y, TORSO_D, 0.05),
      0xffffff, true,
    );
    this.head = this.makePart('head', blob(HEAD_R, 1, 0.075, () => rng.next()), 0xffffff, true);
    // A slab rather than a cap: hair that follows the skull exactly reads as a
    // swimming cap, and the point of it is to break the silhouette.
    // Anchored at its underside rather than its middle, so scaling a mop taller
    // grows it upward. Centred, the tall variants grew *down* over the face and
    // every kid with big hair had no features at all.
    const hairGeometry = chamferedBox(HAIR_W, HAIR_H, HAIR_D, 0.045);
    hairGeometry.translate(0, HAIR_H / 2, 0);
    this.hair = this.makePart('hair', hairGeometry, 0xffffff, true);

    for (let i = 0; i < 2; i++) {
      this.arms.push(this.makePart(`arm${i}`, this.limbGeometry(0.125, ARM_LEN, 0.135), 0xffffff, true));
    }
    for (let i = 0; i < 2; i++) {
      // Denim, and one solid colour from hip to ankle — a kid in shorts with
      // bare legs needs two boxes per leg and does not survive being twenty
      // metres away, which is where they usually are.
      this.legs.push(this.makePart(`leg${i}`, this.limbGeometry(0.155, LEG_LEN, 0.175), 0x46567a, true));
    }
    for (let i = 0; i < 2; i++) {
      // Trainers: deliberately oversized and pushed forward, which is most of
      // what makes a walk cycle read at a distance.
      const shoe = chamferedBox(0.17, 0.11, 0.27, 0.035);
      shoe.translate(0, -0.055, 0.035);
      this.shoes.push(this.makePart(`shoe${i}`, shoe, 0xe8e2d4, true));
    }

    // A neck, which fills the gap a small head leaves over the collar. Skin, so
    // it is tinted per kid like the head and the hands.
    this.neck = this.makeMesh(
      'neck', chamferedBox(NECK_R * 2, 0.1, NECK_R * 2, 0.02), 0xffffff,
    );

    // The face and the hands carry no outline. All of it is small enough that a
    // shell would be most of the shape, and all of it sits against something
    // already outlined.
    //
    // Each eye layer is a sphere squashed along the face's normal rather than a
    // ball. A ball on a ball reads as a bead stuck to the head from any angle
    // that is not straight on, which is what the first one did.
    const disc = (radius: number): THREE.BufferGeometry => {
      const g = new THREE.SphereGeometry(radius, 10, 6);
      g.scale(1, 1, EYE_FLATTEN);
      return g;
    };
    // Two slots per person, hence the doubled pools — `pairCapacity` rather
    // than `capacity * 2`, which is what the helper was written for and was not
    // being used by the one place that had to agree with it.
    this.hands = this.makeMesh(
      'hands', blob(0.072, 0, 0.14, () => rng.next()), 0xffffff, pairCapacity(capacity),
    );
    this.eyes = this.makeMesh('eyes', disc(EYE_R), SCLERA, pairCapacity(capacity));
    this.irises = this.makeMesh('irises', disc(IRIS_R), 0xffffff, pairCapacity(capacity));
    this.pupils = this.makeMesh('pupils', disc(PUPIL_R), PUPIL, pairCapacity(capacity));
    this.brows = this.makeMesh(
      'brows', chamferedBox(BROW_W, BROW_H, BROW_D, 0.006), 0xffffff, pairCapacity(capacity),
    );
    this.mouth = this.makeMesh(
      'mouth', chamferedBox(MOUTH_W, MOUTH_H, MOUTH_D, 0.008), MOUTH_INK,
    );
    // A bunch of hair behind the head — a ponytail, a puff — for the styles
    // that have one. Outlined, because unlike the rest of the face it is on the
    // silhouette, and a shape on the silhouette without ink is the one thing
    // this world does not have.
    this.bunch = this.makePart(
      'bunch', blob(0.1, 1, 0.11, () => rng.next()), 0xffffff, true,
    );

    // Paint. Four slots a person, so the pool is four deep — but a shape that
    // nobody is wearing draws nothing, which is what makes twelve of these
    // affordable.
    for (const [shape, geometry] of markGeometries()) {
      const mesh = this.makeMesh(
        `mark-${shape}`, geometry, 0xffffff, capacity * MARK_SLOTS.length,
      );
      // Both sides: a mark on a back is seen from behind, and one on an arm is
      // seen from whichever way that arm is swinging.
      (mesh.material as THREE.MeshToonMaterial).side = THREE.DoubleSide;
      this.marks.set(shape, mesh);
    }

    this.hideAll();
  }

  /**
   * A limb with its pivot at the origin rather than its centre.
   *
   * A box centred on itself rotates about its middle, which makes a leg scissor
   * around its own knee. Shifting the geometry down by half its length puts the
   * joint at the origin, so the instance matrix can place the hip and rotate
   * about it — which is what a hip does.
   */
  private limbGeometry(w: number, len: number, d: number): THREE.BufferGeometry {
    const g = chamferedBox(w, len, d, 0.028);
    g.translate(0, -len / 2, 0);
    return g;
  }

  private makeMesh(
    name: string, geometry: THREE.BufferGeometry, color: number, slots = this.capacity,
  ): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geometry, createToonMaterial({ color }), slots);
    // Named because a test that finds a leg by counting children is testing
    // whichever mesh happens to be sixth, and goes on passing when that stops
    // being a leg.
    mesh.name = name;
    mesh.castShadow = true;
    // Characters move every frame and are never all on screen at once; culling
    // an instanced mesh is all-or-nothing against a bounding sphere that would
    // have to cover the whole lot, so it can only ever be wrong.
    mesh.frustumCulled = false;
    this.group.add(mesh);
    return mesh;
  }

  private makePart(
    name: string, geometry: THREE.BufferGeometry, color: number, outlined: boolean,
  ): Part {
    const mesh = this.makeMesh(name, geometry, color);
    let outline: THREE.InstancedMesh | null = null;
    if (outlined) {
      const material = createOutlineMaterial(INK, OUTLINE_THICKNESS);
      // Back faces only: the shell is the same geometry pushed out along its
      // smoothed normal, so what survives is a rim round the silhouette.
      material.side = THREE.BackSide;
      outline = new THREE.InstancedMesh(geometry, material, this.capacity);
      outline.name = `${name}-ink`;
      outline.frustumCulled = false;
      outline.castShadow = false;
      // Drawn before the body, so the ink never lands on top of a face.
      outline.renderOrder = -1;
      this.group.add(outline);
      this.outlineMaterials.push(material);
    }
    const part: Part = { mesh, outline };
    this.parts.push(part);
    return part;
  }

  /** Begin a frame. Everything not posed before `finish` is hidden. */
  begin(): void {
    this.drawn = 0;
    this.frame++;
    this.markCount.clear();
  }

  /**
   * Pose one person.
   *
   * Returns false when the batch is full, which is a real answer rather than an
   * error: a mode may spawn more than the pool holds, and the right behaviour is
   * to draw as many as fit rather than to grow a buffer mid-round.
   */
  pose(dt: number, p: CharacterPose): boolean {
    const index = this.drawn;
    if (index >= this.capacity) return false;
    this.drawn++;

    const look = lookFor(p.id);
    const facing = p.facing;
    const cos = Math.cos(facing);
    const sin = Math.sin(facing);

    // ── The walk cycle ────────────────────────────────────────────────────────
    let kid = this.state.get(p.id);
    if (kid === undefined) {
      kid = { stride: 0, lean: 0, idle: look.idlePhase, seen: this.frame };
      this.state.set(p.id, kid);
    }
    kid.seen = this.frame;

    const moving = p.onGround && !(p.stunned === true) && p.speed > 0.25;
    let phase = kid.stride;
    if (moving) {
      phase = (phase + (p.speed / STRIDE_LENGTH) * TAU * dt) % TAU;
    } else {
      // Toward the nearest neutral, whichever way is shorter, so stopping
      // settles into a stance rather than freezing mid-step.
      const target = phase < Math.PI ? 0 : TAU;
      phase += (target - phase) * Math.min(1, dt * 9);
    }
    kid.stride = phase;

    // The breath runs whatever they are doing, so there is no seam at the
    // moment somebody stops — it is simply uncovered by the stride settling.
    kid.idle = (kid.idle + IDLE_RATE * dt) % TAU;
    const breath = Math.sin(kid.idle);

    const effort = Math.min(1, p.speed / FULL_SPEED);
    const swing = moving ? Math.sin(phase) * SWING_MAX * (0.55 + effort * 0.45) : 0;
    // Twice a stride: both feet plant per cycle, so the bob is at double rate.
    // Standing, it is a breath instead — a kid waiting on a lawn who is
    // perfectly rigid is the loudest thing wrong with a group of them.
    const bob = moving ? Math.cos(phase * 2) * 0.024 : breath * IDLE_LIFT;
    const sway = moving ? 0 : breath * IDLE_SWAY;

    // Lean into a run, slump when stunned, arch back a little in the air. Eased,
    // because all three change abruptly and a body should not.
    //
    // Positive is forward throughout, which is *not* what a positive rotation
    // about the local X axis does — that tips the chest backwards — so the sign
    // is flipped once, at the point the angle becomes a rotation, rather than
    // being carried inverted through every offset below.
    const wantLean = p.stunned === true ? 0.42 : !p.onGround ? -0.14 : effort * LEAN_MAX;
    let lean = kid.lean;
    lean += (wantLean - lean) * Math.min(1, dt * 8);
    kid.lean = lean;

    // ── Torso ─────────────────────────────────────────────────────────────────
    //
    // Leaning about the hip rather than the middle: a body that pitches about
    // its own centre pushes its legs backwards out of the ground.
    const torsoMid = (TORSO_TOP - HIP_Y) / 2;
    const leanCos = Math.cos(lean);
    const leanSin = Math.sin(lean);
    const torsoY = HIP_Y + torsoMid * leanCos;
    // Forward is -Z in the character's own frame, so a forward lean carries the
    // chest that way once the offset is turned by the facing.
    const torsoReach = torsoMid * leanSin;
    this.pos.set(
      p.x + torsoReach * -sin,
      p.y + torsoY + bob,
      p.z + torsoReach * -cos,
    );
    this.euler.set(-lean, facing, 0, 'YXZ');
    this.quat.setFromEuler(this.euler);
    // Wider or narrower per kid, never taller: the joints are tied to
    // `CAP_HEIGHT` so the drawing and the capsule agree about how tall somebody
    // is, and a kid drawn taller than their own capsule has floating feet.
    this.scratchScale.set(look.build, 1, look.build);
    this.setPart(this.torso, index, this.pos, this.quat, this.scratchScale);
    this.torso.mesh.setColorAt(index, p.shirt);
    // Kept, because the paint hangs off the chest and the chest is *here* —
    // not at the feet. The torso pivots about the hip when it leans, so a mark
    // placed at a fixed distance from the ground ends up inside the shirt the
    // moment somebody tips forward. Which is what the first version did, and it
    // showed up as a back that could not be painted at all.
    this.torsoAt.copy(this.pos);
    this.torsoTurn.copy(this.quat);

    // ── Head, hair, face, neck ────────────────────────────────────────────────
    //
    // The head rides on top of the leaned torso, so it travels forward with the
    // chest instead of staying pinned over the hips.
    const neckLift = (HEAD_Y - HIP_Y) * leanSin;
    const headX = p.x + neckLift * -sin;
    const headZ = p.z + neckLift * -cos;
    const headY = p.y + HIP_Y + (HEAD_Y - HIP_Y) * leanCos + bob;

    // Heads stay upright through about half the lean, which is what people do
    // when they run — and it keeps the face pointing where they are going.
    this.euler.set(-lean * 0.45, facing, 0, 'YXZ');
    this.quat.setFromEuler(this.euler);
    this.pos.set(headX, headY, headZ);
    this.scratchScale.setScalar(look.headScale);
    this.setPart(this.head, index, this.pos, this.quat, this.scratchScale);
    this.head.mesh.setColorAt(index, look.skin);

    // Hair, eyes and mouth are placed by rotating an offset in the *head's*
    // frame, rather than by the facing alone. Otherwise a tipped head keeps its
    // face pointing at the horizon while the skull turns underneath it.
    const r = HEAD_R * look.headScale;
    this.head3.set(headX, headY, headZ);

    // Sits on the crown and slightly back, so a fringe never reaches the eyes.
    // The style is five numbers over the one slab rather than five geometries:
    // at this scale a cartoon haircut is carried almost entirely by how tall it
    // is, how far down the back it comes, and whether there is something behind
    // the head — and a mesh per style would be a draw call per style.
    const style = look.style;
    this.pos.copy(this.attach(0, r * style.lift, r * style.back));
    this.scratchScale.set(
      style.wide * look.headScale, style.tall * look.headScale, style.deep * look.headScale,
    );
    this.setPart(this.hair, index, this.pos, this.quat, this.scratchScale);
    this.hair.mesh.setColorAt(index, look.hair);

    // The bunch, for the styles that have one. Zero-scaled for the ones that do
    // not, rather than skipped: an instance below `count` is drawn whatever is
    // in it, so "do not draw this one" has to be a matrix that produces no
    // pixels. A degenerate scale is the cheapest one there is.
    this.pos.copy(this.attach(0, r * 0.02, r * (0.86 + style.bunch * 0.42)));
    const bunchScale = style.bunch * look.headScale;
    this.scratchScale.set(bunchScale, bunchScale * 1.25, bunchScale);
    this.setPart(this.bunch, index, this.pos, this.quat, this.scratchScale);
    this.bunch.mesh.setColorAt(index, look.hair);

    // ── The face ──────────────────────────────────────────────────────────────
    //
    // Three discs an eye. One dark dot each is what these were, and a face made
    // of dots is a doll: what reads as human is the *white*, because a sclera is
    // very nearly the brightest thing on a face, and a dark pupil inside a light
    // field is the thing an eye actually is. The iris between them carries the
    // only colour anybody chooses about their own face.
    //
    // Each layer stands a hair further out than the one behind it. Coplanar
    // discs on a curved skull z-fight, and z-fighting on a face at four metres
    // is the most visible artefact this renderer can produce.
    const brow = BROWS[look.brows] ?? BROWS[0]!;
    const drawBrows = look.brows !== BROWS_NONE;
    for (let e = 0; e < 2; e++) {
      const side = e === 0 ? -1 : 1;
      const slot = index * 2 + e;

      this.seat(EYE_AIM.x * side, EYE_AIM.y, EYE_AIM.z, r);
      this.matrix.compose(this.pos, this.quat, this.scratchScale.setScalar(look.headScale));
      this.eyes.setMatrixAt(slot, this.matrix);

      this.seat(EYE_AIM.x * side, EYE_AIM.y, EYE_AIM.z, r + IRIS_OUT * look.headScale);
      this.matrix.compose(this.pos, this.quat, this.scratchScale.setScalar(look.headScale));
      this.irises.setMatrixAt(slot, this.matrix);
      this.irises.setColorAt(slot, look.eyes);

      this.seat(EYE_AIM.x * side, EYE_AIM.y, EYE_AIM.z, r + PUPIL_OUT * look.headScale);
      this.matrix.compose(this.pos, this.quat, this.scratchScale.setScalar(look.headScale));
      this.pupils.setMatrixAt(slot, this.matrix);

      // The brows do more for "this is a person" than the eyes under them, and
      // they are the only part of a face that carries a mood without animating.
      // Tilted by the chosen style, mirrored, so a raised inner edge on one is a
      // raised inner edge on both rather than one up and one down.
      this.seat(BROW_AIM.x * side, BROW_AIM.y + brow.lift, BROW_AIM.z, r);
      this.euler.set(0, 0, brow.tilt * side, 'XYZ');
      this.browQuat.setFromEuler(this.euler);
      this.browQuat.premultiply(this.quat);
      this.matrix.compose(
        this.pos, this.browQuat,
        this.scratchScale.setScalar(drawBrows ? look.headScale : 0),
      );
      this.brows.setMatrixAt(slot, this.matrix);
      this.brows.setColorAt(slot, look.hair);
    }

    // A mouth, which there was not one of. Two dots on a blank face is a doll;
    // the third mark is what makes it a kid, and it is one more box.
    //
    // Stunned, it goes round and open — the one expression the game animates,
    // and it costs a different scale rather than different geometry. Being out
    // of the fight already shows in the shirt, and a shirt is a thing you read
    // at forty metres while a face is a thing you read at four.
    const shape = MOUTHS[look.mouth] ?? MOUTHS[0]!;
    this.seat(MOUTH_AIM.x, MOUTH_AIM.y, MOUTH_AIM.z, r);
    this.scratchScale.set(
      look.headScale * (p.stunned === true ? 0.5 : shape.wide),
      look.headScale * (p.stunned === true ? 2.6 : shape.tall),
      look.headScale,
    );
    // A grin and a frown are the same bar rolled about the face's own normal at
    // one end — which is not a curve, and is the whole of what a curve buys at
    // this size. A second segment would be a second draw call for a shape three
    // pixels tall at the distance anybody sees it.
    this.euler.set(0, 0, p.stunned === true ? 0 : shape.curve * 0.55, 'XYZ');
    this.browQuat.setFromEuler(this.euler);
    this.browQuat.premultiply(this.quat);
    this.matrix.compose(this.pos, this.browQuat, this.scratchScale);
    this.mouth.setMatrixAt(index, this.matrix);

    // The neck, bridging collar to jaw. Placed halfway between the two so it
    // covers the gap a small head leaves and disappears inside a large one.
    this.pos.copy(this.attach(0, -r * 0.86, 0));
    this.pos.y = (this.pos.y + p.y + TORSO_TOP + bob) / 2;
    this.matrix.compose(this.pos, this.quat, this.one);
    this.neck.setMatrixAt(index, this.matrix);
    this.neck.setColorAt(index, look.skin);

    // ── Limbs ─────────────────────────────────────────────────────────────────
    //
    // Shoulders ride the lean with the chest; hips do not, because hips are
    // where the lean is measured from.
    const shoulderLift = (SHOULDER_Y - HIP_Y) * leanSin;
    const shoulderY = p.y + HIP_Y + (SHOULDER_Y - HIP_Y) * leanCos + bob;
    const shoulderX = p.x + shoulderLift * -sin;
    const shoulderZ = p.z + shoulderLift * -cos;

    // Airborne: legs tuck up and arms come out, which is the difference between
    // a jump and a person sliding upwards.
    const airborne = !p.onGround;
    // The sway is the breath again, mirrored, so the arms drift apart and back
    // rather than swinging in step like a march.
    const armSwingL = airborne ? -0.85 : -swing * ARM_SWING + lean * 0.5 + sway;
    const armSwingR = airborne ? -0.85 : swing * ARM_SWING + lean * 0.5 - sway;
    const legSwingL = airborne ? 0.55 : swing;
    const legSwingR = airborne ? 0.25 : -swing;

    // Shoulders follow the build, or a stocky kid's arms hang inside their own
    // chest and a slight one's float clear of it.
    const shoulderOut = SHOULDER_X * look.build;
    this.poseLimb(this.arms[0]!, index, shoulderX, shoulderY, shoulderZ,
      cos, sin, -shoulderOut, facing, armSwingL, p.shirt);
    this.poseLimb(this.arms[1]!, index, shoulderX, shoulderY, shoulderZ,
      cos, sin, shoulderOut, facing, armSwingR, p.shirt);
    this.poseLimb(this.legs[0]!, index, p.x, p.y + HIP_Y, p.z,
      cos, sin, -HIP_X, facing, legSwingL, look.trousers);
    this.poseLimb(this.legs[1]!, index, p.x, p.y + HIP_Y, p.z,
      cos, sin, HIP_X, facing, legSwingR, look.trousers);

    // Hands and shoes hang off the end of the limb they belong to, which means
    // swinging them by the same angle about the same joint rather than guessing
    // at where the limb ended up.
    this.tipOf(this.hands, index * 2, shoulderX, shoulderY, shoulderZ,
      cos, sin, -shoulderOut, facing, armSwingL, ARM_LEN, look.skin);
    this.tipOf(this.hands, index * 2 + 1, shoulderX, shoulderY, shoulderZ,
      cos, sin, shoulderOut, facing, armSwingR, ARM_LEN, look.skin);
    this.tipOfPart(this.shoes[0]!, index, p.x, p.y + HIP_Y, p.z,
      cos, sin, -HIP_X, facing, legSwingL, LEG_LEN, look.shoes);
    this.tipOfPart(this.shoes[1]!, index, p.x, p.y + HIP_Y, p.z,
      cos, sin, HIP_X, facing, legSwingR, LEG_LEN, look.shoes);

    // ── Paint ─────────────────────────────────────────────────────────────────
    //
    // Every mark is placed **in the frame of the part it is painted on**, which
    // is the same rule the face follows and for the same reason. Placed in world
    // space against the feet instead, a mark is right only while its wearer is
    // standing perfectly upright: the torso pivots about the hip as it leans and
    // the arms swing about the shoulder, so a chest mark at a fixed height drifts
    // out of the shirt at the front and *into* it at the back.
    const worn = look.appearance.marks;

    // Chest and back: out along the torso's own ±Z by half its depth. The back
    // one is turned to face the other way, or it would be seen mirrored — and,
    // being a flat polygon, would also be lit from the wrong side.
    const chestOut = (TORSO_D / 2) * look.build + MARK_LIFT;
    this.placeMark(worn.chest, 0, 0, -chestOut, this.torsoAt, this.torsoTurn, 0, 0);
    this.placeMark(worn.back, 0, 0, chestOut, this.torsoAt, this.torsoTurn, Math.PI, 0);

    // Sleeves: out on the arm's own side, a little under half way down it, and
    // facing outward rather than forward — a mark on the front of a sleeve is
    // edge-on from every angle anybody actually plays at.
    const sleeveOut = ARM_R + MARK_LIFT;
    for (const [side, mark, swing] of [
      [-1, worn.leftArm, armSwingL], [1, worn.rightArm, armSwingR],
    ] as const) {
      this.armAt.set(shoulderX + shoulderOut * side * cos, shoulderY, shoulderZ - shoulderOut * side * sin);
      this.euler.set(swing, facing, 0, 'YXZ');
      this.armTurn.setFromEuler(this.euler);
      this.placeMark(
        mark, sleeveOut * side, -ARM_LEN * 0.42, 0,
        this.armAt, this.armTurn, (Math.PI / 2) * side, 0.62,
      );
    }

    return true;
  }

  /**
   * Write one mark, if there is one.
   *
   * Packed into the front of its shape's buffer rather than indexed by wearer,
   * so a lawn where one kid in six has painted something draws one instance
   * rather than a pool full of empties. That is the same rule `finish` follows
   * for the bodies, and it is the reason twelve shapes is affordable at all.
   */
  private placeMark(
    mark: Mark,
    lx: number, ly: number, lz: number,
    base: THREE.Vector3, frame: THREE.Quaternion,
    turnAbout: number, shrink: number,
  ): void {
    const shape = MARK_SHAPES[mark.shape];
    if (shape === undefined || shape === 'none') return;
    const mesh = this.marks.get(shape);
    if (mesh === undefined) return;
    const slot = this.markCount.get(shape) ?? 0;
    if (slot >= mesh.instanceMatrix.count) return;

    // The offset is in the part's frame, so it has to be turned by that frame
    // before it means anything in the world — the same step the face takes.
    this.pos.copy(this.offset.set(lx, ly, lz).applyQuaternion(frame).add(base));
    // Two rotations: which way the mark faces on the body, then how far the
    // player has spun it about its own middle.
    this.euler.set(0, turnAbout, mark.turn * Math.PI * 2, 'YZX');
    this.markSpin.setFromEuler(this.euler);
    this.markSpin.premultiply(frame);
    this.matrix.compose(
      this.pos, this.markSpin,
      this.scratchScale.setScalar(markSizeOf(mark) * (1 - shrink * 0.55)),
    );
    mesh.setMatrixAt(slot, this.matrix);
    mesh.setColorAt(slot, this.markColour.setHex(
      CLOTH_COLOURS[mark.colour] ?? CLOTH_COLOURS[0], THREE.SRGBColorSpace,
    ));
    this.markCount.set(shape, slot + 1);
  }

  /**
   * Put something in the head's frame, at a local offset.
   *
   * Was a closure built inside `pose`, in a file that hoists a scratch vector
   * two lines above it with a note saying this runs per kid per frame. One
   * allocation a kid a frame is not a cliff, but it is the thing the rest of
   * this class is careful about, and a method costs nothing.
   *
   * Reads `this.quat` and `this.head3`, which the caller has already set.
   */
  private attach(lx: number, ly: number, lz: number): THREE.Vector3 {
    return this.offset.set(lx, ly, lz).applyQuaternion(this.quat).add(this.head3);
  }

  /**
   * Put a face feature **on the surface**, along the direction it faces.
   *
   * The whole point of normalising first. Written as three offsets and scaled
   * by the radius — which is what this replaced — the numbers say "just inside
   * the skull" and mean nothing of the sort: `(0.37, -0.14, -1)` is 1.07 long,
   * so a feature "at" the surface sat seven per cent outside it before its own
   * thickness was added. That was a third of a head of black bead hanging off
   * every kid's temple, invisible face-on and unmissable from the side.
   *
   * Leaves the answer in `this.pos`.
   */
  private seat(lx: number, ly: number, lz: number, radius: number): void {
    const len = Math.hypot(lx, ly, lz);
    const k = (radius * FACE_SEAT) / len;
    this.pos.copy(this.attach(lx * k, ly * k, lz * k));
  }

  /**
   * Hang one limb off a joint and swing it.
   *
   * The joint offset is in the character's own frame, so it has to be turned by
   * their facing before it means anything in the world — otherwise every kid's
   * arms stay pinned to world east and west however they turn.
   */
  private poseLimb(
    part: Part, index: number,
    x: number, y: number, z: number,
    cos: number, sin: number,
    localX: number, facing: number, swing: number,
    tint: THREE.Color | null,
  ): void {
    this.pos.set(x + localX * cos, y, z - localX * sin);
    // YXZ so the swing happens about the character's own side-to-side axis
    // after the yaw, rather than about a fixed world axis.
    this.euler.set(swing, facing, 0, 'YXZ');
    this.quat.setFromEuler(this.euler);
    this.setPart(part, index, this.pos, this.quat, this.one);
    if (tint !== null) part.mesh.setColorAt(index, tint);
  }

  /** Where a limb of length `len` ends, given the same joint and swing. */
  private tipPosition(
    x: number, y: number, z: number,
    cos: number, sin: number,
    localX: number, swing: number, len: number,
  ): void {
    const jointX = x + localX * cos;
    const jointZ = z - localX * sin;
    // The limb points down its own -Y, rotated by the swing about the local X,
    // so a positive swing carries the tip forward — which is -Z in the
    // character's frame, and (-sin, -cos) once turned by their facing.
    const drop = Math.cos(swing) * len;
    const reach = Math.sin(swing) * len;
    this.pos.set(jointX + reach * -sin, y - drop, jointZ + reach * -cos);
  }

  private tipOf(
    mesh: THREE.InstancedMesh, slot: number,
    x: number, y: number, z: number,
    cos: number, sin: number,
    localX: number, facing: number, swing: number, len: number,
    tint: THREE.Color,
  ): void {
    this.tipPosition(x, y, z, cos, sin, localX, swing, len);
    this.euler.set(swing, facing, 0, 'YXZ');
    this.quat.setFromEuler(this.euler);
    this.matrix.compose(this.pos, this.quat, this.one);
    mesh.setMatrixAt(slot, this.matrix);
    mesh.setColorAt(slot, tint);
  }

  private tipOfPart(
    part: Part, index: number,
    x: number, y: number, z: number,
    cos: number, sin: number,
    localX: number, facing: number, swing: number, len: number,
    tint: THREE.Color | null = null,
  ): void {
    this.tipPosition(x, y, z, cos, sin, localX, swing, len);
    this.euler.set(swing, facing, 0, 'YXZ');
    this.quat.setFromEuler(this.euler);
    this.setPart(part, index, this.pos, this.quat, this.one);
    if (tint !== null) part.mesh.setColorAt(index, tint);
  }

  /** Write one instance to a part and its shell in the same breath. */
  private setPart(
    part: Part, index: number,
    pos: THREE.Vector3, quat: THREE.Quaternion, scale: THREE.Vector3,
  ): void {
    this.matrix.compose(pos, quat, scale);
    part.mesh.setMatrixAt(index, this.matrix);
    part.outline?.setMatrixAt(index, this.matrix);
  }

  /**
   * End a frame: stop the buffers after the last person posed, and upload.
   *
   * `count` rather than a hidden matrix, and the difference is the whole of it.
   * Every unused slot used to be given a degenerate transform that collapsed it
   * to nothing — which hides it and **still draws it**, because an
   * `InstancedMesh` submits `count` instances whatever is in them. With nobody
   * on the lawn that was thirty-two torsos, thirty-two heads, thirty-two heads
   * worth of ink and sixty-four eyes going through the vertex shader every
   * frame to produce no pixels: about thirteen thousand triangles of nothing,
   * which is more than the whole cul-de-sac costs.
   *
   * Lowering `count` fixes it at both ends. The GPU stops processing the empty
   * slots, and the loop that used to write a matrix into each of them — up to
   * two hundred and fifty writes a frame, on the CPU, to hide things — is gone
   * rather than merely shorter, because a slot past `count` cannot be seen no
   * matter what is in it.
   */
  finish(): void {
    for (const part of this.parts) {
      part.mesh.count = this.drawn;
      part.mesh.instanceMatrix.needsUpdate = true;
      if (part.mesh.instanceColor !== null) part.mesh.instanceColor.needsUpdate = true;
      if (part.outline !== null) {
        part.outline.count = this.drawn;
        part.outline.instanceMatrix.needsUpdate = true;
      }
    }
    for (const single of [this.neck, this.mouth]) {
      single.count = this.drawn;
      single.instanceMatrix.needsUpdate = true;
      if (single.instanceColor !== null) single.instanceColor.needsUpdate = true;
    }
    // Two of these per person — a left and a right — so the pair meshes run at
    // twice the count rather than at it.
    for (const pair of [this.hands, this.eyes, this.irises, this.pupils, this.brows]) {
      pair.count = pairCapacity(this.drawn);
      pair.instanceMatrix.needsUpdate = true;
      if (pair.instanceColor !== null) pair.instanceColor.needsUpdate = true;
    }

    // Marks are packed rather than indexed, so the count is however many were
    // actually written — usually zero for most shapes, which is what makes a
    // palette of twelve cost nothing to offer.
    for (const [shape, mesh] of this.marks) {
      mesh.count = this.markCount.get(shape) ?? 0;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
    }

    this.forgetTheAbsent();
  }

  /**
   * Drop the animation state of anybody who was not drawn this frame.
   *
   * Ids are handed out by a counter that never goes backwards inside a round,
   * and Water War spawns a fresh raid every few seconds, so a map keyed by id
   * and never pruned grows for as long as a round lasts. It is small — a few
   * numbers each — and it is still unbounded, which is a different thing from
   * small.
   *
   * Pruning on "was not posed" rather than on a departure hook is deliberate.
   * There is no one place a kid leaves from: a bot goes down inside its mode, a
   * guest drops off a socket, a whole roster is replaced when the round ends.
   * Three call sites to remember means one of them eventually is not, and the
   * one that is not leaves a ghost nobody notices. Whether somebody was drawn
   * is a thing this class already knows for certain.
   */
  private forgetTheAbsent(): void {
    if (this.state.size === this.drawn) return;
    for (const [id, kid] of this.state) {
      if (kid.seen !== this.frame) this.state.delete(id);
    }
  }

  /** How many were posed this frame. For tests and the debug overlay. */
  get posed(): number {
    return this.drawn;
  }

  setOutlinesVisible(visible: boolean): void {
    for (const part of this.parts) {
      if (part.outline !== null) part.outline.visible = visible;
    }
  }

  setViewportHeight(height: number): void {
    for (const m of this.outlineMaterials) m.uniforms.viewportHeight!.value = height;
  }

  /** Hide everyone, e.g. on returning to the menu. */
  hideAll(): void {
    this.drawn = 0;
    this.state.clear();
    this.frame++;
    this.finish();
  }

  /** How many kids the rig is remembering a stride for. For tests. */
  get remembered(): number {
    return this.state.size;
  }
}

/**
 * Hands and eyes need two slots per person, so the pools are twice as long.
 *
 * Split out so the two places that build a batch cannot disagree about it —
 * which they were free to, because the constructor wrote `capacity * 2` by hand
 * and this was called by nobody at all. A helper that exists to stop two things
 * drifting apart and is used by one of them is not doing the job it claims to.
 */
export function pairCapacity(capacity: number): number {
  return capacity * 2;
}
