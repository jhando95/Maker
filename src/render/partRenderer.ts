/**
 * Draws every placed part, in chunks the camera can skip.
 *
 * One InstancedMesh per part kind **per 12-metre chunk of the yard**, plus one
 * outline shell per mesh that shares the *same* instanceMatrix buffer object as
 * its parent. Sharing the buffer is what keeps outlines affordable: the shell
 * costs one extra draw call, not one per part, and never needs its own
 * transform upload.
 *
 * ## Why chunks, measured
 *
 * The first version of this file was one mesh per kind with `frustumCulled`
 * switched off, and the comment explaining why was correct: an InstancedMesh's
 * bounding sphere sits at its origin, and with instances scattered across the
 * whole yard three.js would pop an entire fort out of view the moment that
 * origin left the frustum. The *consequence* was that every plank anybody had
 * ever placed was submitted every frame, twice — the one cost in this game a
 * player can grow without limit. Measured before the change: turning away from
 * a 129-plank structure saved 172 draw calls and 55,000 triangles, and none of
 * that saving was the structure.
 *
 * Chunking is the standard fix and the cheap one. A mesh whose instances all
 * sit inside one 12-metre cell has a bounding sphere that means something, so
 * culling can be switched back on and three.js does the rest. The cost is more
 * draw calls when many chunks are in view — bounded by how much of the yard is
 * actually built on — and the alternative, repacking one buffer to the visible
 * set each frame, trades a rasterisation cost for uploading the whole buffer
 * sixty times a second.
 *
 * ## The rules that keep the soak flat
 *
 * Chunk buckets are created lazily and **never destroyed** — a bucket whose
 * last part is removed goes invisible and waits, because the soak's second
 * twelve rounds must allocate nothing, and rounds build in the same places.
 * Geometry and materials are made once per *kind* and shared by every chunk,
 * so a new bucket compiles no program and uploads no geometry: the seed bucket
 * each kind starts with is what the boot-time warm-up compiles, and every
 * later bucket looks identical to the compiler.
 *
 * Removal is O(1) via swap-with-last, which keeps three buffers aligned:
 * matrices, live colours, and the unshaded base colours the enclosure shading
 * multiplies from.
 */

import * as THREE from 'three';
import { giveInstanceColor } from './instanceColor.ts';
import { PART_KINDS, COLORWAYS, OUTLINE_COLORS, type PartKind } from '../build/partKit.ts';
import { chamferedBox, wedge } from './geometry.ts';
import { createToonMaterial, createOutlineMaterial } from './toonMaterial.ts';
import type { PartId } from '../physics/types.ts';
import { Rng } from '../core/rng.ts';

/**
 * Metres per chunk.
 *
 * Sized against the fights this game has: a fort fits in one or two, so a
 * built-up corner of the yard is a handful of draw calls, while the far half of
 * a 116-metre world drops out of the frustum entirely. Smaller chunks cull
 * tighter and cost more draws; this is a knob to measure, not a constant to
 * defend.
 */
export const CHUNK = 12;

/**
 * Slots a fresh bucket starts with.
 *
 * Small, because there is a bucket per kind per chunk now and most hold a
 * handful of parts; growth doubles, so a dense chunk pays a few copies on the
 * way up and nothing after.
 */
const INITIAL_CAPACITY = 32;

interface ChunkBucket {
  kindId: number;
  mesh: THREE.InstancedMesh;
  outline: THREE.InstancedMesh;
  /** Instance slot -> part id. */
  slotToPart: Int32Array;
  /**
   * Each slot's colour before any shading, three floats per slot.
   *
   * Kept apart from `instanceColor` so a shade is always `base * factor` from
   * the original: multiplying the live buffer in place would compound — two
   * re-shades at 0.9 make 0.81 — and the error would ratchet darker with every
   * pass over the world.
   */
  baseColor: Float32Array;
  /** How many slots are in use. */
  used: number;
  capacity: number;
}

