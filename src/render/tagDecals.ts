/**
 * The marks a spray can leaves on the garden.
 *
 * One instanced mesh per shape, drawn from the same geometry the locker paints
 * a shirt with — so a can of paint added no geometry to this project at all. A
 * shape nobody has sprayed has a count of zero and costs nothing, which is the
 * rule this codebase has now got wrong twice and states everywhere it applies.
 *
 * ## Sitting on a surface without fighting it
 *
 * A tag is a flat polygon turned to face along the surface normal and pushed
 * `TAG_LIFT` out along it. That is a decal in the only sense this renderer
 * supports: no projection, no depth trickery, no second pass. It curls off a
 * corner if you spray across one, which is exactly what a real sticker does and
 * cheaper than anything that would not.
 *
 * The rotation is built from the normal rather than stored, because the wire
 * format carries a normal and a spin and nothing else — a quaternion on the
 * wire would be four numbers where three do, and would let a client send an
 * orientation that does not match the surface it claims to be on.
 */

import * as THREE from 'three';
import { giveInstanceColor } from './instanceColor.ts';
import { markGeometries } from './markShapes.ts';
import { TAG_COLORS, TAG_LIFT, TAG_SHAPES, type TagRecord } from '../game/spray.ts';
import { WORLD_LIMIT } from '../game/spray.ts';

/** The shape geometry faces -Z, so this is what a normal has to be turned onto. */
const FACE = new THREE.Vector3(0, 0, -1);

export class TagDecals {
  readonly group = new THREE.Group();

  private readonly meshes = new Map<number, THREE.InstancedMesh>();
  private readonly material: THREE.MeshBasicMaterial;

  constructor() {
    this.group.name = 'tags';
    // Unlit and flat, which is the whole cel-shaded look and also the honest
    // answer for paint: a mark on a shaded plank that shades with it reads as
    // part of the plank, and a tag is meant to read as something somebody did.
    this.material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      // Never writes depth and always loses a tie, so a mark four millimetres
      // off a fence cannot flicker against it.
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });

    const geometries = markGeometries();
    for (let i = 0; i < TAG_SHAPES.length; i++) {
      const geometry = geometries.get(TAG_SHAPES[i]!);
      if (geometry === undefined) continue;
      const mesh = giveInstanceColor(
        new THREE.InstancedMesh(geometry, this.material, WORLD_LIMIT),
      );
      mesh.name = `tag:${TAG_SHAPES[i]}`;
      mesh.count = 0;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 1;
      this.meshes.set(i, mesh);
      this.group.add(mesh);
    }
  }

  /** How many are on screen, per shape and in total. Read by the tests. */
  get drawn(): number {
    let n = 0;
    for (const mesh of this.meshes.values()) n += mesh.count;
    return n;
  }

  /**
   * Redraw the lot.
   *
   * Called when the list changes rather than every frame — tags do not move,
   * and rebuilding ninety matrices on a change nobody made is the sort of cost
   * that never shows up in a profile and is always there.
   */
  set(tags: readonly TagRecord[]): void {
    const counts = new Map<number, number>();
    const position = new THREE.Vector3();
    const normal = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const spin = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const matrix = new THREE.Matrix4();
    const color = new THREE.Color();

    for (const tag of tags) {
      const mesh = this.meshes.get(tag.shape);
      if (mesh === undefined) continue;
      const i = counts.get(tag.shape) ?? 0;
      if (i >= mesh.instanceMatrix.count) continue;

      normal.set(tag.nx, tag.ny, tag.nz).normalize();
      position.set(tag.x, tag.y, tag.z).addScaledVector(normal, TAG_LIFT);
      quaternion.setFromUnitVectors(FACE, normal);
      // Turned about the normal afterwards, so the spin means the same thing on
      // a wall as on the ground rather than being a turn about some axis the
      // surface happened to give us.
      spin.setFromAxisAngle(normal, tag.spin);
      quaternion.premultiply(spin);
      scale.set(tag.size, tag.size, tag.size);
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(i, matrix);
      mesh.setColorAt(i, color.setHex(TAG_COLORS[tag.color] ?? TAG_COLORS[0]!, THREE.SRGBColorSpace));
      counts.set(tag.shape, i + 1);
    }

    for (const [shape, mesh] of this.meshes) {
      // Off is a count of zero, not a matrix parked out of sight.
      mesh.count = counts.get(shape) ?? 0;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const mesh of this.meshes.values()) {
      mesh.geometry.dispose();
      mesh.dispose();
    }
    this.material.dispose();
  }
}
