/**
 * Entry point. Builds the world, wires the systems together, and runs the loop.
 *
 * Simulation runs on a fixed timestep; rendering runs per frame and interpolates
 * between the last two simulation states. Input edges are resolved at tick
 * boundaries so a fast click is never doubled or swallowed.
 */

import * as THREE from 'three';
import { GameLoop } from './core/loop.ts';
import { Input } from './core/input.ts';
import { CollisionWorld } from './physics/collisionWorld.ts';
import { TICK_RATE, DT } from './physics/constants.ts';
import { createScene } from './world/scene.ts';
import { PartRenderer } from './render/partRenderer.ts';
import { BuildSystem, type PlacementRecord } from './build/buildSystem.ts';
import { CharacterController, type MoveIntent } from './player/controller.ts';
import { CameraRig } from './player/cameraRig.ts';
import { Hud } from './ui/hud.ts';
import { MAX_REACH } from './build/snapping.ts';
import { seedStarterStructures } from './world/starter.ts';
import { AudioBus } from './audio/audioBus.ts';
import { GameSounds } from './audio/gameSounds.ts';

const app = document.getElementById('app')!;
app.style.cssText = 'position:fixed;inset:0;overflow:hidden;';

// ── Renderer ─────────────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: 'high-performance',
  stencil: false,
});
// Cap the pixel ratio: 3x on a dense display costs 2.25x the fill rate of 2x
// for no visible gain, and cel shading needs the MSAA more than the resolution.
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
// The world only changes when someone builds, so regenerating the shadow map
// every frame is pure waste — and holding it still also removes the shimmer a
// per-frame regeneration causes.
renderer.shadowMap.autoUpdate = false;
renderer.shadowMap.needsUpdate = true;
app.appendChild(renderer.domElement);

// ── World ────────────────────────────────────────────────────────────────────
const { scene, invalidateShadows, props: scenery } = createScene('backyard-01');
const world = new CollisionWorld(1.0, 4096);
const parts = new PartRenderer();
scene.add(parts.group);

const build = new BuildSystem(world, parts);
scene.add(build.ghostGroup);

/**
 * Mark the shadow map stale after the world changes.
 *
 * Debounced rather than immediate. Holding the place button lays a part every
 * ten ticks, and rebuilding a 2048² shadow map that often — re-rendering every
 * caster in the yard each time — costs far more than the parts being added.
 * Collapsing a burst of placements into one rebuild is invisible: the shadow is
 * at most a fraction of a second behind the geometry that casts it.
 */
let shadowsDirty = false;
let shadowsLastRebuild = 0;
const SHADOW_REBUILD_INTERVAL = 0.25;

function worldChanged(): void {
  shadowsDirty = true;
}

function flushShadows(nowSeconds: number): void {
  if (!shadowsDirty || nowSeconds - shadowsLastRebuild < SHADOW_REBUILD_INTERVAL) return;
  shadowsDirty = false;
  shadowsLastRebuild = nowSeconds;
  invalidateShadows();
  renderer.shadowMap.needsUpdate = true;
}

// A few things already standing, so the first thing a player sees is what the
// game is for rather than an empty lawn.
seedStarterStructures(build);

const player = new CharacterController(world, -3, 0.5, -6);
const camera = new CameraRig(world, window.innerWidth / window.innerHeight);
camera.yaw = Math.PI * 0.15;

const hud = new Hud(app);
const input = new Input(renderer.domElement);

// Audio cannot start without a user gesture, so it rides the same click that
// grabs pointer lock. Until then every play() is a no-op rather than an error.
const audio = new AudioBus();
const sounds = new GameSounds(audio, world);

parts.setViewportHeight(window.innerHeight);
scenery.setViewportHeight(window.innerHeight);
// The starter structures are already in; draw their shadows on the first frame
// rather than a quarter second later.
invalidateShadows();
renderer.shadowMap.needsUpdate = true;

// ── Player avatar, visible in third person ───────────────────────────────────
const avatar = new THREE.Group();
{
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.32, 1.06, 4, 10),
    new THREE.MeshToonMaterial({ color: 0x4f8fd8 }),
  );
  body.position.y = 0.85;
  body.castShadow = true;
  avatar.add(body);
  const cap = new THREE.Mesh(
    new THREE.SphereGeometry(0.2, 10, 8),
    new THREE.MeshToonMaterial({ color: 0xe8d44f }),
  );
  cap.position.y = 1.62;
  cap.castShadow = true;
  avatar.add(cap);
}
scene.add(avatar);

