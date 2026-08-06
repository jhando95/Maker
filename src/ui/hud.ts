/**
 * HUD.
 *
 * Plain DOM over the canvas rather than in-world geometry: text stays crisp at
 * any resolution, costs no draw calls, and is far quicker to iterate on.
 *
 * Kept deliberately sparse. In a game about looking at the thing you are
 * building, every pixel of chrome is a pixel of backyard you cannot see.
 */

import { PART_KINDS, COLORWAYS } from '../build/partKit.ts';
import { costOf } from '../build/lumber.ts';
import type { InputDevice } from '../core/input.ts';
import { PartWheel, type WheelEntry } from './partWheel.ts';
import { installTheme } from './theme.ts';

/** Objectives trackable at once. Pooled, so tracking them allocates nothing. */
const MAX_PINS = 8;
/** Overlapping directional cues. Four is more attackers than you can face. */
const MAX_HURT_ARCS = 4;
/** Seconds the crosshair stays kicked out after a hit. */
const HIT_MARKER_TIME = 0.12;
/** Seconds a damage arc lingers before fading. */
const HURT_ARC_TIME = 0.7;

/**
 * An objective, already projected to the screen by the shell.
 *
 * Screen space rather than world space because the shell already owns a camera
 * that can project a point, and a HUD that had to be handed one would be a HUD
 * that knows about three.js.
 */
export interface ScreenPin {
  x: number;
  y: number;
  /** True when the objective is off screen and this is a chevron on the edge. */
  edge: boolean;
  /** Which way the chevron points, radians. Ignored when on screen. */
  angle: number;
  distance: number;
  color: string;
  kind: 'stash' | 'bucket' | 'flag';
  /** Dimmed — present, but not the one that needs you. */
  quiet?: boolean;
}

