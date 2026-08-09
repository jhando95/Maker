import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { Rng } from '../core/rng.ts';
import { buildGround, buildTufts, type GroundOptions } from './ground.ts';
import {
  wearPoints, WATER_SOURCES, LEFT_FLAG, RIGHT_FLAG, TREEHOUSE,
} from './neighborhood.ts';

const GRASS = 0x7fb84a;
const GRASS_DARK = 0x63963a;
const DIRT = 0x8a6b45;

const lot = (over: Partial<GroundOptions> = {}): GroundOptions => ({
  extent: 58,
  grass: GRASS,
  grassDark: GRASS_DARK,
  dirt: DIRT,
  wear: wearPoints(),
  ...over,
});

/** The colour written at vertex `i`, as a THREE.Color. */
function vertexColor(mesh: THREE.Mesh, i: number): THREE.Color {
  const c = mesh.geometry.getAttribute('color');
  return new THREE.Color(c.getX(i), c.getY(i), c.getZ(i));
}

/** The vertex nearest a point on the ground. */
function nearestVertex(mesh: THREE.Mesh, x: number, z: number): number {
  const p = mesh.geometry.getAttribute('position');
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < p.count; i++) {
    const d = Math.hypot(p.getX(i) - x, p.getZ(i) - z);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/** How close a colour is to dirt rather than grass. 0 = grass, 1 = dirt. */
function dirtiness(c: THREE.Color): number {
  const grass = new THREE.Color().setHex(GRASS, THREE.SRGBColorSpace);
  const dirt = new THREE.Color().setHex(DIRT, THREE.SRGBColorSpace);
  const toDirt = Math.hypot(c.r - dirt.r, c.g - dirt.g, c.b - dirt.b);
  const toGrass = Math.hypot(c.r - grass.r, c.g - grass.g, c.b - grass.b);
  return toGrass / (toGrass + toDirt);
}

describe('the lawn', () => {
  it('is the same lawn on every machine', () => {
    // Two people have to be standing on the same ground, and none of it is
    // sent — the seed is the whole mechanism, the same reason `Math.random` is
    // banned from world state.
    const a = buildGround(new Rng('lot'), lot());
    const b = buildGround(new Rng('lot'), lot());
    const ca = a.geometry.getAttribute('color').array;
    const cb = b.geometry.getAttribute('color').array;
    expect(Array.from(ca)).toEqual(Array.from(cb));
  });

  it('is a different lawn under a different seed', () => {
    // Otherwise the seed is decoration and the determinism test above is
    // passing on a constant.
    const a = buildGround(new Rng('lot'), lot());
    const b = buildGround(new Rng('other'), lot());
    const ca = a.geometry.getAttribute('color').array;
    const cb = b.geometry.getAttribute('color').array;
    expect(Array.from(ca)).not.toEqual(Array.from(cb));
  });

  it('covers the lot it was asked for', () => {
    const mesh = buildGround(new Rng('lot'), lot({ extent: 40 }));
    mesh.geometry.computeBoundingBox();
    const box = mesh.geometry.boundingBox!;
    expect(box.min.x).toBeCloseTo(-20, 5);
    expect(box.max.x).toBeCloseTo(20, 5);
    expect(box.min.z).toBeCloseTo(-20, 5);
    expect(box.max.z).toBeCloseTo(20, 5);
  });

  it('sits above the plane that fills the horizon and below anything placed on it', () => {
    // Both directions matter and both are z-fighting: coplanar with the far
    // plane and the whole lot flickers; above y=0 and every part laid flat on
    // the ground shimmers.
    const mesh = buildGround(new Rng('lot'), lot());
    expect(mesh.position.y).toBeLessThan(0);
    expect(mesh.position.y).toBeGreaterThan(-0.02);
  });

  it('keeps the material white so the toon ramp still shades it', () => {
    // A tinted material multiplies with the vertex colour and darkens the
    // whole lawn; the colour has to ride entirely on the vertices.
    const mesh = buildGround(new Rng('lot'), lot());
    const material = mesh.material as THREE.MeshToonMaterial;
    expect(material.color.getHex()).toBe(0xffffff);
    expect(material.vertexColors).toBe(true);
  });

  it('wears bare where the game sends people', () => {
    const mesh = buildGround(new Rng('lot'), lot({
      wear: [{ x: 6, z: -4, radius: 5, strength: 1 }],
    }));
    const middle = dirtiness(vertexColor(mesh, nearestVertex(mesh, 6, -4)));
    const outside = dirtiness(vertexColor(mesh, nearestVertex(mesh, 6, -14)));
    expect(middle).toBeGreaterThan(0.8);
    expect(outside).toBeLessThan(0.2);
  });

  it('fades a patch out across its radius rather than in its middle tenth', () => {
    // The first falloff was `k * k`, which puts nearly all the dirt in the
    // centre: a five-metre patch drew as a dot with a faint halo, so the
    // radius said one thing and the picture said another.
    const mesh = buildGround(new Rng('lot'), lot({
      wear: [{ x: 0, z: 0, radius: 8, strength: 1 }],
    }));
    const half = dirtiness(vertexColor(mesh, nearestVertex(mesh, 4, 0)));
    expect(half).toBeGreaterThan(0.35);
    expect(half).toBeLessThan(0.75);
  });

  it('leaves the lawn green where nothing walks', () => {
    const mesh = buildGround(new Rng('lot'), lot());
    const colors = mesh.geometry.getAttribute('color');
    let bare = 0;
    for (let i = 0; i < colors.count; i++) {
      if (dirtiness(vertexColor(mesh, i)) > 0.5) bare++;
    }
    // Wear is where people go, not a texture. If most of the lot is dirt the
    // patches have stopped meaning anything.
    expect(bare / colors.count).toBeLessThan(0.2);
  });

  it('varies the green rather than painting one flat colour', () => {
    // The measurement that started this work: one colour covered between
    // fifteen and forty-one per cent of every frame.
    //
    // Measured as a percentile spread rather than a count of distinct values,
    // because a count answers the wrong question. Keeping the tone politely
    // between the two palette greens gave hundreds of distinct values spanning
    // almost nothing, and it drew as one flat colour — which is the failure
    // this test exists to catch.
    const mesh = buildGround(new Rng('lot'), lot({ wear: [] }));
    const colors = mesh.geometry.getAttribute('color');
    const luma: number[] = [];
    for (let i = 0; i < colors.count; i++) {
      const c = vertexColor(mesh, i);
      luma.push(0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b);
    }
    luma.sort((a, b) => a - b);
    const at = (p: number): number => luma[Math.floor(p * (luma.length - 1))]!;
    // Percentiles rather than min and max, so one extreme vertex cannot pass it.
    expect((at(0.9) - at(0.1)) / at(0.5)).toBeGreaterThan(0.22);
  });
});

describe('where the grass is walked off', () => {
  it('puts a patch at every tap, both flags and the tree', () => {
    // Derived from the map's own constants rather than hand-placed, so moving
    // an objective moves the wear with it instead of leaving the ground
    // quietly lying about where the traffic goes.
    const spots = wearPoints();
    const covered = (x: number, z: number): boolean =>
      spots.some((s) => Math.hypot(s.x - x, s.z - z) < s.radius * 0.5);
    for (const source of WATER_SOURCES) expect(covered(source.x, source.z)).toBe(true);
    expect(covered(LEFT_FLAG.x, LEFT_FLAG.z)).toBe(true);
    expect(covered(RIGHT_FLAG.x, RIGHT_FLAG.z)).toBe(true);
    expect(covered(TREEHOUSE.x, TREEHOUSE.z)).toBe(true);
  });

  it('wears the route from the gate to the door, not just its ends', () => {
    // A path is a line and the lattice only knows about circles, so it is laid
    // as overlapping steps. The failure this guards is the obvious cheap
    // version: two circles with clean grass between them.
    const spots = wearPoints();
    const onPath = spots.filter((s) => Math.abs(s.x) < 0.01 && s.z > 7 && s.z < 18);
    expect(onPath.length).toBeGreaterThan(6);
    const gaps = onPath
      .map((s) => s.z)
      .sort((a, b) => a - b)
      .map((z, i, all) => (i === 0 ? 0 : z - all[i - 1]!));
    // Every step within one radius of the last, or the path is dotted.
    expect(Math.max(...gaps)).toBeLessThan(1.6);
  });
});

describe('the grass clumps', () => {
  it('are the same clumps on every machine', () => {
    const read = (mesh: THREE.InstancedMesh): number[] => Array.from(mesh.instanceMatrix.array);
    const a = buildTufts(new Rng('lot'), { ...lot(), count: 400 });
    const b = buildTufts(new Rng('lot'), { ...lot(), count: 400 });
    expect(a.count).toBe(b.count);
    expect(read(a)).toEqual(read(b));
  });

  it('never leaves an unplaced instance drawn at the origin', () => {
    // An InstancedMesh draws `count` instances whether or not they were given a
    // matrix, and an unwritten matrix is the identity — a spike of grass
    // through the middle of the lot.
    const mesh = buildTufts(new Rng('lot'), {
      ...lot(),
      // Wear over the whole lot, so rejection is near-certain and the buffer
      // cannot be filled.
      wear: [{ x: 0, z: 0, radius: 200, strength: 1 }],
      count: 500,
    });
    expect(mesh.count).toBeLessThan(500);
    const matrix = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, matrix);
      pos.setFromMatrixPosition(matrix);
      expect(Math.hypot(pos.x, pos.z)).toBeGreaterThan(0);
    }
  });

  it('thins out where the ground is worn', () => {
    const mesh = buildTufts(new Rng('lot'), {
      ...lot(),
      extent: 40,
      wear: [{ x: 10, z: 0, radius: 6, strength: 1 }],
      count: 4000,
    });
    const matrix = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    let onWorn = 0;
    let onClean = 0;
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, matrix);
      pos.setFromMatrixPosition(matrix);
      if (Math.hypot(pos.x - 10, pos.z) < 3) onWorn++;
      // The mirror image of the patch, so the two areas are equal.
      if (Math.hypot(pos.x + 10, pos.z) < 3) onClean++;
    }
    expect(onClean).toBeGreaterThan(0);
    expect(onWorn).toBeLessThan(onClean * 0.35);
  });

  it('stands ankle-high at most, because this is a mown lawn', () => {
    // Taller is more visible and is the wrong answer twice: it reads as an
    // overgrown field, and the ground is where you place things.
    const mesh = buildTufts(new Rng('lot'), { ...lot(), count: 600 });
    mesh.geometry.computeBoundingBox();
    const blade = mesh.geometry.boundingBox!.max.y;
    const matrix = new THREE.Matrix4();
    const scale = new THREE.Vector3();
    let tallest = 0;
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, matrix);
      matrix.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale);
      tallest = Math.max(tallest, blade * scale.y);
    }
    expect(tallest).toBeGreaterThan(0.05);
    expect(tallest).toBeLessThan(0.2);
  });

  it('tints brighter than the lawn it stands in', () => {
    // Tinted between the two grass tones — the reasonable guess — a blade
    // draws darker than the ground beside it, because a near-vertical face
    // lands a band lower on the toon ramp. It then reads as debris rather than
    // as grass.
    const mesh = buildTufts(new Rng('lot'), { ...lot(), count: 300 });
    const light = new THREE.Color().setHex(GRASS, THREE.SRGBColorSpace);
    const tint = new THREE.Color();
    const luma = (c: THREE.Color): number => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    for (let i = 0; i < mesh.count; i++) {
      mesh.getColorAt(i, tint);
      expect(luma(tint)).toBeGreaterThan(luma(light));
    }
  });

  it('gives each blade in a clump its own tip', () => {
    // Three triangles around one shared apex is a description of a cone, and
    // that is what it drew: a lawn covered in small dark conifers. No tint
    // fixes a silhouette.
    const mesh = buildTufts(new Rng('lot'), { ...lot(), count: 1 });
    const p = mesh.geometry.getAttribute('position');
    const tips = new Set<string>();
    for (let i = 0; i < p.count; i++) {
      if (p.getY(i) > 0.001) tips.add(`${p.getX(i).toFixed(4)},${p.getZ(i).toFixed(4)}`);
    }
    expect(tips.size).toBe(p.count / 3);
  });

  it('does not grow through paving', () => {
    const mesh = buildTufts(new Rng('lot'), {
      ...lot(),
      extent: 40,
      wear: [],
      paved: [{ x: 4, z: -3, halfW: 6, halfD: 2.5 }],
      count: 3000,
    });
    const matrix = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, matrix);
      pos.setFromMatrixPosition(matrix);
      const inside = Math.abs(pos.x - 4) <= 6 && Math.abs(pos.z + 3) <= 2.5;
      expect(inside).toBe(false);
    }
  });

  it('does not grow through paving that is not square to the world', () => {
    // The map has plenty of it, and testing only the axis-aligned case would
    // pass with the rotation ignored entirely.
    const ry = Math.PI / 5;
    const mesh = buildTufts(new Rng('lot'), {
      ...lot(),
      extent: 40,
      wear: [],
      paved: [{ x: 0, z: 0, halfW: 8, halfD: 2, ry }],
      count: 3000,
    });
    const matrix = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const c = Math.cos(-ry);
    const s = Math.sin(-ry);
    let nearby = 0;
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, matrix);
      pos.setFromMatrixPosition(matrix);
      const dx = pos.x * c - pos.z * s;
      const dz = pos.x * s + pos.z * c;
      expect(Math.abs(dx) <= 8 && Math.abs(dz) <= 2).toBe(false);
      if (Math.abs(dx) <= 10 && Math.abs(dz) <= 4) nearby++;
    }
    // And grass immediately beside it, or the rotation could be "reject
    // everything" and still pass the assertion above.
    expect(nearby).toBeGreaterThan(0);
  });

  it('does not ask an InstancedMesh for vertex colours it has no attribute for', () => {
    // `vertexColors` defines USE_COLOR, and USE_COLOR with no geometry `color`
    // attribute renders every instance black. Per-instance tinting comes from
    // `instanceColor`, which three wires up on its own.
    const mesh = buildTufts(new Rng('lot'), { ...lot(), count: 50 });
    const material = mesh.material as THREE.MeshToonMaterial;
    expect(material.vertexColors).toBe(false);
    expect(mesh.geometry.getAttribute('color')).toBeUndefined();
    expect(mesh.instanceColor).not.toBeNull();
  });
});
