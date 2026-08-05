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

  /** Emit the instanced meshes. Call once, after all adds. */
  build(): THREE.Group {
    if (this.built) return this.group;
    this.built = true;

    for (const [key, entry] of this.pending) {
      const count = entry.matrices.length;
      if (count === 0) continue;

      const mesh = new THREE.InstancedMesh(entry.geometry, createToonMaterial({}), count);
      mesh.name = `prop:${key}`;
      mesh.castShadow = entry.castShadow;
      mesh.receiveShadow = entry.receiveShadow;
      // Instances span the whole yard, so the mesh's own bounds are meaningless
      // as a culling volume — culling it as one object pops the entire fence out
      // of view the moment its origin leaves the frustum.
      mesh.frustumCulled = false;

      for (let i = 0; i < count; i++) {
        mesh.setMatrixAt(i, entry.matrices[i]!);
        mesh.setColorAt(i, entry.colors[i]!);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;

      const outlineMaterial = createOutlineMaterial(entry.outlineColor, entry.outlineThickness);
      this.outlineMaterials.push(outlineMaterial);

      const outline = new THREE.InstancedMesh(entry.geometry, outlineMaterial, count);
      outline.name = `prop-outline:${key}`;
      outline.frustumCulled = false;
      outline.castShadow = false;
      outline.receiveShadow = false;
      // Shares the parent's buffer: one upload, one extra draw per key.
      outline.instanceMatrix = mesh.instanceMatrix;

      this.group.add(mesh, outline);
    }

    this.pending.clear();
    return this.group;
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
