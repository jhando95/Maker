/**
 * The backyard: lighting, sky, ground, and the standing scenery.
 *
 * Everything here is generated in code from a seed — there are no model assets.
 * Seeding rather than Math.random matters beyond reproducibility: when there are
 * two players, both must be standing in the same yard, and a seed is the whole
 * mechanism.
 */

import * as THREE from 'three';
import { Rng } from '../core/rng.ts';
import { createToonMaterial } from '../render/toonMaterial.ts';
import { chamferedBox, blob, addOutlineNormals } from '../render/geometry.ts';
import { PropBatch } from '../render/propBatch.ts';

/**
 * Palette.
 *
 * Saturated and warm, pitched at a bright summer afternoon. The fog color must
 * equal the sky's horizon exactly or a seam appears where they meet.
 */
export const PALETTE = {
  skyTop: 0x5bb8e8,
  skyHorizon: 0xdcf1fb,
  fog: 0xdcf1fb,
  grass: 0x7fb84a,
  grassDark: 0x63963a,
  dirt: 0xa87a4e,
  fence: 0xc8a878,
  fencePost: 0xa88a5c,
  houseWall: 0xf0e0c8,
  houseTrim: 0xd8564f,
  roof: 0x6a5548,
  trunk: 0x8a6242,
  foliage: 0x4f9a3a,
  foliageDark: 0x3d7a2c,
  poolWater: 0x4fc3e8,
  poolRim: 0xf0a030,
  sand: 0xe8d4a0,
} as const;

export const SUN_DIRECTION = new THREE.Vector3(28, 34, 18).normalize();

export interface SceneBuild {
  scene: THREE.Scene;
  sun: THREE.DirectionalLight;
  /** Scenery batch, so the viewport-dependent outline width can be updated. */
  props: PropBatch;
  /** Call after placing or removing parts so the static shadow map refreshes. */
  invalidateShadows(): void;
}

/**
 * Shared geometry, keyed by shape.
 *
 * Instancing only pays off if every instance of a shape references the *same*
 * BufferGeometry object. Building a fresh chamfered box per fence picket looks
 * identical and batches into nothing, so all scenery geometry goes through here.
 */
class GeometryCache {
  private readonly cache = new Map<string, THREE.BufferGeometry>();

  box(w: number, h: number, d: number, chamfer: number): { key: string; geometry: THREE.BufferGeometry } {
    const key = `box:${w.toFixed(4)}:${h.toFixed(4)}:${d.toFixed(4)}:${chamfer.toFixed(4)}`;
    let geometry = this.cache.get(key);
    if (geometry === undefined) {
      geometry = chamferedBox(w, h, d, chamfer);
      this.cache.set(key, geometry);
    }
    return { key, geometry };
  }

  raw(key: string, make: () => THREE.BufferGeometry): { key: string; geometry: THREE.BufferGeometry } {
    let geometry = this.cache.get(key);
    if (geometry === undefined) {
      geometry = make();
      this.cache.set(key, geometry);
    }
    return { key, geometry };
  }
}

/** Yard half-extent in meters. */
export const YARD_HALF = 24;

export function createScene(seed: string | number = 'backyard-01'): SceneBuild {
  const rng = new Rng(seed);
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(PALETTE.fog, 45, 190);

  addSky(scene);
  addLights(scene);
  const sun = scene.getObjectByName('sun') as THREE.DirectionalLight;

  addGround(scene);

  // All repeated scenery goes into one batch. Built as individual meshes the
  // fence alone was several hundred draw calls before any player-built part.
  const cache = new GeometryCache();
  const props = new PropBatch('scenery');
  addFence(props, cache, rng.fork());
  addHouse(props, cache);
  addTrees(scene, props, cache, rng.fork());
  addYardProps(scene, props, cache, rng.fork());
  scene.add(props.build());

  return {
    scene,
    sun,
    props,
    invalidateShadows() {
      sun.shadow.needsUpdate = true;
    },
  };
}

const _pos = new THREE.Vector3();
const _rot = new THREE.Euler();