const STYLE = `
.maker-hud {
  position: fixed; inset: 0; pointer-events: none;
  font-family: var(--font);
  color: var(--text); user-select: none;
}
.maker-crosshair {
  position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
  width: 22px; height: 22px;
  transition: transform 0.12s var(--pop);
}
.maker-crosshair span {
  position: absolute; background: var(--text);
  /* Outlined rather than plain white: a bare crosshair disappears against the
     pale sky, which is where players spend most of their time aiming. */
  box-shadow: 0 0 0 1.5px var(--ink);
  border-radius: 1px;
}
.maker-crosshair .h { left: 0; right: 0; top: 50%; height: 2px; margin-top: -1px; }
.maker-crosshair .v { top: 0; bottom: 0; left: 50%; width: 2px; margin-left: -1px; }
.maker-crosshair .dot {
  left: 50%; top: 50%; width: 3px; height: 3px; margin: -1.5px 0 0 -1.5px;
  border-radius: 50%; opacity: 0;
}
.maker-crosshair.invalid span { background: #ff6b6b; }
/* Kicks outward the moment something lands, which is the only cue that says
   "that connected" rather than "a meter changed somewhere". */
.maker-crosshair.hit { transform: translate(-50%, -50%) scale(1.45); }
.maker-crosshair.hit span { background: var(--sun); }

.maker-panel {
  position: absolute; padding: 8px 12px;
  background: var(--panel-fill);
  border: var(--edge); border-radius: var(--r-md);
  box-shadow: var(--drop);
  font-size: 12px; line-height: 1.5;
}
.maker-status { left: 16px; bottom: 16px; }
.maker-help { right: 16px; bottom: 16px; text-align: right; }
.maker-debug { left: 16px; top: 16px; font-family: ui-monospace, monospace; font-size: 11px; }
.maker-key { display: inline-block; padding: 1px 5px; border-radius: var(--r-sm);
  background: var(--card); color: var(--ink);
  font-weight: 800; font-size: 11px; margin-right: 3px;
  box-shadow: 0 1.5px 0 var(--ink-soft); }
.maker-swatch { display: inline-block; width: 11px; height: 11px; border-radius: 3px;
  border: 1.5px solid var(--ink); vertical-align: -1px; margin-right: 4px; }

.maker-lock {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  background: rgba(20, 16, 14, 0.55);
  pointer-events: auto; cursor: pointer;
}
.maker-lock div { text-align: center; }
.maker-lock h1 { font-size: 46px; margin: 0 0 8px; letter-spacing: -1px;
  text-shadow: var(--text-edge); }
.maker-lock p { margin: 0; font-size: 15px; font-weight: 700;
  text-shadow: var(--text-edge); }
.maker-hidden { display: none !important; }

/*
 * The objective banner.
 *
 * Centred at the top because that is where the eye goes when something changes,
 * and built as one card rather than a row of loose numbers: phase and timer are
 * the headline, the score sits beside it, and everything else is smaller than
 * both. The old version gave the phase, the clock and two stats the same weight,
 * so a glance told you four things equally and none of them quickly.
 */
.maker-mode {
  position: absolute; left: 50%; top: 14px; transform: translateX(-50%);
  display: flex; align-items: stretch; gap: 0;
  background: var(--panel-fill);
  border: var(--edge); border-radius: var(--r-lg);
  box-shadow: var(--drop-lg);
  overflow: hidden;
  animation: mk-drop-in 0.28s var(--pop);
}
.maker-mode .cell {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  padding: 6px 14px; gap: 1px;
}
.maker-mode .cell + .cell { border-left: 2px solid var(--ink-soft); }
.maker-mode .cap {
  font-size: 9px; font-weight: 800; letter-spacing: 1.4px; text-transform: uppercase;
  color: var(--text-dim);
}
.maker-mode .phase { font-size: 16px; font-weight: 900; letter-spacing: 0.4px; }
.maker-mode .timer { font-size: 24px; font-weight: 900; line-height: 1; }
.maker-mode .val { font-size: 17px; font-weight: 900; line-height: 1.1; }
.maker-mode .val.tint { color: var(--sun); }
.maker-mode .val.wood { color: var(--wood); }
/* Not enough for what you are holding. Same red the ghost turns. */
.maker-mode .val.wood.short { color: var(--alarm); }
.maker-mode.urgent .timer { color: var(--alarm); animation: mk-tick 1s steps(1) infinite; }
@keyframes mk-tick { 0%, 60% { opacity: 1; } 61%, 100% { opacity: 0.55; } }

/* Score, in the two sides' own colours so it matches the shirts on the lawn. */
.maker-mode .score { display: flex; align-items: center; gap: 5px; font-size: 19px; font-weight: 900; }
.maker-mode .score .l { color: var(--team-left); }
.maker-mode .score .r { color: var(--team-right); }
.maker-mode .score .sep { color: var(--text-dim); font-size: 14px; }

.maker-message {
  position: absolute; left: 50%; top: 92px; transform: translateX(-50%);
  font-size: 32px; font-weight: 900; text-align: center; letter-spacing: -0.4px;
  text-shadow: var(--text-edge);
  animation: mk-pop-in 0.3s var(--pop);
}

/* Ammo and charge sit just above the part chip, near where the hands are. */
.maker-ammo {
  position: absolute; left: 50%; bottom: 92px; transform: translateX(-50%);
  display: flex; flex-direction: column; align-items: center; gap: 5px;
}
.maker-ammo .pips { display: flex; gap: 3px; }
.maker-ammo .pip { width: 7px; height: 15px; border-radius: 3px;
  background: rgba(255,255,255,0.25); }
.maker-ammo .pip.full { background: #6ec6ff; }
.maker-charge { width: 128px; height: 6px; border-radius: 3px;
  background: rgba(0,0,0,0.4); overflow: hidden; }
.maker-charge i { display: block; height: 100%; background: #ffd76a; width: 0%; }
.maker-charge.refill i { background: #6ec6ff; }
.maker-refill-label { font-size: 11px; font-weight: 700; opacity: 0.9; }

/*
 * Two meters that mean opposite things, so they are labelled and never bare.
 *
 * Unlabelled they were a stack of identical blue bars with a stray number
 * between them, and nothing said which was the water you have and which was
 * the water on you.
 */
.maker-meter { display: flex; align-items: center; gap: 8px; }
.maker-meter .cap { font-size: 10px; font-weight: 900; letter-spacing: 1px;
  width: 38px; text-align: right; text-shadow: 0 1.5px 0 var(--ink); }
.maker-meter .track { width: 122px; height: 11px; border-radius: var(--r-sm);
  background: rgba(20, 14, 12, 0.75);
  border: var(--edge); box-shadow: var(--drop);
  overflow: hidden; }
.maker-meter .track i { display: block; height: 100%; width: 0%;
  transition: width 0.1s linear; }

/* The tank: continuous, so a bar rather than pips. */
.maker-tank .track i { background: #6ec6ff; }
.maker-tank.low .track i { background: #ffb06a; }
.maker-tank .cap { color: #bfe6ff; }

/* How wet you are. Climbs toward being knocked out of the fight. */
.maker-soak .track i { background: #7fd6ff; }
.maker-soak.drenched .track i { background: #4a86c8; }
.maker-soak .cap { color: #9fdcff; }
.maker-soak.drenched .cap { color: #ffd0d0; }

/*
 * The edge of the screen beads up as you get soaked.
 *
 * A meter tucked by the hands is not something anyone reads mid-fight; the
 * vignette is what actually tells you to break off, because it is impossible to
 * miss and it grows exactly as your odds get worse.
 */
.maker-vignette {
  position: absolute; inset: 0; pointer-events: none; opacity: 0;
  transition: opacity 0.18s ease-out;
  /*
   * Two layers, because one blue wash is invisible against the sky — which is
   * exactly where you look when running away. The dark ring carries the signal
   * on bright backgrounds; the pale one reads as water on the grass.
   */
  background:
    radial-gradient(ellipse at center, rgba(214,242,255,0) 34%, rgba(214,242,255,0.34) 100%),
    radial-gradient(ellipse at center, rgba(28,74,116,0) 26%, rgba(28,74,116,0.62) 100%);
}

/*
 * Objective markers, drawn over the world.
 *
 * The map is forty-eight metres of lot with a house in the middle of it, and
 * Water War puts three taps at three corners of it. Until now the only way to
 * find out which one was being drained was to walk round and look — the mode
 * knew, the screen did not, and a triage mode where you cannot see what needs
 * triaging is a mode you play by wandering.
 *
 * On-screen markers sit on the thing; off-screen ones pin to the edge with an
 * arrow, so an objective behind you still has a direction and a distance.
 */
.maker-pins { position: absolute; inset: 0; overflow: hidden; }
.maker-pin {
  position: absolute; left: 0; top: 0;
  display: flex; flex-direction: column; align-items: center; gap: 2px;
  transform: translate(-50%, -50%);
  will-change: transform;
}
.maker-pin .dot {
  width: 15px; height: 15px; border-radius: 50%;
  border: var(--edge); box-shadow: var(--drop);
  background: var(--sun);
}
.maker-pin.flag .dot { border-radius: 3px; }
.maker-pin .dist {
  font-size: 10px; font-weight: 900; letter-spacing: 0.4px;
  text-shadow: var(--text-edge);
}
/*
 * Off the screen: a chevron pointing the way, with the distance kept.
 *
 * The distance was hidden here at first, to keep the edge uncluttered. Exactly
 * backwards: an objective you can see tells you roughly how far it is by how
 * big it looks, and one you cannot see tells you nothing at all. Off screen is
 * the only place the number was ever load-bearing.
 */
.maker-pin.edge .dot { width: 0; height: 0; background: none; border: none; box-shadow: none;
  border-left: 9px solid transparent; border-right: 9px solid transparent;
  border-bottom: 14px solid var(--sun);
  filter: drop-shadow(0 0 1.5px var(--ink)) drop-shadow(0 0 1.5px var(--ink)); }
/* Faded when it is not the one that needs you. */
.maker-pin.quiet { opacity: 0.45; }

/*
 * Which way the water came from.
 *
 * A wetness meter says how much trouble you are in; it never says where the
 * trouble is. Four seconds of turning on the spot looking for whoever is
 * soaking you is the least fun this game has to offer.
 */
.maker-hurt { position: absolute; left: 50%; top: 50%; width: 0; height: 0; }
.maker-hurt i {
  position: absolute; left: -22px; top: -128px;
  width: 44px; height: 44px;
  transform-origin: 22px 128px;
  opacity: 0;
  background: radial-gradient(ellipse at 50% 100%, rgba(126, 206, 255, 0.95), rgba(126, 206, 255, 0) 72%);
  transition: opacity 0.45s var(--ease);
}
.maker-hurt i.show { opacity: 1; transition-duration: 0.06s; }
`;