// ── Input plumbing ───────────────────────────────────────────────────────────
input.onPointerLockChange = (locked) => hud.setPointerLocked(locked);
hud.onLockClick(() => {
  void input.requestPointerLock();
  void audio.unlock().then(() => {
    audio.play('uiClick', { volume: 0.5 });
    audio.startAmbient();
  });
});

let snapKindLabel = 'none';
let candidateCount = 0;
let validPlacement = false;
/** Ticks the place button has been held, for sticky repeat. */
let placeHeldTicks = 0;
/** Identity of the snap target the ghost is latched to, for the snap tick. */
let lastSnapKey = '';

/** Place, and make a sound about it. Returns whether anything was placed. */
function tryPlaceWithFeedback(): boolean {
  const record = build.place();
  if (record === null) return false;
  build.applyPlace(record);
  worldChanged();
  sounds.placed(record.x, record.y, record.z, camera, player);
  return true;
}

function fixedUpdate(dt: number): void {
  input.beginTick();

  // Look is sampled per tick from accumulated mouse movement, so a 1000Hz mouse
  // and a 60Hz simulation agree on how far the view turned.
  const look = input.lookDelta;
  if (look.x !== 0 || look.y !== 0) camera.look(look.x, look.y);

  // Movement intent is expressed in the camera's ground basis, which is what
  // makes W mean "the way I am facing" rather than "world -Z".
  const axis = input.moveAxis;
  const basis = camera.getMoveBasis();
  const intent: MoveIntent = {
    right: axis.z * basis.fx + axis.x * basis.rx,
    forward: axis.z * basis.fz + axis.x * basis.rz,
    jump: input.isDown('jump'),
    sprint: input.isDown('sprint'),
    crouch: input.isDown('crouch'),
    climb: axis.z,
  };
  player.step(dt, intent);
  sounds.update(dt, player, camera);

  // ── Build actions ──────────────────────────────────────────────────────────
  const hotbar = input.hotbarPressed;
  if (hotbar >= 0) build.selectKind(hotbar);

  const wheel = input.wheel;
  if (wheel !== 0) {
    if (input.isDown('sprint')) build.cycleColorway(wheel > 0 ? 1 : -1);
    else build.cycleKind(wheel > 0 ? 1 : -1);
  }

  if (input.wasPressed('rotateCW')) build.rotateYaw(1);
  if (input.wasPressed('rotateCCW')) build.rotateYaw(-1);
  if (input.wasPressed('rotatePitch')) build.rotatePitch(1);
  if (input.wasPressed('rotateRoll')) build.rotateRoll(1);
  if (input.wasPressed('resetRotation')) build.resetRotation();
  if (input.wasPressed('cycleSnap')) build.cycleSnapCandidate();
  if (input.wasPressed('toggleCamera')) camera.toggleMode();
  if (input.wasPressed('debugToggle')) hud.toggleDebug();

  const state = player.sample(1);
  const ray = camera.getAimRay(state.x, state.y + state.eyeHeight, state.z, MAX_REACH);

  const snap = build.update(
    dt,
    ray.ox, ray.oy, ray.oz,
    ray.dx, ray.dy, ray.dz,
    input.isDown('freeAim'),
    // Crouch doubles as the fine-placement modifier while building.
    input.isDown('crouch'),
  );

  snapKindLabel = snap.candidate?.kind ?? 'none';
  candidateCount = snap.count;
  validPlacement = snap.candidate?.valid ?? false;

  // A tick when the ghost latches onto a different target. Keyed on the target
  // rather than the position, or sliding along one face would chatter.
  const snapKey = snap.candidate === null
    ? ''
    : `${snap.candidate.kind}:${snap.candidate.host}`;
  if (snapKey !== lastSnapKey) {
    lastSnapKey = snapKey;
    if (snap.candidate !== null && snap.candidate.valid) sounds.snapped();
  }

  // Sticky repeat while held: the difference between building a 20-rung ladder
  // and giving up on one.
  if (input.wasPressed('placePart')) {
    placeHeldTicks = 0;
    if (!tryPlaceWithFeedback()) sounds.invalid();
  } else if (input.isDown('placePart')) {
    placeHeldTicks++;
    if (placeHeldTicks % 10 === 0) tryPlaceWithFeedback();
  }

  if (input.wasPressed('removePart')) {
    const aimed = build.lastSnap?.hitPart ?? -1;
    let px = 0, py = 0, pz = 0;
    if (aimed >= 0 && world.store.isAlive(aimed)) {
      const c = aimed * 3;
      px = world.store.center[c]!;
      py = world.store.center[c + 1]!;
      pz = world.store.center[c + 2]!;
    }
    if (build.removeAimed()) {
      worldChanged();
      sounds.removed(px, py, pz, camera, player);
    }
  }

  if (input.wasPressed('interact') && build.undo()) {
    worldChanged();
    sounds.removed(player.x, player.y + 1, player.z, camera, player);
  }
}