/** The resources every chunk of one kind shares. */
interface KindResources {
  kind: PartKind;
  geometry: THREE.BufferGeometry;
  material: THREE.MeshToonMaterial;
  outlineMaterial: THREE.ShaderMaterial;
}

export class PartRenderer {
  readonly group = new THREE.Group();

  private readonly kinds: KindResources[] = [];
  /** `${kindId}:${cx},${cz}` -> the bucket drawing that cell. */
  private readonly buckets = new Map<string, ChunkBucket>();
  /** Part id -> the bucket and slot holding it. */
  private readonly location = new Map<PartId, { bucket: ChunkBucket; slot: number }>();

  private readonly matrix = new THREE.Matrix4();
  private readonly quat = new THREE.Quaternion();
  private readonly pos = new THREE.Vector3();
  private readonly scale = new THREE.Vector3(1, 1, 1);
  private readonly color = new THREE.Color();

  /** Part id -> the enclosure factor last applied. Absent means 1. */
  private readonly shades = new Map<PartId, number>();

  private outlinesOn = true;
  /** Per-part hue jitter, seeded so every client generates the same lumber. */
  private readonly jitterRng = new Rng('lumber-jitter');

  constructor(outlineThickness = 0.012) {
    this.group.name = 'parts';

    for (const kind of PART_KINDS) {
      const geometry = kind.isWedge
        ? wedge(kind.length, kind.thickness, kind.width)
        : chamferedBox(kind.length, kind.thickness, kind.width, kind.chamfer);
      const material = createToonMaterial({ color: 0xffffff });
      const outlineMaterial = createOutlineMaterial(OUTLINE_COLORS[kind.material], outlineThickness);
      this.kinds.push({ kind, geometry, material, outlineMaterial });

      // A seed bucket per kind, empty, at the origin chunk. This is what the
      // boot-time warm-up compiles: every later bucket shares this one's
      // geometry and materials, so it looks identical to the shader compiler
      // and the soak's "zero mid-round programs" assertion holds however many
      // chunks a session touches.
      this.ensureBucket(kind.id, 0, 0);
    }
  }

  private ensureBucket(kindId: number, cx: number, cz: number): ChunkBucket {
    const key = `${kindId}:${cx},${cz}`;
    const existing = this.buckets.get(key);
    if (existing !== undefined) return existing;

    const shared = this.kinds[kindId]!;
    const mesh = giveInstanceColor(
      new THREE.InstancedMesh(shared.geometry, shared.material, INITIAL_CAPACITY),
    );
    mesh.count = 0;
    mesh.visible = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // The whole point of chunking: a bucket's instances all sit inside one
    // cell, so its bounding sphere means something and culling can be on.
    mesh.frustumCulled = true;
    mesh.name = `parts:${shared.kind.key}:${cx},${cz}`;

    const outline = new THREE.InstancedMesh(shared.geometry, shared.outlineMaterial, INITIAL_CAPACITY);
    outline.count = 0;
    outline.visible = false;
    outline.frustumCulled = true;
    outline.castShadow = false;
    outline.receiveShadow = false;
    outline.name = `outline:${shared.kind.key}:${cx},${cz}`;
    // The shell reads the parent's transforms directly — one upload, two draws.
    outline.instanceMatrix = mesh.instanceMatrix;

    this.group.add(mesh, outline);
    const bucket: ChunkBucket = {
      kindId,
      mesh,
      outline,
      slotToPart: new Int32Array(INITIAL_CAPACITY).fill(-1),
      baseColor: new Float32Array(INITIAL_CAPACITY * 3),
      used: 0,
      capacity: INITIAL_CAPACITY,
    };
    this.buckets.set(key, bucket);
    return bucket;
  }

  /**
   * Recompute what the frustum tests, after a change.
   *
   * The outline shares the parent's Sphere *object*, so one recompute serves
   * both — `computeBoundingSphere` mutates in place once the sphere exists.
   */
  private refreshBounds(bucket: ChunkBucket): void {
    const populated = bucket.used > 0;
    bucket.mesh.visible = populated;
    bucket.outline.visible = populated && this.outlinesOn;
    if (!populated) return;
    bucket.mesh.computeBoundingSphere();
    bucket.outline.boundingSphere = bucket.mesh.boundingSphere;
  }