import type { Loadout, ModeHud } from '../game/gameMode.ts';

export interface HudState {
  selectedKind: number;
  colorway: number;
  validPlacement: boolean;
  snapKind: string;
  candidateCount: number;
  rotation: { yaw: number; pitch: number; roll: number };
  partsPlaced: number;
  cameraMode: string;
  climbing: boolean;
  /** True when a repeat step is available, so the hint can be offered. */
  canRepeat: boolean;
  /**
   * Whether a part can be placed at all right now.
   *
   * Its own field rather than inferred from the mode, and it was inferred until
   * Tag arrived. The rule used to be "there is ammo, so you are throwing rather
   * than building", which happened to be true of all three modes and is a
   * coincidence — it says a mode with no ammo is a mode with a plank in your
   * hands. Tag has neither, and got the snap readout, the part chip and a row of
   * rotate-and-place key hints, every one of which is a key that does nothing.
   */
  canBuild: boolean;
  /** Null when no mode is running. */
  mode: ModeHud | null;
  /** Seconds, for expiring timed cues without a second clock to keep in step. */
  now: number;
}

export interface DebugState {
  fps: number;
  parts: number;
  drawCalls: number;
  triangles: number;
  playerY: number;
  onGround: boolean;
  /** Effective render scale, which may be below the player's setting. */
  renderScale: number;
  /** True when the governor has pulled it below what the player asked for. */
  throttled: boolean;
}

