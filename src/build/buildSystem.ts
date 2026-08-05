/**
 * The build loop: what the player is holding, where it would go, and committing
 * it to the world.
 *
 * Placement is deliberately split into intent and application. `place()` decides
 * *what* should happen and hands a plain serializable record to `applyPlace()`,
 * which is the only thing that touches world state. Today both run on the same
 * machine; when there is a server, the intent is what gets sent and the
 * application is what the server authorises. Keeping the seam here now is the
 * difference between adding multiplayer and rewriting for it.
 */

import * as THREE from 'three';
import { CollisionWorld } from '../physics/collisionWorld.ts';
import { PART_KINDS, COLORWAYS, getPartKind, halfExtents, collisionProxy } from './partKit.ts';
import { Snapper, type Candidate, type SnapResult, ROT_STEP_DEG } from './snapping.ts';
import { PartRenderer } from '../render/partRenderer.ts';
import { chamferedBox, wedge } from '../render/geometry.ts';
import { damp } from '../core/mathUtils.ts';
import type { PartId } from '../physics/types.ts';

/** A committed placement. This is the wire format and the save format. */
export interface PlacementRecord {
  kind: number;
  colorway: number;
  x: number; y: number; z: number;
  qx: number; qy: number; qz: number; qw: number;
}

/** Positions quantized to 1mm and rotations to 1e-4 keeps saves compact and
 *  makes two clients agree exactly on what was placed. */
function quantize(v: number, step = 0.001): number {
  return Math.round(v / step) * step;
}

export const GHOST_VALID = 0x8fe3a0;
export const GHOST_INVALID = 0xff6b6b;

/** Beyond this the ghost teleports instead of easing — damping reads as lag. */
const GHOST_TELEPORT_DISTANCE = 0.6;

/**
 * Caps on one repeat chain.
 *
 * Without them, holding the repeat key with a two-metre delta on open lawn lays
 * parts at seven a second until the world is full — nothing stops it, because
 * open ground never fails validation.
 */
export const REPEAT_MAX_CHAIN = 64;
export const REPEAT_MAX_SPAN = 24;

/**
 * How many links of the chain to draw ahead.
 *
 * Not the same as REPEAT_MAX_CHAIN, and deliberately much smaller. Sixty-four
 * translucent boards is a wall you cannot see the world through, and the useful
 * information — which way this is going and where it stops — is all in the
 * first few. They fade along the run so a chain that continues past the preview
 * reads as continuing rather than as ending there.
 */
export const REPEAT_PREVIEW_LINKS = 10;

export class BuildSystem {
  private readonly world: CollisionWorld;
  private readonly renderer: PartRenderer;
  private readonly snapper: Snapper;

  /** Which hotbar slot is selected. */
  selectedKind = 0;
  selectedColorway = 0;

  yawSteps = 0;
  pitchSteps = 0;
  rollSteps = 0;
  cycleIndex = 0;

  readonly ghostGroup = new THREE.Group();
  private ghostMesh: THREE.Mesh;
  private readonly ghostMaterial: THREE.MeshBasicMaterial;
  private readonly ghostGeometries: THREE.BufferGeometry[] = [];

  /** Preview of where holding repeat would lay the next few parts. */
  private readonly chainMeshes: THREE.Mesh[] = [];
  private readonly chainMaterials: THREE.MeshBasicMaterial[] = [];
  /**
   * What the visible chain was computed from.
   *
   * The projection walks the chain running a real overlap test per link, which
   * is cheap but pointless to redo sixty times a second for a chain that cannot
   * have changed. It can only change when the world does or when the chain head
   * moves, and both of those are countable.
   */
  private chainKey = '';

  private lastResult: SnapResult | null = null;
  /** Damped ghost transform, so the preview glides rather than snapping. */
  private readonly ghostPos = new THREE.Vector3();
  private readonly ghostQuat = new THREE.Quaternion();
  private ghostInitialized = false;

  /** Undo stack of part ids, most recent last. */
  private readonly history: PartId[] = [];

  /** Placements this session, for the HUD. */
  placedCount = 0;

  private ghostValidColor = GHOST_VALID;
  private ghostInvalidColor = GHOST_INVALID;

