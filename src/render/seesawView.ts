/**
 * The see-saw's moving half, drawn.
 *
 * The tyre is map scenery and stays in the scenery batch; this is the plank
 * and its handles, one group per see-saw, posed every tick from the same
 * state the collision box is pushed from. One source of truth for where the
 * plank is — the `Seesaw` — so the drawn board and the board bodies stand on
 * cannot drift apart.
 */

import * as THREE from 'three';
import { addOutlineNormals, chamferedBox } from './geometry.ts';
import { createToonMaterial, createOutlineMaterial } from './toonMaterial.ts';

/** The prefab's plank, verbatim: size, paint and chamfer. */
const PLANK = { w: 3.8, h: 0.16, d: 0.5, color: 0xd8564f, outline: 0x8a3226 };

export class SeesawView {
  readonly group = new THREE.Group();

  constructor() {
    this.group.name = 'seesaw';

    const geometry = chamferedBox(PLANK.w, PLANK.h, PLANK.d, 0.02);
    const plank = new THREE.Mesh(geometry, createToonMaterial({ color: PLANK.color }));
    plank.castShadow = true;
    plank.receiveShadow = true;
    this.group.add(plank);

    const shell = new THREE.Mesh(
      addOutlineNormals(geometry.clone()),
      createOutlineMaterial(PLANK.outline, 0.012),
    );
    this.group.add(shell);

    // Handles at both ends, the detail that says see-saw rather than plank.
    // Children of the group, so they ride the tilt instead of being authored
    // at one frozen angle the way the prefab used to freeze them.
    const handleGeometry = chamferedBox(0.06, 0.3, 0.06, 0.01);
    const handleMaterial = createToonMaterial({ color: 0x4a4f54 });
    for (const dx of [-1.55, 1.55]) {
      const handle = new THREE.Mesh(handleGeometry, handleMaterial);
      handle.position.set(dx, 0.08 + 0.15, 0);
      this.group.add(handle);
    }
  }

  follow(pose: { x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number }): void {
    this.group.position.set(pose.x, pose.y, pose.z);
    this.group.quaternion.set(pose.qx, pose.qy, pose.qz, pose.qw);
  }
}
