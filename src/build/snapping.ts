/**
 * Smart snapping.
 *
 * The player aims, and this decides where the part they are holding actually
 * goes. Everything about how the game feels to build in lives here.
 *
 * The approach: cast the aim ray, gather the parts near where it lands, generate
 * candidate placements from a small set of rules, score them, and keep the best
 * one — with enough hysteresis that the preview does not flicker between two
 * near-tied answers while the player's hand shakes.
 *
 * Candidates come from the part-kit invariant that every part's long axis is
 * local +X, thickness +Y, width +Z. That is what makes it possible to derive
 * snap frames from half-extents on the fly instead of authoring them per part.
 */

import * as THREE from 'three';
import { CollisionWorld } from '../physics/collisionWorld.ts';
import { makeObb } from '../physics/partStore.ts';
import type { Obb, PartId } from '../physics/types.ts';
import { MODULE, FINE_MODULE, halfExtents, type PartKind } from './partKit.ts';
import { snapTo } from '../core/mathUtils.ts';

/** How far from the aim hit we look for parts to snap to. */
export const SNAP_RADIUS = 1.5;
/** Furthest the player can place from their eye. */
export const MAX_REACH = 5.0;
/** Closest, so you cannot build inside your own face. */
export const MIN_REACH = 0.45;
/** Rotation nudge, in degrees. Divides both 90 and 360. */
export const ROT_STEP_DEG = 15;
/** An incumbent candidate survives while it scores at least this fraction of the best. */
export const LATCH_MARGIN = 0.8;
/** Overlap tolerance. Flush parts touch exactly, so this must be forgiving. */
export const OVERLAP_EPS = 0.004;
/** How many ranked candidates get the full overlap check each frame. */
export const MAX_VALIDATED = 12;

export type CandidateKind = 'stack' | 'butt' | 'side' | 'ground' | 'free';

export interface Candidate {
  kind: CandidateKind;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  /** The part this candidate attaches to, or -1 for ground and free. */
  host: PartId;
  score: number;
  valid: boolean;
}

/** Rule priority. Face-to-face stacking is what players want most of the time. */
const KIND_BONUS: Record<CandidateKind, number> = {
  stack: 1.0,
  butt: 0.9,
  side: 0.75,
  ground: 0.35,
  free: 0.0,
};

const W_DIST = 1.0;
const W_VIEW = 0.35;
const W_KIND = 0.6;
const W_STICKY = 0.22;

export interface SnapInput {
  /** Aim ray, already in the right space for the current camera mode. */
  ox: number; oy: number; oz: number;
  dx: number; dy: number; dz: number;
  /** The part being placed. */
  kind: PartKind;
  /** Player's manual rotation, applied on top of any inherited alignment. */
  yawSteps: number;
  pitchSteps: number;
  rollSteps: number;
  /** Hold to place freely, ignoring every snap rule. */
  freeAim: boolean;
  /** Ctrl-style fine mode: finer lattice, smaller search. */
  fine: boolean;
  /** Which of the ranked candidates the player has cycled to. */
  cycleIndex: number;
}

export interface SnapResult {
  candidate: Candidate | null;
  /** All ranked candidates, so the UI can show how many alternatives exist. */
  count: number;
  /** Where the aim ray landed, for debug rendering. */
  hitX: number; hitY: number; hitZ: number;
  hitPart: PartId;
}

/** Local axis index and sign, identifying one of a box's six faces. */
interface Face {
  axis: 0 | 1 | 2;
  sign: -1 | 1;
}

const FACES: Face[] = [
  { axis: 0, sign: 1 }, { axis: 0, sign: -1 },
  { axis: 1, sign: 1 }, { axis: 1, sign: -1 },
  { axis: 2, sign: 1 }, { axis: 2, sign: -1 },
];

export class Snapper {
  private readonly world: CollisionWorld;

  private readonly hostObb: Obb = makeObb();
  private readonly candidates: Candidate[] = [];

  /** The candidate currently shown, kept sticky between frames. */
  private incumbent: Candidate | null = null;

  private readonly tmpV = new THREE.Vector3();
  private readonly tmpV2 = new THREE.Vector3();
  private readonly tmpM = new THREE.Matrix4();
  private readonly hostBasis = new THREE.Matrix4();
  private readonly manualQ = new THREE.Quaternion();
  private readonly euler = new THREE.Euler();