  private grow(bucket: ChunkBucket): void {
    const next = bucket.capacity * 2;
    const oldMesh = bucket.mesh;
    const oldOutline = bucket.outline;
    const shared = this.kinds[bucket.kindId]!;

    const mesh = giveInstanceColor(
      new THREE.InstancedMesh(shared.geometry, shared.material, next),
    );
    mesh.instanceMatrix.array.set(oldMesh.instanceMatrix.array);
    mesh.count = oldMesh.count;
    mesh.visible = oldMesh.visible;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = true;
    mesh.name = oldMesh.name;

    // Both buffers exist by construction now, so this is a copy rather than a
    // conditional creation — and the new one is already the right length.
    if (oldMesh.instanceColor !== null && mesh.instanceColor !== null) {
      mesh.instanceColor.array.set(oldMesh.instanceColor.array);
      mesh.instanceColor.needsUpdate = true;
    }

    const outline = new THREE.InstancedMesh(shared.geometry, shared.outlineMaterial, next);
    outline.count = oldOutline.count;
    outline.visible = oldOutline.visible;
    outline.frustumCulled = true;
    outline.name = oldOutline.name;
    outline.instanceMatrix = mesh.instanceMatrix;

    this.group.remove(oldMesh, oldOutline);
    oldMesh.dispose();
    oldOutline.dispose();
    this.group.add(mesh, outline);

    const slotToPart = new Int32Array(next).fill(-1);
    slotToPart.set(bucket.slotToPart);

    const baseColor = new Float32Array(next * 3);
    baseColor.set(bucket.baseColor);
    bucket.baseColor = baseColor;

    bucket.mesh = mesh;
    bucket.outline = outline;
    bucket.slotToPart = slotToPart;
    bucket.capacity = next;
    this.refreshBounds(bucket);
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
    if (this.kinds[kindId] === undefined) return;
    const bucket = this.ensureBucket(kindId, Math.floor(cx / CHUNK), Math.floor(cz / CHUNK));
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
    bucket.baseColor[slot * 3] = this.color.r;
    bucket.baseColor[slot * 3 + 1] = this.color.g;
    bucket.baseColor[slot * 3 + 2] = this.color.b;
    // A fresh part starts unshaded; whoever computes enclosure runs after the
    // world changes and will say otherwise if it is.
    this.shades.delete(id);

    bucket.slotToPart[slot] = id;
    bucket.mesh.count = bucket.used;
    bucket.outline.count = bucket.used;
    bucket.mesh.instanceMatrix.needsUpdate = true;
    if (bucket.mesh.instanceColor !== null) bucket.mesh.instanceColor.needsUpdate = true;

    this.location.set(id, { bucket, slot });
    this.refreshBounds(bucket);
  }

