/**
 * The chunking half of the part renderer: which cell a part lands in, what the
 * frustum is told, and what an empty cell costs.
 *
 * Written after seven planted bugs on exactly these behaviours sailed through
 * the rest of the suite — the chunking is deliberately invisible to every
 * caller, which means it is also invisible to every caller's tests. These
 * assert through the renderer's public surface: the meshes it puts in its
 * group, their names, their spheres, and their visibility.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { CHUNK, PartRenderer } from './partRenderer.ts';

const add = (r: PartRenderer, id: number, x: number, z = 0) =>
  r.add(id, 0, 0, x, 0.5, z, 0, 0, 0, 1);

/** Every part mesh (not outline) currently populated, by name. */
function populated(r: PartRenderer): THREE.InstancedMesh[] {
  return r.group.children.filter(
    (o): o is THREE.InstancedMesh =>
      o instanceof THREE.InstancedMesh && o.name.startsWith('parts:') && o.count > 0,
  );
}

describe('which cell a part lands in', () => {
  it('puts parts a world apart in different meshes', () => {
    const r = new PartRenderer();
    add(r, 1, 0);
    add(r, 2, CHUNK * 4);
    const meshes = populated(r);
    expect(meshes).toHaveLength(2);
    expect(meshes[0]!.name).not.toBe(meshes[1]!.name);
  });

  it('and parts in one cell in one mesh', () => {
    const r = new PartRenderer();
    add(r, 1, 1);
    add(r, 2, 2);
    add(r, 3, 3);
    const meshes = populated(r);
    expect(meshes).toHaveLength(1);
    expect(meshes[0]!.count).toBe(3);
  });

  it('does not conjure a bucket per part', () => {
    const r = new PartRenderer();
    const before = r.bucketCount;
    for (let i = 0; i < 20; i++) add(r, i, (i % 4) * 0.5);
    expect(r.bucketCount).toBe(before);
  });
});

describe('what the frustum is told', () => {
  it('leaves culling on for every populated mesh', () => {
    // The entire point of the change. A mesh with culling off is submitted
    // every frame from anywhere, which is the bug this file replaced.
    const r = new PartRenderer();
    add(r, 1, 30);
    for (const mesh of populated(r)) expect(mesh.frustumCulled).toBe(true);
  });

  it('gives a populated mesh a sphere that actually contains its parts', () => {
    const r = new PartRenderer();
    add(r, 1, 30, 30);
    add(r, 2, 34, 30);
    const mesh = populated(r)[0]!;
    expect(mesh.boundingSphere).not.toBeNull();
    const sphere = mesh.boundingSphere!;
    for (const p of [new THREE.Vector3(30, 0.5, 30), new THREE.Vector3(34, 0.5, 30)]) {
      // A little slack for the part's own extent.
      expect(sphere.distanceToPoint(p)).toBeLessThan(1);
    }
  });

  it('keeps the sphere honest as parts arrive', () => {
    // A sphere computed once and never again is a fort that pops out of view
    // when it outgrows its first plank.
    const r = new PartRenderer();
    add(r, 1, 24, 24);
    const first = populated(r)[0]!.boundingSphere!.radius;
    add(r, 2, 24 + CHUNK - 1, 24);
    const after = populated(r)[0]!.boundingSphere!.radius;
    expect(after).toBeGreaterThan(first);
  });

  it('shares one sphere between a mesh and its outline', () => {
    const r = new PartRenderer();
    add(r, 1, 30);
    const mesh = populated(r)[0]!;
    const outline = r.group.children.find(
      (o) => o.name === mesh.name.replace('parts:', 'outline:'),
    ) as THREE.InstancedMesh;
    expect(outline.boundingSphere).toBe(mesh.boundingSphere);
  });
});

describe('what an empty cell costs', () => {
  it('nothing: an emptied bucket goes invisible', () => {
    const r = new PartRenderer();
    add(r, 1, 30);
    const mesh = populated(r)[0]!;
    r.remove(1);
    expect(mesh.visible).toBe(false);
    expect(mesh.count).toBe(0);
  });

  it('and a cleared world shows nothing at all', () => {
    const r = new PartRenderer();
    add(r, 1, 0);
    add(r, 2, 40);
    r.clear();
    for (const child of r.group.children) expect(child.visible).toBe(false);
    expect(r.instanceCount).toBe(0);
  });

  it('but the bucket is kept, so rebuilding in place allocates nothing', () => {
    const r = new PartRenderer();
    add(r, 1, 30);
    const buckets = r.bucketCount;
    const nodes = r.group.children.length;
    r.clear();
    add(r, 2, 30);
    expect(r.bucketCount).toBe(buckets);
    expect(r.group.children.length).toBe(nodes);
  });
});

describe('removal, seen from the buffer rather than the bookkeeping', () => {
  it('a shade after a swap lands on the moved part where it now lives', () => {
    // The lie this catches is self-consistent everywhere else: a stale slot in
    // the location map makes `shade` write to a dead slot and `colorOf` read
    // it back, agreeing with each other and with nothing on screen. Slot 0 of
    // a one-part mesh is what the GPU draws, so it is what is asked.
    const r = new PartRenderer();
    add(r, 1, 30);
    add(r, 2, 31);
    const base = r.colorOf(2)!;
    r.remove(1);                          // 2 swaps into slot 0
    r.shade(2, 0.5);
    const mesh = populated(r)[0]!;
    const drawn = new THREE.Color();
    mesh.getColorAt(0, drawn);
    expect(drawn.r).toBeCloseTo(base.r * 0.5, 5);
    expect(mesh.count).toBe(1);
  });
});

describe('growing a dense cell', () => {
  it('keeps the outline on the same matrix buffer across a grow', () => {
    // The shell reads the parent's transforms directly; a grow that gives it
    // its own buffer draws every outline at wherever the copy stopped being
    // updated — which is invisible until a part moves.
    const r = new PartRenderer();
    for (let i = 0; i < 40; i++) add(r, i, 30 + (i % 6) * 0.4, 30);
    const mesh = populated(r)[0]!;
    const outline = r.group.children.find(
      (o) => o.name === mesh.name.replace('parts:', 'outline:'),
    ) as THREE.InstancedMesh;
    expect(outline.instanceMatrix).toBe(mesh.instanceMatrix);
    expect(mesh.count).toBe(40);
  });
});