  /**
   * The last two placements, which together define a repeatable step.
   *
   * Placing parts one at a time is fine for a sandbox and miserable under a
   * build timer. Once two parts exist, the offset between them is almost always
   * the thing the player wants again: two rungs describe a ladder, two treads
   * describe a staircase, two planks describe a wall.
   */
  private lastPlacement: PlacementRecord | null = null;
  private previousPlacement: PlacementRecord | null = null;
  /** Parts laid by the current chain, and where it started. */
  private repeatCount = 0;
  private repeatOrigin: { x: number; y: number; z: number } | null = null;

  constructor(world: CollisionWorld, renderer: PartRenderer) {
    this.world = world;
    this.renderer = renderer;
    this.snapper = new Snapper(world);

    for (const kind of PART_KINDS) {
      this.ghostGeometries.push(
        kind.isWedge
          ? wedge(kind.length, kind.thickness, kind.width)
          : chamferedBox(kind.length, kind.thickness, kind.width, kind.chamfer),
      );
    }

    // Unlit and translucent: the ghost must read as a proposal, not as a part
    // that is already there. depthWrite off so it never occludes real geometry.
    this.ghostMaterial = new THREE.MeshBasicMaterial({
      color: GHOST_VALID,
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
    });

    this.ghostMesh = new THREE.Mesh(this.ghostGeometries[0], this.ghostMaterial);
    this.ghostMesh.frustumCulled = false;
    this.ghostGroup.add(this.ghostMesh);
    this.ghostGroup.name = 'ghost';

    // One material per link, because each carries its own opacity — the fade
    // along the chain is what tells you it keeps going.
    for (let i = 0; i < REPEAT_PREVIEW_LINKS; i++) {
      const material = new THREE.MeshBasicMaterial({
        color: GHOST_VALID,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(this.ghostGeometries[0], material);
      mesh.frustumCulled = false;
      mesh.visible = false;
      this.chainMaterials.push(material);
      this.chainMeshes.push(mesh);
      this.ghostGroup.add(mesh);
    }
  }

  selectKind(index: number): void {
    if (index < 0 || index >= PART_KINDS.length) return;
    if (index === this.selectedKind) return;
    this.selectedKind = index;
    this.clearRepeat();
    this.ghostMesh.geometry = this.ghostGeometries[index]!;
    // A different part has different snap frames, so the sticky choice from the
    // old one is meaningless.
    this.snapper.reset();
    this.cycleIndex = 0;
  }

  cycleKind(delta: number): void {
    const next = (this.selectedKind + delta + PART_KINDS.length) % PART_KINDS.length;
    this.selectKind(next);
  }

  cycleColorway(delta: number): void {
    this.selectedColorway =
      (this.selectedColorway + delta + COLORWAYS.length) % COLORWAYS.length;
  }

  rotateYaw(steps: number): void {
    this.yawSteps += steps;
  }

  rotatePitch(steps: number): void {
    this.pitchSteps += steps;
  }

  rotateRoll(steps: number): void {
    this.rollSteps += steps;
  }

  resetRotation(): void {
    this.yawSteps = 0;
    this.pitchSteps = 0;
    this.rollSteps = 0;
  }

  cycleSnapCandidate(): void {
    this.cycleIndex++;
  }

  /** Ghost tint, so settings can offer a colourblind-safe pair. */
  setGhostColors(valid: number, invalid: number): void {
    this.ghostValidColor = valid;
    this.ghostInvalidColor = invalid;
  }

  /**
   * Recompute the preview. Runs every frame; nothing here mutates world state.
   */
  update(
    dt: number,
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    freeAim: boolean,
    fine: boolean,
  ): SnapResult {
    const result = this.snapper.solve({
      ox, oy, oz, dx, dy, dz,
      kind: getPartKind(this.selectedKind),
      yawSteps: this.yawSteps,
      pitchSteps: this.pitchSteps,
      rollSteps: this.rollSteps,
      freeAim,
      fine,
      cycleIndex: this.cycleIndex,
    });

    this.lastResult = result;
    this.updateGhost(dt, result.candidate);
    this.updateChainPreview();
    return result;
  }

  /**
   * Where the repeat chain would go, drawn ahead of running it.
   *
   * Holding the repeat key can lay sixty-four parts past where you could aim,
   * which is the feature — and until you can see where they land, using it is a
   * guess you find out about afterwards. The projection runs the same rules
   * repeatPlace does, including the overlap test, so the preview stops exactly
   * where the chain would: a run of stair treads visibly ends at the wall it
   * would hit rather than implying it continues through.
   */
  /**
   * The records holding the repeat key would actually lay, up to `limit`.
   *
   * Runs the same rules repeatPlace does — the span cap and the overlap test —
   * against a world it pretends already contains the earlier links. Anything
   * less would preview a chain that does not happen: without treating each
   * projected part as solid, a chain stepping half a part's length would show
   * ten links where only the first is real.
   */
  projectRepeatChain(limit = REPEAT_PREVIEW_LINKS): PlacementRecord[] {
    const head = this.lastPlacement;
    const delta = this.repeatDelta;
    if (head === null || delta === null) return [];

    const out: PlacementRecord[] = [];
    let record = head;

    for (let i = 0; i < limit && i < REPEAT_MAX_CHAIN; i++) {
      const next: PlacementRecord = {
        ...record,
        x: quantize(record.x + delta.dx),
        y: quantize(record.y + delta.dy),
        z: quantize(record.z + delta.dz),
      };
      const span = Math.hypot(next.x - head.x, next.y - head.y, next.z - head.z);
      if (span > REPEAT_MAX_SPAN) break;
      if (!this.canPlaceAt(next, out)) break;

      out.push(next);
      record = next;
    }
    return out;
  }

  private updateChainPreview(): void {
    const head = this.lastPlacement;
    const delta = this.repeatDelta;
    if (head === null || delta === null) {
      if (this.chainKey !== '') this.hideChainPreview();
      return;
    }

    const key = `${this.world.version}|${head.x},${head.y},${head.z},${head.kind},${head.qx},${head.qy},${head.qz},${head.qw}|${delta.dx},${delta.dy},${delta.dz}`;
    if (key === this.chainKey) return;
    this.chainKey = key;

    const chain = this.projectRepeatChain();
    const geometry = this.ghostGeometries[head.kind] ?? this.ghostGeometries[0]!;

    for (let i = 0; i < this.chainMeshes.length; i++) {
      const mesh = this.chainMeshes[i]!;
      const next = chain[i];
      if (next === undefined) {
        mesh.visible = false;
        continue;
      }
      mesh.geometry = geometry;
      mesh.position.set(next.x, next.y, next.z);
      mesh.quaternion.set(next.qx, next.qy, next.qz, next.qw);
      mesh.visible = true;
      // Fainter with distance, and never as solid as the ghost being aimed —
      // this is what *would* happen, not what is about to. The floor matters:
      // a pale green ghost over a green lawn at very low opacity is invisible,
      // and an invisible preview is worse than none because the hint says it
      // is there.
      this.chainMaterials[i]!.color.setHex(this.ghostValidColor);
      this.chainMaterials[i]!.opacity = 0.38 - 0.026 * i;
    }
  }

  private hideChainPreview(): void {
    for (const mesh of this.chainMeshes) mesh.visible = false;
    this.chainKey = '';
  }

  /** How many links the preview is currently drawing. */
  get chainPreviewLength(): number {
    let n = 0;
    for (const mesh of this.chainMeshes) if (mesh.visible) n++;
    return n;
  }

  private updateGhost(dt: number, candidate: Candidate | null): void {
    // Only the aimed ghost is hidden, not the whole group. The chain preview
    // describes the last part placed, not where the player is currently
    // pointing, and aiming at the sky is no reason for it to disappear.
    if (candidate === null) {
      this.ghostMesh.visible = false;
      return;
    }
    this.ghostMesh.visible = true;

    if (!this.ghostInitialized) {
      this.ghostPos.copy(candidate.position);
      this.ghostQuat.copy(candidate.quaternion);
      this.ghostInitialized = true;
    } else if (this.ghostPos.distanceTo(candidate.position) > GHOST_TELEPORT_DISTANCE) {
      // A large jump means the player switched to a different surface entirely.
      // Easing across that gap looks like the preview lagging behind the mouse.
      this.ghostPos.copy(candidate.position);
      this.ghostQuat.copy(candidate.quaternion);
    } else {
      this.ghostPos.set(
        damp(this.ghostPos.x, candidate.position.x, 0.03, dt),
        damp(this.ghostPos.y, candidate.position.y, 0.03, dt),
        damp(this.ghostPos.z, candidate.position.z, 0.03, dt),
      );
      this.ghostQuat.slerp(candidate.quaternion, Math.min(1, dt * 25));
    }

    this.ghostMesh.position.copy(this.ghostPos);
    this.ghostMesh.quaternion.copy(this.ghostQuat);
    this.ghostMaterial.color.setHex(candidate.valid ? this.ghostValidColor : this.ghostInvalidColor);
    this.ghostMaterial.opacity = candidate.valid ? 0.45 : 0.3;
  }

  /**
   * Turn the current preview into a placement intent.
   *
   * Returns null when the placement is illegal. The record is plain data — no
   * object references, no Three.js types — because it is what a server would
   * receive and what a save file stores.
   */
  place(): PlacementRecord | null {
    const candidate = this.lastResult?.candidate;
    if (candidate === undefined || candidate === null || !candidate.valid) return null;

    return {
      kind: this.selectedKind,
      colorway: this.selectedColorway,
      x: quantize(candidate.position.x),
      y: quantize(candidate.position.y),
      z: quantize(candidate.position.z),
      qx: quantize(candidate.quaternion.x, 1e-4),
      qy: quantize(candidate.quaternion.y, 1e-4),
      qz: quantize(candidate.quaternion.z, 1e-4),
      qw: quantize(candidate.quaternion.w, 1e-4),
    };
  }

  /**
   * Commit a placement. The only path that adds a part to the world, so a
   * server-authoritative build applies exactly the same function.
   */
  applyPlace(record: PlacementRecord): PartId {
    const kind = getPartKind(record.kind);
    const h = halfExtents(kind);

    // Re-normalize: quantizing the quaternion pushes it slightly off unit
    // length, and the collision math assumes an orthonormal basis.
    const q = new THREE.Quaternion(record.qx, record.qy, record.qz, record.qw).normalize();

    const handle = this.world.addPart(
      record.kind, record.colorway,
      record.x, record.y, record.z,
      q.x, q.y, q.z, q.w,
      h.hx, h.hy, h.hz,
      // A wedge collides as a slab along its slope, not as its bounding box.
      collisionProxy(kind),
    );
    this.renderer.add(
      handle.id, record.kind, record.colorway,
      record.x, record.y, record.z,
      q.x, q.y, q.z, q.w,
    );

    this.history.push(handle.id);
    this.placedCount++;
    this.snapper.reset();
    this.cycleIndex = 0;

    // A repeat is only meaningful between two parts of the same kind; a step
    // from a post to a plank describes nothing the player meant.
    this.previousPlacement =
      this.lastPlacement !== null && this.lastPlacement.kind === record.kind
        ? this.lastPlacement
        : null;
    this.lastPlacement = record;
    // A manual placement begins a new chain; repeatPlace restores its own
    // counters immediately afterwards.
    this.repeatOrigin = null;
    this.repeatCount = 0;

    return handle.id;
  }

  /** Place what the preview currently shows, if it is legal. */
  tryPlace(): boolean {
    const record = this.place();
    if (record === null) return false;
    this.applyPlace(record);
    return true;
  }

  /** Remove whatever the aim ray is pointing at. */
  removeAimed(): boolean {
    const part = this.lastResult?.hitPart;
    if (part === undefined || part < 0) return false;
    return this.applyRemove(part);
  }

  applyRemove(id: PartId): boolean {
    if (!this.world.removePart(id)) return false;
    this.renderer.remove(id);
    const i = this.history.lastIndexOf(id);
    if (i !== -1) this.history.splice(i, 1);
    this.snapper.reset();
    return true;
  }

  /** Undo the most recent placement still standing. */
  undo(): boolean {
    while (this.history.length > 0) {
      const id = this.history.pop()!;
      if (this.world.store.isAlive(id)) {
        this.world.removePart(id);
        this.renderer.remove(id);
        this.snapper.reset();
        return true;
      }
    }
    return false;
  }

  /**
   * Is there a step to repeat, and what is it?
   *
   * The delta is taken in world space rather than in the part's local frame.
   * Local-frame stepping compounds rotation, so a chain of parts placed with any
   * turn between them spirals; world-space stepping repeats exactly the
   * displacement the player just made, which is what they watched happen.
   */
  get repeatDelta(): { dx: number; dy: number; dz: number } | null {
    if (this.lastPlacement === null || this.previousPlacement === null) return null;
    const dx = this.lastPlacement.x - this.previousPlacement.x;
    const dy = this.lastPlacement.y - this.previousPlacement.y;
    const dz = this.lastPlacement.z - this.previousPlacement.z;
    // Two parts in the same place describe no step.
    if (Math.hypot(dx, dy, dz) < 1e-4) return null;
    return { dx, dy, dz };
  }

  /** The transform the next repeat would produce, or null if there is none. */
  nextRepeat(): PlacementRecord | null {
    const delta = this.repeatDelta;
    const last = this.lastPlacement;
    if (delta === null || last === null) return null;
    return {
      ...last,
      x: quantize(last.x + delta.dx),
      y: quantize(last.y + delta.dy),
      z: quantize(last.z + delta.dz),
    };
  }

  /**
   * Place the next part in the repeat chain.
   *
   * Validated the same way any placement is: overlapping something, or leaving
   * the world, ends the chain rather than stacking parts inside each other.
   * Reach is deliberately *not* checked — the whole point is to run a ladder up
   * past where the player could aim.
   */
  repeatPlace(): PlacementRecord | null {
    const next = this.nextRepeat();
    if (next === null) return null;

    if (this.repeatOrigin === null) {
      this.repeatOrigin = {
        x: this.lastPlacement!.x, y: this.lastPlacement!.y, z: this.lastPlacement!.z,
      };
      this.repeatCount = 0;
    }

    const span = Math.hypot(
      next.x - this.repeatOrigin.x,
      next.y - this.repeatOrigin.y,
      next.z - this.repeatOrigin.z,
    );
    if (this.repeatCount >= REPEAT_MAX_CHAIN || span > REPEAT_MAX_SPAN) {
      this.clearRepeat();
      return null;
    }

    if (!this.canPlaceAt(next)) {
      // Break the chain so a blocked repeat does not retry forever.
      this.clearRepeat();
      return null;
    }

    // applyPlace advances the chain head, so the counters are restored after.
    const origin = this.repeatOrigin;
    const count = this.repeatCount;
    this.applyPlace(next);
    this.repeatOrigin = origin;
    this.repeatCount = count + 1;
    return next;
  }

  /**
   * Would this record be a legal placement? Overlap and bounds only.
   *
   * `pending` is for projecting a chain that has not been placed yet: each link
   * has to see the ones before it as solid, or a chain stepping less than a
   * part's length would preview ten links where only the first can exist.
   */
  private canPlaceAt(record: PlacementRecord, pending: readonly PlacementRecord[] = []): boolean {
    const box = worldAabb(record);
    if (box.minY < this.world.groundY - 0.02) return false;

    // Shrunk, because parts placed flush touch exactly and must not read as
    // overlapping — the most common legitimate placement in the game.
    const shrink = 0.006;
    const probe = {
      minX: box.minX + shrink, minY: box.minY + shrink, minZ: box.minZ + shrink,
      maxX: box.maxX - shrink, maxY: box.maxY - shrink, maxZ: box.maxZ - shrink,
    };

    // queryAabb is a BROADPHASE: it returns everything sharing a hash cell, not
    // everything actually overlapping. Treating a non-empty result as a
    // collision rejects every placement within a metre of anything.
    for (const id of this.world.queryAabb(probe)) {
      const other = this.world.store.readAabb(id);
      if (
        probe.minX < other.maxX && probe.maxX > other.minX &&
        probe.minY < other.maxY && probe.maxY > other.minY &&
        probe.minZ < other.maxZ && probe.maxZ > other.minZ
      ) {
        return false;
      }
    }

    for (const other of pending) {
      const b = worldAabb(other);
      if (
        probe.minX < b.maxX && probe.maxX > b.minX &&
        probe.minY < b.maxY && probe.maxY > b.minY &&
        probe.minZ < b.maxZ && probe.maxZ > b.minZ
      ) {
        return false;
      }
    }
    return true;
  }

  /** Drop the repeat chain, e.g. when the player changes what they are doing. */
  clearRepeat(): void {
    this.previousPlacement = null;
    this.repeatOrigin = null;
    this.repeatCount = 0;
    this.hideChainPreview();
  }

  /** Serialize every placed part. Same shape the network would carry. */
  serialize(): PlacementRecord[] {
    const out: PlacementRecord[] = [];
    const store = this.world.store;
    for (const id of store.live()) {
      const v = id * 4;
      // The part's own orientation, not the collision basis — for a wedge those
      // differ, and saving the collision basis would reload the ramp rotated
      // onto its own slope.
      const qx = store.visualQuat[v]!;
      const qy = store.visualQuat[v + 1]!;
      const qz = store.visualQuat[v + 2]!;
      const qw = store.visualQuat[v + 3]!;

      // Likewise the centre: a proxy is offset from the part's own centre, so
      // undo that offset to recover where the part was actually placed.
      const kind = getPartKind(store.kind[id]!);
      const proxy = collisionProxy(kind);
      const c = id * 3;
      let x = store.center[c]!;
      let y = store.center[c + 1]!;
      let z = store.center[c + 2]!;
      if (proxy !== null) {
        const off = new THREE.Vector3(proxy.ox, proxy.oy, proxy.oz)
          .applyQuaternion(new THREE.Quaternion(qx, qy, qz, qw));
        x -= off.x;
        y -= off.y;
        z -= off.z;
      }

      out.push({
        kind: store.kind[id]!,
        colorway: store.colorway[id]!,
        x: quantize(x), y: quantize(y), z: quantize(z),
        qx: quantize(qx, 1e-4), qy: quantize(qy, 1e-4),
        qz: quantize(qz, 1e-4), qw: quantize(qw, 1e-4),
      });
    }
    return out;
  }

  /** Replace the world with a saved set of parts. */
  deserialize(records: PlacementRecord[]): void {
    this.world.clear();
    this.renderer.clear();
    this.history.length = 0;
    this.placedCount = 0;
    for (const r of records) this.applyPlace(r);
    // Loaded parts are not a step the player just made.
    this.lastPlacement = null;
    this.previousPlacement = null;
  }

  get rotationDegrees(): { yaw: number; pitch: number; roll: number } {
    return {
      yaw: (this.yawSteps * ROT_STEP_DEG) % 360,
      pitch: (this.pitchSteps * ROT_STEP_DEG) % 360,
      roll: (this.rollSteps * ROT_STEP_DEG) % 360,
    };
  }

  get lastSnap(): SnapResult | null {
    return this.lastResult;
  }
}

/**
 * World-axis bounding box of a part at a given placement.
 *
 * A rotated box's world extent is the rotation matrix's absolute values applied
 * to its half-extents — the same arithmetic the collision world does when a part
 * is added, done here for parts that do not exist yet.
 */
function worldAabb(record: PlacementRecord): {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
} {
  const h = halfExtents(getPartKind(record.kind));
  const q = new THREE.Quaternion(record.qx, record.qy, record.qz, record.qw).normalize();
  const e = new THREE.Matrix4().makeRotationFromQuaternion(q).elements;

  const ex = Math.abs(e[0]!) * h.hx + Math.abs(e[4]!) * h.hy + Math.abs(e[8]!) * h.hz;
  const ey = Math.abs(e[1]!) * h.hx + Math.abs(e[5]!) * h.hy + Math.abs(e[9]!) * h.hz;
  const ez = Math.abs(e[2]!) * h.hx + Math.abs(e[6]!) * h.hy + Math.abs(e[10]!) * h.hz;

  return {
    minX: record.x - ex, minY: record.y - ey, minZ: record.z - ez,
    maxX: record.x + ex, maxY: record.y + ey, maxZ: record.z + ez,
  };
}
