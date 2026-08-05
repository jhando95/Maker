import * as THREE from 'three';
import { createScene, PALETTE } from './world/scene.ts';
import { PartRenderer } from './render/partRenderer.ts';
import { CollisionWorld } from './physics/collisionWorld.ts';
import { PART_KINDS, halfExtents } from './build/partKit.ts';

const app = document.getElementById('app')!;
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', stencil: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.shadowMap.autoUpdate = false;
renderer.shadowMap.needsUpdate = true;
app.appendChild(renderer.domElement);

const { scene, sun } = createScene('backyard-01');
const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.1, 1000);
camera.position.set(-7, 4.2, -9);
camera.lookAt(1, 1.4, 1);

const parts = new PartRenderer();
scene.add(parts.group);
parts.setViewportHeight(innerHeight);

// A demo structure so the instanced path, outlines and shadows are all exercised.
const world = new CollisionWorld();
const q = new THREE.Quaternion();
const e = new THREE.Euler();
let placed = 0;
function place(kindId: number, colorway: number, x: number, y: number, z: number, rx=0, ry=0, rz=0) {
  const k = PART_KINDS[kindId]!;
  const h = halfExtents(k);
  q.setFromEuler(e.set(rx, ry, rz));
  const handle = world.addPart(kindId, colorway, x, y, z, q.x, q.y, q.z, q.w, h.hx, h.hy, h.hz);
  parts.add(handle.id, kindId, colorway, x, y, z, q.x, q.y, q.z, q.w);
  placed++;
}

// Platform floor of planks.
for (let i = 0; i < 8; i++) place(0, 0, 0, 1.0, -0.875 + i * 0.25);
// Four posts.
for (const [px, pz] of [[-0.4,-0.9],[0.4,-0.9],[-0.4,0.9],[0.4,0.9]]) place(4, 1, px, 0.5, pz, 0, 0, Math.PI/2);
// Ladder: two rails plus rungs at one module pitch.
for (const rz of [-0.3, 0.3]) place(1, 2, -0.6, 1.0, rz, 0, 0, Math.PI/2);
for (let i = 0; i < 5; i++) place(2, 3, -0.6, 0.25 + i * 0.25, 0, 0, Math.PI/2, 0);
// Staircase, 0.25 rise over 0.5 run.
for (let i = 0; i < 5; i++) place(0, 4 + (i%4), 1.2 + i*0.5, 0.25*(i+1), 0);
// A wall of panels.
for (let i = 0; i < 3; i++) place(5, 5, 0.5, 1.5, 2.2 + i*1.0, 0, 0, Math.PI/2);
// A ramp.
place(6, 6, -2.2, 0.25, -2.0);

renderer.shadowMap.needsUpdate = true;
sun.shadow.needsUpdate = true;

let frames = 0;
renderer.setAnimationLoop(() => {
  frames++;
  renderer.render(scene, camera);
});

(window as any).__maker = {
  ready: true,
  stats: () => ({
    parts: placed,
    instances: parts.instanceCount,
    drawCalls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
    frames,
    fog: PALETTE.fog.toString(16),
  }),
  camera,
  scene,
  renderer,
};
