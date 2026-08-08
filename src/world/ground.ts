/**
 * The lawn.
 *
 * It was one 400-metre plane in one flat green, which is the largest surface in
 * every frame the game ever draws. Measured across five viewpoints, a single
 * colour covered between fifteen and forty-one per cent of the screen — the wide
 * shot of the lot was forty-one per cent one value. Nothing else in the scene
 * comes close to that, and no amount of work on props moves a number like it.
 *
 * ## Wear is where people go, not decoration
 *
 * The dirt patches are not scattered for texture. They are placed from the map's
 * own landmarks — the taps everybody runs to, the flag bases, the tree everybody
 * climbs, the gate everybody comes through — so the ground records the paths the
 * game actually creates. That has a second use beyond looking right: a player who
 * has never seen this map can read where the traffic goes before anything moves.
 *
 * ## Why vertex colours rather than a texture
 *
 * There are no image assets in this project and adding a pipeline for one lawn
 * would be the largest thing in the repository by weight. Vertex colours on a
 * subdivided plane cost one geometry, one draw call and no download, and they
 * survive the toon shader intact: the material stays white and the colour rides
 * on the vertices, so the three-band ramp still does the shading.
 *
 * The cost is resolution. A 0.9m lattice cannot draw a footpath's edge crisply,
 * so the wear is soft-edged on purpose — which is what a worn lawn looks like
 * anyway, and what a hard-edged decal would have got wrong. It is also why the
 * gate path, at 1.5m wide, barely registers: it is two vertices across, and
 * widening the lattice to draw it would cost vertices everywhere.
 *
 * ## The clumps are the part that works
 *
 * Tinting the ground is a smaller effect than it measures as. At eye level the
 * lawn is the bottom half of the screen and a plane there reads as a billiard
 * table however carefully it is shaded — what changed the picture was giving it
 * a surface. Which is also why the two failures worth knowing about are both in
 * the clumps rather than in the tone: three triangles round a shared apex is a
 * cone and drew as a field of small conifers, and tinting a blade like the lawn
 * makes it *darker* than the lawn, because a near-vertical face lands a band
 * lower on the toon ramp.
 */

import * as THREE from 'three';
import { Rng } from '../core/rng.ts';
import { createToonMaterial } from '../render/toonMaterial.ts';

/** Somewhere the grass gets walked off. */
export interface Wear {
  x: number;
  z: number;
  /** Where the bare patch fades out entirely. */
  radius: number;
  /** 0..1. How bare the middle gets. */
  strength?: number;
}

/**
 * How finely the lawn is divided.
 *
 * Set against the ground's extent to give a cell a little under a metre. Finer
 * draws a crisper path edge and costs vertices for a surface nobody looks at
 * closely; coarser starts to show the lattice as visible triangular banding on
 * open ground, which is worse than the flat colour it replaced.
 *
 * It is a count rather than a cell size because `PlaneGeometry` takes segments,
 * and it has to be raised whenever the extent is — which is a real hazard: the
 * ground grew from 58 metres to 108 to fit the cul-de-sac on it, and left alone
 * this number would have quietly doubled the cell size everywhere including
 * under the lot.
 */
const CELLS = 116;

/**
 * The lattice the grass tone is sampled from.
 *
 * Deliberately coarse and bilinear rather than per-vertex random: per-vertex
 * noise at this density reads as static, and what a lawn actually has is broad
 * patches of slightly different green a few metres across.
 */
const NOISE_CELLS = 22;

/** Where the average patch of lawn sits between the two grass tones. */
const TONE_CENTRE = 0.82;
/**
 * How far the tone drifts either side of that.
 *
 * Wide enough to run off both ends of the ramp, which is deliberate. The two
 * palette greens are a base colour and its own shadow — about a fifth of a ramp
 * apart — and a tone field that stays politely between them produces a lawn
 * that measures as varied and still looks like one flat colour. Overshooting
 * extrapolates the ramp instead: past the light end toward a sunlit yellow-green,
 * past the dark end toward a deeper one, neither of which clips.
 *
 * Bilinear noise also concentrates toward its middle, so the values actually
 * reached are a good deal narrower than the nominal range here.
 */
