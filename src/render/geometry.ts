/**
 * Procedural geometry.
 *
 * There are no model assets and no artist, so every shape in the game is built
 * here. The thing that keeps that from looking like programmer art is the
 * chamfer: a visible bevel on every edge catches the light differently from the
 * faces around it, which gives a plain box a drawn, hand-made silhouette. Two or
 * three pixels of it at play distance is the whole trick.
 */

import * as THREE from 'three';

/**
 * Average normals across vertices that share a position, and store the result as
 * an `outlineNormal` attribute.
 *
 * Inverted-hull outlines expand geometry along a normal. A chamfered box has
 * split vertices at every edge — that is what makes the facets crisp — so
 * expanding along the shading normal pulls the corners apart and tears visible
 * holes in the outline. Averaging first gives every corner one agreed direction
 * to move in, and the shell stays closed.
 */
export function addOutlineNormals(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  if (position === undefined || normal === undefined) return geometry;

  const count = position.count;
  const accum = new Map<string, [number, number, number]>();
  // Quantize before keying: vertices meant to coincide can differ in the last
  // bits after the generator's own arithmetic.
  const key = (i: number) =>
    `${position.getX(i).toFixed(5)},${position.getY(i).toFixed(5)},${position.getZ(i).toFixed(5)}`;

  for (let i = 0; i < count; i++) {
    const k = key(i);
    const entry = accum.get(k);
    if (entry === undefined) {
      accum.set(k, [normal.getX(i), normal.getY(i), normal.getZ(i)]);
    } else {
      entry[0] += normal.getX(i);
      entry[1] += normal.getY(i);
      entry[2] += normal.getZ(i);
    }
  }

  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const entry = accum.get(key(i))!;
    const len = Math.hypot(entry[0], entry[1], entry[2]) || 1;
    out[i * 3] = entry[0] / len;
    out[i * 3 + 1] = entry[1] / len;
    out[i * 3 + 2] = entry[2] / len;
  }

  geometry.setAttribute('outlineNormal', new THREE.BufferAttribute(out, 3));
  return geometry;
}

/**
 * A box with bevelled edges, centered on the origin.
 *
 * Built as an inset core box whose vertices are pushed out to the full extents
 * along each axis independently, which produces flat faces joined by flat
 * chamfer strips — sharp facets rather than the rounded fillet a subdivided
 * approach would give. Flat shading then reads every facet as its own tone.
 */
