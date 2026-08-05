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
import { createToonMaterial, createOutlineMaterial } from '../render/toonMaterial.ts';
import { chamferedBox, blob, addOutlineNormals } from '../render/geometry.ts';

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
  /** Call after placing or removing parts so the static shadow map refreshes. */
  invalidateShadows(): void;
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
  addFence(scene, rng.fork());
  addHouse(scene);
  addTrees(scene, rng.fork());
  addProps(scene, rng.fork());

  return {
    scene,
    sun,
    invalidateShadows() {
      sun.shadow.needsUpdate = true;
    },
  };
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
  const sun = new THREE.DirectionalLight(0xfff4d6, 3.0);
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
  scene.add(new THREE.HemisphereLight(0xbfe6ff, 0x7fa84a, 0.55));
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
function outlinedBox(
  width: number, height: number, depth: number,
  color: number, chamfer = 0.012, outlineColor = 0x3a2c2a,
): THREE.Group {
  const group = new THREE.Group();
  const geometry = chamferedBox(width, height, depth, chamfer);
  const mesh = new THREE.Mesh(geometry, createToonMaterial({ color }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);

  const outline = new THREE.Mesh(geometry, createOutlineMaterial(outlineColor, 0.014));
  group.add(outline);
  return group;
}

function addFence(scene: THREE.Scene, rng: Rng): void {
  const fence = new THREE.Group();
  fence.name = 'fence';

  const picketHeight = 1.6;
  const spacing = 0.28;

  // Three sides; the fourth is the house.
  const runs: Array<{ from: THREE.Vector3; to: THREE.Vector3 }> = [
    { from: new THREE.Vector3(-YARD_HALF, 0, -YARD_HALF), to: new THREE.Vector3(YARD_HALF, 0, -YARD_HALF) },
    { from: new THREE.Vector3(YARD_HALF, 0, -YARD_HALF), to: new THREE.Vector3(YARD_HALF, 0, YARD_HALF) },
    { from: new THREE.Vector3(-YARD_HALF, 0, YARD_HALF), to: new THREE.Vector3(-YARD_HALF, 0, -YARD_HALF) },
  ];

  for (const run of runs) {
    const length = run.from.distanceTo(run.to);
    const count = Math.floor(length / spacing);
    const dir = run.to.clone().sub(run.from).normalize();
    const angle = Math.atan2(dir.x, dir.z);

    for (let i = 0; i < count; i++) {
      const t = (i + 0.5) / count;
      const p = run.from.clone().lerp(run.to, t);
      // Each picket leans and varies a little; a perfectly uniform fence reads
      // as a repeated asset, a slightly wobbly one reads as built by hand.
      const h = picketHeight + rng.signed(0.06);
      const picket = outlinedBox(0.09, h, 0.02, PALETTE.fence, 0.006, 0x5a4432);
      picket.position.set(p.x, h / 2, p.z);
      picket.rotation.y = angle;
      picket.rotation.z = rng.signed(0.012);
      fence.add(picket);
    }

    // Two horizontal rails behind the pickets.
    for (const y of [0.45, 1.15]) {
      const rail = outlinedBox(length, 0.09, 0.03, PALETTE.fencePost, 0.006, 0x5a4432);
      const mid = run.from.clone().lerp(run.to, 0.5);
      rail.position.set(mid.x, y, mid.z);
      rail.rotation.y = angle + Math.PI / 2;
      fence.add(rail);
    }
  }

  scene.add(fence);
}

function addHouse(scene: THREE.Scene): void {
  const house = new THREE.Group();
  house.name = 'house';

  // Only the back wall of the house is in the yard; the rest is out of play.
  const wall = outlinedBox(30, 7, 6, PALETTE.houseWall, 0.02, 0x6a5548);
  wall.position.set(0, 3.5, YARD_HALF + 2.5);
  house.add(wall);

  // A door and two windows, as flat trim panels standing slightly proud.
  const door = outlinedBox(1.1, 2.1, 0.12, PALETTE.houseTrim, 0.01, 0x6a2320);
  door.position.set(-2, 1.05, YARD_HALF - 0.44);
  house.add(door);

  for (const x of [2.5, 6]) {
    const frame = outlinedBox(1.4, 1.2, 0.1, PALETTE.houseTrim, 0.01, 0x6a2320);
    frame.position.set(x, 2.0, YARD_HALF - 0.45);
    house.add(frame);
    const glass = outlinedBox(1.15, 0.95, 0.06, 0x9fd8ee, 0.006, 0x4a7a8a);
    glass.position.set(x, 2.0, YARD_HALF - 0.4);
    house.add(glass);
  }

  // A low porch step, the natural first thing to build onto.
  const step = outlinedBox(3.2, 0.35, 1.2, PALETTE.houseTrim, 0.015, 0x6a2320);
  step.position.set(-2, 0.175, YARD_HALF - 1.2);
  house.add(step);

  scene.add(house);
}

function addTrees(scene: THREE.Scene, rng: Rng): void {
  const trees = new THREE.Group();
  trees.name = 'trees';

  const spots: Array<[number, number, number]> = [
    [-15, -14, 1.35],
    [16, -12, 1.1],
    [-18, 8, 0.95],
    [13, 14, 0.8],
  ];

  for (const [x, z, scale] of spots) {
    const tree = new THREE.Group();

    const trunkHeight = 3.4 * scale;
    const trunk = outlinedBox(0.42 * scale, trunkHeight, 0.42 * scale, PALETTE.trunk, 0.02, 0x4a3122);
    trunk.position.y = trunkHeight / 2;
    trunk.rotation.y = rng.range(0, Math.PI);
    tree.add(trunk);

    // Foliage as two or three overlapping lumpy blobs rather than one sphere —
    // the overlap is what gives a hand-drawn silhouette.
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
      const cluster = new THREE.Group();
      cluster.add(mesh);
      cluster.add(new THREE.Mesh(geometry, createOutlineMaterial(0x2e4a22, 0.016)));
      cluster.position.set(
        rng.signed(0.8) * scale,
        trunkHeight + rng.range(0.3, 1.0) * scale,
        rng.signed(0.8) * scale,
      );
      tree.add(cluster);
    }

    tree.position.set(x, 0, z);
    trees.add(tree);
  }

  scene.add(trees);
}

