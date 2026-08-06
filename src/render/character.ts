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
 * **A face.** Two eyes are four hundred bytes of geometry and they do more than
 * everything else here put together. A capsule has no front; a head with eyes
 * has a front, and "which way is that kid facing" stops being a guess.
 *
 * **Being different from each other.** Skin, hair colour and hair shape vary by
 * actor id, so six kids on a lawn are six kids rather than six copies. Seeded
 * from the id rather than randomised, so the same kid looks the same every time
 * you see them — including on two machines that have never spoken.
 *
 * ## Why instanced, and what that costs
 *
 * Twelve instanced meshes and nine outline shells, each one draw call however
 * many people are in the world. That is twenty-one draws for the entire cast,
 * fixed, with no allocation when a wave arrives and no shader compiled mid-round
 * — the two things that produce a visible hitch at exactly the wrong moment.
 *
 * The cost is that a part can only be posed by a matrix and tinted by one
 * colour. So there are no bendable knees and no per-vertex anything: a limb is a
 * rigid box on a pivot. At this scale, with this outline, that is the look
 * anyway.
 */

import * as THREE from 'three';
import { createToonMaterial, createOutlineMaterial } from './toonMaterial.ts';
import { chamferedBox, blob } from './geometry.ts';
import { Rng } from '../core/rng.ts';
import { CAP_HEIGHT, CAP_RADIUS } from '../physics/constants.ts';

/**
 * Where a kid's joints are, as fractions of the collision capsule.
 *
 * Tied to CAP_HEIGHT rather than written as numbers so the drawing and the
 * thing that collides can never disagree about how tall somebody is — a
 * character whose feet float or sink is the first thing anyone notices.
 */
export const HIP_Y = CAP_HEIGHT * 0.42;
export const TORSO_TOP = CAP_HEIGHT * 0.79;
export const HEAD_Y = CAP_HEIGHT * 0.905;
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

/**
 * A head about a quarter of the body.
 *
 * Cartoon proportions on purpose. Eleven-year-olds in a garden drawn at adult
 * proportions read as small adults, and the whole reason the head is this big is
 * that it is where the face is — the part of a character a player actually
 * looks at.
 */
const HEAD_R = 0.235;
/**
 * Hair, narrower than the skull it sits on.
 *
 * Wider than the head and it stops being hair and becomes a hat brim, which is
 * what the first version was — a slab overhanging the face on every side.
 */
const HAIR_W = HEAD_R * 1.78;
const HAIR_H = HEAD_R * 0.62;
const HAIR_D = HEAD_R * 1.72;

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
 * Skin and hair, chosen by actor id.
 *
 * A short list rather than a continuous range: at three bands of toon shading,
 * two tones a few per cent apart are the same tone, and a palette that reads as
 * distinct at forty metres is the only kind worth having.
 */
const SKIN_TONES = [0xf3cfa8, 0xe0a878, 0xb87a4e, 0x8a5636, 0xf7ddc0] as const;
const HAIR_COLOURS = [0x3a2a1c, 0x7a4a24, 0xd9a441, 0x1d1a19, 0xa0522d, 0xc76b3a, 0x5d4037] as const;

/**
 * Rough perceived brightness, for keeping hair off skin.
 *
 * The palettes are both warm browns, so picking from each independently
 * eventually lands mid-brown hair on mid-brown skin and the head becomes one
 * featureless lump — which is exactly what the first kid drawn looked like.
 */
function luma(hex: number): number {
  return (0.2126 * ((hex >> 16) & 255) + 0.7152 * ((hex >> 8) & 255) + 0.0722 * (hex & 255)) / 255;
}
/** Enough of a gap that a hairline is a line rather than a suggestion. */
const HAIR_SKIN_CONTRAST = 0.24;

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
 * How a kid is put together, seeded from their id.
 *
 * Derived rather than stored per actor, so a remote player who joins halfway
 * through looks the same to everyone without anybody having to send what they
 * look like.
 */
export interface Look {
  skin: THREE.Color;
  hair: THREE.Color;
  /** Hair box dimensions, so a mop and a crew cut are different silhouettes. */
  hairScaleY: number;
  hairScaleXZ: number;
  /** Head size, the cheapest way to make two kids obviously different people. */
  headScale: number;
}

const lookCache = new Map<number, Look>();

