/**
 * Draws every placed part.
 *
 * One InstancedMesh per part kind, plus one outline shell per kind that shares
 * the *same* instanceMatrix buffer object as its parent. Sharing the buffer is
 * what keeps outlines affordable: the shell costs one extra draw call per kind,
 * not per part, and never needs its own transform upload. Eight kinds means
 * roughly sixteen draw calls for an entire fort.
 *
 * Removal is O(1) via swap-with-last. Instance buffers have no holes, so
 * deleting from the middle means moving the last instance into the gap, which
 * needs a two-way map between a part's id and the instance slot holding it.
 */

import * as THREE from 'three';
import { giveInstanceColor } from './instanceColor.ts';
import { PART_KINDS, COLORWAYS, OUTLINE_COLORS, type PartKind } from '../build/partKit.ts';
import { chamferedBox, wedge } from './geometry.ts';
import { createToonMaterial, createOutlineMaterial } from './toonMaterial.ts';
import type { PartId } from '../physics/types.ts';
import { Rng } from '../core/rng.ts';

const INITIAL_CAPACITY = 256;

interface KindBucket {
  kind: PartKind;
  mesh: THREE.InstancedMesh;
  outline: THREE.InstancedMesh;
  /** Instance slot -> part id. */
  slotToPart: Int32Array;
  /** How many slots are in use. */
  used: number;
  capacity: number;
}

export class PartRenderer {
  readonly group = new THREE.Group();

  private readonly buckets: KindBucket[] = [];
  /** Part id -> which bucket and slot holds it. */
  private readonly location = new Map<PartId, { kind: number; slot: number }>();

  private readonly matrix = new THREE.Matrix4();
  private readonly quat = new THREE.Quaternion();
  private readonly pos = new THREE.Vector3();
  private readonly scale = new THREE.Vector3(1, 1, 1);
  private readonly color = new THREE.Color();

  private readonly outlineMaterials: THREE.ShaderMaterial[] = [];
  /** Per-part hue jitter, seeded so every client generates the same lumber. */
  private readonly jitterRng = new Rng('lumber-jitter');

  constructor(outlineThickness = 0.012) {
    this.group.name = 'parts';

    for (const kind of PART_KINDS) {
      const geometry = kind.isWedge
        ? wedge(kind.length, kind.thickness, kind.width)
        : chamferedBox(kind.length, kind.thickness, kind.width, kind.chamfer);

      const material = createToonMaterial({ color: 0xffffff });
      const mesh = giveInstanceColor(
        new THREE.InstancedMesh(geometry, material, INITIAL_CAPACITY),
      );
      mesh.count = 0;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // Instances are scattered across the whole yard, so the mesh's own
      // bounding sphere is meaningless; culling it as one object would pop the
      // entire fort out of view when its origin left the frustum.
      mesh.frustumCulled = false;
      mesh.name = `parts:${kind.key}`;

      const outlineMaterial = createOutlineMaterial(OUTLINE_COLORS[kind.material], outlineThickness);
      this.outlineMaterials.push(outlineMaterial);

      const outline = new THREE.InstancedMesh(geometry, outlineMaterial, INITIAL_CAPACITY);
      outline.count = 0;
      outline.frustumCulled = false;
      outline.castShadow = false;
      outline.receiveShadow = false;
      outline.name = `outline:${kind.key}`;
      // The shell reads the parent's transforms directly — one upload, two draws.
      outline.instanceMatrix = mesh.instanceMatrix;

      this.group.add(mesh, outline);

      this.buckets.push({
        kind,
        mesh,
        outline,
        slotToPart: new Int32Array(INITIAL_CAPACITY).fill(-1),
        used: 0,
        capacity: INITIAL_CAPACITY,
      });
    }
  }

  /** Grow a bucket's instance buffers, preserving what is already in them. */
  private grow(bucket: KindBucket): void {
    const next = bucket.capacity * 2;
    const oldMesh = bucket.mesh;
    const oldOutline = bucket.outline;

    const mesh = giveInstanceColor(
      new THREE.InstancedMesh(oldMesh.geometry, oldMesh.material, next),
    );
    mesh.instanceMatrix.array.set(oldMesh.instanceMatrix.array);
    mesh.count = oldMesh.count;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.name = oldMesh.name;

    // Both buffers exist by construction now, so this is a copy rather than a
    // conditional creation — and the new one is already the right length.
    if (oldMesh.instanceColor !== null && mesh.instanceColor !== null) {
      mesh.instanceColor.array.set(oldMesh.instanceColor.array);
      mesh.instanceColor.needsUpdate = true;
    }

    const outline = new THREE.InstancedMesh(oldMesh.geometry, oldOutline.material, next);
    outline.count = oldOutline.count;
    outline.frustumCulled = false;
    outline.name = oldOutline.name;
    outline.instanceMatrix = mesh.instanceMatrix;

    this.group.remove(oldMesh, oldOutline);
    oldMesh.dispose();
    oldOutline.dispose();
    this.group.add(mesh, outline);

    const slotToPart = new Int32Array(next).fill(-1);
    slotToPart.set(bucket.slotToPart);

    bucket.mesh = mesh;
    bucket.outline = outline;
    bucket.slotToPart = slotToPart;
    bucket.capacity = next;
  }