const TONE_RANGE = 0.62;

/**
 * A value-noise field, sampled bilinearly.
 *
 * Seeded, because two players must be standing on the same lawn and a seed is
 * the whole mechanism — the same reason `Math.random` is banned from world
 * state.
 */
function noiseField(rng: Rng, size: number): (u: number, v: number) => number {
  const grid: number[] = [];
  for (let i = 0; i < (size + 1) * (size + 1); i++) grid.push(rng.next());

  return (u: number, v: number): number => {
    const fx = Math.min(0.9999, Math.max(0, u)) * size;
    const fz = Math.min(0.9999, Math.max(0, v)) * size;
    const x0 = Math.floor(fx);
    const z0 = Math.floor(fz);
    const tx = fx - x0;
    const tz = fz - z0;
    // Smoothstep, so the patches have soft shoulders instead of visible
    // diamond seams where four lattice cells meet.
    const sx = tx * tx * (3 - 2 * tx);
    const sz = tz * tz * (3 - 2 * tz);
    const at = (x: number, z: number): number => grid[z * (size + 1) + x]!;
    const a = at(x0, z0) + (at(x0 + 1, z0) - at(x0, z0)) * sx;
    const b = at(x0, z0 + 1) + (at(x0 + 1, z0 + 1) - at(x0, z0 + 1)) * sx;
    return a + (b - a) * sz;
  };
}

/**
 * How far in from the lot's edge the detail fades out entirely.
 *
 * Without this the lawn is a mottled square sitting on a flat plane and the
 * join is plainly visible from anywhere high enough to see it — the detail
 * draws its own boundary and the lot reads as a rug thrown over the world.
 */
const EDGE_FADE = 7;

/** 0 at the lot's boundary, 1 once fully inside it. */
function insideness(x: number, z: number, half: number): number {
  const edge = Math.min(half - Math.abs(x), half - Math.abs(z));
  const k = Math.min(1, Math.max(0, edge / EDGE_FADE));
  return k * k * (3 - 2 * k);
}

/**
 * The colour the lawn averages out to.
 *
 * The plane that fills the horizon has to be painted this rather than the base
 * green, or the lot is a visibly different shade from everything around it and
 * the edge fade has nothing to fade into.
 */
export function averageLawnColor(grass: number, grassDark: number): THREE.Color {
  return new THREE.Color()
    .setHex(grassDark, THREE.SRGBColorSpace)
    .lerp(new THREE.Color().setHex(grass, THREE.SRGBColorSpace), TONE_CENTRE);
}

/**
 * Ground the grass does not grow through.
 *
 * A footprint rather than a solid: the question is only ever "is this square
 * metre paved", and the height of whatever is standing on it does not change
 * the answer.
 */
export interface Paved {
  x: number;
  z: number;
  halfW: number;
  halfD: number;
  /** Yaw, for the paving that is not square to the world. */
  ry?: number;
}

export interface GroundOptions {
  /** Side length of the detailed lawn, centred on the origin. */
  extent: number;
  grass: number;
  grassDark: number;
  dirt: number;
  wear: readonly Wear[];
  /**
   * Where the map already covers the ground: paving, decking, the pool, the
   * house's own floor.
   *
   * Without this the clumps are scattered across the whole lot and a good many
   * of them come up through the driveway, which is worse than the flat lawn
   * they replaced — a flat lawn is only dull, and grass growing out of concrete
   * is wrong in a way a player notices immediately.
   */
  paved?: readonly Paved[];
}

/** Is this point on ground the map has already covered? */
function isPaved(x: number, z: number, paved: readonly Paved[]): boolean {
  for (const p of paved) {
    let dx = x - p.x;
    let dz = z - p.z;
    if (p.ry !== undefined && p.ry !== 0) {
      const c = Math.cos(-p.ry);
      const s = Math.sin(-p.ry);
      [dx, dz] = [dx * c - dz * s, dx * s + dz * c];
    }
    if (Math.abs(dx) <= p.halfW && Math.abs(dz) <= p.halfD) return true;
  }
  return false;
}

