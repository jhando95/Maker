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
import { installFixtures } from './world/neighborhood.ts';
import { PartRenderer } from './render/partRenderer.ts';
import { BuildSystem, type PlacementRecord } from './build/buildSystem.ts';
import { CharacterController, type MoveIntent } from './player/controller.ts';
import { CameraRig } from './player/cameraRig.ts';
import { Hud } from './ui/hud.ts';
import { MAX_REACH } from './build/snapping.ts';
import { seedStarterStructures, STARTER_ORIGIN } from './world/starter.ts';
import { AudioBus } from './audio/audioBus.ts';
import { GameSounds } from './audio/gameSounds.ts';
import { Rng } from './core/rng.ts';
import { ProjectileSystem } from './game/projectiles.ts';
import { ModeRenderer } from './game/modeRenderer.ts';
import { FortDefenseMode } from './game/fortDefense.ts';
import { CaptureTheFlagMode } from './game/captureTheFlag.ts';
import { WaterWarMode } from './game/waterWar.ts';
import { LEFT_SPAWN } from './world/neighborhood.ts';
import type { GameEvent, GameMode, ModeContext, ModeInput } from './game/gameMode.ts';
import { SettingsStore, ghostColors, loadBindings, saveBindings, clearBindings } from './app/settings.ts';
import { BINDABLE, describeKey, type Action } from './core/input.ts';
import { BuildStore } from './app/buildStore.ts';
import { Menu } from './ui/menu.ts';
import { CrashHandler } from './app/crashHandler.ts';
import { GamepadManager } from './core/gamepadManager.ts';
import { PerformanceGovernor } from './app/performanceGovernor.ts';

/**
 * The modes a player can start.
 *
 * A registry rather than a `new FortDefenseMode()` at the one call site, because
 * the menu, the restart path and the debug API all need to name a mode and none
 * of them should be able to name one that does not exist.
 */
export type ModeId = 'fortDefense' | 'captureTheFlag' | 'waterWar';

export const MODES: ReadonlyArray<{ id: ModeId; name: string; blurb: string }> = [
  {
    id: 'captureTheFlag',
    name: 'Capture the Flag',
    blurb: 'Their flag is past the house. Build a way over, and a way to stop them.',
  },
  {
    id: 'waterWar',
    name: 'Water War',
    blurb: 'Three taps, one hot afternoon. Fortify them, then hold them while the street drains them dry.',
  },
  {
    id: 'fortDefense',
    name: 'Fort Defense',
    blurb: 'Build a fort around the stash, then hold five waves of neighbourhood kids.',
  },
];

function createMode(id: ModeId): GameMode {
  if (id === 'captureTheFlag') return new CaptureTheFlagMode();
  if (id === 'waterWar') return new WaterWarMode();
  return new FortDefenseMode();
}

const app = document.getElementById('app')!;
app.style.cssText = 'position:fixed;inset:0;overflow:hidden;';

/**
 * Installed first, before anything that could throw.
 *
 * A throw inside a requestAnimationFrame callback is caught by nothing: the
 * frame dies, no further frames are scheduled, and the last good image sits
 * frozen on screen with the reason only in the console.
 */
const crash = new CrashHandler(() => ({
  parts: world.partCount,
  mode: mode?.id ?? 'none',
  phase: mode?.hud().phase ?? null,
  player: { x: +player.x.toFixed(2), y: +player.y.toFixed(2), z: +player.z.toFixed(2) },
  screen: menu.current,
  tick: loop.tick,
}));

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
const { scene, invalidateShadows, props: scenery, slabs } = createScene('backyard-01');
const world = new CollisionWorld(1.0, 4096);
// The map's solid geometry, from the same numbers the scenery was drawn with.
// Installed before anything else touches the world so the starter structures
// and the player both spawn against a house that is already there.
installFixtures(world, slabs);
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