const dims = (i: number): string => {
  const k = PART_KINDS[i]!;
  return `${k.length}×${k.thickness}`;
};

/**
 * The wheel's contents. Built once — the part kit does not change at runtime,
 * and rebuilding this string list every frame would be pure churn.
 */
const WHEEL_ENTRIES: readonly WheelEntry[] = PART_KINDS.map((k, i) => ({
  label: k.name,
  detail: dims(i),
  color: `#${COLORWAYS[0]!.toString(16).padStart(6, '0')}`,
}));

const key = (label: string) => `<span class="maker-key">${label}</span>`;

/**
 * Two lines, not five.
 *
 * A permanent five-line reference in the corner is a manual, and nobody reads a
 * manual they cannot dismiss. What survives is the two things you cannot guess:
 * how to rotate what you are holding, and how to change it. Everything else is
 * either obvious (WASD), discoverable from the wheel itself, or listed in
 * Settings → Controls where a reference belongs.
 */
const HELP_KEYBOARD = [
  `${key('Q')}${key('E')} turn &nbsp; ${key('Z')}${key('X')} tilt &nbsp; ${key('R')} snap &nbsp; ${key('G')} repeat`,
  `${key('Tab')} parts &nbsp; ${key('Alt')} free aim &nbsp; ${key('V')} camera &nbsp; ${key('`')} debug`,
];

/**
 * Mirrors PAD_BINDINGS in core/gamepad.ts. Written out rather than generated
 * from it: the bindings are a flat list of button-to-action pairs, and these
 * lines group verbs the way a player thinks about them — move, build, rotate —
 * which no amount of iteration over that list would produce.
 */
const HELP_GAMEPAD = [
  `${key('LB')}${key('RB')} turn &nbsp; ${key('D↑')}${key('D↓')} tilt &nbsp; ${key('Y')} snap`,
  `${key('D←')}${key('D→')} parts &nbsp; ${key('LT')} free aim &nbsp; ${key('R3')} camera`,
];

/**
 * What the corner says once building is off and there is a fight on.
 *
 * The build hints are not merely useless during a raid, they are wrong: half
 * those keys do nothing while you are holding a soaker, and a player who tries
 * them learns the controls are broken rather than that the phase changed.
 */
const HELP_FIGHT_KEYBOARD = [
  `${key('LMB')} soak &nbsp; ${key('Tab')} kit &nbsp; stand in water to fill up`,
  `${key('Shift')} sprint &nbsp; ${key('V')} camera &nbsp; ${key('`')} debug`,
];

const HELP_FIGHT_GAMEPAD = [
  `${key('RT')} soak &nbsp; ${key('D←')}${key('D→')} kit &nbsp; stand in water to fill up`,
  `${key('L3')} sprint &nbsp; ${key('R3')} camera`,
];

/**
 * And what it says with nothing in your hands at all.
 *
 * Tag is the first mode where there is no plank and no soaker, and the corner
 * had been a two-way switch on the assumption that there is always one or the
 * other. Left as it was, a mode about running told the player to hold the left
 * mouse button to soak somebody and to stand in water to fill up — neither of
 * which is a thing that exists in it.
 *
 * These are the verbs that are left, and they are the ones this mode is made
 * of: a jump against a ledge is a pull-up, and a sprint is most of the game.
 */
const HELP_RUN_KEYBOARD = [
  `${key('Shift')} sprint &nbsp; ${key('Space')} jump &nbsp; hold ${key('Space')} at a ledge to climb it`,
  `${key('V')} camera &nbsp; ${key('`')} debug`,
];

const HELP_RUN_GAMEPAD = [
  `${key('L3')} sprint &nbsp; ${key('A')} jump &nbsp; hold ${key('A')} at a ledge to climb it`,
  `${key('R3')} camera`,
];

