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
import { TICK_RATE, DT, CAP_HEIGHT } from './physics/constants.ts';
import { createScene } from './world/scene.ts';
import {
  AFTERNOON, DUSK, GOLDEN, dayTimeForRound, lampGlowAt, type DayTime,
} from './world/daylight.ts';
import { installFixtures } from './world/neighborhood.ts';
import { PartRenderer } from './render/partRenderer.ts';
import { chamferedBox } from './render/geometry.ts';
import { BuildSystem, type PlacementRecord } from './build/buildSystem.ts';
import { CharacterController, type MoveIntent } from './player/controller.ts';
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
import { CharacterBatch, dress, undressAll, wearing } from './render/character.ts';
import { LockerStore, MAX_PRESETS } from './app/lockerStore.ts';
import { clampAppearance, defaultAppearance, type Appearance } from './game/appearance.ts';
import { NetHost, NetClient, type SessionContext } from './net/session.ts';
import { SocketTransport, loopbackPair, type Transport } from './net/transport.ts';
import { RelayHostLink, relayUrl } from './net/relayLink.ts';
import { RemoteMode } from './net/remoteMode.ts';
import { applyItems } from './game/itemField.ts';
import { PLAY_HALF, enforceBounds, installBarrier } from './world/bounds.ts';
import {
  CommsLog, EMOTE_LABELS, EMOTE_ORDER, type Channel, type EmoteKind, type PingKind,
} from './game/comms.ts';
import type { HeardEvent } from './net/session.ts';
import { BlueprintStore } from './app/blueprintStore.ts';
import {
  blueprintCost, connectedFrom, normalize, stampAt, type Blueprint,
} from './build/blueprint.ts';
import { VoiceChat } from './voice/voiceChat.ts';
import { transmitting } from './voice/voiceRules.ts';
import { IdentityStore } from './app/identity.ts';
import { LobbyClient, lobbyUrl, socketLink, type Matched } from './net/lobby.ts';
import { QUEUE_MODES } from './net/lobbyProtocol.ts';
import { PROTOCOL_VERSION, type PackedRound } from './net/protocol.ts';
import { FortDefenseMode } from './game/fortDefense.ts';
import { CaptureTheFlagMode } from './game/captureTheFlag.ts';
import { WaterWarMode } from './game/waterWar.ts';
import { TagMode, IT_SPAWN } from './game/tag.ts';
import { LavaMode, LAVA_SPAWN, COURSE as LAVA_COURSE } from './game/lava.ts';
import { BOARD_THICKNESS } from './build/partKit.ts';
import { LEFT_SPAWN, RIGHT_SPAWN, WATER_SOURCES } from './world/neighborhood.ts';
import { IDLE_INPUT, sameForEveryone } from './game/gameMode.ts';
import type {
  ActorInput, GameEvent, GameMode, Marker, ModeContext, ModeInput,
} from './game/gameMode.ts';
import { SettingsStore, ghostColors, loadBindings, saveBindings, clearBindings } from './app/settings.ts';
import { BINDING_GROUPS, describeKey, labelFor, type Action } from './core/input.ts';
import { BuildStore } from './app/buildStore.ts';
import { Menu, type LobbyView } from './ui/menu.ts';
import { CrashHandler } from './app/crashHandler.ts';
import { GamepadManager } from './core/gamepadManager.ts';
import { PerformanceGovernor } from './app/performanceGovernor.ts';
import { FrameStats } from './app/frameStats.ts';

/** How far off the window edge an off-screen objective chevron sits. */
const PIN_EDGE_MARGIN = 54;
/** Objectives are pinned above the thing rather than at its feet. */
const PIN_HEIGHT = 1.4;
/**
 * Nearer than this and an objective is not pinned at all.
 *
 * A pin is a direction and a distance, and both are noise once you are standing
 * on the thing: the chevron spins as you turn and the label reads "0m", which
 * is the compass telling you where you already are. It never came up while
 * every objective was a stash or a tap, because you are rarely inside one.
 *
 * Tag pins people, including the chaser — and in a solo round the chaser is
 * you, so without this the first thing the mode draws is a pin on your own hat.
 */
const PIN_MIN_DISTANCE = 2.5;


/**
 * The modes a player can start.
 *
 * A registry rather than a `new FortDefenseMode()` at the one call site, because
 * the menu, the restart path and the debug API all need to name a mode and none
 * of them should be able to name one that does not exist.
 */
export type ModeId = 'fortDefense' | 'captureTheFlag' | 'waterWar' | 'tag' | 'lava';