function addProps(scene: THREE.Scene, rng: Rng): void {
  const props = new THREE.Group();
  props.name = 'props';

  // Sandbox.
  const sandbox = new THREE.Group();
  for (const [dx, dz, w, d] of [
    [0, -1.5, 3.2, 0.18],
    [0, 1.5, 3.2, 0.18],
    [-1.5, 0, 0.18, 3.2],
    [1.5, 0, 0.18, 3.2],
  ] as const) {
    const side = outlinedBox(w, 0.3, d, PALETTE.fence, 0.01, 0x5a4432);
    side.position.set(dx, 0.15, dz);
    sandbox.add(side);
  }
  const sand = new THREE.Mesh(
    new THREE.PlaneGeometry(3.0, 3.0).rotateX(-Math.PI / 2),
    createToonMaterial({ color: PALETTE.sand }),
  );
  sand.position.y = 0.22;
  sand.receiveShadow = true;
  sandbox.add(sand);
  sandbox.position.set(8, 0, -6);
  props.add(sandbox);

  // Kiddie pool.
  const pool = new THREE.Group();
  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(1.5, 0.22, 8, 20).rotateX(Math.PI / 2),
    createToonMaterial({ color: PALETTE.poolRim }),
  );
  rim.position.y = 0.22;
  rim.castShadow = true;
  pool.add(rim);
  const water = new THREE.Mesh(
    new THREE.CircleGeometry(1.45, 20).rotateX(-Math.PI / 2),
    createToonMaterial({ color: PALETTE.poolWater }),
  );
  water.position.y = 0.2;
  pool.add(water);
  pool.position.set(-9, 0, -8);
  props.add(pool);

  // A scattered lumber pile — the visual promise of what you can build with.
  for (let i = 0; i < 14; i++) {
    const length = rng.pick([1.0, 2.0, 0.5]);
    const plank = outlinedBox(length, 0.05, 0.25, 0xc89f6a, 0.008, 0x4a3122);
    plank.position.set(
      -3 + rng.signed(1.6),
      0.03 + Math.floor(i / 5) * 0.06,
      -3 + rng.signed(1.2),
    );
    plank.rotation.y = rng.range(0, Math.PI);
    plank.rotation.z = rng.signed(0.02);
    props.add(plank);
  }

  scene.add(props);
}

export { addOutlineNormals };
