/**
 * Batches static scenery into instanced draws.
 *
 * The backyard is mostly repeated shapes — every fence picket is the same box at
 * a different transform. Built as individual meshes that was ~500 objects and,
 * with an outline shell each, ~1000 draw calls before a single player-built part
 * was on screen. Grouping by geometry turns each repeated shape into one draw
 * plus one for its outline.
 *
 * Scenery never moves, so instance matrices are written once at build time and
 * never touched again. That is the difference from PartRenderer, which has to
 * support insertion and O(1) removal at runtime.
 */

import * as THREE from 'three';
import { createToonMaterial, createOutlineMaterial } from './toonMaterial.ts';

export interface PropOptions {
  outlineColor?: number;
  outlineThickness?: number;
  castShadow?: boolean;
  receiveShadow?: boolean;
}

interface Pending {
  geometry: THREE.BufferGeometry;
  outlineColor: number;
  outlineThickness: number;
  matrices: THREE.Matrix4[];
  colors: THREE.Color[];
  castShadow: boolean;
  receiveShadow: boolean;
}

/**
 * Accumulates scenery and emits instanced meshes.
 *
 * Instances are keyed by caller-supplied string rather than by geometry
 * identity, so a caller must pass the *same* geometry object for a given key —
 * building a fresh BufferGeometry per picket would defeat the whole point and is
 * easy to do by accident.
 */
export class PropBatch {
  /**
   * Cell size for splitting a busy key, in metres.
   *
   * Two-thirds of the lot's width, which is the scale that matters: the yard is
   * forty-eight metres across and the neighbourhood a hundred and thirty, so a
   * thirty-two metre cell puts the four fence runs, the two gardens, the street
   * and each side of the horizon in different buckets without shattering
   * anything into single-instance draws.
   */
  static readonly CHUNK = 48;

  /**
   * How many instances a key needs before it is worth splitting.
   *
   * Chunking buys culling and costs draw calls, so it only pays where there are
   * enough triangles behind the key to be worth culling. Thirty-two is a little
   * over the count at which one draw of a simple box starts to cost more than
   * the couple of extra draws splitting it would add.
   */
  static readonly CHUNK_THRESHOLD = 80;

  readonly group = new THREE.Group();

  private readonly pending = new Map<string, Pending>();
  private readonly outlineMaterials: THREE.ShaderMaterial[] = [];
  private built = false;

  constructor(name = 'props') {
    this.group.name = name;
  }

  /**
   * Queue one instance.
   *
   * @param key groups instances that share geometry and outline treatment
   * @param color per-instance tint, so one geometry can serve several colours
   */
  add(
    key: string,
    geometry: THREE.BufferGeometry,
    matrix: THREE.Matrix4,
    color: number,
    options: PropOptions = {},
  ): void {
    if (this.built) throw new Error('PropBatch.add after build()');

    let entry = this.pending.get(key);
    if (entry === undefined) {
      entry = {
        geometry,
        outlineColor: options.outlineColor ?? 0x3a2c2a,
        outlineThickness: options.outlineThickness ?? 0.014,
        matrices: [],
        colors: [],
        castShadow: options.castShadow ?? true,
        receiveShadow: options.receiveShadow ?? true,
      };
      this.pending.set(key, entry);
    } else if (entry.geometry !== geometry) {
      throw new Error(
        `PropBatch key '${key}' was given two different geometries; ` +
          'instancing requires one shared geometry per key',
      );
    }

    entry.matrices.push(matrix.clone());
    entry.colors.push(new THREE.Color().setHex(color, THREE.SRGBColorSpace));
  }

  /** Convenience for the common case: a transform from position/rotation. */
  addAt(
    key: string,
    geometry: THREE.BufferGeometry,
    position: THREE.Vector3,
    rotation: THREE.Euler,
    color: number,
    options: PropOptions = {},
  ): void {
    const m = new THREE.Matrix4().compose(
      position,
      new THREE.Quaternion().setFromEuler(rotation),
      new THREE.Vector3(1, 1, 1),
    );
    this.add(key, geometry, m, color, options);
  }

  /**
   * Emit the instanced meshes. Call once, after all adds.
   *
   * ## Why this splits a key into chunks
   *
   * Frustum culling used to be switched off here, with a comment explaining
   * exactly why it had to be: instances of one key span the whole yard, so the
   * mesh's bounding volume covers the whole yard, and an object that large is
   * either entirely in the frustum or entirely behind you. Turning culling on
   * with a bad bound is worse than leaving it off — the whole fence pops out of
   * view the moment its origin does.
   *
   * The consequence was that **nothing in the world was ever culled**. Measured
   * from five viewpoints — facing the house, facing the street, on the roof, and
   * facing forty metres of empty lawn — the draw calls and the triangle count
   * came back identical to the digit every time. Looking at nothing cost exactly
   * what looking at the whole neighbourhood cost.
   *
   * So the bound is made meaningful instead of being ignored: instances are
   * grouped into `CHUNK`-metre cells and each cell becomes its own mesh with its
   * own tight bounds, which three.js then culls for free. A player facing north
   * stops paying for the south fence, the cul-de-sac and half the trees.
   *
   * ## And why only some keys
   *
   * Chunking trades triangles for draw calls, and that trade is only worth
   * making where there are triangles to save. A key with a handful of instances
   * is already one cheap draw; splitting it four ways to cull three is a loss.
   * So a key is chunked only when it holds more than `CHUNK_THRESHOLD`
   * instances — which is the fence, the pickets, the trees and the hedges, and
   * not the one-off boxes that make up a house.
   *
   * Small keys still get culling, because they still get a correct bound. A
   * localised set — the cart, a bin — now disappears from the frame when you
   * turn your back on it, which it never used to.
   */
  build(): THREE.Group {
    if (this.built) return this.group;
    this.built = true;

    for (const [key, entry] of this.pending) {
      const count = entry.matrices.length;
      if (count === 0) continue;
      if (count <= PropBatch.CHUNK_THRESHOLD) {
        this.emit(key, entry, entry.matrices, entry.colors);
        continue;
      }

      // Bucket by cell, keeping each instance's colour with its matrix.
      const cells = new Map<string, { matrices: THREE.Matrix4[]; colors: THREE.Color[] }>();
      for (let i = 0; i < count; i++) {
        const m = entry.matrices[i]!;
        const cx = Math.floor(m.elements[12]! / PropBatch.CHUNK);
        const cz = Math.floor(m.elements[14]! / PropBatch.CHUNK);
        const id = `${cx},${cz}`;
        let cell = cells.get(id);
        if (cell === undefined) {
          cell = { matrices: [], colors: [] };
          cells.set(id, cell);
        }
        cell.matrices.push(m);
        cell.colors.push(entry.colors[i]!);
      }

      for (const [id, cell] of cells) {
        this.emit(`${key}@${id}`, entry, cell.matrices, cell.colors);
      }
    }

    this.pending.clear();
    return this.group;
  }

