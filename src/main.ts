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
import { chamferedBox } from './render/geometry.ts';
import { BuildSystem, type PlacementRecord } from './build/buildSystem.ts';
import { CharacterController } from './player/controller.ts';
import { CameraRig } from './player/cameraRig.ts';
import { Hud, type ScreenPin } from './ui/hud.ts';
import { MAX_REACH } from './build/snapping.ts';
import { seedStarterStructures, STARTER_ORIGIN } from './world/starter.ts';
import { AudioBus } from './audio/audioBus.ts';
import { GameSounds } from './audio/gameSounds.ts';
import { Rng } from './core/rng.ts';
import { ActorRoster, LOCAL_ACTOR_ID, type Actor, type Team } from './game/actor.ts';
import { BUTTON, commandToIntent, makeCommand } from './core/command.ts';

import { ProjectileSystem } from './game/projectiles.ts';
import { ModeRenderer } from './game/modeRenderer.ts';
import { CharacterBatch } from './render/character.ts';
import { NetHost, NetClient, type SessionContext } from './net/session.ts';
import { SocketTransport, loopbackPair, type Transport } from './net/transport.ts';
import { RelayHostLink, relayUrl } from './net/relayLink.ts';
import { RemoteMode } from './net/remoteMode.ts';
import { PROTOCOL_VERSION, type PackedRound } from './net/protocol.ts';
import { FortDefenseMode } from './game/fortDefense.ts';
import { CaptureTheFlagMode } from './game/captureTheFlag.ts';
import { WaterWarMode } from './game/waterWar.ts';
import { LEFT_SPAWN, RIGHT_SPAWN } from './world/neighborhood.ts';
import { IDLE_INPUT, sameForEveryone } from './game/gameMode.ts';
import type { ActorInput, GameEvent, GameMode, ModeContext, ModeInput } from './game/gameMode.ts';
import { SettingsStore, ghostColors, loadBindings, saveBindings, clearBindings } from './app/settings.ts';
import { BINDABLE, describeKey, type Action } from './core/input.ts';
import { BuildStore } from './app/buildStore.ts';
import { Menu } from './ui/menu.ts';
import { CrashHandler } from './app/crashHandler.ts';
import { GamepadManager } from './core/gamepadManager.ts';
import { PerformanceGovernor } from './app/performanceGovernor.ts';

/** How far off the window edge an off-screen objective chevron sits. */
const PIN_EDGE_MARGIN = 54;
/** Objectives are pinned above the thing rather than at its feet. */
const PIN_HEIGHT = 1.4;


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
/**
 * How many people can be drawn at once.
 *
 * A mode's own cap is twelve bots; the rest is headroom for the local player and
 * for however many other people are in the world. Sized once and never grown,
 * because growing an instanced buffer mid-round allocates and recompiles at
 * exactly the moment a wave arrives.
 */
const MAX_CHARACTERS = 32;
const projectiles = new ProjectileSystem(world);
/**
 * One rig for everybody in the world, the local player included.
 *
 * Owned here rather than by the mode renderer because whether to draw the
 * person holding the camera is a question about the camera, and because a
 * sandbox with no mode running still has somebody standing in it.
 */
const characters = new CharacterBatch(MAX_CHARACTERS);
scene.add(characters.group);
const modeRenderer = new ModeRenderer(characters);
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
  characters.setOutlinesVisible(s.outlines);
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

/**
 * The person at this keyboard, as an actor like any other.
 *
 * Left team because the player has always started in the left yard and every
 * mode's bots have always been the other side; naming it makes that arrangement
 * something a mode can read rather than something it assumes.
 */
const localActor: Actor = {
  id: LOCAL_ACTOR_ID,
  kind: 'local',
  team: 'left',
  controller: player,
  /**
   * Where the player is looking, so the rig can face them that way.
   *
   * A getter rather than a field written each tick: a bot's heading is derived
   * from where it is walking, and the player's is derived from the camera, so
   * both are things you *ask*, and neither can go stale between the tick that
   * set it and the frame that draws it.
   */
  get heading(): number {
    return camera.yaw;
  },
};
const actors = new ActorRoster(localActor);

/**
 * This tick's input, reused rather than reallocated.
 *
 * One object per tick would be sixty short-lived allocations a second for the
 * whole session, and the garbage collector pausing mid-jump is exactly the kind
 * of hitch the fixed timestep exists to avoid.
 */
const localCommand = makeCommand();
/** Monotonic tick counter, so a command can say which tick it belongs to. */
let simTick = 0;
/** Scratch list of who to draw, reused so rendering allocates nothing. */
const drawnActors: Actor[] = [];