/**
 * Build the lawn as one vertex-coloured mesh.
 *
 * Returns a mesh only — the caller places it and owns the far ground plane that
 * fills the horizon behind it.
 */
export function buildGround(rng: Rng, options: GroundOptions): THREE.Mesh {
  const { extent, wear } = options;
  const half = extent / 2;
  const geometry = new THREE.PlaneGeometry(extent, extent, CELLS, CELLS);
  geometry.rotateX(-Math.PI / 2);

  const position = geometry.getAttribute('position');
  const count = position.count;
  const colors = new Float32Array(count * 3);

  const tone = noiseField(rng, NOISE_CELLS);
  const light = new THREE.Color().setHex(options.grass, THREE.SRGBColorSpace);
  const dark = new THREE.Color().setHex(options.grassDark, THREE.SRGBColorSpace);
  const dirt = new THREE.Color().setHex(options.dirt, THREE.SRGBColorSpace);
  const scratch = new THREE.Color();

  for (let i = 0; i < count; i++) {
    const x = position.getX(i);
    const z = position.getZ(i);

    // Broad patches of slightly different green.
    const t = tone((x + half) / extent, (z + half) / extent);
    const inside = insideness(x, z, half);
    scratch.copy(dark).lerp(light, TONE_CENTRE + (t - 0.5) * 2 * TONE_RANGE * inside);

    // Then the bare ground where the game sends people.
    let bare = 0;
    for (const spot of wear) {
      const d = Math.hypot(x - spot.x, z - spot.z);
      if (d >= spot.radius) continue;
      // Smoothstep rather than a square. Squaring puts nearly all the dirt in
      // the middle tenth of the radius, so a four-metre patch drew as a small
      // dot with a wide faint halo — the radius said one thing and the picture
      // said another.
      const k = 1 - d / spot.radius;
      const falloff = k * k * (3 - 2 * k);
      bare = Math.max(bare, falloff * (spot.strength ?? 1));
    }
    if (bare > 0) scratch.lerp(dirt, Math.min(1, bare));

    colors[i * 3] = scratch.r;
    colors[i * 3 + 1] = scratch.g;
    colors[i * 3 + 2] = scratch.b;
  }

  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();

  // White, so the vertex colour is the colour. A tinted material would multiply
  // with it and darken the whole lawn.
  const material = createToonMaterial({ color: 0xffffff, vertexColors: true });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'lawn';
  mesh.receiveShadow = true;
  // A hair below zero so a part laid flat on the ground never z-fights it, and
  // above the far plane for the same reason.
  mesh.position.y = -0.004;
  return mesh;
}

/**
 * How tall a clump stands before per-instance scaling.
 *
 * An ankle-deep number here is wrong even though it is more visible: this is a
 * mown suburban lawn that kids run across, and grass drawn at a quarter of a
 * metre reads as an overgrown field — and as an obstacle, in a game where the
 * ground is where you place things.
 */
const BLADE_HEIGHT = 0.13;
/** How far a blade's tip leans out from the clump's base. */
const BLADE_LEAN = 0.06;
/** Half-width of a blade at the ground. */
const BLADE_WIDTH = 0.028;
/** Blades per clump. Each is its own spike, not a facet of a shared cone. */
const BLADES = 3;

/**
 * Clumps of grass standing up out of the lawn.
 *
 * The single most effective thing on this list, and the cheapest: at eye level
 * the lawn is the bottom half of the screen, and a flat plane there reads as a
 * billiard table however well it is tinted. A few thousand little angular blades
 * give it a surface, and they cost one instanced draw.
 *
 * They are skipped on the worn patches, which is most of what sells the wear —
 * bare ground next to grass that is visibly standing up says "walked on" far
 * better than a change of colour does.
 */