// On the back lawn, facing the starter structures. The old spawn was the
// origin, which the house now occupies.
const player = new CharacterController(world, STARTER_ORIGIN.x, 0.5, STARTER_ORIGIN.z - 9);
const camera = new CameraRig(world, window.innerWidth / window.innerHeight);
camera.yaw = Math.PI;

const hud = new Hud(app);
const input = new Input(renderer.domElement);
// Restore saved bindings before anything reads input.
const savedBindings = loadBindings();
if (savedBindings !== null) input.setBindings(savedBindings as Record<string, Action>);

const gamepad = new GamepadManager(input);

// Audio cannot start without a user gesture, so it rides the same click that
// grabs pointer lock. Until then every play() is a no-op rather than an error.
const audio = new AudioBus();
const sounds = new GameSounds(audio, world);

const settings = new SettingsStore();
/**
 * Resolution is the one quality lever the game is allowed to move on its own.
 *
 * Simulation cost is measured and bounded (`npm run bench`); GPU cost depends on
 * a machine this code will never see. Shadows and outlines are how the game
 * looks and stay with the player — nobody picks a resolution for its own sake.
 */
const governor = new PerformanceGovernor();

function applyRenderScale(): void {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2) * governor.currentScale);
  renderer.setSize(window.innerWidth, window.innerHeight);
}

governor.onChange = () => {
  applyRenderScale();
  // Shadows are drawn on demand, and the map is sized off the drawing buffer.
  renderer.shadowMap.needsUpdate = true;
};

// ── Mode plumbing ────────────────────────────────────────────────────────────
const projectiles = new ProjectileSystem(world);
const modeRenderer = new ModeRenderer();
scene.add(modeRenderer.group);

// Applied only after every system it touches exists — the subscription fires
// immediately so defaults land without a separate apply step, which means
// declaration order here is load-bearing.
settings.subscribe((s) => {
  camera.sensitivity = s.sensitivity;
  camera.invertY = s.invertY;
  camera.baseFov = s.fov;
  audio.setMasterVolume(s.masterVolume);
  audio.setSfxVolume(s.sfxVolume);
  parts.setOutlinesVisible(s.outlines);
  scenery.setOutlinesVisible(s.outlines);
  modeRenderer.setOutlinesVisible(s.outlines);
  renderer.shadowMap.enabled = s.shadows;
  renderer.shadowMap.needsUpdate = true;
  // Render scale trades resolution for fill rate without touching layout: the
  // canvas keeps its CSS size and only its backing store shrinks. The player's
  // value is a ceiling; the governor may be rendering below it.
  governor.enabled = s.autoQuality;
  governor.setCeiling(s.renderScale);
  applyRenderScale();
  const g = ghostColors(s.colorblindGhost);
  build.setGhostColors(g.valid, g.invalid);
  gamepad.enabled = s.gamepadEnabled;
  gamepad.setOptions({
    lookSpeed: s.gamepadLookSpeed,
    deadzone: s.gamepadDeadzone,
    invertY: s.invertY,
  });
});

/**
 * Events raised by simulation and drained here. Keeping presentation on this
 * side of a queue is what stops the mode from having to know about audio.
 */
const events: GameEvent[] = [];

const modeContext: ModeContext = {
  world, build, player, camera, projectiles,
  rng: new Rng('round-1'),
  emit: (e) => events.push(e),
  worldChanged: () => worldChanged(),
};

/** null means free build with no rules. */
let mode: GameMode | null = null;

/** The world as it was when the round began, for restarts. */
let roundSnapshot: ReturnType<typeof build.serialize> | null = null;
/** Which mode a restart should rebuild. */
let lastModeId: ModeId = 'fortDefense';

function startRound(id: ModeId = lastModeId): void {
  lastModeId = id;
  roundSnapshot = build.serialize();
  mode = createMode(id);
  mode.start(modeContext);
  audio.play('roundStart', { volume: 0.6 });
  resetPlayerToSpawn(id);
}

function stopRound(): void {
  mode?.end(modeContext);
  mode = null;
  projectiles.clear();
  modeRenderer.clear();
}