/**
 * Turn the objectives a mode publishes into pins on the screen.
 *
 * Reads `mode.markers()`, which already exists for the 3D renderer, so no mode
 * needs to know this feature happened. Screen-space maths lives here rather than
 * in the HUD because the camera lives here — a HUD that could project a point
 * would be a HUD that imports three.js.
 *
 * Off-screen objectives are pinned to the edge with a chevron. That is the part
 * that matters: Water War spreads three taps across a forty-eight metre lot, so
 * the one being drained is usually behind you, and until now the only way to
 * find out was to walk round and look.
 */
const pinScratch: ScreenPin[] = [];
const pinVec = new THREE.Vector3();

function projectPins(active: GameMode | null, eye: { x: number; y: number; z: number }): ScreenPin[] {
  pinScratch.length = 0;
  if (active === null) return pinScratch;

  const width = window.innerWidth;
  const height = window.innerHeight;
  const cx = width / 2;
  const cy = height / 2;
  // Kept off the very edge, or half the chevron sits outside the window.
  const marginX = width / 2 - PIN_EDGE_MARGIN;
  const marginY = height / 2 - PIN_EDGE_MARGIN;

  // Dimming is relative: with nothing marked active every pin came out dim,
  // which is the same as none of them being dim except harder to read.
  const markers = active.markers();
  let anyActive = false;
  for (const marker of markers) anyActive ||= marker.active === true;

  for (const marker of markers) {
    pinVec.set(marker.x, marker.y + PIN_HEIGHT, marker.z);
    pinVec.project(camera.camera);

    // `project` gives normalised device coords, and z > 1 means behind the eye —
    // where x and y are mirrored and meaningless, so they get recomputed from
    // the world direction instead.
    const behind = pinVec.z > 1;
    let sx = pinVec.x * cx;
    let sy = -pinVec.y * cy;
    if (behind) {
      sx = -sx;
      sy = -sy;
    }

    const outside = behind || Math.abs(sx) > marginX || Math.abs(sy) > marginY;
    let angle = 0;
    if (outside) {
      // Push out along the direction to the objective until it meets the frame,
      // so a chevron sits where you would turn to find the thing.
      angle = Math.atan2(sy, sx);
      const scale = Math.min(
        marginX / Math.max(Math.abs(sx), 1e-3),
        marginY / Math.max(Math.abs(sy), 1e-3),
      );
      sx *= scale;
      sy *= scale;
    }

    pinScratch.push({
      x: cx + sx,
      y: cy + sy,
      edge: outside,
      // The chevron points along the direction of travel; its art points up.
      angle: angle + Math.PI / 2,
      distance: Math.hypot(marker.x - eye.x, marker.z - eye.z),
      color: `#${marker.color.toString(16).padStart(6, '0')}`,
      kind: marker.kind,
      quiet: anyActive && marker.active !== true,
    });
  }
  return pinScratch;
}

const modeContext: ModeContext = {
  world, build, player, actors, camera, projectiles,
  rng: new Rng('round-1'),
  emit: (e) => events.push(e),
  worldChanged: () => worldChanged(),
};

/** null means free build with no rules. */
let mode: GameMode | null = null;

/**
 * The local player's will to fight this tick.
 *
 * Rebuilt in place rather than allocated, because it is read once a tick for
 * sixty ticks a second and the shape never changes.
 */
const localInput: ActorInput = { ...IDLE_INPUT };

/**
 * What everybody is trying to do, as the running mode asks about them.
 *
 * The local player's comes off this keyboard and this camera. Everybody else's
 * comes out of the last command they sent, which the host already had and used
 * to walk their body and nothing else — reading the rest of it is the whole of
 * how a guest gets to throw anything.
 */
const modeInput: ModeInput = {
  of: (id) => {
    if (id === actors.local.id) return localInput;
    return net instanceof NetHost ? net.inputOf(id) : IDLE_INPUT;
  },
};

/** Which entry of the mode's weapon wheel is held, for the wire. */
function heldSlot(): number {
  const loadout = mode?.loadout;
  if (loadout === undefined) return 0;
  return Math.max(0, loadout.entries.findIndex((e) => e.id === loadout.selected));
}