export function buildTufts(rng: Rng, options: GroundOptions & { count: number }): THREE.InstancedMesh {
  const { extent, wear, count } = options;
  const paved = options.paved ?? [];
  const half = extent / 2;

  // Three separate blades leaning out of a common base.
  //
  // The first attempt was three triangles round a shared apex, which is a
  // description of a cone — and that is exactly what it drew. Scattered across
  // the lawn they read as a few thousand little dark conifers rather than as
  // grass, and no amount of tinting fixes a silhouette. Giving each blade its
  // own tip, splayed outward, costs the same three triangles and reads as a
  // clump because it is one.
  const blade = new THREE.BufferGeometry();
  const verts: number[] = [];
  for (let i = 0; i < BLADES; i++) {
    const a = (i / BLADES) * Math.PI * 2;
    const ax = Math.cos(a);
    const az = Math.sin(a);
    // Blades in one clump are not the same length; a matched set reads as a
    // manufactured object.
    const h = BLADE_HEIGHT * (i === 0 ? 1 : i === 1 ? 0.76 : 0.9);
    verts.push(
      ax * 0.012 - az * BLADE_WIDTH, 0, az * 0.012 + ax * BLADE_WIDTH,
      ax * 0.012 + az * BLADE_WIDTH, 0, az * 0.012 - ax * BLADE_WIDTH,
      ax * BLADE_LEAN, h, az * BLADE_LEAN,
    );
  }
  blade.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  blade.computeVertexNormals();

  // Deliberately *not* vertexColors. An InstancedMesh tints through
  // `instanceColor`, which three wires up on its own; asking for vertexColors as
  // well defines USE_COLOR, and USE_COLOR without a geometry `color` attribute
  // reads an undeclared varying — every blade came out black, which at this size
  // looks like scattered litter rather than a shader bug.
  const material = createToonMaterial({ color: 0xffffff });
  material.side = THREE.DoubleSide;
  const mesh = new THREE.InstancedMesh(blade, material, count);
  mesh.name = 'tufts';
  mesh.castShadow = false;
  mesh.receiveShadow = false;

  const light = new THREE.Color().setHex(options.grass, THREE.SRGBColorSpace);
  const dark = new THREE.Color().setHex(options.grassDark, THREE.SRGBColorSpace);
  const tint = new THREE.Color();
  const matrix = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  let placed = 0;
  // Bounded tries, because rejecting on wear can in principle never terminate.
  for (let tries = 0; tries < count * 6 && placed < count; tries++) {
    const x = (rng.next() - 0.5) * extent;
    const z = (rng.next() - 0.5) * extent;

    if (isPaved(x, z, paved)) continue;

    let bare = 0;
    for (const spot of wear) {
      const d = Math.hypot(x - spot.x, z - spot.z);
      if (d < spot.radius) bare = Math.max(bare, 1 - d / spot.radius);
    }
    // Thins out toward a worn patch rather than stopping at its rim, so the
    // edge of a path is a gradient of thinning grass instead of a hard line.
    if (rng.next() < bare * 1.35) continue;
    // And thins out at the lot's boundary for the same reason the tone does:
    // otherwise the clumps stop dead in a straight line and draw the edge of
    // the detailed square just as clearly as a colour change would.
    if (rng.next() > insideness(x, z, half)) continue;

    pos.set(x, -0.004, z);
    quat.setFromAxisAngle(up, rng.next() * Math.PI * 2);
    const h = 0.6 + rng.next() * 0.55;
    scale.set(0.85 + rng.next() * 0.4, h, 0.85 + rng.next() * 0.4);
    matrix.compose(pos, quat, scale);
    mesh.setMatrixAt(placed, matrix);
    // Brighter than the lawn, overshooting the light end of the ramp.
    //
    // These were tinted between the two grass tones, which is the reasonable
    // guess and is wrong: a near-vertical face lands a band lower on the toon
    // ramp than the flat ground beside it, so a blade tinted like the lawn
    // draws darker than the lawn and reads as debris. Grass standing up is the
    // part that catches the sun, and it has to be tinted as if it does.
    tint.copy(dark).lerp(light, 1.3 + rng.next() * 0.35);
    mesh.setColorAt(placed, tint);
    placed++;
  }
  // Anything unplaced would otherwise draw at the origin as a spike of grass
  // through the middle of the lot.
  mesh.count = placed;
  return mesh;
}