export const MODES: ReadonlyArray<{ id: ModeId; name: string; blurb: string }> = [
  {
    // First on the list, because it is the one that is about the thing the game
    // is named after — and because it is the only one whose rules a player
    // already knows before they read the card.
    id: 'lava',
    name: 'The Floor Is Lava',
    blurb: 'The grass is lava. Get round the garden on the roofs, the crates and whatever you nail together.',
  },
  {
    id: 'captureTheFlag',
    name: 'Capture the Flag',
    blurb: 'Their flag is past the house. Build a way over, and a way to stop them.',
  },
  {
    id: 'tag',
    name: 'Tag',
    blurb: 'Freeze tag, out the front gate and all over the street. No planks, just legs.',
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
  if (id === 'lava') return new LavaMode();
  if (id === 'captureTheFlag') return new CaptureTheFlagMode();
  if (id === 'waterWar') return new WaterWarMode();
  if (id === 'tag') return new TagMode();
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
const {
  scene, invalidateShadows, setDaylight, props: scenery, slabs, lights: nightLights,
} = createScene('backyard-01');
const world = new CollisionWorld(1.0, 4096);
// The map's solid geometry, from the same numbers the scenery was drawn with.
// Installed before anything else touches the world so the starter structures
// and the player both spawn against a house that is already there.
installFixtures(world, slabs);
// And the four walls at the edge of it. Separate because they are not scenery:
// nothing draws them, and the slab list is a description of what the yard looks
// like rather than of where it ends.
installBarrier(world);
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

/**
 * How long an afternoon takes, in seconds of play.
 *
 * Five minutes, which is the length of a round of Lava and a good long one of
 * anything else — so a game that goes the distance ends at dusk and a quick one
 * ends in the gold. It is not the length of any particular mode on purpose:
 * tying it to a mode's own timer means it resets every time a phase does, and
 * Fort Defense would run the sun backwards five times a round.
 */
const AFTERNOON_LENGTH = 300;

/**
 * Seconds of round played, which is the only clock the sky reads.
 *
 * Advanced by the loop rather than taken from `mode.hud().timer`, for the
 * reason above, and reset when a round starts. Outside a round it does not
 * move, so the yard behind the menu is the afternoon it has always been.
 */
let roundClock = 0;

/**
 * Where in the afternoon to draw.
 *
 * A player who wants the golden hour for a screenshot should not have to play
 * four minutes of a round to get it, and a player who finds a changing sky
 * distracting should be able to nail it down. `round` is the default because it
 * is the one that means anything.
 */
function roundDayTime(): DayTime {
  switch (settings.get('timeOfDay')) {
    case 'afternoon': return AFTERNOON;
    case 'golden': return GOLDEN;
    case 'dusk': return DUSK;
    default: return dayTimeForRound(roundClock, AFTERNOON_LENGTH);
  }
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
if (savedBindings !== null) input.setBindingSlots(savedBindings);

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
/**
 * Everything anybody said, on this machine.
 *
 * The shell's, not a mode's: you can ping in Free Build, and a round ending
 * does not end a conversation.
 *
 * Declared up here rather than beside the rest of the comms plumbing because
 * `settings.subscribe` fires immediately with the stored values, and the mute
 * settings read this — declared below, it was a `ReferenceError` on the first
 * line of the first frame, which the smoke test caught as a blank screen.
 */
const comms = new CommsLog();

/**
 * Proximity voice.
 *
 * Declared beside `comms` and for the same reason — `settings.subscribe` fires
 * immediately and reads the voice settings — and given its outbound channel as
 * a closure over `net` rather than the session itself, because `net` is a `let`
 * that is null before anybody joins and a different object afterwards.
 */
const voice = new VoiceChat(audio, (to, signal) => net?.signal(to, signal));

settings.subscribe((s) => {
  camera.sensitivity = s.sensitivity;
  camera.invertY = s.invertY;
  camera.baseFov = s.fov;
  audio.setMasterVolume(s.masterVolume);
  audio.setSfxVolume(s.sfxVolume);
  comms.muteChannel('team', s.muteTeamChat);
  comms.muteChannel('near', s.muteNearChat);
  audio.setVoiceVolume(s.voiceVolume);
  // Switched on and off here rather than at the point of use, because turning
  // it on is an async permission prompt and turning it off has to release the
  // microphone — a tab that keeps the recording indicator lit after a player
  // switched voice off is a tab they will close.
  if (s.voiceEnabled) void voice.start();
  else voice.stop();
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
    // Pinned in the locker, so the player faces the camera that is otherwise
    // always behind them — and so that turning shows a different side rather
    // than the same one from a different place. See `setLockerView`.
    return lockerFacing ?? camera.yaw;
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

/**
 * The mode's objectives plus everybody's pings, in one list.
 *
 * Reused rather than rebuilt, because this runs every frame and the compass is
 * the one HUD element that reads world state per frame.
 */
const markerScratch: Marker[] = [];
function commsMarkers(active: GameMode | null): readonly Marker[] {
  const pings = comms.worldPings;
  const own = active?.markers() ?? [];
  if (pings.length === 0) return own;
  markerScratch.length = 0;
  for (const m of own) markerScratch.push(m);
  for (const p of pings) {
    markerScratch.push({
      kind: 'flag', x: p.x, y: p.y, z: p.z, color: PING_COLOR, active: true,
    });
  }
  return markerScratch;
}

/** Ping markers are the one colour nothing else in the game uses. */
const PING_COLOR = 0x7ee0ff;

/** Just the pings, for the 3D renderer, which already has the mode's own. */
const pingScratch: Marker[] = [];
function pingMarkers(): readonly Marker[] {
  pingScratch.length = 0;
  for (const p of comms.worldPings) {
    pingScratch.push({ kind: 'flag', x: p.x, y: p.y, z: p.z, color: PING_COLOR, active: true });
  }
  return pingScratch;
}

const emoteScratch: Array<{ x: number; y: number; label: string }> = [];
const emoteVec = new THREE.Vector3();

/**
 * Emote bubbles, projected to the screen.
 *
 * Screen space rather than world geometry, for the same reason the compass pins
 * are: text stays crisp at any resolution and costs no draw call, and a bubble
 * that has to stay legible at forty metres is a piece of UI wearing a hat.
 */
function projectEmotes(eye: { x: number; y: number; z: number }): typeof emoteScratch {
  emoteScratch.length = 0;
  for (const actor of actors.all) {
    const emote = comms.emoteOf(actor.id);
    if (emote === undefined) continue;
    const body = actor.controller;
    emoteVec.set(body.x, body.y + CAP_HEIGHT + 0.42, body.z);
    emoteVec.project(camera.camera);
    // Behind the eye, where projected coordinates are mirrored and meaningless.
    if (emoteVec.z > 1) continue;
    // Off screen. Unlike an objective, an emote gets no edge chevron: somebody
    // waving behind you is not information you need pinned.
    if (Math.abs(emoteVec.x) > 1 || Math.abs(emoteVec.y) > 1) continue;
    emoteScratch.push({
      x: (emoteVec.x * 0.5 + 0.5) * window.innerWidth,
      y: (-emoteVec.y * 0.5 + 0.5) * window.innerHeight,
      label: EMOTE_LABELS[emote.kind],
    });
  }
  void eye;
  return emoteScratch;
}

/**
 * What the microphone badge says.
 *
 * Four states rather than two, because "nothing is coming out" has four
 * different causes and a player who cannot tell them apart will conclude the
 * feature is broken for whichever one they are in.
 */
function micLabel(): string {
  const s = settings.current;
  if (s.micMuted) return '🔇 MUTED';
  if (voice.micSpeaking) return '🎙 LIVE';
  if (s.voicePushToTalk) return '🎙 HOLD C';
  return '🎙 OPEN';
}

const voiceScratch: Array<{ x: number; y: number }> = [];

/**
 * A speaker mark over everybody currently audible.
 *
 * Placed a little above the emote bubble rather than on it, so somebody who
 * waves while talking gets both rather than one on top of the other.
 */
function projectVoices(): typeof voiceScratch {
  voiceScratch.length = 0;
  if (!voice.live) return voiceScratch;
  for (const actor of actors.all) {
    if (actor.kind !== 'remote' || !voice.speaking(actor.id)) continue;
    const body = actor.controller;
    emoteVec.set(body.x, body.y + CAP_HEIGHT + 0.95, body.z);
    emoteVec.project(camera.camera);
    if (emoteVec.z > 1) continue;
    if (Math.abs(emoteVec.x) > 1 || Math.abs(emoteVec.y) > 1) continue;
    voiceScratch.push({
      x: (emoteVec.x * 0.5 + 0.5) * window.innerWidth,
      y: (-emoteVec.y * 0.5 + 0.5) * window.innerHeight,
    });
  }
  return voiceScratch;
}

function projectPins(active: GameMode | null, eye: { x: number; y: number; z: number }): ScreenPin[] {
  if (active === null && comms.worldPings.length === 0) {
    pinScratch.length = 0;
    return pinScratch;
  }

  const width = window.innerWidth;
  const height = window.innerHeight;
  const cx = width / 2;
  const cy = height / 2;
  // Kept off the very edge, or half the chevron sits outside the window.
  const marginX = width / 2 - PIN_EDGE_MARGIN;
  const marginY = height / 2 - PIN_EDGE_MARGIN;

  // Dimming is relative: with nothing marked active every pin came out dim,
  // which is the same as none of them being dim except harder to read.
  // A ping is an objective for six seconds. Concatenated here rather than
  // published by the mode, because none of this is a rule of any game — you can
  // ping in Free Build, and there is no mode there to publish anything.
  pinScratch.length = 0;
  const markers = commsMarkers(active);
  let anyActive = false;
  for (const marker of markers) anyActive ||= marker.active === true;

  for (const marker of markers) {
    const distance = Math.hypot(marker.x - eye.x, marker.z - eye.z);
    if (distance < PIN_MIN_DISTANCE) continue;

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
      distance,
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
  heard: (event) => receive(event),
  signalled: (from, signal) => void voice.receive(from, signal),
  wearing: (id, appearance) => dress(id, appearance),
};

/**
 * What this player looks like, and getting everyone else to agree.
 *
 * Null means "I have never opened the locker", which is not the same as any
 * particular outfit: a player who has chosen nothing should look like the
 * seeded kid their id produces, and that varies. Handing out a fixed default
 * here would make every first-time player identical.
 *
 * `applyLook` has to be called at three moments and not only when the locker
 * closes, because the local id is not a constant — it is 0 alone and whatever
 * the host assigned in somebody else's yard. So: when the outfit changes, when
 * a session is joined, and when one is left.
 */
const locker = new LockerStore();
let myAppearance: Appearance | null = locker.worn();

function applyLook(): void {
  dress(actors.local.id, myAppearance);
  // The wire only when there is one. `wear` on a client sends; on a host it
  // broadcasts and remembers, so a guest who joins later is told.
  net?.wear(myAppearance ?? wearing(actors.local.id));
}

function wearAppearance(appearance: Appearance | null): void {
  myAppearance = appearance === null ? null : locker.wear(appearance);
  applyLook();
}

/**
 * The locker's view of the player.
 *
 * The preview is the real character standing in the real yard, drawn by the
 * same rig in the same light, so all this has to do is put the camera in front
 * of them. Third person already stands behind and looks at the player, and the
 * local actor's drawn facing is normally the camera's own yaw — so pinning that
 * facing to a fixed angle is the whole of it.
 *
 * **The facing is pinned, not offset**, and that distinction is the difference
 * between a turntable and a thing that cannot be turned at all. Carried as an
 * offset from the camera, the character rotates *with* the camera and always
 * presents the same side: the first version orbited beautifully and the back
 * was unreachable, which for a screen with paint on the back is most of the
 * point missing.
 */
let lockerFacing: number | null = null;

/**
 * Where there is room to be looked at.
 *
 * The locker is opened from the pause screen as often as from the title, and
 * where somebody was standing when they paused is very often inside the thing
 * they were building. The boom collides, so it does not end up inside a wall —
 * it ends up a foot from the player's nose instead, which is a preview of a
 * chin. Eight rays and the roomiest one costs nothing and happens once.
 */
function clearestYaw(): number {
  const state = player.sample(1);
  const eyeY = state.y + state.eyeHeight;
  let best = camera.yaw;
  let bestRoom = -1;
  for (let i = 0; i < 8; i++) {
    const yaw = (i / 8) * Math.PI * 2;
    // The boom leaves the eye backwards along the facing and a little upward.
    const dx = Math.sin(yaw);
    const dz = Math.cos(yaw);
    const len = Math.hypot(dx, 0.16, dz);
    const hit = world.raycast(
      state.x, eyeY, state.z, dx / len, 0.16 / len, dz / len, 5,
    );
    const room = hit === null ? 5 : hit.distance;
    if (room > bestRoom) {
      bestRoom = room;
      best = yaw;
    }
  }
  return best;
}

function setLockerView(active: boolean): void {
  if (active) camera.yaw = clearestYaw();
  // Pinned to face whatever the camera ended up behind.
  lockerFacing = active ? camera.yaw + Math.PI : null;
  camera.frame(active);
}

/**
 * Where everybody's voice comes from, and what is in the way.
 *
 * Run every tick beside the rest of the audio. Three separate things, and the
 * reason they are one function is that all three are answers about the same
 * roster in the same instant:
 *
 * - **The mesh** follows who is in the world. Not who is in earshot — see
 *   `VoiceMesh` for why gating the connection on distance is the obvious
 *   optimisation and the wrong one.
 * - **The mix** follows where they are standing right now.
 * - **The microphone** follows whether this player is holding the key.
 */
function updateVoice(dt: number): void {
  if (!voice.live) return;
  voice.selfId = actors.local.id;
  voiceRoster.length = 0;
  for (const actor of actors.all) {
    // Bots have no microphone. Filtering on `remote` rather than on "not me"
    // matters in every solo mode, where the roster is mostly kids.
    if (actor.kind === 'remote') voiceRoster.push(actor.id);
  }
  voice.sync(voiceRoster);

  const s = settings.current;
  voice.setTransmitting(
    transmitting(s.voiceEnabled, s.micMuted, s.voicePushToTalk, input.isDown('pushToTalk')),
  );

  const eye = player.sample(1);
  const basis = camera.getMoveBasis();
  refreshOcclusion(dt, eye.x, eye.y + eye.eyeHeight, eye.z);
  voice.update(
    dt,
    {
      x: eye.x, y: eye.y + eye.eyeHeight, z: eye.z,
      rightX: basis.rx, rightZ: basis.rz,
    },
    voicePosition,
    (id) => comms.isMuted(id),
    (id) => occlusionCache.get(id) ?? false,
  );
}

const voiceRoster: number[] = [];
const voiceHead = { x: 0, y: 0, z: 0 };

/** Somebody's mouth, roughly, or null once they have left the roster. */
function voicePosition(id: number): { x: number; y: number; z: number } | null {
  const actor = actors.get(id);
  if (actor === undefined) return null;
  const body = actor.controller;
  voiceHead.x = body.x;
  voiceHead.y = body.y + CAP_HEIGHT * 0.85;
  voiceHead.z = body.z;
  return voiceHead;
}

/**
 * Is there something solid between these two people?
 *
 * One ray, head to head, against the same collision world everything else uses
 * — so a fort somebody built muffles a voice exactly as much as the house does,
 * which is the payoff for building the check on the world rather than on the
 * map's constants.
 *
 * Rechecked on a slower clock than the mix, because the answer changes when
 * somebody walks round a corner and not when they shuffle. Sixty raycasts a
 * second per speaker is a real cost for a question whose answer is stable for
 * hundreds of milliseconds at a time.
 */
const OCCLUSION_INTERVAL = 0.2;
const occlusionCache = new Map<number, boolean>();
let sinceOcclusion = OCCLUSION_INTERVAL;

/**
 * Recheck every speaker at once, or leave the cache alone.
 *
 * The whole map is built here rather than lazily inside the per-speaker
 * callback, which is what the first version did and which quietly never
 * refreshed: the clock was read inside the callback and reset nowhere, so
 * either every peer was rechecked every frame or none ever was. Doing the sweep
 * in one place makes "when" a single line.
 */
function refreshOcclusion(dt: number, ex: number, ey: number, ez: number): void {
  sinceOcclusion += dt;
  if (sinceOcclusion < OCCLUSION_INTERVAL) return;
  sinceOcclusion = 0;
  occlusionCache.clear();
  for (const id of voiceRoster) {
    const where = voicePosition(id);
    if (where === null) continue;
    const dx = where.x - ex;
    const dy = where.y - ey;
    const dz = where.z - ez;
    const distance = Math.hypot(dx, dy, dz);
    if (distance < 1e-3) continue;
    // Stopped just short of them, or the ray ends inside their own body and
    // everybody in the world is permanently behind a wall.
    occlusionCache.set(id, world.raycast(ex, ey, ez, dx, dy, dz, distance - 0.4) !== null);
  }
}


/**
 * Take something the session has already decided this player is entitled to.
 *
 * The sound is fired from the return value rather than unconditionally, which
 * is the difference between muting a person and muting their words: a muted
 * player's message must not announce itself, or every mute leaks the fact that
 * somebody is talking.
 */
function receive(event: HeardEvent): void {
  if (event.kind === 'say') {
    if (comms.say(event.from, event.name, event.channel, event.text)) sounds.comms('chat');
    return;
  }
  if (event.kind === 'ping') {
    if (comms.ping(event.from, event.pingKind, event.x, event.y, event.z)) sounds.comms('ping');
    return;
  }
  if (comms.emote(event.from, event.emoteKind)) sounds.comms('emote');
}

/**
 * Say, ping or emote — through the session when there is one, and straight into
 * the log when there is not.
 *
 * Playing alone still shows your own chat and your own pings. The alternative
 * is a feature that silently does nothing until somebody else turns up, which
 * is how a player concludes it is broken rather than empty.
 */
function sayLocally(channel: Channel, text: string): void {
  if (net !== null) {
    net.say(channel, text);
    return;
  }
  receive({ kind: 'say', from: LOCAL_ACTOR_ID, name: identity.name, channel, text });
}

function pingLocally(kind: PingKind, x: number, y: number, z: number): void {
  if (net !== null) {
    net.ping(kind, x, y, z);
    return;
  }
  receive({ kind: 'ping', from: LOCAL_ACTOR_ID, pingKind: kind, x, y, z });
}

function emoteLocally(kind: EmoteKind): void {
  if (net !== null) {
    net.emote(kind);
    return;
  }
  receive({ kind: 'emote', from: LOCAL_ACTOR_ID, emoteKind: kind });
}

/**
 * Where a ping goes: whatever you are looking at, or a point out in front.
 *
 * Cast from the eye along the crosshair rather than dropped at the player's
 * feet, because a ping means *that* and not *here*. The fallback matters as
 * much as the hit: aiming at the sky has to produce a mark somewhere sensible
 * rather than nothing at all, or the key feels broken exactly when somebody is
 * pointing at a rooftop.
 */
/**
 * Which emote the key sends.
 *
 * A cycle rather than a wheel, for now, and the comment is the honest part: a
 * radial picker already exists for parts and weapons and this should use it,
 * but wiring a third content set into it is a bigger change than the feature
 * warrants today. Tapping through six is a worse gesture than pointing at one
 * and a much better one than not being able to say "sorry".
 */
let emoteAt = 0;
function nextEmote(): EmoteKind {
  const kind = EMOTE_ORDER[emoteAt % EMOTE_ORDER.length]!;
  emoteAt++;
  return kind;
}

/**
 * Where the water is, and how much of it is left.
 *
 * Water War owns three draining taps and publishes them; every other mode is
 * played in a garden where the same three taps are simply running. Asking the
 * mode first is what makes a drained tap fall silent — the cue that mode never
 * had, where you could still hear a source you had already lost.
 */
function waterSources(): ReadonlyArray<{ x: number; z: number; water?: number }> {
  const running = mode as { sources?: ReadonlyArray<{ x: number; z: number; water: number }> } | null;
  return running?.sources ?? WATER_SOURCES;
}

const PING_RANGE = 90;
function pingAtCrosshair(): void {
  const eye = player.sample(1);
  const look = camera.getLookDirection();
  const hit = world.raycast(
    eye.x, eye.y + eye.eyeHeight, eye.z,
    look.x, look.y, look.z, PING_RANGE,
  );
  const distance = hit === null ? 18 : hit.distance;
  pingLocally(
    'look',
    eye.x + look.x * distance,
    eye.y + eye.eyeHeight + look.y * distance,
    eye.z + look.z * distance,
  );
}

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
    // A guest's afternoon starts when they start seeing a round, which is not
    // when the host's did. That is a stated limitation rather than a bug — the
    // light is not on the wire and nothing about it needs to be — but it does
    // mean somebody who joins four minutes in gets four minutes of afternoon of
    // their own rather than arriving at dusk with everybody else.
    roundClock = 0;
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

function joinSession(url: string, room: string, name = 'kid', claim?: boolean): NetClient {
  leaveSession();
  const client = new NetClient(
    sessionContext, new SocketTransport(relayUrl(url, room, claim)), name,
  );
  net = client;
  netMessage = `joining "${room}"`;
  applyPause();
  return client;
}

// ── The lobby ────────────────────────────────────────────────────────────────
//
// A second, longer-lived connection than the one a match runs on. It knows who
// your friends are and puts you in a queue; its only output is a room name,
// after which the game connects to the relay exactly as if somebody had typed
// the room in by hand. That is why a lobby going quiet cannot interrupt a
// round: once a match starts, the lobby is not in the path.

const identity = new IdentityStore();

/** Where the lobby lives, remembered so the title screen can reconnect. */
let lobbyAddress = 'ws://localhost:8787';
let lobbyClient: LobbyClient | null = null;

/**
 * Go and play the match the lobby just found.
 *
 * The host is whichever machine the lobby elected, and both sides connect to
 * the same room. The mode is started only by the host, for the same reason a
 * guest never starts one anywhere else: two machines running the rules is two
 * games with one name.
 */
/** Kept for the lobby scenario, which has no other way to see a room name. */
let lastMatch: Matched | null = null;

function enterMatch(match: Matched): void {
  lastMatch = match;
  if (match.host) {
    startHosting(lobbyAddress, match.room);
    // A beat before starting, so every guest has opened its socket and been
    // welcomed. Starting on the same tick would begin a round in front of
    // people who are not in the world yet.
    window.setTimeout(() => {
      if (net instanceof NetHost) startRound(match.mode as ModeId);
    }, 1200);
  } else {
    // Says out loud that it is not the host, so the relay does not hand this
    // socket the authority's lane just for arriving first.
    joinSession(lobbyAddress, match.room, identity.name, false);
  }
  menu.show('none');
}

function connectLobby(url = lobbyAddress): LobbyClient {
  lobbyAddress = url;
  lobbyClient?.disconnect();
  const client = new LobbyClient(identity, () => menu.refresh(), (m) => enterMatch(m));
  client.connect(socketLink(lobbyUrl(url)));
  lobbyClient = client;
  return client;
}

/**
 * The lobby as the menu wants it, or null when there is no connection.
 *
 * Assembled here rather than passing the client straight through, so the menu
 * depends on a shape instead of on the network — and so the two lists it draws
 * are plain data a test can hand it.
 */
function lobbyView(): LobbyView | null {
  const client = lobbyClient;
  if (client === null) return null;
  const state = client.current;
  return {
    connected: state.connected,
    code: state.code,
    name: state.name,
    friends: state.friends,
    party: state.party,
    invitations: state.invitations,
    queue: state.queue,
    problem: state.problem,
    modes: QUEUE_MODES.map((id) => ({
      id,
      name: MODES.find((m) => m.id === id)?.name ?? id,
    })),
    rename: (name) => client.rename(name),
    addFriend: (code) => client.addFriend(code),
    removeFriend: (code) => client.removeFriend(code),
    invite: (code) => client.invite(code),
    accept: (party) => client.accept(party),
    decline: (party) => client.decline(party),
    leaveParty: () => client.leaveParty(),
    kick: (code) => client.kick(code),
    joinQueue: (mode) => client.joinQueue(mode),
    leaveQueue: () => client.leaveQueue(),
  };
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
  // Tell the session what the host is wearing, so a guest is told at the
  // handshake rather than never — nobody sends a `wear` on the host's behalf.
  applyLook();
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
  // The local id just moved back to 0, and an outfit is worn by an id. Without
  // this, leaving somebody else's yard leaves you dressed as whoever id 0 is.
  undressAll();
  applyLook();
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
  roundClock = 0;
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
  // Capture the Flag starts you in your own yard, Tag starts you behind the
  // kids you are about to chase, and everything else starts you where the
  // starter structures are, which is what the sandbox wants.
  //
  // This runs after `mode.start`, so a mode that placed the player itself is
  // overruled here — which is why Tag's spawn is imported rather than repeated.
  // The mode owns where It stands; this owns which way they are looking, and a
  // second copy of the position would be a mode that quietly moved.
  if (id === 'captureTheFlag') player.teleport(LEFT_SPAWN.x, LEFT_SPAWN.y, LEFT_SPAWN.z);
  else if (id === 'tag') player.teleport(IT_SPAWN.x, IT_SPAWN.y, IT_SPAWN.z);
  else if (id === 'lava') player.teleport(LAVA_SPAWN.x, LAVA_SPAWN.y, LAVA_SPAWN.z);
  else player.teleport(STARTER_ORIGIN.x, 0.5, STARTER_ORIGIN.z - 9);
  // Tag looks down the garden at the runners, which is also the way they are
  // about to go: past the house, out of the gate and onto the street. Lava
  // looks west at the treehouse, which is both the first checkpoint and the
  // clearest possible statement of the problem: it is over there, and
  // everything between here and it is lava.
  camera.yaw = id === 'captureTheFlag' ? Math.PI * 0.5
    : id === 'tag' ? 0
      : id === 'lava' ? Math.PI * 0.5
        : Math.PI;
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
  lobby: () => lobbyView(),
  onOpenLobby: (url: string) => { connectLobby(url || lobbyAddress); },
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

  listBindings: () => BINDING_GROUPS.map((group) => ({
    title: group.title,
    rows: group.actions.map(({ action, label }) => ({
      action,
      label,
      keys: input.slotsFor(action).map((code) => (code === null ? null : describeKey(code))),
    })),
  })),
  rebind: (action, slot, code) => {
    const took = input.setBinding(action as Action, code, slot);
    saveBindings(input.getBindingSlots());
    // The label rather than the action name, because "Turn left" is what the
    // player just watched lose its key and `rotateCCW` is not.
    return took === null ? null : labelFor(took);
  },
  clearBinding: (action, slot) => {
    input.clearBinding(action as Action, slot);
    saveBindings(input.getBindingSlots());
  },
  resetBindings: () => {
    input.resetBindings();
    clearBindings();
  },

  // ── The locker ─────────────────────────────────────────────────────────────
  //
  // The screen edits a copy and hands it back whole on every change; nothing
  // here holds a half-built appearance. That is what lets the preview be the
  // real character rather than a model of one — there is only ever one answer
  // to "what is this player wearing", and it is the one on the lawn.
  locker: () => ({
    // The starting point when nobody has chosen is the seeded kid this player's
    // id produces, so opening the locker begins from the person they have been
    // looking at rather than from a blank mannequin.
    appearance: myAppearance ?? wearing(actors.local.id),
    presets: locker.list().map((p) => ({ name: p.name })),
    full: locker.count >= MAX_PRESETS,
  }),
  onLockerChange: (appearance) => wearAppearance(clampAppearance(appearance)),
  onLockerView: (active) => setLockerView(active),
  onLockerTurn: (delta) => { lockerFacing = (lockerFacing ?? 0) + delta; },
  // Somewhere to start from, for anybody who does not want to make forty
  // decisions. Drawn from the same generator that dresses every bot, seeded off
  // the clock rather than an id — this is the one place in the game where a
  // different answer every time is the point.
  onLockerRandom: () => wearAppearance(defaultAppearance(Math.floor(Math.random() * 1e6))),
  onLockerReset: () => {
    locker.undress();
    wearAppearance(null);
  },
  onLockerSave: (name) => locker.keep(name, myAppearance ?? wearing(actors.local.id)),
  onLockerWear: (name) => {
    const preset = locker.get(name);
    if (preset === null) return false;
    wearAppearance(preset);
    return true;
  },
  onLockerDelete: (name) => locker.remove(name),
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
  // The chat box first, in the capture-free ordinary phase but ahead of the
  // pause handler, because Escape has to close a chat box rather than pause a
  // game that is not paused. Handled here rather than through the binding
  // table for the same reason a rebind capture is: while somebody is typing,
  // every key means the letter on it.
  if (hud.saying) {
    if (e.code === 'Escape') {
      e.preventDefault();
      hud.openSay(null);
      return;
    }
    if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      e.preventDefault();
      const text = hud.sayText;
      const channel = hud.sayChannel;
      hud.openSay(null);
      if (channel !== null) sayLocally(channel, text);
    }
    return;
  }
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
      case 'partPulled':
        // The same clatter a player's own collapse makes, from where it
        // happened. A fort coming apart behind you should sound exactly like a
        // fort coming apart, whoever pulled the plank.
        sounds.collapsed(e.x, e.y, e.z, camera, player, e.brought);
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

// ── Blueprints ───────────────────────────────────────────────────────────────
//
// A blueprint takes over the place button when one is selected. That is the
// whole interaction and it is deliberate: a second placement key would mean two
// ways to put something down, and the difference between them is already
// visible in the preview.

const blueprints = new BlueprintStore();
let heldBlueprint: Blueprint | null = null;
let blueprintTurns = 0;

/** Step through none, then each blueprint, and round again. */
function cycleBlueprint(delta: number): void {
  const all = blueprints.all();
  // `null` is a real entry in the ring rather than a separate off switch, so
  // one key both chooses and puts the plank back in your hands.
  const ring: Array<Blueprint | null> = [null, ...all];
  const at = ring.findIndex((b) => b?.id === (heldBlueprint?.id ?? '__none'));
  const from = heldBlueprint === null ? 0 : Math.max(at, 0);
  const next = ((from + delta) % ring.length + ring.length) % ring.length;
  heldBlueprint = ring[next] ?? null;
  blueprintTurns = 0;
  build.showStampPreview(null);
  hud.notice(
    heldBlueprint === null
      ? 'plank'
      : `${heldBlueprint.name} — ${blueprintCost(heldBlueprint.parts)} wood`,
    1.6,
  );
}

/** Where the held blueprint would land, or null when nothing is held. */
function stampRecords(): PlacementRecord[] | null {
  if (heldBlueprint === null) return null;
  const snap = build.lastSnap;
  const c = snap?.candidate;
  if (c === null || c === undefined) return null;
  return stampAt(
    heldBlueprint.parts,
    c.position.x, c.position.y, c.position.z,
    blueprintTurns,
  );
}

/**
 * Save whatever you are looking at, and everything joined to it.
 *
 * A flood fill from the aimed part rather than a drag-selected box: no second
 * control scheme, no mode to be in, and the answer is almost always the thing
 * you meant — a staircase is connected and the lawn it stands on is not a part.
 */
function captureBlueprint(): boolean {
  const seedId = build.lastSnap?.hitPart ?? -1;
  if (seedId < 0 || !world.store.isAlive(seedId) || world.isFixture(seedId)) {
    hud.notice('look at something you built', 2);
    return false;
  }
  if (blueprints.full) {
    hud.notice('no room for another blueprint', 2);
    return false;
  }

  // The player's own parts only. The house is a fixture and saving it would
  // hand somebody a blueprint of the map.
  const ids: number[] = [];
  const boxes = [];
  for (const [id, record] of build.serializeWithIds()) {
    if (world.isFixture(id)) continue;
    ids.push(id);
    boxes.push(world.store.readAabb(id));
    void record;
  }
  const seed = ids.indexOf(seedId);
  if (seed === -1) {
    hud.notice('that is not yours to save', 2);
    return false;
  }

  const byId = new Map(build.serializeWithIds());
  const chosen = connectedFrom(seed, boxes)
    .map((i) => byId.get(ids[i]!))
    .filter((r): r is PlacementRecord => r !== undefined);
  const saved = blueprints.save(`Build ${blueprints.count + 1}`, normalize(chosen));
  if (saved === null) {
    hud.notice('could not save that', 2);
    return false;
  }
  heldBlueprint = saved;
  blueprintTurns = 0;
  hud.notice(`saved ${saved.name} — ${saved.parts.length} parts`, 2.4);
  return true;
}

/** Put the held blueprint down, through the authority when there is one. */
function stampWithFeedback(): boolean {
  const records = stampRecords();
  if (records === null) return false;
  if (net instanceof NetClient) {
    if (!build.canStamp(records)) return false;
    net.stampBlueprint(records);
    sounds.placed(records[0]!.x, records[0]!.y, records[0]!.z, camera, player);
    return true;
  }
  const ids = build.stamp(records);
  if (ids.length === 0) return false;
  if (net instanceof NetHost) {
    for (let i = 0; i < ids.length; i++) net.announcePlacement(ids[i]!, records[i]!);
  }
  worldChanged();
  sounds.placed(records[0]!.x, records[0]!.y, records[0]!.z, camera, player);
  return true;
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

  // ── Talking ────────────────────────────────────────────────────────────────
  //
  // Handled before anything else and allowed to swallow the tick, because a
  // player with the chat box open is typing rather than playing: without this,
  // "wasd" walks you into a fence while you write it.
  comms.tick(dt);
  // A player with the chat box open is typing rather than playing. `beginTick`
  // has already folded the pending keys into this tick's state, so returning
  // here consumes them — which is exactly the intent: those keystrokes were
  // letters, and letting them through walks you into a fence while you write.
  if (hud.saying) return;
  if (input.wasPressed('chatNear')) hud.openSay('near');
  else if (input.wasPressed('chatTeam')) hud.openSay('team');
  else if (input.wasPressed('ping')) pingAtCrosshair();
  else if (input.wasPressed('emoteWheel')) emoteLocally(nextEmote());

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
  // After the step, so the item sees where the body actually ended up. Run on
  // every machine rather than only the host: the effect is a pure function of
  // position, so a guest predicting its own bounce reaches the same answer on
  // the same tick and never gets corrected for it.
  // The returned item is what a bounce sound and a squash animation would hang
  // off. Neither exists yet, so it is dropped rather than wired to a cue that
  // means something else — a trampoline that clicks like a part snapping would
  // teach the wrong thing.
  applyItems(player);
  // And last of all, the boundary — after the step and after the item, because
  // both of them move a body and this is the one that gets the final say.
  //
  // On every machine for the same reason the item pass is: it is a pure
  // function of position, so a guest leaning on the wall and the host stepping
  // that guest agree, and nobody is corrected for standing still.
  if (enforceBounds(player) === 'fell') hud.notice('You fell out of the garden.');
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
  // Running water, from wherever the nearest tap is. Driven off the mode's own
  // sources when there is one so a drained tap goes quiet — the cue Water War
  // never had, where you could hear a source you had already lost — and off the
  // map's constants otherwise, because the taps are running whether or not
  // anybody is playing a game about them.
  sounds.updateWater(player, camera, waterSources());
  updateVoice(dt);

  // ── Build actions ──────────────────────────────────────────────────────────
  const hotbar = input.hotbarPressed;
  if (hotbar >= 0) build.selectKind(hotbar);

  const wheel = input.wheel;
  if (wheel !== 0) {
    if (input.isDown('sprint')) build.cycleColorway(wheel > 0 ? 1 : -1);
    else build.cycleKind(wheel > 0 ? 1 : -1);
  }

  // The same step, from a button rather than a notch of the wheel.
  //
  // `nextPart` and `prevPart` have existed since the input layer was written
  // and nothing has ever read them — so the pad's d-pad, which `gamepad.ts`
  // binds to exactly these two, has been doing nothing at all. Nobody noticed
  // because the pad has a part wheel and the wheel is the better way to pick.
  // Found by listing every action on the controls screen: an action a player
  // can bind a key to had better do something when they press it.
  if (input.wasPressed('nextPart')) build.cycleKind(1);
  if (input.wasPressed('prevPart')) build.cycleKind(-1);

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
    if (input.wasPressed('cycleBlueprint')) cycleBlueprint(input.isDown('sprint') ? -1 : 1);
    if (input.wasPressed('saveBlueprint')) {
      if (captureBlueprint()) sounds.pickPart();
      else sounds.invalid();
    }
    // The blueprint turns on the same keys a single part does, so there is one
    // rotate control rather than two that do the same thing to different things.
    if (heldBlueprint !== null) {
      if (input.wasPressed('rotateCW')) blueprintTurns++;
      if (input.wasPressed('rotateCCW')) blueprintTurns--;
    }
    build.showStampPreview(stampRecords());

    if (input.wasPressed('placePart')) {
      placeHeldTicks = 0;
      const done = heldBlueprint !== null ? stampWithFeedback() : tryPlaceWithFeedback();
      if (!done) sounds.invalid();
    } else if (input.isDown('placePart') && heldBlueprint === null) {
      // Held-to-repeat is for single parts only. A blueprint stamped eight
      // times a second is a wall of staircases and an emptied lumber pile
      // before anybody has let go of the button.
      placeHeldTicks++;
      if (placeHeldTicks % 10 === 0) tryPlaceWithFeedback();
    }
  } else {
    build.showStampPreview(null);
  }

  // ── Mode tick ──────────────────────────────────────────────────────────────
  if (mode !== null) {
    // The afternoon only runs while a round does, so the yard behind the menu
    // is not quietly getting dark while somebody reads the settings — and a
    // round that is over stops the clock where it ended, which is what the
    // result screen wants behind it.
    if (!mode.finished) roundClock += dt;
    mode.fixedUpdate(dt, modeContext, modeInput);
    // Kids are inside the boundary too. A bot steps its own controller from
    // inside `bot.update`, so the shell is the only place with a view of all of
    // them after the mode has finished moving them.
    //
    // Nothing sends a kid out today — they route on a flow field that reads the
    // wall as solid — but "nothing sends them out" is a claim about every mode
    // that will ever exist, and this costs one loop over at most fifteen bodies.
    for (const bot of mode.bots) enforceBounds(bot.controller);
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
    } else {
      // Everything that came down, not just the part under the crosshair: take
      // the leg out of a tower and the tower goes with it, and the guests have
      // to be told about every plank of it rather than the one that was aimed
      // at. See `build/support.ts`.
      const down = build.removeAimed();
      if (down.length > 0) {
        if (net instanceof NetHost) for (const id of down) net.announceRemoval(id);
        worldChanged();
        // A structure falling apart is a different event from a plank being
        // taken down, and it has to sound like one — otherwise the only
        // feedback for losing a tower is that it is not there any more.
        if (down.length > 1) sounds.collapsed(px, py, pz, camera, player, down.length);
        else sounds.removed(px, py, pz, camera, player);
      }
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
  // Three states, not two. "Building is off" used to mean "you are holding a
  // soaker", which was true of every mode until one arrived with no weapon at
  // all — and Tag put a water cannon in the hands of somebody playing a game
  // about running away. What decides it is whether the mode meters ammo, which
  // is the same thing that decides whether the HUD draws a tank.
  const armed = mode !== null && mode.hud().ammo !== null;
  const empty = mode !== null && !mode.buildingAllowed && !armed;
  viewmodel.visible = !camera.showsPlayer && !empty;
  viewPlank.visible = !armed;
  viewSoaker.visible = armed;
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
  // The afternoon gets late as the round does.
  //
  // Driven off the round's own clock rather than off a wall clock of its own,
  // which is what makes it free over a network: a guest is already told how
  // long is left, so both machines reach the same sky from the same number and
  // nothing about the light is ever sent. Outside a round the yard sits in the
  // afternoon it has always sat in.
  //
  // `setDaylight` says whether anything moved, and a sun that moved needs the
  // static shadow map rebuilt — otherwise the light goes orange and swings west
  // while every shadow on the lawn goes on pointing at midday.
  if (setDaylight(roundDayTime())) shadowsDirty = true;
  // The crickets come up with the lamps rather than on a clock of their own,
  // off the same number — so a sky that has gone orange is never a garden that
  // still sounds like midday.
  sounds.eveningAmbience(lampGlowAt(roundDayTime()));
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
  modeRenderer.update(
    frameDt, mode, projectiles, performance.now() / 1000, drawnActors, pingMarkers(),
  );
  characters.finish();

  renderer.render(scene, camera.camera);

  hud.update({
    blueprint: heldBlueprint === null ? null : {
      name: heldBlueprint.name,
      parts: heldBlueprint.parts.length,
      cost: blueprintCost(heldBlueprint.parts),
    },
    selectedKind: build.selectedKind,
    colorway: build.selectedColorway,
    validPlacement,
    snapKind: snapKindLabel,
    candidateCount,
    rotation: build.rotationDegrees,
    canRepeat: build.repeatDelta !== null,
    // The same answer the simulation uses to decide whether the mouse places a
    // part, read from the same place, so the HUD cannot disagree with it.
    canBuild: mode === null || mode.buildingAllowed,
    partsPlaced: build.placedCount,
    cameraMode: camera.mode,
    climbing: state.climbing,
    mode: mode?.hud() ?? null,
    now: nowSeconds,
  });
  hud.setPins(projectPins(mode, state));
  hud.setChat(comms.chat);
  hud.setEmotes(projectEmotes(state));
  hud.setVoices(projectVoices());
  hud.setMic(voice.live, voice.micSpeaking, micLabel());

  // Sampled every frame; written to the screen only when it has something new
  // to say, which is four times a second. A readout that rewrote itself sixty
  // times a second would be unreadable and would be a measurable part of what
  // it is measuring.
  //
  // Read after `renderer.render`, because `renderer.info` counts the frame that
  // just went out. Read before it and the numbers are one frame stale, which
  // shows up as a draw count that lags a turn by a frame — invisible in normal
  // play and maddening when somebody is using this to work out what is
  // expensive.
  if (frameStats.frame(frameDt) && settings.get('showStats')) {
    hud.setStats(
      frameStats.current,
      renderer.info.render.calls,
      renderer.info.render.triangles,
    );
  } else if (!settings.get('showStats')) {
    hud.setStats(null, 0, 0);
  }

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

const frameStats = new FrameStats();

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
   * Whether the audio context has actually started.
   *
   * A browser will not run one outside a real user gesture, and every node in
   * the voice graph hangs off it. Worth exposing rather than inferring, because
   * a suspended context fails silently: nodes connect, gains are set, and no
   * sound is ever produced.
   */
  audioRunning: () => audio.running,
  /**
   * Start the audio context, for scenarios that never press Play.
   *
   * `hideOverlay` drops a scenario straight into the world and deliberately
   * skips `enterPlay`, which is where audio is unlocked — so a scenario that
   * needs sound has to ask. It still needs a real click first: this works only
   * because a browser keeps *sticky* user activation after one, and without
   * that gesture the context stays suspended and every node in it is silent.
   */
  wakeAudio: () => audio.unlock(),
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
    /** The same count from the other end: how many actually got drawn. */
    markersDrawn: modeRenderer.markersDrawn,
    splashes: modeRenderer.splashesLive,
    droplets: modeRenderer.dropletsLive,
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
  /**
   * Everything the lava mode knows, flattened.
   *
   * One call rather than five, because the scenario compares a "before" and an
   * "after" on every claim it makes and two round trips between them is two
   * chances for a tick to land in the middle.
   */
  /**
   * Force a time of day, and say what the light did.
   *
   * The setting is the honest route in — a scenario that wrote the sun directly
   * would prove the shader works on a value no player can produce — so this
   * goes through `settings.set` exactly as the menu does, and then reads the
   * light back off the objects three.js is really using.
   */
  setTimeOfDay: (choice: 'round' | 'afternoon' | 'golden' | 'dusk') => {
    settings.set('timeOfDay', choice);
    setDaylight(roundDayTime());
    const fill = scene.getObjectByName('fill') as THREE.HemisphereLight;
    const sky = scene.getObjectByName('sky') as THREE.Mesh;
    const material = sky.material as THREE.ShaderMaterial;
    const fog = scene.fog as THREE.Fog | null;
    const sun = scene.getObjectByName('sun') as THREE.DirectionalLight;
    const dir = sun.position.clone().normalize();
    return {
      elevation: dir.y,
      azimuth: Math.atan2(dir.z, dir.x),
      sunColor: `#${sun.color.getHexString()}`,
      sunIntensity: sun.intensity,
      fillIntensity: fill.intensity,
      skyTop: `#${(material.uniforms.topColor!.value as THREE.Color).getHexString()}`,
      skyHorizon: `#${(material.uniforms.horizonColor!.value as THREE.Color).getHexString()}`,
      fogNear: fog?.near ?? null,
      fogFar: fog?.far ?? null,
      // The lamps, as three.js has them rather than as `daylightAt` computed
      // them: how many the map put down, how far up they are, and — the one
      // that matters — how many are actually in the draw call. "Off" that
      // still draws is the bug this project has shipped twice.
      lamps: nightLights.lightCount,
      lampGlow: nightLights.level,
      lampsDrawn: nightLights.drawn,
    };
  },
  /**
   * Turn the lamps up or down without moving the time of day.
   *
   * The only way to photograph a glow on its own. Comparing dusk against noon
   * changes the sky, the fog, the key, the fill and the shadows, and a lamp is
   * a few hundred pixels somewhere in the middle of all that. Holding every one
   * of those still and moving only the lamps means every pixel that differs
   * between the two shots is a lamp, and no other reading is available.
   */
  /**
   * Hide the aiming furniture — the ghost, its edges, the chain and stamp
   * previews — without changing anything about the world.
   *
   * A photograph of a light should not have a placement preview in it. The
   * ghost eases toward wherever the aim ray lands, which makes it the one thing
   * in a parked shot that is never quite still.
   */
  setBuildPreview: (on: boolean) => build.setPreviewVisible(on),
  /**
   * Whether the part under the crosshair would be held up by anything, and how
   * solid its preview is being drawn — the two halves of the warning. The
   * opacity is there so a scenario can watch the pulse move without
   * differencing screenshots, which this project has now learned twice is a
   * question about the whole yard rather than about one preview.
   */
  buildPreview: () => {
    // Where it is, as well as what it is. A check that asks "would this hold"
    // without asking "and where did the crosshair actually land" is a check
    // that can pass because the ray sailed under its target and hit the lawn.
    const at = build.place();
    return {
      aiming: build.previewActive,
      stands: build.previewStands,
      opacity: build.ghostOpacity,
      at: at === null ? null : { x: at.x, y: at.y, z: at.z },
    };
  },
  setLamps: (level: number) => {
    nightLights.setLevel(level);
    return { level: nightLights.level, drawn: nightLights.drawn };
  },
  lavaState: () => {
    const lava = mode instanceof LavaMode ? mode : null;
    if (lava === null) return null;
    return {
      spawn: { ...LAVA_SPAWN },
      course: LAVA_COURSE.map((c) => ({ name: c.name, x: c.x, y: c.y, z: c.z })),
      cleared: lava.clearedFor(actors.local.id),
      depth: lava.depthFor(actors.local.id),
      dunks: lava.dunksFor(actors.local.id),
      progress: lava.progressFor(actors.local.id),
      finished: lava.finished,
      won: lava.won,
      player: { x: player.x, y: player.y, z: player.z },
    };
  },
  /**
   * Lay a run of planks out across the lawn, the way a player does.
   *
   * Through `build.place` rather than by writing into the world, so what the
   * scenario stands on afterwards is a real placement that went through real
   * validation and real cost — a plank conjured past the build system would
   * prove the raycast works on something no player could ever have made.
   */
  layPlankPath: (x: number, z: number, count: number) => {
    const half = BOARD_THICKNESS / 2;
    const records = Array.from({ length: count }, (_, i) => ({
      kind: 0, colorway: 0,
      x: x + i * 0.9, y: half, z,
      qx: 0, qy: 0, qz: 0, qw: 1,
    }));
    const ids = build.stamp(records);
    if (ids.length > 0) worldChanged();
    const last = records[records.length - 1]!;
    return { placed: ids.length, top: { x: last.x, y: BOARD_THICKNESS, z: last.z } };
  },
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
  removeAtPoint: (x: number, y: number, z: number): number[] => {
    const state = player.sample(1);
    const ex = state.x, ey = state.y + state.eyeHeight, ez = state.z;
    camera.yaw = Math.atan2(-(x - ex), -(z - ez));
    camera.pitch = Math.atan2(y - ey, Math.hypot(x - ex, z - ez));
    const ray = camera.getAimRay(ex, ey, ez, MAX_REACH);
    build.update(DT, ray.ox, ray.oy, ray.oz, ray.dx, ray.dy, ray.dz, false, false);
    // Everything that came down, so a scenario can ask *how much* rather than
    // only whether anything did — which is the entire question a collapse
    // raises.
    const down = build.removeAimed();
    if (down.length > 0) worldChanged();
    return down;
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
  /** Half the width of the world, so a scenario cannot drift from the constant. */
  playHalf: () => PLAY_HALF,
  /**
   * The comms surface, for the scenario.
   *
   * Deliberately the same calls the keys make rather than a shortcut into the
   * log: a scenario that wrote straight into `CommsLog` would pass with the
   * whole session layer disconnected, which is the half most likely to break.
   */
  comms: {
    say: (channel: Channel, text: string) => sayLocally(channel, text),
    ping: () => pingAtCrosshair(),
    emote: () => emoteLocally(nextEmote()),
    openSay: (channel: 'team' | 'near' | null) => hud.openSay(channel),
    state: () => ({
      chat: comms.chat.map((l) => ({ ...l })),
      pings: comms.worldPings.length,
      typing: hud.saying,
      channel: hud.sayChannel,
    }),
    mute: (id: number) => comms.mute(id),
  },
  /**
   * Blueprints, for the scenario.
   *
   * `preview()` reads the ghost meshes rather than recomputing the records,
   * because the failure worth catching is a stamp that is computed correctly
   * and drawn nowhere.
   */
  blueprints: {
    list: () => blueprints.all().map((b) => ({
      id: b.id, name: b.name, parts: b.parts.length,
      cost: blueprintCost(b.parts), builtIn: b.builtIn === true,
    })),
    held: () => (heldBlueprint === null ? null : heldBlueprint.id),
    select: (id: string | null) => {
      heldBlueprint = id === null ? null : blueprints.get(id) ?? null;
      blueprintTurns = 0;
      build.showStampPreview(stampRecords());
    },
    turn: (delta: number) => {
      blueprintTurns += delta;
      build.showStampPreview(stampRecords());
    },
    preview: () => build.stampPreviewLength,
    /** The part under the crosshair, which is what a capture seeds from. */
    aimed: () => {
      const id = build.lastSnap?.hitPart ?? -1;
      return {
        id,
        alive: id >= 0 && world.store.isAlive(id),
        fixture: id >= 0 && world.isFixture(id),
        known: build.serializeWithIds().some(([pid]) => pid === id),
      };
    },
    /**
     * Which parts of the held blueprint could go down on their own.
     *
     * All-or-nothing is the right rule and a terrible diagnostic: a refused
     * stamp says nothing about which part was in the way. This says.
     */
    blockers: () => (stampRecords() ?? []).map((r, i) => ({
      i, ok: build.canStamp([r]), y: r.y, z: r.z,
    })).filter((e) => !e.ok),
    /** Where the held blueprint would land right now, absolute. */
    records: () => stampRecords(),
    /**
     * Stamp an exact list of records, with no aiming in it.
     *
     * `stamp()` re-aims, which is right for a player and wrong for a scenario
     * asking whether a blueprint can be placed into the space it already
     * occupies: the moment the first one exists, the ray lands on *it* and the
     * second attempt is a different placement in a different spot. That made a
     * check about all-or-nothing refusal depend on where a crosshair happened to
     * land, and it is what turned red on CI.
     */
    /**
     * Take down the part standing at a point, and whatever it held up.
     *
     * Aim-free, for the same reason `stampThese` is: the question a collapse
     * raises is about what was joined to what, and routing it through a
     * crosshair makes the answer depend on where a ray happened to land. A
     * player standing on the thing they are about to demolish cannot aim at its
     * legs anyway — the floor is in the way.
     *
     * @returns every part that came down, aimed one first.
     */
    demolishNear: (x: number, y: number, z: number): number[] => {
      const probe = {
        minX: x - 0.05, minY: y - 0.05, minZ: z - 0.05,
        maxX: x + 0.05, maxY: y + 0.05, maxZ: z + 0.05,
      };
      // The point has to be *inside* the part, not merely near it. A tolerance
      // box picks up whatever is flush against the thing being aimed at — the
      // first version took the post under a panel rather than the panel, and
      // reported the collapse of a tower as the removal of its top.
      let found = -1;
      for (const id of world.queryAabb(probe)) {
        if (world.isFixture(id)) continue;
        const box = world.store.readAabb(id);
        if (x < box.minX || x > box.maxX) continue;
        if (y < box.minY || y > box.maxY) continue;
        if (z < box.minZ || z > box.maxZ) continue;
        // Lowest id wins, so two parts sharing a point cannot make this depend
        // on the order the spatial hash happens to walk its cells.
        if (found < 0 || id < found) found = id;
      }
      if (found < 0) return [];
      const down = build.demolish(found);
      if (down.length > 0) worldChanged();
      return down;
    },
    stampThese: (records: PlacementRecord[]) => {
      const ids = build.stamp(records);
      if (ids.length > 0) worldChanged();
      return ids.length > 0;
    },
    capture: () => captureBlueprint(),
    stamp: () => stampWithFeedback(),
    saved: () => blueprints.saved().length,
    forget: (id: string) => blueprints.remove(id),
  },
  /**
   * Voice, for the scenario that drives two real browsers at each other.
   *
   * `state()` reads the peer connections rather than a flag this file keeps,
   * because "is voice working" has exactly one honest answer — whether packets
   * are arriving — and every summary of it can be right while the audio is
   * silent. `stats()` goes all the way to `getStats()` for that reason.
   */
  voice: {
    /** Host or join a room over the real relay, for two-context scenarios. */
    host: (url: string, room: string) => { startHosting(url, room); },
    join: (url: string, room: string, name: string) => { joinSession(url, room, name); },
    /**
     * Switch voice on the way a player does, through Settings.
     *
     * Rather than calling `VoiceChat.start` directly, which is what the first
     * version of the scenario did and which quietly proved nothing: the mesh
     * came up and carried packets, and every one of them was silence, because
     * `transmitting()` still saw `voiceEnabled: false` and had correctly
     * disabled the track. Going through the setting exercises the path that
     * decides whether anything is actually sent.
     */
    turnOn: (openMic = true) => {
      settings.set('voiceEnabled', true);
      settings.set('voicePushToTalk', !openMic);
      settings.set('micMuted', false);
      return voice.start();
    },
    enable: () => voice.start(),
    disable: () => voice.stop(),
    state: () => ({
      live: voice.live,
      calls: voice.callCount,
      error: voice.error,
      micSpeaking: voice.micSpeaking,
      speakers: voice.speakers(),
      marks: projectVoices().length,
    }),
    /** Gain and pan currently applied to one person, straight off the graph. */
    mixFor: (id: number) => voice.mixFor(id),
    stats: () => voice.stats(),
    levels: () => voice.levels(),
    forceSpeaking: (id: number, on: boolean | null) => voice.forceSpeaking(id, on),
  },
  /**
   * What the viewmodel is currently showing, or null for empty hands.
   *
   * For the tag scenario. Read off the objects rather than recomputed from the
   * mode, because "which of these two meshes is visible" is the question, and a
   * copy of the rule that decides it would agree with itself while both meshes
   * were on screen.
   */
  heldItem: (): string | null => {
    if (!viewmodel.visible) return null;
    if (viewSoaker.visible) return 'soaker';
    if (viewPlank.visible) return 'plank';
    return null;
  },
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
  /**
   * Drive the local player from a fixed intent for a while, and report.
   *
   * For the mantle and item scenarios, which need to hold a direction and a
   * jump the way a player does. Goes through the controller rather than
   * teleporting, so what is measured is the movement code and not a shortcut
   * past it — and it runs the same step-then-items pair `simulate` does, in
   * the same order, because an item that only fires from the real loop is an
   * item this cannot see.
   *
   * `peakY` is what a launch is measured by. The end of the drive is wherever
   * gravity put you, which for a bounce is back on the ground, so a test that
   * only read the final height would be asking about the landing.
   */
  driveIntent: (seconds: number, partial: Partial<MoveIntent>) => {
    let mantled = false;
    let bounced = false;
    let fell = false;
    let peakY = player.y;
    const ticks = Math.round(seconds / DT);
    for (let i = 0; i < ticks; i++) {
      player.step(DT, {
        forward: 0, right: 0, jump: false, sprint: false, crouch: false, climb: 0,
        ...partial,
      });
      if (applyItems(player)?.kind === 'trampoline') bounced = true;
      // The boundary too, and in the same place `simulate` puts it — last.
      // Leaving it out is how this driver told the bounds scenario that a body
      // teleported to four thousand metres simply stayed there: the clamp was
      // running in the game and not in the thing measuring the game, which is
      // the exact trap `applyItems` fell into a commit earlier.
      if (enforceBounds(player) === 'fell') fell = true;
      if (player.mantling) mantled = true;
      peakY = Math.max(peakY, player.y);
    }
    return {
      x: player.x, y: player.y, z: player.z,
      mantled, bounced, fell, peakY, onGround: player.onGround,
    };
  },
  /**
   * Run the player and the mode together, the way the loop does.
   *
   * `driveIntent` steps a body and no mode; `fastForward` steps a mode and no
   * body. Both were enough for every mode that came before, because their rules
   * are about where you are and the position is true whether or not anybody
   * stepped you into it.
   *
   * The lava rule is not. It asks what you are *standing on*, and `onGround` is
   * a thing only `step` sets — so a body teleported onto the grass and never
   * stepped is, correctly, in mid-air over it, and the mode says so. Which is a
   * true answer to the wrong question and would have made a scenario measure
   * nothing at all.
   */
  runRound: (seconds: number, partial: Partial<MoveIntent> = {}) => {
    const ticks = Math.round(seconds / DT);
    for (let i = 0; i < ticks; i++) {
      player.step(DT, {
        forward: 0, right: 0, jump: false, sprint: false, crouch: false, climb: 0,
        ...partial,
      });
      applyItems(player);
      enforceBounds(player);
      if (mode !== null) {
        const look = camera.getLookDirection();
        mode.fixedUpdate(DT, modeContext, sameForEveryone({
          fire: false, firePressed: false, fireReleased: false,
          aimX: look.x, aimY: look.y, aimZ: look.z,
        }));
      }
    }
    drainEvents();
    return { x: player.x, y: player.y, z: player.z, onGround: player.onGround };
  },
  /** Connect to a lobby, for the lobby scenario. */
  openLobby: (url: string) => { connectLobby(url); },
  /**
   * The lobby as it stands, or null. Plain data rather than the client, so a
   * scenario reads what the screen reads and cannot reach past it.
   */
  lobbyState: () => {
    const state = lobbyClient?.current;
    if (state === undefined) return null;
    return {
      connected: state.connected,
      code: state.code,
      name: state.name,
      friends: state.friends.map((f) => ({ ...f })),
      party: state.party === null ? null : {
        leaderCode: state.party.leaderCode,
        members: state.party.members.map((m) => ({ code: m.code, name: m.name })),
      },
      invitations: state.invitations.map((i) => ({ party: i.party, from: { ...i.from } })),
      queue: state.queue === null ? null : { ...state.queue },
      problem: state.problem,
    };
  },
  /** The last match the lobby handed over, so a scenario can check the room. */
  lastMatch: () => lastMatch,
  /** What the session layer is doing, for diagnosing a match that never joins. */
  netDebug: () => ({ address: lobbyAddress, message: netMessage, paused: loop.isPaused }),
  projectiles,
  world,
  build,
  player,
  camera,
  scene,
  renderer,
};