  constructor(world: CollisionWorld) {
    this.world = world;
  }

  /** Drop the sticky selection, e.g. after placing or changing part type. */
  reset(): void {
    this.incumbent = null;
  }

  solve(input: SnapInput): SnapResult {
    this.candidates.length = 0;

    const hit = this.world.raycast(
      input.ox, input.oy, input.oz,
      input.dx, input.dy, input.dz,
      MAX_REACH,
    );

    // Nothing in reach: float the ghost at arm's length so there is always
    // something to look at rather than the preview vanishing.
    const reach = hit !== null ? Math.max(hit.distance, MIN_REACH) : MAX_REACH * 0.7;
    const hitX = hit !== null ? hit.x : input.ox + input.dx * reach;
    const hitY = hit !== null ? hit.y : input.oy + input.dy * reach;
    const hitZ = hit !== null ? hit.z : input.oz + input.dz * reach;

    this.manualRotation(input);

    if (input.freeAim) {
      const free = this.freeCandidate(input, hitX, hitY, hitZ);
      this.incumbent = free;
      return { candidate: free, count: 1, hitX, hitY, hitZ, hitPart: hit?.part ?? -1 };
    }

    const radius = input.fine ? SNAP_RADIUS * 0.5 : SNAP_RADIUS;
    const nearby = this.world.queryAabb({
      minX: hitX - radius, minY: hitY - radius, minZ: hitZ - radius,
      maxX: hitX + radius, maxY: hitY + radius, maxZ: hitZ + radius,
    });

    // Whatever the crosshair is directly on gets considered first and scored
    // higher — it is the part the player is actually pointing at.
    const directHit = hit !== null && !hit.isGround ? hit.part : -1;

    for (const hostId of nearby) {
      this.addHostCandidates(hostId, input, hitX, hitY, hitZ, hostId === directHit);
    }

    this.addGroundCandidate(input, hitX, hitY, hitZ);
    this.candidates.push(this.freeCandidate(input, hitX, hitY, hitZ));

    this.candidates.sort((a, b) => b.score - a.score);

    // Validate only the top few. Each check is a separating-axis test against
    // every overlapping neighbour, and a dense fort generates well over a
    // hundred candidates per frame — validating them all costs far more than
    // generating them, to decide the fate of options the player will never see.
    // Ground and free placement are always checked whatever they scored. They
    // are the fallbacks that guarantee the player can put the part *somewhere*,
    // and burying them past the window turns a workable aim into a red ghost.
    for (let i = 0; i < this.candidates.length; i++) {
      const c = this.candidates[i]!;
      if (i < MAX_VALIDATED || c.kind === 'free' || c.kind === 'ground') {
        c.valid = this.validate(c, input);
      } else {
        // Not checked; still reachable by cycling, which validates on demand.
        c.valid = false;
      }
    }

    // Valid beats high-scoring. The best-scoring placement is often one that
    // overlaps something, and showing a red ghost when a perfectly good
    // placement was available one rank down makes the game feel broken — the
    // player sees "no" without being offered the "yes" sitting right there.
    // Ties within each group keep their score order, so this only ever promotes
    // a placement that can actually be made.
    this.candidates.sort((a, b) => (a.valid === b.valid ? 0 : a.valid ? -1 : 1));

    // Cycling: the player has explicitly asked for the Nth alternative, so
    // stickiness does not apply.
    let chosen: Candidate | null;
    if (input.cycleIndex > 0 && this.candidates.length > 0) {
      chosen = this.candidates[input.cycleIndex % this.candidates.length]!;
      // Cycling can reach past the validated window, so check this one now.
      chosen.valid = this.validate(chosen, input);
      this.incumbent = chosen;
    } else {
      chosen = this.applyHysteresis();
    }

    return {
      candidate: chosen,
      count: this.candidates.length,
      hitX, hitY, hitZ,
      hitPart: hit?.part ?? -1,
    };
  }