export class Hud {
  readonly root: HTMLDivElement;

  private readonly crosshair: HTMLDivElement;
  private readonly status: HTMLDivElement;
  private readonly debug: HTMLDivElement;
  private readonly lock: HTMLDivElement;
  private readonly modePanel: HTMLDivElement;
  private readonly messageEl: HTMLDivElement;
  private readonly ammoEl: HTMLDivElement;
  private readonly vignette: HTMLDivElement;
  private readonly pins: HTMLDivElement;
  private readonly hurt: HTMLDivElement;
  /** Pooled pin elements, so tracking objectives allocates nothing per frame. */
  private readonly pinPool: HTMLDivElement[] = [];
  private readonly hurtPool: HTMLElement[] = [];
  private hurtNext = 0;
  private hitUntil = 0;
  /** True while a mode has building switched off, so the hints follow the phase. */
  private fighting = false;
  /**
   * And whether there is anything in your hands while it is.
   *
   * The two used to be the same question, because every mode that took the
   * planks away handed you a soaker in exchange. Tag hands you nothing.
   */
  private armed = false;
  private bannerKey = '';
  private readonly help: HTMLDivElement;
  private readonly chip: HTMLDivElement;
  private readonly wheel: PartWheel;
  private chipKey = '';

  private debugVisible = false;
  private device: InputDevice = 'keyboard';

  constructor(parent: HTMLElement) {
    // Tokens first, since everything below is written in terms of them.
    installTheme();
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);

    this.root = document.createElement('div');
    this.root.className = 'maker-hud';

    this.crosshair = document.createElement('div');
    this.crosshair.className = 'maker-crosshair';
    this.crosshair.innerHTML = '<span class="h"></span><span class="v"></span>';
    this.root.appendChild(this.crosshair);

    this.status = document.createElement('div');
    this.status.className = 'maker-panel maker-status';
    this.root.appendChild(this.status);

    // One line under the crosshair instead of eight boxes across the bottom.
    this.chip = document.createElement('div');
    this.chip.className = 'mk-chip';
    this.root.appendChild(this.chip);

    this.wheel = new PartWheel(this.root);
    // Once. The part kit does not change at runtime, and repainting eight
    // chips every frame was both waste and — measured — enough restyling to
    // stop CSS transitions on those chips from ever reaching their target.
    this.wheel.setEntries(WHEEL_ENTRIES);

    this.help = document.createElement('div');
    this.help.className = 'maker-panel maker-help';
    this.setInputDevice('keyboard');
    this.root.appendChild(this.help);

    this.debug = document.createElement('div');
    this.debug.className = 'maker-panel maker-debug maker-hidden';
    this.root.appendChild(this.debug);

    this.modePanel = document.createElement('div');
    this.modePanel.className = 'maker-mode maker-hidden';
    this.root.appendChild(this.modePanel);

    this.messageEl = document.createElement('div');
    this.messageEl.className = 'maker-message maker-hidden';
    this.root.appendChild(this.messageEl);

    this.ammoEl = document.createElement('div');
    this.ammoEl.className = 'maker-ammo maker-hidden';
    this.root.appendChild(this.ammoEl);

    // Behind the crosshair and panels, in front of the world.
    this.vignette = document.createElement('div');
    this.vignette.className = 'maker-vignette';
    this.root.insertBefore(this.vignette, this.crosshair);

    // Objective pins live behind everything else, since they track things in
    // the world and must never sit on top of a panel that is telling you why.
    this.pins = document.createElement('div');
    this.pins.className = 'maker-pins';
    this.root.insertBefore(this.pins, this.crosshair);
    for (let i = 0; i < MAX_PINS; i++) {
      const pin = document.createElement('div');
      pin.className = 'maker-pin maker-hidden';
      pin.innerHTML = '<span class="dot"></span><span class="dist"></span>';
      this.pins.appendChild(pin);
      this.pinPool.push(pin);
    }

    this.hurt = document.createElement('div');
    this.hurt.className = 'maker-hurt';
    this.root.insertBefore(this.hurt, this.crosshair);
    for (let i = 0; i < MAX_HURT_ARCS; i++) {
      const arc = document.createElement('i');
      this.hurt.appendChild(arc);
      this.hurtPool.push(arc);
    }

    this.lock = document.createElement('div');
    this.lock.className = 'maker-lock';
    this.lock.innerHTML =
      '<div><h1>Maker</h1><p>Click to build</p></div>';
    this.root.appendChild(this.lock);