/** Queue one chamfered box into the scenery batch. */
function box(
  props: PropBatch,
  cache: GeometryCache,
  w: number, h: number, d: number,
  x: number, y: number, z: number,
  color: number,
  opts: { rx?: number; ry?: number; rz?: number; chamfer?: number; outline?: number } = {},
): void {
  const { key, geometry } = cache.box(w, h, d, opts.chamfer ?? 0.012);
  _pos.set(x, y, z);
  _rot.set(opts.rx ?? 0, opts.ry ?? 0, opts.rz ?? 0);
  props.addAt(key, geometry, _pos, _rot, color, { outlineColor: opts.outline ?? 0x3a2c2a });
}

/**
 * Sky as a vertical gradient on a large inverted sphere.
 *
 * Cheaper and more controllable than three's physical Sky, and it lets the
 * horizon color be pinned to the fog color exactly.
 */
function addSky(scene: THREE.Scene): void {
  const geometry = new THREE.SphereGeometry(400, 24, 16);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      topColor: { value: new THREE.Color(PALETTE.skyTop) },
      horizonColor: { value: new THREE.Color(PALETTE.skyHorizon) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorldPosition;
      void main() {
        vec4 worldPosition = modelMatrix * vec4( position, 1.0 );
        vWorldPosition = worldPosition.xyz;
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 topColor;
      uniform vec3 horizonColor;
      varying vec3 vWorldPosition;
      void main() {
        float h = normalize( vWorldPosition ).y;
        // Biased toward the horizon so most of the visible sky is the lighter
        // tone, which keeps the scene feeling open rather than heavy.
        float t = smoothstep( 0.0, 0.55, h );
        gl_FragColor = vec4( mix( horizonColor, topColor, t ), 1.0 );
        // Three's own materials end with this; a custom shader that writes
        // gl_FragColor directly skips the linear-to-sRGB conversion and comes
        // out visibly darker than everything around it.
        #include <colorspace_fragment>
      }
    `,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const sky = new THREE.Mesh(geometry, material);
  sky.name = 'sky';
  sky.frustumCulled = false;
  scene.add(sky);
}

function addLights(scene: THREE.Scene): void {
  const sun = new THREE.DirectionalLight(0xfff4d6, 2.6);
  sun.name = 'sun';
  sun.position.copy(SUN_DIRECTION).multiplyScalar(60);
  sun.target.position.set(0, 0, 0);
  sun.castShadow = true;

  sun.shadow.mapSize.set(2048, 2048);
  const cam = sun.shadow.camera;
  cam.left = -26;
  cam.right = 26;
  cam.top = 26;
  cam.bottom = -26;
  cam.near = 0.5;
  cam.far = 160;
  cam.updateProjectionMatrix();

  // Boards are thin. normalBias must stay below half the thinnest part or the
  // offset pushes the sample straight through the board and the shadow vanishes;
  // at 0.05m lumber, 0.012 leaves 0.013 of slack on each side.
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.012;
  sun.shadow.radius = 1.4;
  sun.shadow.intensity = 0.72;
  // The world is static between build actions, so re-rendering the shadow map
  // every frame is pure waste — and re-rendering it only on change also removes
  // the shimmer that a moving frustum causes.
  sun.shadow.autoUpdate = false;
  sun.shadow.needsUpdate = true;

  scene.add(sun);
  scene.add(sun.target);

  // The green ground bounce is the single highest-value light here: it tints
  // every downward-facing surface with grass, and the scene immediately reads
  // as outdoors on a lawn rather than in a void.
  scene.add(new THREE.HemisphereLight(0xbfe6ff, 0x7fa84a, 0.5));
}

function addGround(scene: THREE.Scene): void {
  const geometry = new THREE.PlaneGeometry(400, 400, 1, 1);
  geometry.rotateX(-Math.PI / 2);
  const material = createToonMaterial({ color: PALETTE.grass });
  const ground = new THREE.Mesh(geometry, material);
  ground.name = 'ground';
  ground.receiveShadow = true;
  // Sits a hair below y=0 so it never z-fights with a part placed flat on it.
  ground.position.y = -0.005;
  scene.add(ground);

  // A worn dirt patch, to break up the flat green.
  const patch = new THREE.Mesh(
    new THREE.CircleGeometry(3.2, 20).rotateX(-Math.PI / 2),
    createToonMaterial({ color: PALETTE.dirt }),
  );
  patch.position.set(-6, 0.002, 4);
  patch.receiveShadow = true;
  scene.add(patch);
}

/** Shared helper: a chamfered box mesh with an outline shell. */

function addFence(props: PropBatch, cache: GeometryCache, rng: Rng): void {
  const picketHeight = 1.6;
  const spacing = 0.28;

  // Three sides; the fourth is the house.
  const runs: Array<{ from: THREE.Vector3; to: THREE.Vector3 }> = [
    { from: new THREE.Vector3(-YARD_HALF, 0, -YARD_HALF), to: new THREE.Vector3(YARD_HALF, 0, -YARD_HALF) },
    { from: new THREE.Vector3(YARD_HALF, 0, -YARD_HALF), to: new THREE.Vector3(YARD_HALF, 0, YARD_HALF) },
    { from: new THREE.Vector3(-YARD_HALF, 0, YARD_HALF), to: new THREE.Vector3(-YARD_HALF, 0, -YARD_HALF) },
  ];

  // One picket height for the whole fence. Varying it per picket would need a
  // distinct geometry per height and defeat instancing entirely; the hand-built
  // look comes from the lean and the colour jitter instead, which are free.
  for (const run of runs) {
    const length = run.from.distanceTo(run.to);
    const count = Math.floor(length / spacing);
    const dir = run.to.clone().sub(run.from).normalize();
    const angle = Math.atan2(dir.x, dir.z);

    for (let i = 0; i < count; i++) {
      const t = (i + 0.5) / count;
      const p = run.from.clone().lerp(run.to, t);
      box(
        props, cache,
        0.09, picketHeight, 0.02,
        p.x, picketHeight / 2, p.z,
        jitter(PALETTE.fence, rng, 0.04),
        { ry: angle, rz: rng.signed(0.014), chamfer: 0.006, outline: 0x5a4432 },
      );
    }

    // Two horizontal rails behind the pickets. Each run has its own length, so
    // these are three distinct geometries rather than one instanced set — three
    // extra draws total, which is not worth contorting the layout to avoid.
    for (const y of [0.45, 1.15]) {
      const mid = run.from.clone().lerp(run.to, 0.5);
      box(
        props, cache,
        length, 0.09, 0.03,
        mid.x, y, mid.z,
        PALETTE.fencePost,
        { ry: angle + Math.PI / 2, chamfer: 0.006, outline: 0x5a4432 },
      );
    }
  }
}

/** Nudge a colour slightly, so repeated instances do not read as a tiling. */
function jitter(hex: number, rng: Rng, amount: number): number {
  const c = new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  c.setHSL(hsl.h, hsl.s, Math.max(0, Math.min(1, hsl.l + rng.signed(amount))));
  return c.getHex(THREE.SRGBColorSpace);
}

function addHouse(props: PropBatch, cache: GeometryCache): void {
  // Only the back wall of the house is in the yard; the rest is out of play.
  box(props, cache, 30, 7, 6, 0, 3.5, YARD_HALF + 2.5, PALETTE.houseWall, {
    chamfer: 0.02, outline: 0x6a5548,
  });

  // A door and two windows, as flat trim panels standing slightly proud.
  box(props, cache, 1.1, 2.1, 0.12, -2, 1.05, YARD_HALF - 0.44, PALETTE.houseTrim, {
    chamfer: 0.01, outline: 0x6a2320,
  });

  for (const x of [2.5, 6]) {
    box(props, cache, 1.4, 1.2, 0.1, x, 2.0, YARD_HALF - 0.45, PALETTE.houseTrim, {
      chamfer: 0.01, outline: 0x6a2320,
    });
    box(props, cache, 1.15, 0.95, 0.06, x, 2.0, YARD_HALF - 0.4, 0x9fd8ee, {
      chamfer: 0.006, outline: 0x4a7a8a,
    });
  }

  // A low porch step, the natural first thing to build onto.
  box(props, cache, 3.2, 0.35, 1.2, -2, 0.175, YARD_HALF - 1.2, PALETTE.houseTrim, {
    chamfer: 0.015, outline: 0x6a2320,
  });
}

function addTrees(scene: THREE.Scene, props: PropBatch, cache: GeometryCache, rng: Rng): void {
  const spots: Array<[number, number, number]> = [
    [-15, -14, 1.35],
    [16, -12, 1.1],
    [-18, 8, 0.95],
    [13, 14, 0.8],
  ];

  // Foliage blobs are individually lumpy, so each is its own geometry and its
  // own mesh. Four trees is a dozen draws, which is affordable; a forest would
  // need a shared set of blob shapes reused across trees.
  for (const [x, z, scale] of spots) {
    const trunkHeight = 3.4 * scale;
    box(
      props, cache,
      0.42 * scale, trunkHeight, 0.42 * scale,
      x, trunkHeight / 2, z,
      PALETTE.trunk,
      { ry: rng.range(0, Math.PI), chamfer: 0.02, outline: 0x4a3122 },
    );

    const clusters = rng.int(2, 3);
    for (let i = 0; i < clusters; i++) {
      const radius = rng.range(1.3, 1.9) * scale;
      const geometry = blob(radius, 1, 0.16, () => rng.next());
      const dark = i % 2 === 1;
      const mesh = new THREE.Mesh(
        geometry,
        createToonMaterial({ color: dark ? PALETTE.foliageDark : PALETTE.foliage }),
      );
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.position.set(
        x + rng.signed(0.8) * scale,
        trunkHeight + rng.range(0.3, 1.0) * scale,
        z + rng.signed(0.8) * scale,
      );
      scene.add(mesh);
    }
  }
}

function addYardProps(scene: THREE.Scene, props: PropBatch, cache: GeometryCache, rng: Rng): void {
  // Sandbox.
  const sx = 8;
  const sz = -6;
  for (const [dx, dz, w, d] of [
    [0, -1.5, 3.2, 0.18],
    [0, 1.5, 3.2, 0.18],
    [-1.5, 0, 0.18, 3.2],
    [1.5, 0, 0.18, 3.2],
  ] as const) {
    box(props, cache, w, 0.3, d, sx + dx, 0.15, sz + dz, PALETTE.fence, {
      chamfer: 0.01, outline: 0x5a4432,
    });
  }
  const sand = new THREE.Mesh(
    new THREE.PlaneGeometry(3.0, 3.0).rotateX(-Math.PI / 2),
    createToonMaterial({ color: PALETTE.sand }),
  );
  sand.position.set(sx, 0.22, sz);
  sand.receiveShadow = true;
  scene.add(sand);

  // Kiddie pool.
  const px = -9;
  const pz = -8;
  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(1.5, 0.22, 8, 20).rotateX(Math.PI / 2),
    createToonMaterial({ color: PALETTE.poolRim }),
  );
  rim.position.set(px, 0.22, pz);
  rim.castShadow = true;
  scene.add(rim);
  const water = new THREE.Mesh(
    new THREE.CircleGeometry(1.45, 20).rotateX(-Math.PI / 2),
    createToonMaterial({ color: PALETTE.poolWater }),
  );
  water.position.set(px, 0.2, pz);
  scene.add(water);

  // A scattered lumber pile — the visual promise of what you can build with.
  for (let i = 0; i < 14; i++) {
    const length = rng.pick([1.0, 2.0, 0.5]);
    box(
      props, cache,
      length, 0.05, 0.25,
      -3 + rng.signed(1.6),
      0.03 + Math.floor(i / 5) * 0.06,
      -3 + rng.signed(1.2),
      jitter(0xc89f6a, rng, 0.05),
      { ry: rng.range(0, Math.PI), rz: rng.signed(0.02), chamfer: 0.008, outline: 0x4a3122 },
    );
  }
}

export { addOutlineNormals };
