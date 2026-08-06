/**
 * The seams inside `createScene`.
 *
 * Deliberately not a test of what anything looks like — that is what the
 * scenarios are for. What is checked here is the wiring between two systems
 * that each work in isolation and have to agree: the grass knows where the map
 * has already covered the ground only because `createScene` hands it the same
 * slab list it draws, and nothing inside either module can notice if that stops
 * happening.
 */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createScene } from './scene.ts';

/** The tuft field, pulled back out of the assembled scene. */
function tufts(scene: THREE.Scene): THREE.InstancedMesh {
  const mesh = scene.getObjectByName('tufts');
  expect(mesh).toBeDefined();
  return mesh as THREE.InstancedMesh;
}

/** Every clump's position on the ground. */
function positions(mesh: THREE.InstancedMesh): THREE.Vector3[] {
  const matrix = new THREE.Matrix4();
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, matrix);
    out.push(new THREE.Vector3().setFromMatrixPosition(matrix));
  }
  return out;
}

describe('the assembled yard', () => {
  it('grows no grass through the street', () => {
    // The street is 46m by 5m centred on z = -20.5. It is the largest paved
    // surface on the map and the one a player crosses on the way in, so it is
    // also where grass coming up through tarmac is most obvious.
    //
    // This is a test of the wiring rather than of the rule: `buildTufts` is
    // told where the paving is, and if `createScene` ever stops telling it —
    // which is one argument at one call site — every other test in the project
    // still passes.
    const scene = createScene('paving-check').scene;
    const onStreet = positions(tufts(scene))
      .filter((p) => Math.abs(p.x) <= 23 && p.z >= -23 && p.z <= -18);
    expect(onStreet).toHaveLength(0);
  });

  it('still grows grass on the lawn either side of it', () => {
    // Otherwise "no grass on the street" is satisfied by a lot with no grass on
    // it at all, which is the state this whole pass started from.
    const scene = createScene('paving-check').scene;
    const near = positions(tufts(scene))
      .filter((p) => Math.abs(p.x) <= 20 && p.z > -17.5 && p.z < -12);
    expect(near.length).toBeGreaterThan(50);
  });

  it('builds the same yard twice from the same seed', () => {
    // Two players have to be standing in the same yard and none of it is sent.
    const a = positions(tufts(createScene('same').scene));
    const b = positions(tufts(createScene('same').scene));
    expect(a.length).toBe(b.length);
    expect(a.map((p) => p.toArray())).toEqual(b.map((p) => p.toArray()));
  });
});