function restartRound(): void {
  stopRound();
  // Put the yard back the way it was, so a retry starts from the same problem
  // rather than from whatever the last attempt left standing.
  if (roundSnapshot !== null) {
    build.deserialize(roundSnapshot);
    worldChanged();
  }
  startRound(lastModeId);
  enterPlay();
}

function resetPlayerToSpawn(id: ModeId = lastModeId): void {
  // Capture the Flag starts you in your own yard; everything else starts you
  // where the starter structures are, which is what the sandbox wants.
  if (id === 'captureTheFlag') player.teleport(LEFT_SPAWN.x, LEFT_SPAWN.y, LEFT_SPAWN.z);
  else player.teleport(STARTER_ORIGIN.x, 0.5, STARTER_ORIGIN.z - 9);
  camera.yaw = id === 'captureTheFlag' ? Math.PI * 0.5 : Math.PI;
  camera.pitch = -0.05;
}

// ── Application state ────────────────────────────────────────────────────────
//
// One place decides whether the simulation runs and whether the mouse is
// captured. Menus, pause and the result screen are all the same mechanism:
// a screen is open, so the world is frozen and the cursor is free.

const buildStore = new BuildStore();

const menu = new Menu(app, settings, {
  listModes: () => MODES,
  onPlayMode: (id: string) => {
    startRound(id as ModeId);
    enterPlay();
  },
  onPlaySandbox: () => {
    stopRound();
    resetPlayerToSpawn();
    enterPlay();
  },
  onResume: () => enterPlay(),
  onRestart: () => restartRound(),
  onQuitToTitle: () => {
    stopRound();
    enterMenu('title');
  },
  onSaveBuild: (name) => buildStore.save(name, build.serialize(), Date.now()) !== null,
  onLoadBuild: (id) => {
    const parts = buildStore.load(id);
    if (parts === null) return false;
    build.deserialize(parts);
    worldChanged();
    return true;
  },
  onDeleteBuild: (id) => buildStore.remove(id),
  listBuilds: () => buildStore.list(),

  listBindings: () => BINDABLE.map(({ action, label }) => {
    const codes = input.codesFor(action);
    return {
      action,
      label,
      key: codes.length > 0 ? codes.map(describeKey).join(' / ') : 'unbound',
    };
  }),
  rebind: (action, code) => {
    input.setBinding(action as Action, code);
    saveBindings(input.getBindings());
    return true;
  },
  resetBindings: () => {
    input.resetBindings();
    clearBindings();
  },
});

function enterPlay(): void {
  menu.show('none');
  loop.setPaused(false);
  hud.root.style.display = '';
  input.setEnabled(true);
  void input.requestPointerLock();
  void audio.unlock().then(() => audio.startAmbient());
}

function enterMenu(screen: 'title' | 'pause' | 'result', result?: Parameters<Menu['show']>[1]): void {
  menu.show(screen, result);
  loop.setPaused(true);
  // The HUD is about the world, and the world is not running.
  hud.root.style.display = screen === 'pause' ? '' : 'none';
  input.setEnabled(false);
  input.exitPointerLock();
}

// Losing pointer lock — Escape, or alt-tab — is the player leaving the game.
// Treating it as a pause is what stops the world running behind a lost cursor.
input.onPointerLockChange = (locked) => {
  hud.setPointerLocked(locked || menu.isOpen);
  if (!locked && !menu.isOpen) enterMenu('pause');
};

window.addEventListener('keydown', (e) => {
  if (e.code !== 'Escape') return;
  e.preventDefault();
  if (menu.isOpen) menu.handleEscape();
  else enterMenu('pause');
});

// Start is the pad's Escape. It cannot restore pointer lock — the browser only
// grants that from a real click — but the pad keeps working without it, so a
// controller player can pause and resume without reaching for the mouse.
gamepad.onStart = () => {
  if (menu.isOpen) menu.handleEscape();
  else enterMenu('pause');
};

// The on-screen hints name real buttons, so they follow the device in the
// player's hands. Swapping them is also the only feedback a pad needs: touch a
// stick and the help panel starts saying LB instead of Q.
input.onDeviceChange = (device) => hud.setInputDevice(device);