// ── Multiplayer ──────────────────────────────────────────────────────────────
//
// One object either way. The rest of the loop asks it two questions — "did
// anything arrive" and "here is what just happened" — and never has to know
// which side of the connection it is on.
const sessionContext: SessionContext = {
  world, build, actors, local: player, projectiles,
  worldChanged: () => worldChanged(),
  spawnFor: (team) => (team === 'left' ? LEFT_SPAWN : RIGHT_SPAWN),
  mode: () => (isGuest() ? null : mode),
  setRound: (round) => adoptRound(round),
};

/**
 * The host's round, arriving on a guest.
 *
 * A guest never builds a mode object of its own — it wears one. `RemoteMode` is
 * a `GameMode` that answers every question from what the host last said, so the
 * HUD, the compass, the result screen and the build gate all run through code
 * that has no idea a network is involved.
 *
 * The lumber deserves a note. The build system is handed the remote mode's
 * mirrored pile, so a guest's ghost turns red when the *yard* runs out rather
 * than a round trip after they click. Its own placements are still refused or
 * allowed by the host, which is the only opinion that counts; this just stops
 * the local preview from lying in between.
 */
function adoptRound(round: PackedRound | null): void {
  if (round === null || round.id === null) {
    if (remoteMode !== null) {
      remoteMode = null;
      mode = null;
      build.setLumber(undefined);
    }
    return;
  }
  if (remoteMode === null) {
    remoteMode = new RemoteMode(
      (id) => (net instanceof NetClient ? net.wetnessOf(id) : 0),
      () => (net instanceof NetClient ? net.mine : null),
    );
    mode = remoteMode;
    modeOverTimer = 0;
  }
  remoteMode.apply(round);
  build.setLumber(round.wood === null ? undefined : remoteMode.lumber);
}

/** The round a guest is watching, or null when hosting or alone. */
let remoteMode: RemoteMode | null = null;

let net: NetHost | NetClient | null = null;

/** True when somebody else's browser owns the world. */
function isGuest(): boolean {
  return net instanceof NetClient;
}

/** The host's single relay connection, which several guests share. */
let relayLink: RelayHostLink | null = null;
/** A scenario standing in for a second player. Null in a real session. */
let fakeGuest: Transport | null = null;
/** A scenario standing in for the host, when the page is the guest. */
let fakeHost: Transport | null = null;
let netMessage: string | null = null;

/**
 * Open the yard.
 *
 * The relay hands over one transport per guest, and each one goes straight to
 * the session — which cannot tell them apart from the loopback pair the tests
 * use, and does not need to.
 */
function startHosting(url: string, room: string): NetHost {
  leaveSession();
  const host = new NetHost(sessionContext);
  net = host;
  relayLink = new RelayHostLink(url, room, (transport) => host.accept(transport), (m) => {
    netMessage = m;
  });
  netMessage = `hosting "${room}"`;
  applyPause();
  return host;
}

function joinSession(url: string, room: string, name = 'kid'): NetClient {
  leaveSession();
  const client = new NetClient(sessionContext, new SocketTransport(relayUrl(url, room)), name);
  net = client;
  netMessage = `joining "${room}"`;
  applyPause();
  return client;
}

/** Attach a session over an already-made transport. For scenarios and tests. */
function hostOver(transport: Transport): NetHost {
  const host = net instanceof NetHost ? net : startHostingHeadless();
  host.accept(transport);
  return host;
}

function startHostingHeadless(): NetHost {
  leaveSession();
  const host = new NetHost(sessionContext);
  net = host;
  netMessage = 'hosting';
  applyPause();
  return host;
}

function leaveSession(): void {
  // A round belonging to a host you are no longer connected to would otherwise
  // keep its last frame forever: a frozen timer, a score nobody is playing for,
  // and objectives pinned to a game that is still going on without you.
  if (remoteMode !== null) {
    remoteMode = null;
    mode = null;
    build.setLumber();
  }
  net?.close();
  net = null;
  relayLink?.close();
  relayLink = null;
  netMessage = null;
  // Back to being the only person here. Without this, leaving a session leaves
  // everyone who was in it standing on the lawn forever.
  actors.identifyLocal(LOCAL_ACTOR_ID);
  actors.refresh(mode?.bots ?? []);
  // Alone again, so a menu means what it used to mean.
  applyPause();
}

/** A line about the connection for the menu, or null when playing alone. */
function sessionStatus(): string | null {
  if (net === null) return null;
  const status = net.status;
  const who = status.role === 'host' ? 'Hosting' : 'Playing in someone else\'s yard';
  const people = status.peers === 1 ? '1 other person' : `${status.peers} other people`;
  return `${who} — ${people}${status.message === null ? '' : `. ${status.message}`}`
    + (netMessage === null ? '' : ` (${netMessage})`);
}

