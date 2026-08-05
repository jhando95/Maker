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
import { PART_KINDS, COLORWAYS, getPartKind, halfExtents } from './partKit.ts';
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

  private lastResult: SnapResult | null = null;
  /** Damped ghost transform, so the preview glides rather than snapping. */
  private readonly ghostPos = new THREE.Vector3();
  private readonly ghostQuat = new THREE.Quaternion();
  private ghostInitialized = false;

  /** Undo stack of part ids, most recent last. */
  private readonly history: PartId[] = [];

  /** Placements this session, for the HUD. */
  placedCount = 0;

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
  }

  selectKind(index: number): void {
    if (index < 0 || index >= PART_KINDS.length) return;
    if (index === this.selectedKind) return;
    this.selectedKind = index;
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
    return result;
  }

  private updateGhost(dt: number, candidate: Candidate | null): void {
    if (candidate === null) {
      this.ghostGroup.visible = false;
      return;
    }
    this.ghostGroup.visible = true;

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
    this.ghostMaterial.color.setHex(candidate.valid ? GHOST_VALID : GHOST_INVALID);
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

  /** Serialize every placed part. Same shape the network would carry. */
  serialize(): PlacementRecord[] {
    const out: PlacementRecord[] = [];
    const store = this.world.store;
    for (const id of store.live()) {
      const c = id * 3;
      const o = id * 9;
      // Rebuild a quaternion from the stored basis.
      const m = new THREE.Matrix4().set(
        store.axes[o]!, store.axes[o + 3]!, store.axes[o + 6]!, 0,
        store.axes[o + 1]!, store.axes[o + 4]!, store.axes[o + 7]!, 0,
        store.axes[o + 2]!, store.axes[o + 5]!, store.axes[o + 8]!, 0,
        0, 0, 0, 1,
      );
      const q = new THREE.Quaternion().setFromRotationMatrix(m);
      out.push({
        kind: store.kind[id]!,
        colorway: store.colorway[id]!,
        x: quantize(store.center[c]!),
        y: quantize(store.center[c + 1]!),
        z: quantize(store.center[c + 2]!),
        qx: quantize(q.x, 1e-4), qy: quantize(q.y, 1e-4),
        qz: quantize(q.z, 1e-4), qw: quantize(q.w, 1e-4),
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