    parent.appendChild(this.root);
  }

  /**
   * Point the help panel at whichever device the player is holding.
   *
   * Hints that name keys a controller player does not have are worse than no
   * hints — they say the game does not know they are there.
   */
  setInputDevice(device: InputDevice): void {
    this.device = device;
    this.paintHelp();
  }

  private paintHelp(): void {
    const pad = this.device === 'gamepad';
    const lines = !this.fighting
      ? (pad ? HELP_GAMEPAD : HELP_KEYBOARD)
      : this.armed
        ? (pad ? HELP_FIGHT_GAMEPAD : HELP_FIGHT_KEYBOARD)
        : (pad ? HELP_RUN_GAMEPAD : HELP_RUN_KEYBOARD);
    this.help.innerHTML = lines.join('<br>');
  }

  get inputDevice(): InputDevice {
    return this.device;
  }

  setPointerLocked(locked: boolean): void {
    this.lock.classList.toggle('maker-hidden', locked);
  }

  onLockClick(handler: () => void): void {
    this.lock.addEventListener('click', handler);
  }

  toggleDebug(): void {
    this.debugVisible = !this.debugVisible;
    this.debug.classList.toggle('maker-hidden', !this.debugVisible);
  }

  update(state: HudState): void {
    this.crosshair.classList.toggle('invalid', !state.validPlacement);
    // Retired here rather than on a timer, so the kick lasts a real fraction of
    // a second whatever the frame rate is doing.
    if (this.hitUntil > 0 && state.now >= this.hitUntil) {
      this.hitUntil = 0;
      this.crosshair.classList.remove('hit');
    }
    this.updateMode(state.mode, costOf(state.selectedKind), state.canBuild);

    const swatch = COLORWAYS[state.colorway % COLORWAYS.length]!
      .toString(16)
      .padStart(6, '0');
    const rot = state.rotation;
    const rotText =
      rot.yaw === 0 && rot.pitch === 0 && rot.roll === 0
        ? 'aligned'
        : `${rot.yaw}° / ${rot.pitch}° / ${rot.roll}°`;

    // Two lines, not five. The part you are holding and its colour now live in
    // the chip under the crosshair, and repeating what the chip already says in
    // the corner is how a HUD ends up covering the game.
    this.status.innerHTML = [
      `snap <b>${state.snapKind}</b>${state.candidateCount > 1 ? ` (${state.candidateCount})` : ''}` +
        `${rotText === 'aligned' ? '' : ` · ${rotText}`}`,
      state.canRepeat
        ? '<b>hold G</b> to repeat that step'
        : state.climbing ? '<b>climbing</b>' : `built ${state.partsPlaced}`,
    ].join('<br>');

    // The price goes on the chip rather than only in the banner, because the
    // chip is what the player is reading while choosing what to hold — and the
    // choice between a plank and a block is mostly a choice about cost.
    const metered = state.mode?.lumber !== undefined && state.mode.lumber !== null;
    const cost = costOf(state.selectedKind);

    // Only rewritten when it would actually differ; this runs every frame.
    const chipKey = `${state.selectedKind}:${state.colorway}:${metered ? cost : ''}`;
    if (chipKey !== this.chipKey) {
      this.chipKey = chipKey;
      this.chip.innerHTML =
        `<span class="maker-swatch" style="background:#${swatch}"></span>` +
        `<b>${PART_KINDS[state.selectedKind]!.name}</b>` +
        `<span class="dims">${dims(state.selectedKind)}</span>` +
        (metered ? `<span class="cost">${cost} wood</span>` : '') +
        `<span class="hint">Tab</span>`;
    }
  }

  /** The wheel, so the shell can open it and feed it mouse movement. */
  get partWheel(): PartWheel {
    return this.wheel;
  }

  /**
   * Place the objective pins for this frame.
   *
   * Takes screen-space positions rather than world ones: the shell already owns
   * a camera that can project a point, and a HUD that had to be handed one
   * would be a HUD that knows about three.js. Anything off screen arrives with
   * `edge` set and an angle to point along.
   */
  setPins(pins: readonly ScreenPin[]): void {
    for (let i = 0; i < this.pinPool.length; i++) {
      const el = this.pinPool[i]!;
      const pin = pins[i];
      if (pin === undefined) {
        el.classList.add('maker-hidden');
        continue;
      }
      el.classList.remove('maker-hidden');
      el.classList.toggle('edge', pin.edge);
      el.classList.toggle('quiet', pin.quiet === true);
      el.classList.toggle('flag', pin.kind === 'flag');
      el.style.left = `${pin.x}px`;
      el.style.top = `${pin.y}px`;

      const dot = el.firstElementChild as HTMLElement;
      // The chevron turns, the label does not — rotating the whole pin would
      // leave the distance upside down whenever the objective was behind you.
      dot.style.transform = pin.edge ? `rotate(${pin.angle}rad)` : '';
      // The chevron is a CSS triangle, so its colour is a border, not a fill.
      if (pin.edge) dot.style.borderBottomColor = pin.color;
      else dot.style.background = pin.color;

      const dist = el.lastElementChild as HTMLElement;
      const text = `${Math.round(pin.distance)}m`;
      if (dist.textContent !== text) dist.textContent = text;
    }
  }

  /**
   * Something you threw connected.
   *
   * The crosshair kicks outward and flashes. It is the only thing on screen
   * that says "that landed" — before this, hitting someone and missing them
   * looked identical from behind the crosshair, and the meter that moved was on
   * a body forty metres away.
   */
  hitMarker(now: number): void {
    this.hitUntil = now + HIT_MARKER_TIME;
    this.crosshair.classList.add('hit');
  }

  /**
   * Water came from that direction, relative to where you are looking.
   *
   * Zero is straight ahead. A wetness meter says how much trouble you are in
   * and never says where it is coming from, which turns being ambushed into
   * several seconds of spinning on the spot.
   */
  hurtFrom(angle: number): void {
    const arc = this.hurtPool[this.hurtNext % this.hurtPool.length]!;
    this.hurtNext++;
    arc.style.transform = `rotate(${angle}rad)`;
    // Restart rather than extend: re-showing an arc that is already up should
    // read as a second hit, not as one long one.
    arc.classList.remove('show');
    void arc.offsetWidth;
    arc.classList.add('show');
    setTimeout(() => arc.classList.remove('show'), HURT_ARC_TIME * 1000);
  }

  /** Point the wheel at the build kit. */
  showParts(): void {
    this.wheel.setEntries(WHEEL_ENTRIES);
  }

  /**
   * Point the wheel at a mode's weapons.
   *
   * Anything not currently usable — out of water, or a hose away from a tap —
   * is shown greyed rather than hidden, because a wheel whose contents move
   * around is a wheel you have to read every time instead of flicking.
   */
  showWeapons(loadout: Loadout): void {
    this.wheel.setEntries(loadout.entries.map((e) => ({
      label: e.name,
      detail: e.ready ? e.blurb : 'no water',
      color: e.ready ? '#6ec6ff' : '#6a6f74',
    })));
  }

  /** Render the running mode's banner, message and ammo, or hide them all. */
  private updateMode(mode: ModeHud | null, heldCost: number, canBuild: boolean): void {
    const active = mode !== null;
    this.modePanel.classList.toggle('maker-hidden', !active);
    this.messageEl.classList.toggle('maker-hidden', !active || mode!.message === null);
    this.ammoEl.classList.toggle('maker-hidden', !active || mode!.ammo === null);
    // The part chip is meaningless when you cannot place one, so it goes with
    // the build controls rather than sitting there inert. So do the snap
    // readout and the rotate-and-place hints: keys that do nothing right now
    // read as keys that are broken.
    const fighting = active && !canBuild;
    const armed = active && mode!.ammo !== null;
    this.chip.classList.toggle('maker-hidden', fighting);
    this.status.classList.toggle('maker-hidden', fighting);
    if (fighting !== this.fighting || armed !== this.armed) {
      this.fighting = fighting;
      this.armed = armed;
      this.paintHelp();
    }
    if (!active) return;

    const m = mode!;
    // Cells rather than a row of loose spans, each captioned with what it is.
    // The old banner gave the phase, the clock and two stats equal weight, so a
    // glance told you four things equally and none of them quickly.
    const cells: string[] = [`<div class="cell"><span class="phase">${m.phase}</span></div>`];
    if (m.timer !== null) {
      const seconds = Math.max(0, Math.ceil(m.timer));
      const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
      cells.push(`<div class="cell"><span class="timer mk-tabular">${clock}</span></div>`);
    }
    if (m.score !== undefined && m.score !== null) {
      // In the two sides' own colours, so the number on the banner and the shirt
      // on the lawn are obviously the same fact.
      cells.push(
        '<div class="cell"><span class="cap">score</span><span class="score mk-tabular">' +
        `<b class="l">${m.score.left}</b><span class="sep">–</span><b class="r">${m.score.right}</b>` +
        '</span></div>',
      );
    }
    if (m.primary !== null) {
      cells.push(
        `<div class="cell"><span class="cap">${m.primary.label}</span>` +
        `<span class="val tint mk-tabular">${m.primary.value}</span></div>`,
      );
    }
    if (m.secondary !== null) {
      cells.push(
        `<div class="cell"><span class="cap">${m.secondary.label}</span>` +
        `<span class="val mk-tabular">${m.secondary.value}</span></div>`,
      );
    }
    // Last, and only while it can be spent. A wood count during a raid is a
    // number you cannot act on, sitting in the one place the player looks when
    // something has changed.
    if (m.lumber !== undefined && m.lumber !== null) {
      const short = m.lumber < heldCost ? ' short' : '';
      cells.push(
        '<div class="cell"><span class="cap">wood</span>' +
        `<span class="val wood${short} mk-tabular">${m.lumber}</span></div>`,
      );
    }
    // Rewritten only when it changed: this runs every frame, and re-parsing the
    // banner sixty times a second also restarts its arrival animation.
    const bannerKey = cells.join('');
    if (bannerKey !== this.bannerKey) {
      this.bannerKey = bannerKey;
      this.modePanel.innerHTML = bannerKey;
    }
    // Under ten seconds the timer turns warm, which is the only cue a player
    // reliably catches while looking at what they are building.
    this.modePanel.classList.toggle('urgent', m.timer !== null && m.timer <= 10);

    if (m.message !== null) this.messageEl.textContent = m.message;

    // The vignette runs off wetness whether or not the mode shows ammo, so
    // being soaked reads the same during a lull as it does mid-raid.
    const wet = m.wetness ?? 0;
    // Held back until it means something: a splash on the way past should not
    // dim the screen, being two hits from out of the fight should.
    this.vignette.style.opacity = String(wet < 0.25 ? 0 : Math.min(1, (wet - 0.25) / 0.65));

    if (m.ammo !== null) {
      const fraction = m.ammo.max === 0 ? 0 : m.ammo.current / m.ammo.max;
      let supply: string;
      if (m.ammo.gauge === true) {
        supply =
          `<div class="maker-meter maker-tank${fraction < 0.25 ? ' low' : ''}">` +
          `<span class="cap">${Math.round(m.ammo.current)}L</span>` +
          `<span class="track"><i style="width:${Math.round(fraction * 100)}%"></i></span></div>`;
      } else {
        const pips: string[] = [];
        for (let i = 0; i < m.ammo.max; i++) {
          pips.push(`<div class="pip${i < m.ammo.current ? ' full' : ''}"></div>`);
        }
        supply = `<div class="pips">${pips.join('')}</div>`;
      }

      // Charge and refill share the bar: they never happen at once, and two
      // bars in the same place would be read as one thing behaving oddly.
      let bar = '';
      if (m.refill !== null) {
        bar = `<div class="maker-refill-label">filling up…</div>` +
          `<div class="maker-charge refill"><i style="width:${Math.round(m.refill * 100)}%"></i></div>`;
      } else if (m.charge !== null) {
        bar = `<div class="maker-charge"><i style="width:${Math.round(m.charge * 100)}%"></i></div>`;
      }

      // Wetness sits below both, so the thing that ends your round is not
      // competing for the same strip as the thing that reloads it.
      const soak = m.wetness === null || m.wetness <= 0.02 ? ''
        : `<div class="maker-meter maker-soak${m.wetness >= 0.85 ? ' drenched' : ''}">` +
          `<span class="cap">${m.wetness >= 0.85 ? 'SOAKED' : 'WET'}</span>` +
          `<span class="track"><i style="width:${Math.round(m.wetness * 100)}%"></i></span></div>`;

      this.ammoEl.innerHTML = `${supply}${bar}${soak}`;
    }
  }

  updateDebug(state: DebugState): void {
    if (!this.debugVisible) return;
    this.debug.innerHTML = [
      `fps        ${state.fps.toFixed(0)}`,
      `parts      ${state.parts}`,
      `draws      ${state.drawCalls}`,
      `tris       ${state.triangles.toLocaleString()}`,
      `player y   ${state.playerY.toFixed(2)}`,
      `grounded   ${state.onGround}`,
      // Flagged when it is not the player's own choice, so a soft-looking image
      // has a visible reason rather than being a mystery.
      `scale      ${Math.round(state.renderScale * 100)}%${state.throttled ? ' (auto)' : ''}`,
    ].join('<br>');
  }
}