export function lookFor(id: number): Look {
  const cached = lookCache.get(id);
  if (cached !== undefined) return cached;

  // Seeded by id, so the same person looks the same on every machine that ever
  // draws them — which is a networking requirement, not a nicety.
  const rng = new Rng(`kid-${id}`);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rng.next() * list.length)]!;

  const skin = pick(SKIN_TONES);
  // Hair is chosen from what actually contrasts with the skin already picked,
  // rather than from the whole palette and hoping. The filter can never be empty
  // — the darkest and lightest entries are far apart — but the fallback is there
  // because a palette edit should not be able to crash a character.
  const readable = HAIR_COLOURS.filter(
    (h) => Math.abs(luma(h) - luma(skin)) >= HAIR_SKIN_CONTRAST,
  );
  const look: Look = {
    skin: new THREE.Color().setHex(skin, THREE.SRGBColorSpace),
    hair: new THREE.Color().setHex(
      readable.length > 0 ? pick(readable) : HAIR_COLOURS[0], THREE.SRGBColorSpace,
    ),
    hairScaleY: 0.55 + rng.next() * 1.15,
    hairScaleXZ: 0.92 + rng.next() * 0.2,
    headScale: 0.92 + rng.next() * 0.18,
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

export class CharacterBatch {
  readonly group = new THREE.Group();

  private readonly torso: Part;
  private readonly head: Part;
  private readonly hair: Part;
  /** Left then right. */
  private readonly arms: Part[] = [];
  private readonly legs: Part[] = [];
  private readonly shoes: Part[] = [];
  private readonly hands: THREE.InstancedMesh;
  private readonly eyes: THREE.InstancedMesh;

  private readonly outlineMaterials: THREE.ShaderMaterial[] = [];
  private readonly parts: Part[] = [];

  /**
   * How far through a stride each character is, by actor id.
   *
   * Advanced by distance travelled rather than by wall-clock, so feet keep pace
   * with the ground instead of sliding — the difference between a walk cycle and
   * a character skating along with their legs waving.
   */
  private readonly stride = new Map<number, number>();
  /** Lean and slump are eased rather than snapped, or every stop is a jolt. */
  private readonly lean = new Map<number, number>();

  private readonly matrix = new THREE.Matrix4();
  private readonly pos = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();
  private readonly euler = new THREE.Euler();
  private readonly one = new THREE.Vector3(1, 1, 1);
  private readonly scratchScale = new THREE.Vector3(1, 1, 1);
  /** Scratch for placing things in the head's frame. Hoisted; this runs per kid per frame. */
  private readonly offset = new THREE.Vector3();
  private readonly head3 = new THREE.Vector3();

  private static readonly HIDDEN = new THREE.Matrix4().makeTranslation(0, -9999, 0);

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

    // Hands and eyes carry no outline. Both are small enough that a shell would
    // be most of the shape, and both sit against something already outlined.
    // Two slots per person, hence the doubled pool.
    this.hands = this.makeMesh('hands', blob(0.072, 0, 0.14, () => rng.next()), 0xffffff, capacity * 2);
    this.eyes = this.makeMesh('eyes', new THREE.SphereGeometry(0.058, 8, 6), 0x241c18, capacity * 2);

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
    const moving = p.onGround && !(p.stunned === true) && p.speed > 0.25;
    let phase = this.stride.get(p.id) ?? 0;
    if (moving) {
      phase = (phase + (p.speed / STRIDE_LENGTH) * Math.PI * 2 * dt) % (Math.PI * 2);
    } else {
      // Toward the nearest neutral, whichever way is shorter, so stopping
      // settles into a stance rather than freezing mid-step.
      const target = phase < Math.PI ? 0 : Math.PI * 2;
      phase += (target - phase) * Math.min(1, dt * 9);
    }
    this.stride.set(p.id, phase);

    const effort = Math.min(1, p.speed / FULL_SPEED);
    const swing = moving ? Math.sin(phase) * SWING_MAX * (0.55 + effort * 0.45) : 0;
    // Twice a stride: both feet plant per cycle, so the bob is at double rate.
    const bob = moving ? Math.cos(phase * 2) * 0.024 : 0;

    // Lean into a run, slump when stunned, arch back a little in the air. Eased,
    // because all three change abruptly and a body should not.
    //
    // Positive is forward throughout, which is *not* what a positive rotation
    // about the local X axis does — that tips the chest backwards — so the sign
    // is flipped once, at the point the angle becomes a rotation, rather than
    // being carried inverted through every offset below.
    const wantLean = p.stunned === true ? 0.42 : !p.onGround ? -0.14 : effort * LEAN_MAX;
    let lean = this.lean.get(p.id) ?? 0;
    lean += (wantLean - lean) * Math.min(1, dt * 8);
    this.lean.set(p.id, lean);

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
    this.setPart(this.torso, index, this.pos, this.quat, this.one);
    this.torso.mesh.setColorAt(index, p.shirt);

    // ── Head, hair, eyes ──────────────────────────────────────────────────────
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

    // Hair and eyes are placed by rotating an offset in the *head's* frame,
    // rather than by the facing alone. Otherwise a tipped head keeps its face
    // pointing at the horizon while the skull turns underneath it.
    const r = HEAD_R * look.headScale;
    const attach = (lx: number, ly: number, lz: number): THREE.Vector3 =>
      this.offset.set(lx, ly, lz).applyQuaternion(this.quat)
        .add(this.head3.set(headX, headY, headZ));

    // Sits on the crown and slightly back, so a fringe never reaches the eyes.
    this.pos.copy(attach(0, r * 0.34, r * 0.1));
    this.scratchScale.set(
      look.hairScaleXZ * look.headScale,
      look.hairScaleY * look.headScale,
      look.hairScaleXZ * look.headScale,
    );
    this.setPart(this.hair, index, this.pos, this.quat, this.scratchScale);
    this.hair.mesh.setColorAt(index, look.hair);

    // Two eyes, on the front of the head. A few hundred bytes of geometry that
    // do more work than everything else here: a capsule has no front, and a kid
    // walking at you and one walking away used to be the same silhouette.
    for (let e = 0; e < 2; e++) {
      // Forward is -Z in the head's own frame.
      // Just proud of the surface. At 0.86 of the radius they sat inside the
      // skull and the face was blank — the one thing this was all for.
      this.pos.copy(attach((e === 0 ? -1 : 1) * r * 0.37, -r * 0.14, -r * 0.97));
      this.matrix.compose(this.pos, this.quat, this.one);
      this.eyes.setMatrixAt(index * 2 + e, this.matrix);
    }

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
    const armSwingL = airborne ? -0.85 : -swing * ARM_SWING + lean * 0.5;
    const armSwingR = airborne ? -0.85 : swing * ARM_SWING + lean * 0.5;
    const legSwingL = airborne ? 0.55 : swing;
    const legSwingR = airborne ? 0.25 : -swing;

    this.poseLimb(this.arms[0]!, index, shoulderX, shoulderY, shoulderZ,
      cos, sin, -SHOULDER_X, facing, armSwingL, p.shirt);
    this.poseLimb(this.arms[1]!, index, shoulderX, shoulderY, shoulderZ,
      cos, sin, SHOULDER_X, facing, armSwingR, p.shirt);
    this.poseLimb(this.legs[0]!, index, p.x, p.y + HIP_Y, p.z,
      cos, sin, -HIP_X, facing, legSwingL, null);
    this.poseLimb(this.legs[1]!, index, p.x, p.y + HIP_Y, p.z,
      cos, sin, HIP_X, facing, legSwingR, null);

    // Hands and shoes hang off the end of the limb they belong to, which means
    // swinging them by the same angle about the same joint rather than guessing
    // at where the limb ended up.
    this.tipOf(this.hands, index * 2, shoulderX, shoulderY, shoulderZ,
      cos, sin, -SHOULDER_X, facing, armSwingL, ARM_LEN, look.skin);
    this.tipOf(this.hands, index * 2 + 1, shoulderX, shoulderY, shoulderZ,
      cos, sin, SHOULDER_X, facing, armSwingR, ARM_LEN, look.skin);
    this.tipOfPart(this.shoes[0]!, index, p.x, p.y + HIP_Y, p.z,
      cos, sin, -HIP_X, facing, legSwingL, LEG_LEN);
    this.tipOfPart(this.shoes[1]!, index, p.x, p.y + HIP_Y, p.z,
      cos, sin, HIP_X, facing, legSwingR, LEG_LEN);

    return true;
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
  ): void {
    this.tipPosition(x, y, z, cos, sin, localX, swing, len);
    this.euler.set(swing, facing, 0, 'YXZ');
    this.quat.setFromEuler(this.euler);
    this.setPart(part, index, this.pos, this.quat, this.one);
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

  /** End a frame: hide the unused slots and upload. */
  finish(): void {
    for (const part of this.parts) {
      for (let i = this.drawn; i < this.capacity; i++) {
        part.mesh.setMatrixAt(i, CharacterBatch.HIDDEN);
        part.outline?.setMatrixAt(i, CharacterBatch.HIDDEN);
      }
      part.mesh.instanceMatrix.needsUpdate = true;
      if (part.mesh.instanceColor !== null) part.mesh.instanceColor.needsUpdate = true;
      if (part.outline !== null) part.outline.instanceMatrix.needsUpdate = true;
    }
    for (const pair of [this.hands, this.eyes]) {
      for (let i = this.drawn * 2; i < this.capacity * 2; i++) {
        pair.setMatrixAt(i, CharacterBatch.HIDDEN);
      }
      pair.instanceMatrix.needsUpdate = true;
      if (pair.instanceColor !== null) pair.instanceColor.needsUpdate = true;
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
    this.finish();
    this.stride.clear();
    this.lean.clear();
  }
}

/**
 * Hands and eyes need two slots per person, so the pools are twice as long.
 *
 * Split out so the two places that build a batch cannot disagree about it.
 */
export function pairCapacity(capacity: number): number {
  return capacity * 2;
}
