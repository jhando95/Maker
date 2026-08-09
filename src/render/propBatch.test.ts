import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { PropBatch } from './propBatch.ts';

const box = (w = 1, h = 1, d = 1) => new THREE.BoxGeometry(w, h, d);

const at = (x: number, y = 0, z = 0): THREE.Matrix4 =>
  new THREE.Matrix4().makeTranslation(x, y, z);

/** Every mesh the batch emitted, by the prefix that says how it was drawn. */
const census = (group: THREE.Group) => {
  let instanced = 0, merged = 0, outlines = 0, instances = 0;
  group.traverse((o) => {
    if (o.name.startsWith('prop-outline')) { outlines++; return; }
    if ((o as THREE.InstancedMesh).isInstancedMesh) {
      instanced++;
      instances += (o as THREE.InstancedMesh).count;
    } else if ((o as THREE.Mesh).isMesh) merged++;
  });
  return { instanced, merged, outlines, instances };
};

describe('instancing what repeats', () => {
  it('gives a shape used many times an instanced mesh', () => {
    const batch = new PropBatch();
    const g = box();
    for (let i = 0; i < 20; i++) batch.add('k', g, at(i), 0xff0000);
    const c = census(batch.build());
    expect(c.instanced).toBe(1);
    expect(c.instances).toBe(20);
    expect(c.merged).toBe(0);
  });
});

describe('merging what does not', () => {
  it('does not give a shape used once an instanced mesh of its own', () => {
    // The finding this exists for: on the real map, 174 of 212 keys held
    // exactly one instance. An instanced draw with one instance is a bind, a
    // uniform upload and a draw call, for one box.
    const batch = new PropBatch();
    for (let i = 0; i < 30; i++) batch.add(`one-off-${i}`, box(1 + i * 0.1), at(i), 0x00ff00);
    const c = census(batch.build());
    expect(c.instanced).toBe(0);
    expect(c.merged).toBeGreaterThan(0);
  });

  it('collapses many one-off shapes into far fewer draws', () => {
    const batch = new PropBatch();
    for (let i = 0; i < 40; i++) batch.add(`one-off-${i}`, box(1 + i * 0.1), at(i * 0.5), 0x00ff00);
    const c = census(batch.build());
    expect(c.merged).toBeLessThan(6);
  });

  it('keeps the two kinds apart in one batch', () => {
    const batch = new PropBatch();
    const repeated = box(2, 2, 2);
    for (let i = 0; i < 20; i++) batch.add('many', repeated, at(i), 0x0000ff);
    for (let i = 0; i < 12; i++) batch.add(`few-${i}`, box(1 + i * 0.1), at(-i), 0xff00ff);
    const c = census(batch.build());
    expect(c.instanced).toBe(1);
    expect(c.instances).toBe(20);
    expect(c.merged).toBeGreaterThan(0);
  });

  it('gives every merged mesh an outline of its own', () => {
    // The ink is what makes this world read, and a merged prop without one
    // would be the only unlined thing in the game.
    const batch = new PropBatch();
    for (let i = 0; i < 10; i++) batch.add(`few-${i}`, box(1 + i * 0.1), at(i), 0x123456);
    const c = census(batch.build());
    expect(c.outlines).toBe(c.merged + c.instanced);
  });

  it('will not merge two outline treatments into one draw', () => {
    // Outline colour and thickness are uniforms on the shell's material, so two
    // treatments cannot share a draw whatever else they share.
    const batch = new PropBatch();
    for (let i = 0; i < 6; i++) {
      batch.add(`a-${i}`, box(1 + i * 0.1), at(i), 0xffffff, { outlineColor: 0x111111 });
      batch.add(`b-${i}`, box(2 + i * 0.1), at(-i), 0xffffff, { outlineColor: 0x999999 });
    }
    expect(census(batch.build()).merged).toBeGreaterThanOrEqual(2);
  });

  it('splits a merge by cell, so the bound stays worth having', () => {
    // A merged object spanning the neighbourhood is either entirely in the
    // frustum or entirely behind you, which is the exact bug this file already
    // has a long comment about.
    const batch = new PropBatch();
    for (let i = 0; i < 8; i++) {
      batch.add(`near-${i}`, box(1 + i * 0.1), at(i), 0xffffff);
      batch.add(`far-${i}`, box(3 + i * 0.1), at(i + PropBatch.CHUNK * 3), 0xffffff);
    }
    const built = batch.build();
    expect(census(built).merged).toBeGreaterThanOrEqual(2);
    for (const child of built.children) {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh || (mesh as THREE.InstancedMesh).isInstancedMesh) continue;
      expect(mesh.frustumCulled).toBe(true);
      expect(mesh.geometry.boundingSphere).not.toBeNull();
      // Tight, not "the whole world": one cell is CHUNK metres across.
      expect(mesh.geometry.boundingSphere!.radius).toBeLessThan(PropBatch.CHUNK);
    }
  });

  it('bakes the transform in rather than losing it', () => {
    // The merge's one job. A box placed at x = 40 whose vertices come out at
    // the origin is a world where the fence is inside the house.
    const batch = new PropBatch();
    batch.add('lonely', box(), at(40, 3, -7), 0xffffff);
    const built = batch.build();
    const mesh = built.children.find(
      (c) => c.name.startsWith('prop-merged'),
    ) as THREE.Mesh;
    expect(mesh).toBeDefined();
    const centre = mesh.geometry.boundingSphere!.center;
    expect(centre.x).toBeCloseTo(40, 4);
    expect(centre.y).toBeCloseTo(3, 4);
    expect(centre.z).toBeCloseTo(-7, 4);
  });

  it('expands an indexed geometry rather than drawing its vertex soup', () => {
    // `BoxGeometry` is indexed: its vertex array is a third of its triangles
    // and the order lives in the index. Walking the vertices and ignoring that
    // draws a shape nobody asked for, which is what the first version did.
    const batch = new PropBatch();
    const g = box();
    expect(g.index).not.toBeNull();
    batch.add('lonely', g, at(0), 0xffffff);
    const mesh = batch.build().children.find(
      (c) => c.name.startsWith('prop-merged'),
    ) as THREE.Mesh;
    const merged = mesh.geometry.getAttribute('position');
    expect(mesh.geometry.index).toBeNull();
    expect(merged.count).toBe(g.index!.count);
  });

  it('carries the colour per vertex, which is what makes it one draw', () => {
    const batch = new PropBatch();
    batch.add('a', box(), at(0), 0xff0000);
    batch.add('b', box(2), at(1), 0x00ff00);
    const mesh = batch.build().children.find(
      (c) => c.name.startsWith('prop-merged'),
    ) as THREE.Mesh;
    const colors = mesh.geometry.getAttribute('color');
    expect(colors).toBeDefined();
    expect(colors.count).toBe(mesh.geometry.getAttribute('position').count);
    // Two different colours really are both in there.
    const seen = new Set<string>();
    for (let i = 0; i < colors.count; i++) {
      seen.add(`${colors.getX(i).toFixed(2)},${colors.getY(i).toFixed(2)}`);
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('keeps an outline normal for the shell to expand along', () => {
    const batch = new PropBatch();
    batch.add('lonely', box(), at(0), 0xffffff);
    const mesh = batch.build().children.find(
      (c) => c.name.startsWith('prop-merged'),
    ) as THREE.Mesh;
    expect(mesh.geometry.getAttribute('outlineNormal')).toBeDefined();
  });
});