function drainEvents(): void {
  for (const e of events) {
    switch (e.type) {
      case 'splash':
        modeRenderer.splash(e.x, e.y, e.z);
        audio.play('splash', {
          ...spatialAt(e.x, e.y, e.z),
          pitch: 0.9 + Math.random() * 0.25,
        });
        break;
      case 'throw':
        audio.play('throw', { ...spatialAt(e.x, e.y, e.z), volume: 0.5 });
        break;
      case 'botSoaked':
        audio.play('hit', { ...spatialAt(e.x, e.y, e.z), volume: 0.5 });
        break;
      case 'playerSoaked':
        audio.play('hit', { volume: 0.7, pitch: 0.7 });
        break;
      case 'refilled':
        audio.play('uiClick', { ...spatialAt(e.x, e.y, e.z), volume: 0.6, pitch: 1.3 });
        break;
      case 'stashHit':
        audio.play('invalid', { volume: 0.8, pitch: 0.6 });
        break;
      case 'roundWon':
        audio.play('roundWin', { volume: 0.7 });
        break;
      case 'roundLost':
        audio.play('roundLose', { volume: 0.7 });
        break;
      case 'phaseChange':
        audio.play('roundStart', { volume: 0.45 });
        break;
      case 'flagTaken':
        // Higher and brighter when it is your grab, so a pickup across the map
        // does not sound like the one in your hands.
        audio.play('roundStart', {
          ...spatialAt(e.x, e.y, e.z),
          volume: 0.7,
          pitch: e.byPlayer ? 1.35 : 0.85,
        });
        break;
      case 'flagDropped':
        audio.play('invalid', { ...spatialAt(e.x, e.y, e.z), volume: 0.7, pitch: 0.9 });
        break;
      case 'flagReturned':
        audio.play('uiClick', { ...spatialAt(e.x, e.y, e.z), volume: 0.7, pitch: 1.15 });
        break;
      case 'captured':
        audio.play(e.byPlayer ? 'roundWin' : 'roundLose', { volume: 0.65 });
        break;
    }
  }
  events.length = 0;
}

function spatialAt(x: number, y: number, z: number) {
  const basis = camera.getMoveBasis();
  return AudioBus.spatial(x, y, z, player.x, player.y + 1.5, player.z, basis.rx, basis.rz, 28);
}

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
hud.onLockClick(() => enterPlay());

let snapKindLabel = 'none';
let candidateCount = 0;
let validPlacement = false;
/** Ticks the place button has been held, for sticky repeat. */
let placeHeldTicks = 0;
/** Identity of the snap target the ghost is latched to, for the snap tick. */
let lastSnapKey = '';
/** Seconds left on the end-of-round screen before the world is handed back. */
let modeOverTimer = 0;
/** Stance latches, so hold-vs-toggle is a setting rather than two code paths. */
let crouchLatched = false;
let sprintLatched = false;
let repeatHeldTicks = 0;

function doRepeat(): void {
  const placed = build.repeatPlace();
  if (placed === null) {
    sounds.invalid();
    return;
  }
  worldChanged();
  sounds.placed(placed.x, placed.y, placed.z, camera, player);
}

/** Place, and make a sound about it. Returns whether anything was placed. */
function tryPlaceWithFeedback(): boolean {
  const record = build.place();
  if (record === null) return false;
  build.applyPlace(record);
  worldChanged();
  sounds.placed(record.x, record.y, record.z, camera, player);
  return true;
}

/**
 * Set by the debug API to make the next simulation tick throw.
 *
 * The crash handler's whole claim is that a throw inside the loop is survivable
 * and visible, and the only way to check that claim is to actually throw from
 * inside the loop. One boolean read per tick is what that costs.
 */
let pendingCrash = false;

function fixedUpdate(dt: number): void {
  crash.guard('simulation', () => simulate(dt));
}

