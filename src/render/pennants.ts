/**
 * The cloth on top of every flag stand.
 *
 * A stand is an ordinary part, and parts are boxes — the instancing, culling
 * and outline machinery all assume it, and teaching them one triangular
 * exception would touch every path for the sake of a decoration. So the pole
 * renders as the box it is, and this draws the pennant: one instanced
 * triangle per placed stand, coloured by the paint on its pole.
 *
 * Refreshed from `worldChanged`, which is the funnel every placement and
 * removal already goes through — on the machine that built it, on a guest
 * applying a `built`, on a joiner adopting the world wholesale. There is no
 * pennant state to keep in step because there is no pennant state: the placed
 * parts are the truth and this redraws from them.
 *
 * One draw call however many stands exist, and none of the world's budget
 * tests notice it: no stands are placed at boot, so the cost starts at zero
 * and stays proportional to how many flags somebody actually planted.
 */

import * as THREE from 'three';
import type { PlacementRecord } from '../build/buildSystem.ts';
import { COLORWAYS, FLAG_POLE_KIND, getPartKind } from '../build/partKit.ts';
import { createToonMaterial } from './toonMaterial.ts';
import { giveInstanceColor } from './instanceColor.ts';

/** More stands than any yard will hold; the mesh clamps rather than grows. */
const CAPACITY = 64;

/** The pennant: a swallow-tailless little triangle, hanging off the pole top. */
const LENGTH = 0.52;
const DROP = 0.3;

function pennantGeometry(): THREE.BufferGeometry {
  // A single triangle in the local X/Y plane: attached edge at the origin,
  // point trailing +X and drooping. Double-sided at the material, because a
  // flag with a back face costs nothing to want and one draw call to have.
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0,
    LENGTH, -DROP * 0.38, 0,
    0, -DROP, 0,
  ], 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute([
    0, 0, 1,
    0, 0, 1,
    0, 0, 1,
  ], 3));
  return geometry;
}

export class Pennants {
  readonly mesh: THREE.InstancedMesh;

  private readonly matrix = new THREE.Matrix4();
  private readonly quat = new THREE.Quaternion();
  private readonly pos = new THREE.Vector3();
  private readonly axis = new THREE.Vector3();
  private readonly color = new THREE.Color();

  constructor() {
    const material = createToonMaterial({ color: 0xffffff });
    material.side = THREE.DoubleSide;
    this.mesh = giveInstanceColor(
      new THREE.InstancedMesh(pennantGeometry(), material, CAPACITY),
    );
    this.mesh.count = 0;
    this.mesh.name = 'pennants';
    // A handful of triangles scattered across the yard: one bounding sphere
    // over all of them would be most of the map, so culling buys nothing.
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
  }

  /** How many pennants are currently drawn. For the tests, mostly. */
  get drawn(): number {
    return this.mesh.count;
  }

  /**
   * Redraw from the placed world.
   *
   * Takes the id-record pairs `serializeWithIds` already produces rather than
   * the build system itself, so a test can hand it three records and look at
   * the mesh without standing up a world.
   */
  refresh(parts: ReadonlyArray<[number, PlacementRecord]>): void {
    const half = getPartKind(FLAG_POLE_KIND).length / 2;
    let count = 0;

    for (const [, record] of parts) {
      if (record.kind !== FLAG_POLE_KIND) continue;
      if (count >= CAPACITY) break;

      this.quat.set(record.qx, record.qy, record.qz, record.qw).normalize();

      // The pole's long axis is local +X; whichever end sits higher in the
      // world is the top, so a pole planted upside-down still flies its flag
      // at the top rather than in the dirt.
      this.axis.set(half, 0, 0).applyQuaternion(this.quat);
      if (this.axis.y < 0) this.axis.multiplyScalar(-1);
      this.pos.set(
        record.x + this.axis.x,
        record.y + this.axis.y,
        record.z + this.axis.z,
      );

      // The pennant hangs level whatever the pole does, yawed to follow the
      // pole's own width axis so rotating the stand turns the flag with it.
      // A pole lying flat points that axis at the sky, where a yaw stops
      // meaning anything — any level heading is as honest as any other, and
      // zero is the one that does not jitter between frames.
      this.axis.set(0, 0, 1).applyQuaternion(this.quat);
      const level = Math.hypot(this.axis.x, this.axis.z);
      const yaw = level < 0.35 ? 0 : Math.atan2(this.axis.x, this.axis.z) + Math.PI / 2;

      this.matrix.makeRotationY(yaw).setPosition(this.pos);
      this.mesh.setMatrixAt(count, this.matrix);
      this.color.setHex(COLORWAYS[record.colorway] ?? COLORWAYS[0]!);
      this.mesh.setColorAt(count, this.color);
      count++;
    }

    this.mesh.count = count;
    this.mesh.visible = count > 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor !== null) this.mesh.instanceColor.needsUpdate = true;
  }
}