export function chamferedBox(
  width: number,
  height: number,
  depth: number,
  chamfer: number,
): THREE.BufferGeometry {
  const hx = width / 2;
  const hy = height / 2;
  const hz = depth / 2;
  // A chamfer wider than half the thinnest axis would invert the geometry;
  // thin panels legitimately hit this.
  const c = Math.min(chamfer, hx * 0.6, hy * 0.6, hz * 0.6);

  const positions: number[] = [];
  const indices: number[] = [];

  // The 24 corner vertices of a chamfered box: for each of the 8 octants, three
  // points, each pulled to the full extent on one axis and inset on the others.
  const corners: number[] = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        // full-x, full-y, full-z variants of this octant corner
        corners.push(
          sx * hx, sy * (hy - c), sz * (hz - c),
          sx * (hx - c), sy * hy, sz * (hz - c),
          sx * (hx - c), sy * (hy - c), sz * hz,
        );
      }
    }
  }

  /** Octant index for a sign triple. */
  const oct = (sx: number, sy: number, sz: number) =>
    ((sx > 0 ? 1 : 0) << 2) | ((sy > 0 ? 1 : 0) << 1) | (sz > 0 ? 1 : 0);
  /** Vertex index: octant, then which axis is at full extent (0=x,1=y,2=z). */
  const vi = (sx: number, sy: number, sz: number, axis: number) => oct(sx, sy, sz) * 3 + axis;

  const vert = (i: number): [number, number, number] => [
    corners[i * 3]!, corners[i * 3 + 1]!, corners[i * 3 + 2]!,
  ];

  // Emit a quad as two triangles with a shared flat normal, splitting vertices
  // so each facet keeps its own crisp normal.
  const quad = (a: number, b: number, c2: number, d: number): void => {
    const va = vert(a), vb = vert(b), vc = vert(c2), vd = vert(d);
    const base = positions.length / 3;
    for (const v of [va, vb, vc, vd]) positions.push(v[0], v[1], v[2]);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };

  const tri = (a: number, b: number, c2: number): void => {
    const va = vert(a), vb = vert(b), vc = vert(c2);
    const base = positions.length / 3;
    for (const v of [va, vb, vc]) positions.push(v[0], v[1], v[2]);
    indices.push(base, base + 1, base + 2);
  };

  // Six main faces, each the inset rectangle on that axis. The vertex order
  // below traces each ring clockwise as seen from outside, so the positive-side
  // face needs reversing to wind counter-clockwise and face outward.
  // +X / -X
  for (const sx of [1, -1]) {
    const a = vi(sx, -1, -1, 0);
    const b = vi(sx, -1, 1, 0);
    const c2 = vi(sx, 1, 1, 0);
    const d = vi(sx, 1, -1, 0);
    if (sx > 0) quad(d, c2, b, a);
    else quad(a, b, c2, d);
  }
  // +Y / -Y
  for (const sy of [1, -1]) {
    const a = vi(-1, sy, -1, 1);
    const b = vi(1, sy, -1, 1);
    const c2 = vi(1, sy, 1, 1);
    const d = vi(-1, sy, 1, 1);
    if (sy > 0) quad(d, c2, b, a);
    else quad(a, b, c2, d);
  }
  // +Z / -Z
  for (const sz of [1, -1]) {
    const a = vi(-1, -1, sz, 2);
    const b = vi(-1, 1, sz, 2);
    const c2 = vi(1, 1, sz, 2);
    const d = vi(1, -1, sz, 2);
    if (sz > 0) quad(d, c2, b, a);
    else quad(a, b, c2, d);
  }

  // Twelve edge chamfer strips. Each joins the two faces meeting at that edge.
  // Edges along Z (varying sx, sy).
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const a = vi(sx, sy, -1, 0);
      const b = vi(sx, sy, -1, 1);
      const c2 = vi(sx, sy, 1, 1);
      const d = vi(sx, sy, 1, 0);
      if (sx * sy > 0) quad(a, b, c2, d);
      else quad(d, c2, b, a);
    }
  }
  // Edges along Y (varying sx, sz).
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const a = vi(sx, -1, sz, 0);
      const b = vi(sx, -1, sz, 2);
      const c2 = vi(sx, 1, sz, 2);
      const d = vi(sx, 1, sz, 0);
      if (sx * sz > 0) quad(d, c2, b, a);
      else quad(a, b, c2, d);
    }
  }
  // Edges along X (varying sy, sz).
  for (const sy of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const a = vi(-1, sy, sz, 1);
      const b = vi(-1, sy, sz, 2);
      const c2 = vi(1, sy, sz, 2);
      const d = vi(1, sy, sz, 1);
      if (sy * sz > 0) quad(a, b, c2, d);
      else quad(d, c2, b, a);
    }
  }

  // Eight corner triangles closing the gaps where three chamfers meet.
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const a = vi(sx, sy, sz, 0);
        const b = vi(sx, sy, sz, 1);
        const c2 = vi(sx, sy, sz, 2);
        if (sx * sy * sz > 0) tri(a, b, c2);
        else tri(c2, b, a);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return addOutlineNormals(geometry);
}

/**
 * A wedge: full height at -X, tapering to nothing at +X. Used for ramps.
 *
 * Kept as a plain prism rather than a chamfered one — the sloped face is the
 * feature, and bevelling its thin leading edge just makes it look chewed.
 */
export function wedge(width: number, height: number, depth: number): THREE.BufferGeometry {
  const hx = width / 2;
  const hy = height / 2;
  const hz = depth / 2;

  // Six corners: the tall end is a rectangle, the thin end is an edge.
  const p = [
    [-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, -hz], [-hx, hy, hz],
    [hx, -hy, -hz], [hx, -hy, hz],
  ] as const;

  const positions: number[] = [];
  const indices: number[] = [];
  const tri = (a: number, b: number, c: number): void => {
    const base = positions.length / 3;
    for (const i of [a, b, c]) positions.push(p[i]![0], p[i]![1], p[i]![2]);
    indices.push(base, base + 1, base + 2);
  };

  tri(3, 2, 0); tri(1, 3, 0);   // tall end (-X)
  tri(5, 1, 0); tri(4, 5, 0);   // bottom
  tri(5, 4, 2); tri(3, 5, 2);   // sloped top
  tri(2, 4, 0);                 // -Z side
  tri(5, 3, 1);                 // +Z side

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return addOutlineNormals(geometry);
}

/**
 * A low-poly blob, for foliage and rounded props.
 *
 * Deliberately coarse and irregular: perfectly regular spheres read as CAD, and
 * a little seeded lumpiness reads as drawn.
 */
export function blob(
  radius: number,
  detail: number,
  lumpiness: number,
  random: () => number,
): THREE.BufferGeometry {
  const geometry = new THREE.IcosahedronGeometry(radius, detail);
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;

  // Displace by position so vertices sharing a location move together and the
  // surface stays closed.
  const seen = new Map<string, number>();
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const key = `${x.toFixed(4)},${y.toFixed(4)},${z.toFixed(4)}`;
    let scale = seen.get(key);
    if (scale === undefined) {
      scale = 1 + (random() - 0.5) * 2 * lumpiness;
      seen.set(key, scale);
    }
    position.setXYZ(i, x * scale, y * scale, z * scale);
  }

  position.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return addOutlineNormals(geometry);
}
