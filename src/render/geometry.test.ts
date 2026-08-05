import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { chamferedBox, wedge, blob, addOutlineNormals } from './geometry.ts';
import { Rng } from '../core/rng.ts';

/**
 * For a convex mesh, every triangle's geometric normal must point away from the
 * mesh's own centroid. This catches inverted winding, which is otherwise
 * invisible until the material renders inside-out — and with an inverted-hull
 * outline it manifests as the object being drawn entirely in the outline color,
 * which looks like a shader bug rather than a geometry one.
 *
 * Measured from the mesh centroid rather than the origin: a wedge's sloped face
 * passes straight through the origin, so testing against it gives a dot product
 * of exactly zero and reports a correct triangle as inverted.
 */
function expectOutwardWinding(geometry: THREE.BufferGeometry, label: string): void {
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex();
  // Non-indexed geometry (three's polyhedra) lists vertices in draw order.
  const vertexAt = (i: number) => (index === null ? i : index.getX(i));
  const vertexCount = index === null ? position.count : index.count;

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const centroid = new THREE.Vector3();

  // The solid's own center of mass, approximated by the vertex average.
  const meshCenter = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    meshCenter.x += position.getX(i);
    meshCenter.y += position.getY(i);
    meshCenter.z += position.getZ(i);
  }
  meshCenter.divideScalar(position.count);

  let inverted = 0;
  const triangles = vertexCount / 3;

  for (let t = 0; t < triangles; t++) {
    a.fromBufferAttribute(position, vertexAt(t * 3));
    b.fromBufferAttribute(position, vertexAt(t * 3 + 1));
    c.fromBufferAttribute(position, vertexAt(t * 3 + 2));

    ab.subVectors(b, a);
    ac.subVectors(c, a);
    normal.crossVectors(ab, ac);
    if (normal.lengthSq() < 1e-16) continue; // degenerate, ignore

    centroid.copy(a).add(b).add(c).divideScalar(3).sub(meshCenter);
    if (normal.dot(centroid) <= 1e-12) inverted++;
  }

  expect(inverted, `${label}: ${inverted}/${triangles} triangles wound inward`).toBe(0);
}

describe('chamferedBox', () => {
  it('winds every triangle outward', () => {
    expectOutwardWinding(chamferedBox(1, 1, 1, 0.1), 'cube');
  });

  it('winds outward for plank proportions', () => {
    expectOutwardWinding(chamferedBox(2.0, 0.05, 0.25, 0.008), 'plank');
  });

  it('winds outward for post proportions', () => {
    expectOutwardWinding(chamferedBox(1.5, 0.1, 0.1, 0.012), 'post');
  });

  it('winds outward for a thin panel', () => {
    expectOutwardWinding(chamferedBox(1.0, 0.02, 1.0, 0.006), 'panel');
  });

  it('stays inside its nominal extents', () => {
    const g = chamferedBox(2, 0.5, 1, 0.05);
    g.computeBoundingBox();
    const bb = g.boundingBox!;
    expect(bb.min.x).toBeCloseTo(-1, 5);
    expect(bb.max.x).toBeCloseTo(1, 5);
    expect(bb.min.y).toBeCloseTo(-0.25, 5);
    expect(bb.max.y).toBeCloseTo(0.25, 5);
    expect(bb.min.z).toBeCloseTo(-0.5, 5);
    expect(bb.max.z).toBeCloseTo(0.5, 5);
  });

  it('clamps an oversized chamfer rather than inverting the geometry', () => {
    // 0.5 chamfer on a 0.02-thick panel would turn it inside out.
    const g = chamferedBox(1, 0.02, 1, 0.5);
    expectOutwardWinding(g, 'over-chamfered panel');
    g.computeBoundingBox();
    expect(g.boundingBox!.max.y).toBeCloseTo(0.01, 5);
  });

  it('exposes an outlineNormal attribute of unit vectors', () => {
    const g = chamferedBox(1, 0.5, 0.25, 0.02);
    const on = g.getAttribute('outlineNormal');
    expect(on).toBeDefined();
    expect(on.count).toBe(g.getAttribute('position').count);
    for (let i = 0; i < on.count; i++) {
      const len = Math.hypot(on.getX(i), on.getY(i), on.getZ(i));
      expect(len).toBeCloseTo(1, 5);
    }
  });

  it('gives coincident vertices the same outline normal, so the shell stays closed', () => {
    const g = chamferedBox(1, 1, 1, 0.1);
    const pos = g.getAttribute('position');
    const on = g.getAttribute('outlineNormal');
    const byPosition = new Map<string, [number, number, number]>();

    for (let i = 0; i < pos.count; i++) {
      const key = `${pos.getX(i).toFixed(5)},${pos.getY(i).toFixed(5)},${pos.getZ(i).toFixed(5)}`;
      const n: [number, number, number] = [on.getX(i), on.getY(i), on.getZ(i)];
      const seen = byPosition.get(key);
      if (seen === undefined) byPosition.set(key, n);
      else {
        // A shell expanded along differing normals at a shared vertex splits open.
        expect(n[0]).toBeCloseTo(seen[0], 5);
        expect(n[1]).toBeCloseTo(seen[1], 5);
        expect(n[2]).toBeCloseTo(seen[2], 5);
      }
    }
    // A chamfered cube has 24 distinct corner positions.
    expect(byPosition.size).toBe(24);
  });

  it('outline normals point outward', () => {
    const g = chamferedBox(1, 1, 1, 0.1);
    const pos = g.getAttribute('position');
    const on = g.getAttribute('outlineNormal');
    for (let i = 0; i < pos.count; i++) {
      const dot = pos.getX(i) * on.getX(i) + pos.getY(i) * on.getY(i) + pos.getZ(i) * on.getZ(i);
      expect(dot).toBeGreaterThan(0);
    }
  });
});

describe('wedge', () => {
  it('winds every triangle outward', () => {
    expectOutwardWinding(wedge(1, 0.5, 0.25), 'wedge');
  });

  it('spans its nominal extents', () => {
    const g = wedge(2, 0.6, 0.4);
    g.computeBoundingBox();
    expect(g.boundingBox!.min.x).toBeCloseTo(-1, 5);
    expect(g.boundingBox!.max.y).toBeCloseTo(0.3, 5);
  });
});

describe('blob', () => {
  it('winds every triangle outward', () => {
    const rng = new Rng('blob');
    expectOutwardWinding(blob(1, 1, 0.15, () => rng.next()), 'blob');
  });

  it('is deterministic for a given seed', () => {
    const a = blob(1, 1, 0.2, (() => { const r = new Rng(4); return () => r.next(); })());
    const b = blob(1, 1, 0.2, (() => { const r = new Rng(4); return () => r.next(); })());
    const pa = a.getAttribute('position');
    const pb = b.getAttribute('position');
    expect(pa.count).toBe(pb.count);
    for (let i = 0; i < pa.count; i++) expect(pa.getX(i)).toBe(pb.getX(i));
  });
});

describe('addOutlineNormals', () => {
  it('is a no-op on geometry with no normals', () => {
    const g = new THREE.BufferGeometry();
    expect(() => addOutlineNormals(g)).not.toThrow();
  });
});