  /**
   * Keep showing the previous choice unless a challenger is clearly better.
   *
   * Two candidates within a few percent of each other trade the lead as the
   * mouse drifts by a pixel, and the ghost strobes between them. Requiring a
   * challenger to beat the incumbent by a margin makes the preview hold still.
   */
  private applyHysteresis(): Candidate | null {
    const best = this.candidates[0] ?? null;
    if (best === null) {
      this.incumbent = null;
      return null;
    }
    if (this.incumbent === null) {
      this.incumbent = best;
      return best;
    }

    // Find the incumbent again in this frame's list, by what it was attached to
    // and where — candidate objects are rebuilt every frame.
    let survivor: Candidate | null = null;
    for (const c of this.candidates) {
      if (
        c.kind === this.incumbent.kind &&
        c.host === this.incumbent.host &&
        c.position.distanceToSquared(this.incumbent.position) < 1e-6
      ) {
        survivor = c;
        break;
      }
    }

    if (survivor !== null && survivor.score >= best.score * LATCH_MARGIN) {
      this.incumbent = survivor;
      return survivor;
    }
    this.incumbent = best;
    return best;
  }

  /** The player's manual rotation nudges, as a quaternion. */
  private manualRotation(input: SnapInput): void {
    const step = (ROT_STEP_DEG * Math.PI) / 180;
    this.euler.set(
      input.pitchSteps * step,
      input.yawSteps * step,
      input.rollSteps * step,
      'YXZ',
    );
    this.manualQ.setFromEuler(this.euler);
  }

  /**
   * Candidates generated from one nearby part.
   *
   * The new part inherits the host's orientation, which is what makes boards
   * land flush rather than merely near. On top of that the player's manual
   * rotation is applied, so "aligned but turned 90 degrees" is one keypress.
   */
  private addHostCandidates(
    hostId: PartId,
    input: SnapInput,
    hitX: number, hitY: number, hitZ: number,
    isDirectHit: boolean,
  ): void {
    if (!this.world.store.isAlive(hostId)) return;
    const host = this.world.store.readObb(hostId, this.hostObb);
    const mine = halfExtents(input.kind);

    this.hostBasis.set(
      host.ux, host.vx, host.wx, 0,
      host.uy, host.vy, host.wy, 0,
      host.uz, host.vz, host.wz, 0,
      0, 0, 0, 1,
    );
    const hostQuat = new THREE.Quaternion().setFromRotationMatrix(this.hostBasis);
    const placedQuat = hostQuat.clone().multiply(this.manualQ);

    // The placed part's half-extents along its own axes, after manual rotation,
    // expressed in the host's frame. Needed to know how far to offset so the
    // two surfaces touch exactly.
    const myExtent = this.rotatedExtent(mine, this.manualQ);

    const hostHalf = [host.hx, host.hy, host.hz];
    const axes = [
      new THREE.Vector3(host.ux, host.uy, host.uz),
      new THREE.Vector3(host.vx, host.vy, host.vz),
      new THREE.Vector3(host.wx, host.wy, host.wz),
    ];
    const center = new THREE.Vector3(host.cx, host.cy, host.cz);

    for (const face of FACES) {
      const axis = axes[face.axis]!;
      const offset = hostHalf[face.axis]! + myExtent[face.axis]!;

      // Face center pushed out by both half-extents: surfaces flush, no overlap.
      const base = center.clone().addScaledVector(axis, face.sign * offset);

      // Slide along the face so the player can lay parts side by side and end
      // to end, not just centered. Quantized to the module grid.
      const lattice = input.fine ? FINE_MODULE : MODULE;
      const tangentA = axes[(face.axis + 1) % 3]!;
      const tangentB = axes[(face.axis + 2) % 3]!;

      const toHit = this.tmpV.set(hitX, hitY, hitZ).sub(base);
      const alongA = snapTo(toHit.dot(tangentA), lattice);
      const alongB = snapTo(toHit.dot(tangentB), lattice);

      const position = base
        .clone()
        .addScaledVector(tangentA, alongA)
        .addScaledVector(tangentB, alongB);

      // Which rule this is, from which of the host's axes we pushed along.
      // The host's own long axis is 0, thickness 1, width 2.
      const kind: CandidateKind =
        face.axis === 1 ? 'stack' : face.axis === 0 ? 'butt' : 'side';

      this.candidates.push({
        kind,
        position,
        quaternion: placedQuat.clone(),
        host: hostId,
        score: this.score(kind, position, input, hitX, hitY, hitZ, isDirectHit),
        valid: true,
      });
    }
  }