/** The world as it was when the round began, for restarts. */
let roundSnapshot: ReturnType<typeof build.serialize> | null = null;
/** Which mode a restart should rebuild. */
let lastModeId: ModeId = 'fortDefense';

/**
 * Why a mode cannot be *started* here, or null.
 *
 * A guest plays every mode; it just does not start one. The rules run on the
 * authority and nowhere else — a guest that ran its own would spawn its own bots
 * into its own roster, roll its own RNG for its own timings, keep its own score
 * and hand itself a budget the host has never heard of. Two games with the same
 * name, diverging from the opening tick.
 *
 * So this is not a lock on the door any more, it is an answer to "who deals".
 * The host picks; everybody joins whatever was picked, within a couple of
 * hundred milliseconds, without touching this menu at all.
 */
function modesBlocked(): string | null {
  if (!isGuest()) return null;
  return 'Whoever is hosting picks the game — you will join it the moment they do.';
}

function startRound(id: ModeId = lastModeId): void {
  // Refused here as well as hidden in the menu, because the menu is one caller
  // and this is the door.
  if (modesBlocked() !== null) return;
  lastModeId = id;
  roundSnapshot = build.serialize();
  mode = createMode(id);
  mode.start(modeContext);
  // After start(), which is where a mode sets its opening pile.
  build.setLumber(mode.lumber);
  audio.play('roundStart', { volume: 0.6 });
  resetPlayerToSpawn(id);
}

function stopRound(): void {
  mode?.end(modeContext);
  mode = null;
  // A guest's round is a view of somebody else's, so dropping the view is all
  // there is to stop. Without this the shell has no mode and the session still
  // has a `RemoteMode`, and the next snapshot updates an object nothing is
  // reading — the HUD goes blank while the round carries on around you.
  remoteMode = null;
  // Free build has no budget; leaving a round has to hand the sandbox back.
  build.setLumber();
  projectiles.clear();
  modeRenderer.clear();
  characters.hideAll();
  // A mode keeps the roster in step while it is ticking; when it stops ticking
  // there is nobody left to draw but the player.
  actors.refresh([]);
}