  /** Remove a part's instance by moving the last one into its slot. */
  remove(id: PartId): boolean {
    const loc = this.location.get(id);
    if (loc === undefined) return false;
    const bucket = loc.bucket;
    const last = bucket.used - 1;

    if (loc.slot !== last) {
      bucket.mesh.getMatrixAt(last, this.matrix);
      bucket.mesh.setMatrixAt(loc.slot, this.matrix);
      if (bucket.mesh.instanceColor !== null) {
        bucket.mesh.getColorAt(last, this.color);
        bucket.mesh.setColorAt(loc.slot, this.color);
      }
      // The base colour moves with its part, or the next re-shade of the moved
      // part multiplies from the removed one's paint.
      bucket.baseColor.copyWithin(loc.slot * 3, last * 3, last * 3 + 3);
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
    this.shades.delete(id);
    this.refreshBounds(bucket);
    return true;
  }

  clear(): void {
    // Buckets are kept, empty and invisible — see the file comment. A cleared
    // world rebuilt in the same places allocates nothing.
    for (const bucket of this.buckets.values()) {
      bucket.used = 0;
      bucket.mesh.count = 0;
      bucket.outline.count = 0;
      bucket.mesh.visible = false;
      bucket.outline.visible = false;
      bucket.slotToPart.fill(-1);
    }
    this.location.clear();
    this.shades.clear();
  }

  /**
   * Darken one part to `factor` of its own colour.
   *
   * From the stored base every time, never from the live buffer — see the note
   * on `baseColor`. Skipped when nothing changed, because the caller re-shades
   * the whole world on every change and most parts keep the shade they had;
   * a needless write is a needless GPU upload of the whole colour buffer.
   */
  shade(id: PartId, factor: number): void {
    const current = this.shades.get(id) ?? 1;
    if (Math.abs(current - factor) < 1e-3) return;
    const loc = this.location.get(id);
    if (loc === undefined) return;
    const bucket = loc.bucket;
    const at = loc.slot * 3;
    this.color.setRGB(
      bucket.baseColor[at]! * factor,
      bucket.baseColor[at + 1]! * factor,
      bucket.baseColor[at + 2]! * factor,
    );
    bucket.mesh.setColorAt(loc.slot, this.color);
    if (bucket.mesh.instanceColor !== null) bucket.mesh.instanceColor.needsUpdate = true;
    this.shades.set(id, factor);
  }

  /** What a part is currently shaded to. 1 for a part never shaded. */
  shadeOf(id: PartId): number {
    return this.shades.get(id) ?? 1;
  }

  /**
   * The colour actually in the buffer for this part, not the bookkeeping.
   *
   * For tests and the harness: `shadeOf` reports what this class believes, and
   * a class's beliefs about its own buffer are exactly the thing a swap bug
   * falsifies.
   */
  colorOf(id: PartId): { r: number; g: number; b: number } | null {
    const loc = this.location.get(id);
    if (loc === undefined) return null;
    loc.bucket.mesh.getColorAt(loc.slot, this.color);
    return { r: this.color.r, g: this.color.g, b: this.color.b };
  }

  /** The spread of shades across every live part, for a scenario to check. */
  shadeStats(): { min: number; max: number; shaded: number } {
    // A part absent from the map is at 1, so the spread starts there whenever
    // any part is unshaded — and an empty world is all at 1 by vacuity.
    const anyUnshaded = this.location.size === 0 || this.shades.size < this.location.size;
    let min = 1;
    let max = anyUnshaded ? 1 : 0;
    for (const factor of this.shades.values()) {
      if (factor < min) min = factor;
      if (factor > max) max = factor;
    }
    return { min, max, shaded: this.shades.size };
  }

  /** Outline width is measured in pixels, so it depends on the viewport. */
  setViewportHeight(height: number): void {
    for (const shared of this.kinds) {
      shared.outlineMaterial.uniforms.viewportHeight!.value = height;
    }
  }

  setOutlinesVisible(visible: boolean): void {
    this.outlinesOn = visible;
    for (const bucket of this.buckets.values()) {
      bucket.outline.visible = visible && bucket.used > 0;
    }
  }

  /**
   * Draw calls if nothing were culled — the *ceiling*, not the frame's cost.
   *
   * The whole point of chunking is that the real number is lower whenever the
   * camera is not looking at everything; `renderer.info.render.calls` is where
   * the real number lives.
   */
  get drawCalls(): number {
    let n = 0;
    for (const bucket of this.buckets.values()) {
      if (bucket.used > 0) n += bucket.outline.visible ? 2 : 1;
    }
    return n;
  }

  get instanceCount(): number {
    let n = 0;
    for (const bucket of this.buckets.values()) n += bucket.used;
    return n;
  }

  /** How many chunk buckets exist, for tests and the harness. */
  get bucketCount(): number {
    return this.buckets.size;
  }

  dispose(): void {
    for (const bucket of this.buckets.values()) {
      bucket.mesh.dispose();
      bucket.outline.dispose();
    }
    for (const shared of this.kinds) {
      shared.geometry.dispose();
      shared.material.dispose();
      shared.outlineMaterial.dispose();
    }
  }
}