  /**
   * Half-extents of the placed part along each host axis, after manual rotation.
   *
   * A part turned 90 degrees presents a different extent to the face it is
   * meeting, and using the unrotated one makes rotated parts either float off
   * the surface or sink into it.
   */
  private rotatedExtent(
    mine: { hx: number; hy: number; hz: number },
    q: THREE.Quaternion,
  ): [number, number, number] {
    this.tmpM.makeRotationFromQuaternion(q);
    const e = this.tmpM.elements;
    // Projection of the rotated box onto each axis.
    return [
      Math.abs(e[0]!) * mine.hx + Math.abs(e[4]!) * mine.hy + Math.abs(e[8]!) * mine.hz,
      Math.abs(e[1]!) * mine.hx + Math.abs(e[5]!) * mine.hy + Math.abs(e[9]!) * mine.hz,
      Math.abs(e[2]!) * mine.hx + Math.abs(e[6]!) * mine.hy + Math.abs(e[10]!) * mine.hz,
    ];
  }

  /** Snap to the module grid on the ground plane. */
  private addGroundCandidate(
    input: SnapInput,
    hitX: number, hitY: number, hitZ: number,
  ): void {
    const mine = halfExtents(input.kind);
    const extent = this.rotatedExtent(mine, this.manualQ);
    const lattice = input.fine ? FINE_MODULE : MODULE;

    const position = new THREE.Vector3(
      snapTo(hitX, lattice),
      this.world.groundY + extent[1]!,
      snapTo(hitZ, lattice),
    );

    this.candidates.push({
      kind: 'ground',
      position,
      quaternion: this.manualQ.clone(),
      host: -1,
      score: this.score('ground', position, input, hitX, hitY, hitZ, false),
      valid: true,
    });
  }

  /** Unsnapped placement exactly where the player is aiming. */
  private freeCandidate(
    input: SnapInput,
    hitX: number, hitY: number, hitZ: number,
  ): Candidate {
    const mine = halfExtents(input.kind);
    const extent = this.rotatedExtent(mine, this.manualQ);
    // Lift off the surface it landed on so the ghost is not half-buried.
    const position = new THREE.Vector3(hitX, hitY + extent[1]!, hitZ);
    const c: Candidate = {
      kind: 'free',
      position,
      quaternion: this.manualQ.clone(),
      host: -1,
      score: this.score('free', position, input, hitX, hitY, hitZ, false),
      valid: true,
    };
    c.valid = this.validate(c, input);
    return c;
  }

  /**
   * Rank a candidate.
   *
   * Distance to the aim point dominates, because the player is pointing at where
   * they want the part. View alignment breaks ties in favour of the face they
   * can actually see, and the rule bonus expresses that stacking is the common
   * case. Stickiness is added to the incumbent so the preview holds still.
   */
  private score(
    kind: CandidateKind,
    position: THREE.Vector3,
    input: SnapInput,
    hitX: number, hitY: number, hitZ: number,
    isDirectHit: boolean,
  ): number {
    const d = position.distanceTo(this.tmpV2.set(hitX, hitY, hitZ));
    // Falls off smoothly rather than cutting out, so candidates do not pop in
    // and out of contention at the search boundary.
    const distScore = 1 / (1 + d * d * 2.2);

    // Prefer placements in front of the player rather than behind the host.
    this.tmpV.copy(position).sub(this.tmpV2.set(input.ox, input.oy, input.oz)).normalize();
    const viewScore = Math.max(0, this.tmpV.dot(this.tmpV2.set(input.dx, input.dy, input.dz)));

    let s = W_DIST * distScore + W_VIEW * viewScore + W_KIND * KIND_BONUS[kind];
    if (isDirectHit) s += 0.2;

    if (
      this.incumbent !== null &&
      this.incumbent.kind === kind &&
      this.incumbent.position.distanceToSquared(position) < 1e-6
    ) {
      s += W_STICKY;
    }
    return s;
  }