  /**
   * Add a part's visual instance.
   *
   * Position and rotation come from the simulation; this is the only place they
   * are turned into a matrix.
   */
  add(
    id: PartId,
    kindId: number,
    colorway: number,
    cx: number, cy: number, cz: number,
    qx: number, qy: number, qz: number, qw: number,
  ): void {
    const bucket = this.buckets[kindId];
    if (bucket === undefined) return;
    if (bucket.used >= bucket.capacity) this.grow(bucket);

    const slot = bucket.used++;
    this.pos.set(cx, cy, cz);
    this.quat.set(qx, qy, qz, qw);
    this.matrix.compose(this.pos, this.quat, this.scale);
    bucket.mesh.setMatrixAt(slot, this.matrix);

    // Per-instance hue jitter, so a wall of identical planks does not read as a
    // tiled texture. Kept narrow enough that it still looks like one material.
    const base = COLORWAYS[colorway % COLORWAYS.length]!;
    this.color.setHex(base, THREE.SRGBColorSpace);
    const hsl = { h: 0, s: 0, l: 0 };
    this.color.getHSL(hsl);
    this.color.setHSL(
      hsl.h + this.jitterRng.signed(0.012),
      Math.max(0, Math.min(1, hsl.s + this.jitterRng.signed(0.05))),
      Math.max(0, Math.min(1, hsl.l + this.jitterRng.signed(0.065))),
    );
    bucket.mesh.setColorAt(slot, this.color);

    bucket.slotToPart[slot] = id;
    bucket.mesh.count = bucket.used;
    bucket.outline.count = bucket.used;
    bucket.mesh.instanceMatrix.needsUpdate = true;
    if (bucket.mesh.instanceColor !== null) bucket.mesh.instanceColor.needsUpdate = true;

    this.location.set(id, { kind: kindId, slot });
  }

  /** Remove a part's instance by moving the last one into its slot. */
  remove(id: PartId): boolean {
    const loc = this.location.get(id);
    if (loc === undefined) return false;
    const bucket = this.buckets[loc.kind]!;
    const last = bucket.used - 1;

    if (loc.slot !== last) {
      bucket.mesh.getMatrixAt(last, this.matrix);
      bucket.mesh.setMatrixAt(loc.slot, this.matrix);
      if (bucket.mesh.instanceColor !== null) {
        bucket.mesh.getColorAt(last, this.color);
        bucket.mesh.setColorAt(loc.slot, this.color);
      }
      // The part that was at the end now lives here.
      const movedId = bucket.slotToPart[last]!;
      bucket.slotToPart[loc.slot] = movedId;
      const movedLoc = this.location.get(movedId);
      if (movedLoc !== undefined) movedLoc.slot = loc.slot;
    }

    bucket.slotToPart[last] = -1;
    bucket.used = last;
    bucket.mesh.count = last;
    bucket.outline.count = last;
    bucket.mesh.instanceMatrix.needsUpdate = true;
    if (bucket.mesh.instanceColor !== null) bucket.mesh.instanceColor.needsUpdate = true;

    this.location.delete(id);
    return true;
  }

  clear(): void {
    for (const bucket of this.buckets) {
      bucket.used = 0;
      bucket.mesh.count = 0;
      bucket.outline.count = 0;
      bucket.slotToPart.fill(-1);
    }
    this.location.clear();
  }

  /** Outline width is measured in pixels, so it depends on the viewport. */
  setViewportHeight(height: number): void {
    for (const material of this.outlineMaterials) {
      material.uniforms.viewportHeight!.value = height;
    }
  }

  setOutlinesVisible(visible: boolean): void {
    for (const bucket of this.buckets) bucket.outline.visible = visible;
  }

  get drawCalls(): number {
    let n = 0;
    for (const bucket of this.buckets) {
      if (bucket.used > 0) n += bucket.outline.visible ? 2 : 1;
    }
    return n;
  }

  get instanceCount(): number {
    let n = 0;
    for (const bucket of this.buckets) n += bucket.used;
    return n;
  }

  dispose(): void {
    for (const bucket of this.buckets) {
      bucket.mesh.dispose();
      bucket.outline.dispose();
      bucket.mesh.geometry.dispose();
      (bucket.mesh.material as THREE.Material).dispose();
      (bucket.outline.material as THREE.Material).dispose();
    }
  }
}
