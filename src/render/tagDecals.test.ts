import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { TagDecals } from './tagDecals.ts';
import { TAG_LIFT, WORLD_LIMIT, clampTag, type TagRecord } from '../game/spray.ts';

const tag = (over: Partial<TagRecord> = {}): TagRecord =>
  clampTag({ shape: 0, color: 0, size: 0.5, spin: 0, x: 0, y: 1, z: 0, nx: 0, ny: 0, nz: 1, ...over });

describe('drawing tags', () => {
  it('draws nothing at all in a garden nobody has sprayed', () => {
    // An instanced mesh's count is a number handed to the draw call, and this
    // project has got that wrong twice.
    const decals = new TagDecals();
    expect(decals.drawn).toBe(0);
    decals.set([]);
    expect(decals.drawn).toBe(0);
  });

  it('draws one per tag, and stops drawing them when they go', () => {
    const decals = new TagDecals();
    decals.set([tag(), tag({ x: 1 }), tag({ x: 2 })]);
    expect(decals.drawn).toBe(3);
    decals.set([tag()]);
    expect(decals.drawn).toBe(1);
    decals.set([]);
    expect(decals.drawn).toBe(0);
  });

  it('spreads shapes across their own meshes rather than one', () => {
    // The reason a palette of eleven is affordable: a shape costs a draw call
    // only while somebody is using it.
    const decals = new TagDecals();
    decals.set([tag({ shape: 0 }), tag({ shape: 1 }), tag({ shape: 2 })]);
    expect(decals.drawn).toBe(3);
    let used = 0;
    decals.group.traverse((o) => {
      if ((o as THREE.InstancedMesh).isInstancedMesh && (o as THREE.InstancedMesh).count > 0) used++;
    });
    expect(used).toBe(3);
  });

  it('sits the mark off the surface rather than in it', () => {
    // Four millimetres along the normal. In the surface it z-fights; a
    // centimetre out and it visibly floats on a plank you are standing against.
    const decals = new TagDecals();
    decals.set([tag({ x: 0, y: 1, z: 0, nx: 0, ny: 0, nz: 1 })]);
    const mesh = decals.group.children.find(
      (o) => (o as THREE.InstancedMesh).count > 0,
    ) as THREE.InstancedMesh;
    const m = new THREE.Matrix4();
    mesh.getMatrixAt(0, m);
    const at = new THREE.Vector3().setFromMatrixPosition(m);
    expect(at.z).toBeCloseTo(TAG_LIFT, 5);
    expect(at.y).toBeCloseTo(1, 5);
  });

  it('turns the mark to face the way it was sprayed', () => {
    // The claim that a tag lies on the surface rather than in some fixed plane.
    // The shapes face -Z, so a mark on a wall whose normal is +X has to have
    // been turned a quarter turn.
    const decals = new TagDecals();
    decals.set([tag({ nx: 1, ny: 0, nz: 0 })]);
    const mesh = decals.group.children.find(
      (o) => (o as THREE.InstancedMesh).count > 0,
    ) as THREE.InstancedMesh;
    const m = new THREE.Matrix4();
    mesh.getMatrixAt(0, m);
    // Decomposed rather than read straight off the matrix: the instance carries
    // a scale, and `setFromRotationMatrix` assumes the upper 3x3 is orthonormal
    // — so it returns a quaternion halfway to the right answer and the test
    // fails against working code.
    const rotation = new THREE.Quaternion();
    m.decompose(new THREE.Vector3(), rotation, new THREE.Vector3());
    const facing = new THREE.Vector3(0, 0, -1).applyQuaternion(rotation);
    expect(facing.x).toBeCloseTo(1, 3);
  });

  it('scales to the size that was asked for', () => {
    const decals = new TagDecals();
    decals.set([tag({ size: 0.8 })]);
    const mesh = decals.group.children.find(
      (o) => (o as THREE.InstancedMesh).count > 0,
    ) as THREE.InstancedMesh;
    const m = new THREE.Matrix4();
    mesh.getMatrixAt(0, m);
    expect(new THREE.Vector3().setFromMatrixScale(m).x).toBeCloseTo(0.8, 5);
  });

  it('will not overrun its buffer however many it is handed', () => {
    // The world cap and the buffer are the same number, and a list longer than
    // the cap is a bug somewhere else — but writing past an instanced buffer is
    // a crash, and a crash is a worse way to find out.
    const decals = new TagDecals();
    const many = Array.from({ length: WORLD_LIMIT * 3 }, (_, i) => tag({ shape: 0, x: i }));
    expect(() => decals.set(many)).not.toThrow();
    expect(decals.drawn).toBeLessThanOrEqual(WORLD_LIMIT);
  });
});