  /**
   * Is this placement legal?
   *
   * Reach limits, world bounds, and overlap. The overlap tolerance is the
   * important number: flush parts touch *exactly*, so a test with no slack
   * rejects the most common legitimate placement in the game.
   */
  private validate(c: Candidate, input: SnapInput): boolean {
    const dist = Math.hypot(
      c.position.x - input.ox,
      c.position.y - input.oy,
      c.position.z - input.oz,
    );
    if (dist > MAX_REACH || dist < MIN_REACH) return false;

    const mine = halfExtents(input.kind);
    const extent = this.rotatedExtent(mine, c.quaternion);
    // Never below the ground plane.
    if (c.position.y - extent[1]! < this.world.groundY - 0.02) return false;

    // Shrink the probe so surfaces that merely touch do not read as overlapping.
    const shrink = OVERLAP_EPS;
    const overlapping = this.world.queryAabb({
      minX: c.position.x - extent[0]! + shrink,
      minY: c.position.y - extent[1]! + shrink,
      minZ: c.position.z - extent[2]! + shrink,
      maxX: c.position.x + extent[0]! - shrink,
      maxY: c.position.y + extent[1]! - shrink,
      maxZ: c.position.z + extent[2]! - shrink,
    });

    // Broadphase AABBs are conservative for rotated parts, so confirm with a
    // real box test before rejecting.
    for (const id of overlapping) {
      if (id === c.host) continue;
      if (this.obbOverlap(c, input, id, shrink)) return false;
    }
    return true;
  }

  /** Separating-axis test between the candidate and an existing part. */
  private obbOverlap(c: Candidate, input: SnapInput, otherId: PartId, shrink: number): boolean {
    const other = this.world.store.readObb(otherId, this.hostObb);
    const mine = halfExtents(input.kind);

    this.tmpM.makeRotationFromQuaternion(c.quaternion);
    const e = this.tmpM.elements;
    const aAxes: number[][] = [
      [e[0]!, e[1]!, e[2]!],
      [e[4]!, e[5]!, e[6]!],
      [e[8]!, e[9]!, e[10]!],
    ];
    const aHalf = [
      Math.max(mine.hx - shrink, 1e-4),
      Math.max(mine.hy - shrink, 1e-4),
      Math.max(mine.hz - shrink, 1e-4),
    ];
    const bAxes: number[][] = [
      [other.ux, other.uy, other.uz],
      [other.vx, other.vy, other.vz],
      [other.wx, other.wy, other.wz],
    ];
    const bHalf = [other.hx, other.hy, other.hz];

    const t = [other.cx - c.position.x, other.cy - c.position.y, other.cz - c.position.z];

    // Fifteen candidate separating axes: three per box, plus the nine cross
    // products. Finding any one that separates them proves no overlap.
    const axesToTest: number[][] = [...aAxes, ...bAxes];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const a = aAxes[i]!;
        const b = bAxes[j]!;
        const cross = [
          a[1]! * b[2]! - a[2]! * b[1]!,
          a[2]! * b[0]! - a[0]! * b[2]!,
          a[0]! * b[1]! - a[1]! * b[0]!,
        ];
        // Parallel axes give a zero cross product and no useful test.
        if (cross[0]! ** 2 + cross[1]! ** 2 + cross[2]! ** 2 > 1e-8) axesToTest.push(cross);
      }
    }

    for (const axis of axesToTest) {
      const len = Math.hypot(axis[0]!, axis[1]!, axis[2]!);
      if (len < 1e-8) continue;
      const ax = axis[0]! / len;
      const ay = axis[1]! / len;
      const az = axis[2]! / len;

      let ra = 0;
      for (let i = 0; i < 3; i++) {
        const v = aAxes[i]!;
        ra += aHalf[i]! * Math.abs(v[0]! * ax + v[1]! * ay + v[2]! * az);
      }
      let rb = 0;
      for (let i = 0; i < 3; i++) {
        const v = bAxes[i]!;
        rb += bHalf[i]! * Math.abs(v[0]! * ax + v[1]! * ay + v[2]! * az);
      }

      const separation = Math.abs(t[0]! * ax + t[1]! * ay + t[2]! * az);
      if (separation > ra + rb) return false;
    }
    return true;
  }
}
