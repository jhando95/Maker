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
import { BULB } from './culDeSac.ts';

/** The tuft field, pulled back out of the assembled scene. */
/**
 * Every instanced mesh the grass is drawn from.
 *
 * A list rather than one mesh, because the lawn is split into cells so it can be
 * frustum-culled. This used to fetch the single mesh by name and read `count`
 * off it — which, once the name belonged to a group, quietly returned nothing:
 * the verge test failed honestly, and the paving test went green for the worst
 * possible reason, having found no grass anywhere to be on the road.
 */
function tufts(scene: THREE.Scene): THREE.InstancedMesh[] {
  const root = scene.getObjectByName('tufts');
  expect(root).toBeDefined();
  const out: THREE.InstancedMesh[] = [];
  root!.traverse((o) => {
    if ((o as THREE.InstancedMesh).isInstancedMesh === true) out.push(o as THREE.InstancedMesh);
  });
  expect(out.length, 'the lawn should be drawn by at least one mesh').toBeGreaterThan(0);
  return out;
}

/** Every clump's position on the ground. */
function positions(meshes: readonly THREE.InstancedMesh[]): THREE.Vector3[] {
  const matrix = new THREE.Matrix4();
  const out: THREE.Vector3[] = [];
  for (const mesh of meshes) {
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, matrix);
      out.push(new THREE.Vector3().setFromMatrixPosition(matrix));
    }
  }
  return out;
}

describe('the assembled yard', () => {
  it('grows no grass through the turning head', () => {
    // The largest paved surface on the map, and the one a player looks straight
    // at over the front fence — so it is where grass coming up through tarmac
    // would be most obvious.
    //
    // This is a test of the wiring rather than of the rule: `buildTufts` is
    // told where the paving is, and if `createScene` ever stops telling it —
    // which is one argument at one call site — every other test in the project
    // still passes.
    //
    // Measured against the bulb's own constants rather than a copy of them.
    // The first version had the street's rectangle typed in, and when the road
    // moved outside the fence the test went on happily checking a patch of
    // front lawn where grass is supposed to grow.
    const scene = createScene('paving-check').scene;
    const onRoad = positions(tufts(scene)).filter(
      (p) => Math.hypot(p.x - BULB.x, p.z - BULB.z) < BULB.radius * 0.8,
    );
    expect(onRoad).toHaveLength(0);
  });

  it('still grows grass on the verge beside it', () => {
    // Otherwise "no grass on the road" is satisfied by a lot with no grass on
    // it at all, which is the state this whole pass started from.
    const scene = createScene('paving-check').scene;
    const verge = positions(tufts(scene)).filter((p) => {
      const r = Math.hypot(p.x - BULB.x, p.z - BULB.z);
      return r > BULB.radius + 1 && r < BULB.radius + 5;
    });
    expect(verge.length).toBeGreaterThan(20);
  });

  it('builds the same yard twice from the same seed', () => {
    // Two players have to be standing in the same yard and none of it is sent.
    const a = positions(tufts(createScene('same').scene));
    const b = positions(tufts(createScene('same').scene));
    expect(a.length).toBe(b.length);
    expect(a.map((p) => p.toArray())).toEqual(b.map((p) => p.toArray()));
  });
});