function simulate(dt: number): void {
  if (pendingCrash) {
    pendingCrash = false;
    throw new Error('deliberate scenario crash');
  }

  input.beginTick();

  // Look is sampled per tick from accumulated mouse movement, so a 1000Hz mouse
  // and a 60Hz simulation agree on how far the view turned.
  // The part wheel takes the mouse while it is open.
  //
  // Under pointer lock there is no cursor, so the pick is made by direction —
  // and the same movement cannot both aim the wheel and swing the camera, or
  // choosing a plank spins you round to face the fence.
  const look = input.lookDelta;
  const picker = hud.partWheel;
  // One wheel, two contents. Parts while you can build, weapons while you
  // cannot — which is exactly when each is the only one that makes sense, and
  // is one gesture to learn instead of two.
  const loadout = mode?.buildingAllowed === false ? mode.loadout : undefined;
  if (input.wasPressed('partWheel') && (mode === null || mode.buildingAllowed || loadout !== undefined)) {
    if (loadout !== undefined) {
      hud.showWeapons(loadout);
      picker.show(loadout.entries.findIndex((e) => e.id === loadout.selected));
    } else {
      hud.showParts();
      picker.show(build.selectedKind);
    }
  }
  if (picker.isOpen) {
    picker.move(look.x, look.y);
    if (!input.isDown('partWheel')) {
      const picked = picker.hide();
      if (picked !== null) {
        if (loadout !== undefined) loadout.select(loadout.entries[picked]?.id ?? loadout.selected);
        else build.selectKind(picked);
        sounds.pickPart();
      }
      hud.showParts();
    }
  } else if (look.x !== 0 || look.y !== 0) {
    camera.look(look.x, look.y);
  }

  // A stick reports where it is, not how far it moved, so it is a rate and has
  // to be integrated. Without the dt the turn speed would follow the tick rate.
  const pad = input.padLook;
  if (pad.yaw !== 0 || pad.pitch !== 0) camera.turn(-pad.yaw * dt, pad.pitch * dt);

  // Movement intent is expressed in the camera's ground basis, which is what
  // makes W mean "the way I am facing" rather than "world -Z".
  // Hold-vs-toggle for crouch and sprint. Toggling is an accessibility need as
  // much as a preference: holding a key for a whole round is genuinely painful
  // for some players.
  const cfg = settings.current;
  if (cfg.toggleCrouch) {
    if (input.wasPressed('crouch')) crouchLatched = !crouchLatched;
  } else {
    crouchLatched = input.isDown('crouch');
  }
  if (cfg.toggleSprint) {
    if (input.wasPressed('sprint')) sprintLatched = !sprintLatched;
    // Coming to a stop cancels a latched sprint, or it silently persists into
    // the next time the player moves and feels like a stuck key.
    if (input.moveAxis.x === 0 && input.moveAxis.z === 0) sprintLatched = false;
  } else {
    sprintLatched = input.isDown('sprint');
  }

  const axis = input.moveAxis;
  const basis = camera.getMoveBasis();
  const intent: MoveIntent = {
    right: axis.z * basis.fx + axis.x * basis.rx,
    forward: axis.z * basis.fz + axis.x * basis.rz,
    jump: input.isDown('jump'),
    sprint: sprintLatched,
    crouch: crouchLatched,
    climb: axis.z,
  };
  // Being soaked slows the player. Without this the mode's incoming fire is
  // toothless and building cover is decoration.
  if (mode !== null && mode.playerSpeedScale < 1) {
    intent.right *= mode.playerSpeedScale;
    intent.forward *= mode.playerSpeedScale;
    intent.sprint = false;
  }
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
    // Crouch doubles as the fine-placement modifier while building, so it must
    // follow the latch rather than the raw key.
    crouchLatched,
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
  // During a wave the mouse throws balloons instead of placing parts, so the
  // player is never fumbling between two things bound to the same button.
  const canBuild = mode === null || mode.buildingAllowed;
  // No previews while building is off. A ghost you cannot place, and a chain
  // preview showing where parts would go, are both lying during a wave.
  build.ghostGroup.visible = canBuild;
  if (canBuild) {
    if (input.wasPressed('placePart')) {
      placeHeldTicks = 0;
      if (!tryPlaceWithFeedback()) sounds.invalid();
    } else if (input.isDown('placePart')) {
      placeHeldTicks++;
      if (placeHeldTicks % 10 === 0) tryPlaceWithFeedback();
    }
  }

  // ── Mode tick ──────────────────────────────────────────────────────────────
  if (mode !== null) {
    const modeInput: ModeInput = {
      fire: input.isDown('placePart'),
      firePressed: input.wasPressed('placePart'),
      fireReleased: input.wasReleased('placePart'),
    };
    mode.fixedUpdate(dt, modeContext, modeInput);
    if (mode.finished && modeOverTimer <= 0) modeOverTimer = 4;
  }
  if (modeOverTimer > 0) {
    modeOverTimer -= dt;
    if (modeOverTimer <= 0 && mode !== null) {
      const s = mode.summary();
      enterMenu('result', {
        won: mode.won,
        headline: s.headline,
        // Parts placed belongs to the shell, not the mode — it is the same
        // number whatever is being played.
        lines: [...s.lines, { label: 'parts placed', value: String(build.placedCount) }],
      });
    }
  }

  // Repeat the last step. Held, it runs a chain — two rungs become a ladder.
  if (canBuild) {
    if (input.wasPressed('repeatPlace')) {
      repeatHeldTicks = 0;
      doRepeat();
    } else if (input.isDown('repeatPlace')) {
      repeatHeldTicks++;
      // About eight a second: fast enough to feel like drawing, slow enough to
      // watch where the chain is going and let go.
      if (repeatHeldTicks % 8 === 0) doRepeat();
    }
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
  crash.guard('render', () => draw(alpha, frameDt));
}

function draw(alpha: number, frameDt: number): void {
  // The Gamepad API has no button events, only connection ones, so pads must be
  // polled. Polling on the frame rather than the tick matches how the keyboard
  // already works — devices write into a pending buffer whenever they like and
  // the tick boundary folds it — and it keeps the pad alive while paused, which
  // is what lets Start reopen the game.
  gamepad.poll();

  // Measured on the frame, not the tick: the tick rate is fixed and says
  // nothing about whether the machine is keeping up.
  governor.frame(frameDt);

  const state = player.sample(alpha);
  const speedFraction = Math.min(1, player.speed / 7.4);
  camera.update(frameDt, state.x, state.y + state.eyeHeight, state.z, speedFraction);

  avatar.visible = camera.showsPlayer;
  avatar.position.set(state.x, state.y, state.z);
  avatar.rotation.y = camera.yaw;

  flushShadows(performance.now() / 1000);
  drainEvents();
  modeRenderer.setStream(
    mode?.stream ?? null,
    state.x, state.y + state.eyeHeight * 0.82, state.z,
  );
  modeRenderer.update(frameDt, mode, projectiles, performance.now() / 1000);

  renderer.render(scene, camera.camera);

  hud.update({
    selectedKind: build.selectedKind,
    colorway: build.selectedColorway,
    validPlacement,
    snapKind: snapKindLabel,
    candidateCount,
    rotation: build.rotationDegrees,
    canRepeat: build.repeatDelta !== null,
    partsPlaced: build.placedCount,
    cameraMode: camera.mode,
    climbing: state.climbing,
    mode: mode?.hud() ?? null,
  });
  hud.updateDebug({
    fps: loop.fps,
    parts: world.partCount,
    drawCalls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
    playerY: state.y,
    onGround: state.onGround,
    renderScale: governor.currentScale,
    throttled: governor.isThrottling,
  });
}

const loop = new GameLoop({ fixedUpdate, render }, { tickRate: TICK_RATE });

/**
 * Everything that has to happen once, on any crash, from any source.
 *
 * The guards in fixedUpdate and render are not the only way a crash arrives —
 * an event handler or a rejected promise reaches the handler directly, and
 * those must stop the loop too. Doing it here means there is one answer rather
 * than one per call site.
 *
 * Stopping matters beyond tidiness: a loop that keeps running behind the crash
 * screen goes on throwing sixty times a second, holds the pointer captive so
 * the player cannot click Reload, and leaves the ambient track playing under a
 * dialog that says the game has stopped.
 */
crash.onCrash = () => {
  loop.stop();
  audio.setMuted(true);
  input.setEnabled(false);
  if (document.pointerLockElement) document.exitPointerLock();
};

loop.start();

// Boot into the title screen through the same path everything else uses, so the
// HUD and pointer-lock state cannot start out disagreeing with the menu.
enterMenu('title');

window.addEventListener('resize', () => {
  applyRenderScale();
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
  /**
   * Dismiss whatever screen is up and let the world run.
   *
   * Not enterPlay(): pointer lock cannot be granted without a real gesture, so
   * a headless capture would bounce straight back to the pause screen.
   */
  hideOverlay: () => {
    menu.show('none');
    loop.setPaused(false);
    hud.root.style.display = '';
    hud.setPointerLocked(true);
    input.setEnabled(true);
  },
  setHudVisible: (visible: boolean) => {
    hud.root.style.display = visible ? '' : 'none';
  },
  setCameraMode: (mode: 'first' | 'third') => {
    camera.mode = mode;
  },
  selectPart: (i: number) => build.selectKind(i),
  getSelectedPart: () => build.selectedKind,
  actionDown: (a: string) => input.isDown(a as Action),
  bindingFor: (code: string) => input.getBindings()[code] ?? null,
  /** Move the mouse, for scenarios that cannot hold pointer lock. */
  look: (dx: number, dy: number) => input.injectLook(dx, dy),
  hud,
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
  settings,
  crash,
  /**
   * Throw from inside the next simulation tick.
   *
   * Deliberately not a direct call to crash.report(): that would prove only
   * that the dialog renders, and say nothing about whether a real throw in the
   * loop is caught at all.
   */
  crashNextTick: () => {
    pendingCrash = true;
  },
  isPaused: () => loop.isPaused,
  isRunning: () => loop.isRunning,
  /**
   * Controller state, for the headless harness.
   *
   * There is no inject-a-pad hook here on purpose: a scenario replaces
   * navigator.getGamepads instead, so the frame poll reads the fake through the
   * same path a real pad takes. A hook that bypassed that would be overwritten
   * by the very next frame, and would prove nothing about readPads.
   */
  padCount: () => gamepad.padCount,
  /**
   * Adaptive quality, which the screenshot harness turns off so captures are a
   * fixed resolution rather than one that depends on how the software
   * rasterizer felt that second.
   */
  setAutoQuality: (enabled: boolean) => {
    governor.enabled = enabled;
    applyRenderScale();
  },
  renderScale: () => ({ effective: governor.currentScale, throttled: governor.isThrottling }),
  inputDevice: () => input.lastDevice,
  getCameraYaw: () => camera.yaw,
  menu,
  startRound,
  stopRound,
  getMode: () => mode,
  /**
   * Advance the running mode without waiting in real time, using the real
   * context. Scenarios that build their own context get subtly different
   * behaviour, which is worse than useless for verification.
   */
  fastForward: (seconds: number, until?: string, fire = false) => {
    if (mode === null) return null;
    const ticks = Math.round(seconds / DT);
    for (let i = 0; i < ticks; i++) {
      // firePressed only on the first tick, so a held trigger reads as one press
      // and a cooldown-gated weapon is not treated as spam.
      mode.fixedUpdate(DT, modeContext, {
        fire, firePressed: fire && i === 0, fireReleased: false,
      });
      if (until !== undefined && mode.hud().phase === until) break;
    }
    drainEvents();
    return { phase: mode.hud().phase, bots: mode.bots.length };
  },
  projectiles,
  world,
  build,
  player,
  camera,
  scene,
  renderer,
};