  /** One instanced mesh and its outline shell, with bounds three.js can cull. */
  private emit(
    name: string,
    entry: Pending,
    matrices: readonly THREE.Matrix4[],
    colors: readonly THREE.Color[],
  ): void {
    const count = matrices.length;
    const mesh = new THREE.InstancedMesh(entry.geometry, createToonMaterial({}), count);
    mesh.name = `prop:${name}`;
    mesh.castShadow = entry.castShadow;
    mesh.receiveShadow = entry.receiveShadow;

    for (let i = 0; i < count; i++) {
      mesh.setMatrixAt(i, matrices[i]!);
      mesh.setColorAt(i, colors[i]!);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;

    // Over the instances rather than over the geometry, which is the whole
    // reason culling can be switched on: `InstancedMesh.computeBoundingSphere`
    // walks the instance matrices, so the answer describes where these props
    // actually are instead of where one unplaced box is.
    mesh.computeBoundingSphere();
    mesh.frustumCulled = true;

    const outlineMaterial = createOutlineMaterial(entry.outlineColor, entry.outlineThickness);
    this.outlineMaterials.push(outlineMaterial);

    const outline = new THREE.InstancedMesh(entry.geometry, outlineMaterial, count);
    outline.name = `prop-outline:${name}`;
    outline.castShadow = false;
    outline.receiveShadow = false;
    // Shares the parent's buffer: one upload, one extra draw per chunk.
    outline.instanceMatrix = mesh.instanceMatrix;
    outline.boundingSphere = mesh.boundingSphere;
    outline.frustumCulled = true;

    this.group.add(mesh, outline);
  }

  /** Outline width is measured in pixels, so it depends on the viewport. */
  setViewportHeight(height: number): void {
    for (const m of this.outlineMaterials) {
      m.uniforms.viewportHeight!.value = height;
    }
  }

  setOutlinesVisible(visible: boolean): void {
    for (const child of this.group.children) {
      if (child.name.startsWith('prop-outline:')) child.visible = visible;
    }
  }

  /** Draw calls this batch contributes, for the debug overlay. */
  get drawCalls(): number {
    return this.group.children.length;
  }
}

/**
 * Split one big instanced mesh into a grid of smaller ones, so it can be culled.
 *
 * The same idea `PropBatch.build` applies to scenery, for the meshes that are
 * built somewhere else and handed over whole — the lawn's eleven thousand grass
 * clumps being the one that matters. A single `InstancedMesh` is one object with
 * one bounding volume, so a lawn that stretches sixty metres is drawn in full
 * whether you are looking across it or standing with your back to it.
 *
 * The parts share the source mesh's geometry and material, which is what keeps
 * this cheap: no new shader, no new upload of anything but the matrices, and the
 * per-instance colours carried across so the split is invisible.
 *
 * Returns a group, and the caller adds that instead of the mesh. The source
 * mesh is left alone — it is the caller's, and a helper that quietly disposed of
 * its argument would be a trap.
 */
export function chunkInstanced(
  source: THREE.InstancedMesh,
  cell: number,
  name = source.name,
): THREE.Group {
  const group = new THREE.Group();
  group.name = name;

  const cells = new Map<string, number[]>();
  const m = new THREE.Matrix4();
  for (let i = 0; i < source.count; i++) {
    source.getMatrixAt(i, m);
    const id = `${Math.floor(m.elements[12]! / cell)},${Math.floor(m.elements[14]! / cell)}`;
    const bucket = cells.get(id);
    if (bucket === undefined) cells.set(id, [i]);
    else bucket.push(i);
  }

  const colour = new THREE.Color();
  for (const [id, indices] of cells) {
    const part = new THREE.InstancedMesh(source.geometry, source.material, indices.length);
    part.name = `${name}@${id}`;
    part.castShadow = source.castShadow;
    part.receiveShadow = source.receiveShadow;
    for (let k = 0; k < indices.length; k++) {
      source.getMatrixAt(indices[k]!, m);
      part.setMatrixAt(k, m);
      if (source.instanceColor !== null) {
        source.getColorAt(indices[k]!, colour);
        part.setColorAt(k, colour);
      }
    }
    part.instanceMatrix.needsUpdate = true;
    if (part.instanceColor !== null) part.instanceColor.needsUpdate = true;
    part.computeBoundingSphere();
    part.frustumCulled = true;
    group.add(part);
  }

  return group;
}