function restartRound(): void {
  // A guest cannot restart somebody else's round, and the failure if it tried
  // would be quiet and nasty: `stopRound` then puts the yard back to *this*
  // machine's snapshot of it, so the guest would be standing in a world the host
  // has never seen and every placement either side made would disagree.
  if (modesBlocked() !== null) return;
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
  // Two buttons rather than one and a flag. The relay makes the first tab in a
  // room the host, but the *game* has to be told which it is, because hosting
  // means running the simulation and joining means following one — and a player
  // who guessed wrong would rather be told than silently become the authority.
  onHost: (url: string, room: string) => startHosting(url, room),
  onJoin: (url: string, room: string) => joinSession(url, room),
  onLeaveSession: () => leaveSession(),
  sessionStatus: () => sessionStatus(),
  modesBlocked: () => modesBlocked(),
  onPlaySandbox: () => {
    stopRound();
    resetPlayerToSpawn();
    enterPlay();
  },
  onResume: () => enterPlay(),
  onRestart: () => restartRound(),
  onQuitToTitle: () => {
    // Leaving somebody else's round means leaving their yard. Quitting the round
    // alone would put a guest on the title screen and then hand them straight
    // back into it on the next snapshot, because the round is not theirs to end
    // — which reads as a broken button rather than as a rule.
    if (isGuest()) leaveSession();
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
  applyPause();
  // The HUD is about the world, and the world is not running.
  hud.root.style.display = screen === 'pause' ? '' : 'none';
  input.setEnabled(false);
  input.exitPointerLock();
}

/**
 * Stop the world, but only if it is yours to stop.
 *
 * You cannot pause a game other people are playing, and trying to does more than
 * fail politely. The loop is where the session drains the wire, so a paused guest
 * stops hearing about the round entirely — while the host, which has no idea a
 * menu is open, goes on running that guest's body from the last command it
 * received. Their character keeps walking on everybody else's screen, and the
 * moment they resume they are dragged back across however far it got.
 *
 * So in a session the world keeps turning and the menu only takes the cursor and
 * the controls. Standing still with your hands off the keyboard is what being
 * away actually looks like, and it is what everybody else sees.
 */
function applyPause(): void {
  loop.setPaused(menu.isOpen && net === null);
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
        // Says "that was you". Before this, connecting and missing looked the
        // same from behind the crosshair, and the only thing that moved was a
        // meter on a body forty metres away.
        hud.hitMarker(performance.now() / 1000);
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
characters.setViewportHeight(window.innerHeight);
// The starter structures are already in; draw their shadows on the first frame
// rather than a quarter second later.
invalidateShadows();
renderer.shadowMap.needsUpdate = true;

// The local player is drawn by the shared character rig along with everyone
// else — see `drawCharacters`. There is no separate avatar: a player drawn by
// different code from the people around them stops looking like one of them,
// which is exactly what the old blue capsule with a yellow ball on top did.

/**
 * What you are holding, in front of the camera.
 *
 * First person was an empty screen with a crosshair on it, which reads as a
 * floating eye rather than a kid in a garden — and it also meant the only way to
 * know what you were about to use was to read a chip in the corner.
 *
 * Positioned relative to the camera every frame rather than parented to it. A
 * child of the camera would inherit its near-plane clipping and its shake, and
 * this needs to lag the camera slightly, which is most of what makes a held
 * object feel like it has weight.
 */
const viewmodel = new THREE.Group();
const viewPlank = new THREE.Mesh(
  chamferedBox(0.52, 0.045, 0.12, 0.01),
  new THREE.MeshToonMaterial({ color: 0xd8a866 }),
);
viewPlank.rotation.set(0.05, 0.38, 0.20);
const viewSoaker = new THREE.Group();
{
  const tank = new THREE.Mesh(
    chamferedBox(0.3, 0.13, 0.13, 0.03),
    new THREE.MeshToonMaterial({ color: 0x3fa8d8 }),
  );
  const nozzle = new THREE.Mesh(
    chamferedBox(0.34, 0.05, 0.05, 0.015),
    new THREE.MeshToonMaterial({ color: 0xf2c94c }),
  );
  nozzle.position.set(0.3, 0.02, 0);
  const grip = new THREE.Mesh(
    chamferedBox(0.07, 0.16, 0.07, 0.02),
    new THREE.MeshToonMaterial({ color: 0xe06a4f }),
  );
  grip.position.set(-0.05, -0.13, 0);
  viewSoaker.add(tank, nozzle, grip);
  viewSoaker.rotation.set(0.04, -0.22, 0.06);
}
viewmodel.add(viewPlank, viewSoaker);
// Never shadowed or shadowing: it is inches from the eye, so a shadow map at
// world scale has nothing useful to say about it and only produces acne.
viewmodel.traverse((o) => { o.castShadow = false; o.receiveShadow = false; });
scene.add(viewmodel);

/** Where the held thing sits relative to the eye: forward, right, and down. */
const HOLD_FORWARD = 0.78;
const HOLD_RIGHT = 0.34;
const HOLD_DOWN = -0.42;

/** Lagged copy of the camera's aim, so the held thing swings a beat behind. */
const viewLag = { yaw: 0, pitch: 0, bob: 0 };

/**
 * The shortest way round from one angle to another.
 *
 * Yaw wraps at ±π, so chasing it by plain subtraction sends the viewmodel the
 * long way round the moment the player crosses the seam — a full spin of the
 * held object for a one-degree turn.
 */
function shortestAngle(from: number, to: number): number {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

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

/**
 * Place, and make a sound about it. Returns whether anything was placed.
 *
 * A guest asks rather than places: the host owns the world, and a client that
 * put the plank down itself would be building a second, private world that
 * happens to look similar. The sound plays on the request, because the delay
 * between asking and being answered is exactly the round trip and a click that
 * feels like nothing is a click the player repeats.
 */
function tryPlaceWithFeedback(): boolean {
  const record = build.place();
  if (record === null) return false;
  if (net instanceof NetClient) {
    net.requestPlacement(record);
    sounds.placed(record.x, record.y, record.z, camera, player);
    return true;
  }
  if (!build.tryPlace()) return false;
  const id = build.lastPlacedId;
  if (id !== null && net instanceof NetHost) net.announcePlacement(id, record);
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

  // Before anything else this tick: whatever arrived is applied at a tick
  // boundary, never in the middle of one. A socket that could deliver mid-step
  // is a socket that can split one tick's inputs across two.
  net?.beforeTick();

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

  // What the player wants this tick, as data rather than as a function call.
  // The controller is driven from a command whether it came from these keys, a
  // recording, or eventually another machine — there is one path, so a replay
  // cannot diverge from live play by taking a different one.
  const axis = input.moveAxis;
  const basis = camera.getMoveBasis();
  localCommand.tick = simTick;
  localCommand.moveX = axis.z * basis.fx + axis.x * basis.rx;
  localCommand.moveZ = axis.z * basis.fz + axis.x * basis.rz;
  localCommand.climb = axis.z;
  localCommand.yaw = camera.yaw;
  localCommand.pitch = camera.pitch;
  localCommand.buttons =
    (input.isDown('jump') ? BUTTON.jump : 0) |
    (sprintLatched ? BUTTON.sprint : 0) |
    (crouchLatched ? BUTTON.crouch : 0) |
    // The trigger, which a guest's host reads to fire on their behalf. It went
    // unset for as long as the only person who could throw anything was
    // whoever the mode was running on.
    (input.isDown('placePart') ? BUTTON.fire : 0);
  localCommand.slot = heldSlot();

  // The same three facts the host will derive from that command, for the person
  // sitting here — built from the camera rather than from the yaw and pitch so
  // the local player aims with the exact vector the crosshair is drawn on.
  {
    const look = camera.getLookDirection();
    localInput.fire = input.isDown('placePart');
    localInput.firePressed = input.wasPressed('placePart');
    localInput.fireReleased = input.wasReleased('placePart');
    localInput.aimX = look.x;
    localInput.aimY = look.y;
    localInput.aimZ = look.z;
  }

  // Being soaked slows the player. Applied here rather than baked into the
  // command because it is a rule the mode applies to your intent, not part of
  // the intent: a soaked player is pushing the stick just as hard.
  player.step(dt, commandToIntent(localCommand, mode?.playerSpeedScale ?? 1));
  // After the step, so a guest records what it predicted for this tick and the
  // host publishes where everybody actually ended up.
  if (net instanceof NetHost) net.afterTick(dt);
  else net?.afterTick(dt, localCommand);
  simTick++;

  // Keep the roster honest even with no mode running.
  //
  // A mode refreshes it at the top of its own tick, because a mode owns its
  // bots. Nothing did when there was no mode, so anybody who joined a Free Build
  // session existed, collided and could be hit — and was never drawn, because
  // drawing walks the roster. The bug only appears once there is a way to join a
  // sandbox, which is exactly what a network is.
  if (mode === null) actors.refresh([]);
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
  //
  // Off for a guest. Repeat places directly through the build system, and
  // routing a whole chain through the authority one request at a time is a
  // different design rather than a wiring change — so it is disabled honestly
  // instead of quietly building a private world that drifts from everyone
  // else's.
  if (canBuild && !isGuest()) {
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
    if (net instanceof NetClient) {
      // Named by the host's id for it, which the session translates. Nothing
      // disappears here until they say so.
      if (aimed >= 0) {
        net.requestRemoval(aimed);
        sounds.removed(px, py, pz, camera, player);
      }
    } else if (build.removeAimed()) {
      if (net instanceof NetHost && aimed >= 0) net.announceRemoval(aimed);
      worldChanged();
      sounds.removed(px, py, pz, camera, player);
    }
  }

  // Undo is off for a guest for the same reason as repeat.
  if (!isGuest() && input.wasPressed('interact') && build.undo()) {
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

  // ── What you are holding ───────────────────────────────────────────────────
  // Hidden in third person, where seeing your own body answers the question.
  const holdingWeapon = mode !== null && !mode.buildingAllowed;
  viewmodel.visible = !camera.showsPlayer;
  viewPlank.visible = !holdingWeapon;
  viewSoaker.visible = holdingWeapon;
  if (viewmodel.visible) {
    // Chases the camera rather than matching it. Exact tracking makes a held
    // object feel welded to your eyes; a little lag reads as weight.
    const chase = Math.min(1, frameDt * 14);
    viewLag.yaw += shortestAngle(viewLag.yaw, camera.yaw) * chase;
    viewLag.pitch += (camera.pitch - viewLag.pitch) * chase;
    // Bob with ground speed, and only on the ground — a bobbing viewmodel in
    // mid-air is the classic tell that it is driven by a timer, not by walking.
    const walking = state.onGround ? Math.hypot(state.vx, state.vz) : 0;
    viewLag.bob += frameDt * walking * 7.5;

    // The camera's own basis, derived rather than guessed: at yaw 0 the rig
    // looks along -Z, so forward is (-sin, 0, -cos) and right is (cos, 0, -sin).
    // The first attempt used a hand-rolled pair of these and put a 0.6m plank
    // half a metre from the eye, filling a quarter of the screen.
    const sy = Math.sin(viewLag.yaw);
    const cy = Math.cos(viewLag.yaw);
    const eyeY = state.y + state.eyeHeight;
    const bobY = Math.sin(viewLag.bob) * 0.014 * Math.min(1, walking / 4);
    const bobX = Math.sin(viewLag.bob * 0.5) * 0.010 * Math.min(1, walking / 4);
    viewmodel.position.set(
      state.x + -sy * HOLD_FORWARD + cy * (HOLD_RIGHT + bobX),
      eyeY + HOLD_DOWN + bobY,
      state.z + -cy * HOLD_FORWARD + -sy * (HOLD_RIGHT + bobX),
    );
    viewmodel.rotation.set(viewLag.pitch * 0.4, viewLag.yaw, 0, 'YXZ');
  }

  const nowSeconds = performance.now() / 1000;
  flushShadows(nowSeconds);
  drainEvents();
  modeRenderer.setStream(
    mode?.stream ?? null,
    state.x, state.y + state.eyeHeight * 0.82, state.z,
  );
  // Everybody, drawn by one rig.
  //
  // The local player goes in the same list as everyone else, and drops out of it
  // only in first person — where they would otherwise be drawn from inside their
  // own head, which is a wall of shirt across the screen rather than a character.
  drawnActors.length = 0;
  for (const who of actors.all) {
    if (who.id !== actors.local.id || camera.showsPlayer) drawnActors.push(who);
  }
  characters.begin();
  modeRenderer.update(frameDt, mode, projectiles, performance.now() / 1000, drawnActors);
  characters.finish();

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
    now: nowSeconds,
  });
  hud.setPins(projectPins(mode, state));
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
  characters.setViewportHeight(window.innerHeight);
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
  /** Wood left, and what the held part costs, for the budget scenario. */
  lumber: () => ({
    // A boolean rather than trusting Infinity to survive the bridge into a
    // scenario, where it would arrive as null and read as "no wood at all".
    unlimited: build.lumber.unlimited,
    available: build.lumber.unlimited ? -1 : build.lumber.available,
    cost: build.selectedCost,
    affordable: build.canAffordSelected,
  }),
  setLumber: (amount: number) => build.lumber.set(amount),
  /** The preview's current outline colour, for checking it says "no". */
  ghostTint: () => build.ghostTint,
  actionDown: (a: string) => input.isDown(a as Action),
  /**
   * Movement intent this frame, stick and keys summed.
   *
   * Exposed for the controller scenario, which needs to check that unplugging a
   * pad leaves nothing held. Watching the player's feet instead cannot tell a
   * released stick from one still pushed into a fence.
   */
  moveAxis: () => input.moveAxis,
  /** Stick look rate this frame, for the same reason as moveAxis. */
  padLook: () => input.padLook,
  actors,
  /**
   * Put a second person in the world without a network to bring them.
   *
   * The whole remote path — roster, collision, drawing, team colour — exists
   * before any socket does, and this is what lets it be checked. When a
   * transport arrives it will call exactly this, so the scenario driving it is
   * testing the real thing rather than a stand-in.
   */
  addRemoteActor: (id: number, team: Team, x: number, y: number, z: number) => {
    actors.addRemote({
      id, kind: 'remote', team,
      controller: new CharacterController(world, x, y, z),
    });
  },
  removeRemoteActor: (id: number) => actors.removeRemote(id),
  /** Drive a remote actor the way a received command would. */
  stepRemoteActor: (id: number, moveX: number, moveZ: number) => {
    const who = actors.get(id);
    if (who === undefined || who.kind !== 'remote') return null;
    const command = makeCommand(simTick);
    command.moveX = moveX;
    command.moveZ = moveZ;
    who.controller.step(DT, commandToIntent(command));
    return { x: who.controller.x, y: who.controller.y, z: who.controller.z };
  },
  /**
   * The exact order the character rig drew people in this frame.
   *
   * Exposed because the instance index is what a scenario needs to read a
   * colour off the buffer, and re-deriving it from the roster is re-implementing
   * the renderer's own rule — which is how a test ends up checking a coincidence
   * rather than a colour.
   */
  drawnActorIds: () => drawnActors.map((a) => a.id),
  /**
   * Toggle only the characters' ink, leaving the world's alone.
   *
   * Separate from the setting because "does this pass render" is answered by
   * changing one thing and diffing the picture, and the setting changes every
   * outline in the scene at once — which cannot tell a character's shell from a
   * fence post's.
   */
  setCharacterOutlines: (visible: boolean) => characters.setOutlinesVisible(visible),
  /** How many people the rig drew last frame. */
  charactersPosed: () => characters.posed,
  /**
   * Host, and hand the caller the other end of a guest's connection.
   *
   * A second full game in the same page is not possible — main.ts is a module,
   * and there is one world — so the scenario *is* the second player, speaking
   * the real protocol down a real transport into the real session. Everything on
   * this side of the pipe is exactly what a relay would drive.
   */
  hostWithFakeGuest: (): void => {
    const pipe = loopbackPair();
    fakeGuest = pipe.client;
    hostOver(pipe.host);
  },
  guestSend: (message: unknown): void => {
    fakeGuest?.send(message as Parameters<Transport['send']>[0]);
  },
  guestDrain: (): unknown[] => fakeGuest?.drain() ?? [],
  /**
   * The mirror image: this page becomes the guest, and the caller plays host.
   *
   * Needed because the two halves of a session make very different claims, and
   * only one of them has ever been checked in a browser. Hosting proves that
   * somebody who joined is drawn. Being a guest is the claim that a round
   * somebody else is running arrives as *pixels on this screen* — a phase on the
   * banner, a clock counting down, a pin on the compass — and no amount of
   * unit-testing the session reaches those.
   */
  joinFakeHost: (): void => {
    leaveSession();
    const pipe = loopbackPair();
    fakeHost = pipe.host;
    const client = new NetClient(sessionContext, pipe.client, 'scenario');
    net = client;
    netMessage = 'joined';
    applyPause();
  },
  hostSend: (message: unknown): void => {
    fakeHost?.send(message as Parameters<Transport['send']>[0]);
  },
  hostDrain: (): unknown[] => fakeHost?.drain() ?? [],
  netStatus: () => net?.status ?? null,
  /**
   * What this build speaks.
   *
   * Read by the scenarios rather than written into them. A scenario with the
   * version typed in as a literal starts being refused the moment the protocol
   * changes, and the failure — "expected a welcome, saw refused" — says nothing
   * about the version being the reason.
   */
  protocolVersion: PROTOCOL_VERSION,
  /** What is being played here, and whether this machine is the one deciding. */
  roundInfo: () => ({
    mode: mode?.id ?? 'none',
    phase: mode?.hud().phase ?? null,
    guest: isGuest(),
    wood: mode?.hud().lumber ?? null,
    markers: mode?.markers().length ?? 0,
    finished: mode?.finished ?? false,
  }),
  leaveSession: () => {
    fakeGuest?.close();
    fakeGuest = null;
    fakeHost?.close();
    fakeHost = null;
    leaveSession();
  },
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
  /**
   * Aim at a world point and take down what is there.
   *
   * By point rather than by the angle that placed it, because those are not the
   * same ray: a placement snaps to a surface, so the part ends up next to where
   * you were pointing rather than on it. Re-aiming at the old angle happened to
   * hit it on one machine and missed on a slower one.
   */
  removeAtPoint: (x: number, y: number, z: number): boolean => {
    const state = player.sample(1);
    const ex = state.x, ey = state.y + state.eyeHeight, ez = state.z;
    camera.yaw = Math.atan2(-(x - ex), -(z - ez));
    camera.pitch = Math.atan2(y - ey, Math.hypot(x - ex, z - ez));
    const ray = camera.getAimRay(ex, ey, ez, MAX_REACH);
    build.update(DT, ray.ox, ray.oy, ray.oz, ray.dx, ray.dy, ray.dz, false, false);
    const ok = build.removeAimed();
    if (ok) worldChanged();
    return ok;
  },
  /** Where the last placement landed, so a scenario can aim back at it. */
  lastPlacedAt: () => build.lastPlacedAt,
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
      // and a cooldown-gated weapon is not treated as spam. Aimed straight
      // ahead from wherever the camera is, since there is nobody to turn it.
      const look = camera.getLookDirection();
      mode.fixedUpdate(DT, modeContext, sameForEveryone({
        fire, firePressed: fire && i === 0, fireReleased: false,
        aimX: look.x, aimY: look.y, aimZ: look.z,
      }));
      if (until !== undefined && mode.hud().phase === until) break;
    }
    drainEvents();
    return { phase: mode.hud().phase, bots: mode.bots.length };
  },
  /**
   * How many balloons this machine would draw right now.
   *
   * For the party scenario, which has to tell "the host's balloons reached this
   * screen" from "the count happens to be right". A guest runs no projectile
   * simulation at all, so on that side this is purely what arrived in a
   * snapshot.
   */
  balloonsDrawn: () => projectiles.activeCount,
  projectiles,
  world,
  build,
  player,
  camera,
  scene,
  renderer,
};