function render(alpha: number, frameDt: number): void {
  const state = player.sample(alpha);
  const speedFraction = Math.min(1, player.speed / 7.4);
  camera.update(frameDt, state.x, state.y + state.eyeHeight, state.z, speedFraction);

  avatar.visible = camera.showsPlayer;
  avatar.position.set(state.x, state.y, state.z);
  avatar.rotation.y = camera.yaw;

  flushShadows(performance.now() / 1000);
  renderer.render(scene, camera.camera);

  hud.update({
    selectedKind: build.selectedKind,
    colorway: build.selectedColorway,
    validPlacement,
    snapKind: snapKindLabel,
    candidateCount,
    rotation: build.rotationDegrees,
    partsPlaced: build.placedCount,
    cameraMode: camera.mode,
    climbing: state.climbing,
  });
  hud.updateDebug({
    fps: loop.fps,
    parts: world.partCount,
    drawCalls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
    playerY: state.y,
    onGround: state.onGround,
  });
}

const loop = new GameLoop({ fixedUpdate, render }, { tickRate: TICK_RATE });
loop.start();

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.setAspect(window.innerWidth / window.innerHeight);
  parts.setViewportHeight(window.innerHeight);
  scenery.setViewportHeight(window.innerHeight);
});

// ── Debug API, also driven by the headless screenshot harness ────────────────
declare global {
  interface Window {
    __maker?: Record<string, unknown>;
  }
}

window.__maker = {
  ready: true,
  stats: () => ({
    fps: Math.round(loop.fps),
    parts: world.partCount,
    instances: parts.instanceCount,
    drawCalls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
    player: { x: +player.x.toFixed(2), y: +player.y.toFixed(2), z: +player.z.toFixed(2), onGround: player.onGround },
    hashCells: world.hash.stats().cells,
  }),
  teleport: (x: number, y: number, z: number) => player.teleport(x, y, z),
  lookAt: (yaw: number, pitch: number) => {
    camera.yaw = yaw;
    camera.pitch = pitch;
  },
  /** Aim at a world point, so scenarios can frame a shot without doing trig. */
  lookAtPoint: (tx: number, ty: number, tz: number) => {
    const state = player.sample(1);
    const dx = tx - state.x;
    const dy = ty - (state.y + state.eyeHeight);
    const dz = tz - state.z;
    camera.yaw = Math.atan2(-dx, -dz);
    camera.pitch = Math.atan2(dy, Math.hypot(dx, dz));
  },
  /** Drop the click-to-play overlay, which otherwise dims every screenshot. */
  hideOverlay: () => hud.setPointerLocked(true),
  setHudVisible: (visible: boolean) => {
    hud.root.style.display = visible ? '' : 'none';
  },
  setCameraMode: (mode: 'first' | 'third') => {
    camera.mode = mode;
  },
  selectPart: (i: number) => build.selectKind(i),
  /** Aim and place without a mouse, so scenarios can drive the build system. */
  placeAt: (yaw: number, pitch: number): boolean => {
    camera.yaw = yaw;
    camera.pitch = pitch;
    const state = player.sample(1);
    const ray = camera.getAimRay(state.x, state.y + state.eyeHeight, state.z, MAX_REACH);
    build.update(DT, ray.ox, ray.oy, ray.oz, ray.dx, ray.dy, ray.dz, false, false);
    const ok = build.tryPlace();
    if (ok) worldChanged();
    return ok;
  },
  save: (): PlacementRecord[] => build.serialize(),
  load: (records: PlacementRecord[]) => {
    build.deserialize(records);
    worldChanged();
  },
  audio,
  world,
  build,
  player,
  camera,
  scene,
  renderer,
};
