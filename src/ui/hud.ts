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
import type { InputDevice } from '../core/input.ts';
import { PartWheel, type WheelEntry } from './partWheel.ts';

const STYLE = `
.maker-hud {
  position: fixed; inset: 0; pointer-events: none;
  font-family: ui-rounded, "Nunito", "Segoe UI", system-ui, sans-serif;
  color: #fff; user-select: none;
  --ink: #3a2c2a;
}
.maker-crosshair {
  position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
  width: 22px; height: 22px;
}
.maker-crosshair span {
  position: absolute; background: #fff;
  /* Outlined rather than plain white: a bare crosshair disappears against the
     pale sky, which is where players spend most of their time aiming. */
  box-shadow: 0 0 0 1.5px rgba(58, 44, 42, 0.85);
  border-radius: 1px;
}
.maker-crosshair .h { left: 0; right: 0; top: 50%; height: 2px; margin-top: -1px; }
.maker-crosshair .v { top: 0; bottom: 0; left: 50%; width: 2px; margin-left: -1px; }
.maker-crosshair.invalid span { background: #ff6b6b; }

.maker-panel {
  position: absolute; padding: 8px 11px; border-radius: 10px;
  background: rgba(28, 22, 20, 0.5); backdrop-filter: blur(4px);
  font-size: 12px; line-height: 1.5;
}
.maker-status { left: 14px; bottom: 14px; }
.maker-help { right: 14px; bottom: 14px; text-align: right; opacity: 0.85; }
.maker-debug { left: 14px; top: 14px; font-family: ui-monospace, monospace; font-size: 11px; }
.maker-key { display: inline-block; padding: 0 4px; border-radius: 4px;
  background: rgba(255,255,255,0.2); font-weight: 700; margin-right: 3px; }
.maker-swatch { display: inline-block; width: 11px; height: 11px; border-radius: 3px;
  border: 1.5px solid rgba(255,255,255,0.7); vertical-align: -1px; margin-right: 4px; }

.maker-lock {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  background: rgba(20, 16, 14, 0.55); backdrop-filter: blur(3px);
  pointer-events: auto; cursor: pointer;
}
.maker-lock div { text-align: center; }
.maker-lock h1 { font-size: 42px; margin: 0 0 6px; letter-spacing: -0.5px; }
.maker-lock p { margin: 0; opacity: 0.85; font-size: 14px; }
.maker-hidden { display: none !important; }

/* Mode banner: phase, timer and objective, centred at the top where the eye
   goes when something changes. */
.maker-mode {
  position: absolute; left: 50%; top: 16px; transform: translateX(-50%);
  display: flex; align-items: center; gap: 14px;
  padding: 8px 16px; border-radius: 12px;
  background: rgba(28, 22, 20, 0.55); backdrop-filter: blur(4px);
}
.maker-mode .phase { font-size: 15px; font-weight: 800; letter-spacing: 0.6px; }
.maker-mode .timer { font-size: 22px; font-weight: 800; font-variant-numeric: tabular-nums; }
.maker-mode .stat { font-size: 12px; opacity: 0.9; }
.maker-mode .stat b { font-size: 15px; }
.maker-mode .stash { color: #ffd76a; letter-spacing: 2px; }
.maker-mode.urgent .timer { color: #ff9f6a; }

.maker-message {
  position: absolute; left: 50%; top: 96px; transform: translateX(-50%);
  font-size: 30px; font-weight: 800; text-align: center;
  text-shadow: 0 3px 0 rgba(58,44,42,0.55);
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
.maker-meter { display: flex; align-items: center; gap: 7px; }
.maker-meter .cap { font-size: 10px; font-weight: 800; letter-spacing: 1px;
  opacity: 0.75; width: 34px; text-align: right; }
.maker-meter .track { width: 118px; height: 9px; border-radius: 5px;
  background: rgba(0,0,0,0.42); overflow: hidden; }
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
  /** Null when no mode is running. */
  mode: ModeHud | null;
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
  /** True while a mode has building switched off, so the hints follow the phase. */
  private fighting = false;
  private readonly help: HTMLDivElement;
  private readonly chip: HTMLDivElement;
  private readonly wheel: PartWheel;
  private chipKey = '';

  private debugVisible = false;
  private device: InputDevice = 'keyboard';

  constructor(parent: HTMLElement) {
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
    const lines = this.fighting
      ? (pad ? HELP_FIGHT_GAMEPAD : HELP_FIGHT_KEYBOARD)
      : (pad ? HELP_GAMEPAD : HELP_KEYBOARD);
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
    this.updateMode(state.mode);

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

    // Only rewritten when it would actually differ; this runs every frame.
    const chipKey = `${state.selectedKind}:${state.colorway}`;
    if (chipKey !== this.chipKey) {
      this.chipKey = chipKey;
      this.chip.innerHTML =
        `<span class="maker-swatch" style="background:#${swatch}"></span>` +
        `<b>${PART_KINDS[state.selectedKind]!.name}</b>` +
        `<span class="dims">${dims(state.selectedKind)}</span>` +
        `<span class="hint">Tab</span>`;
    }
  }

  /** The wheel, so the shell can open it and feed it mouse movement. */
  get partWheel(): PartWheel {
    return this.wheel;
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
  private updateMode(mode: ModeHud | null): void {
    const active = mode !== null;
    this.modePanel.classList.toggle('maker-hidden', !active);
    this.messageEl.classList.toggle('maker-hidden', !active || mode!.message === null);
    this.ammoEl.classList.toggle('maker-hidden', !active || mode!.ammo === null);
    // The part chip is meaningless while throwing, so it goes with the build
    // controls rather than sitting there inert.
    const fighting = active && mode!.ammo !== null;
    this.chip.classList.toggle('maker-hidden', fighting);
    // So do the snap readout and the rotate-and-place hints: keys that do
    // nothing right now read as keys that are broken.
    this.status.classList.toggle('maker-hidden', fighting);
    if (fighting !== this.fighting) {
      this.fighting = fighting;
      this.paintHelp();
    }
    if (!active) return;

    const m = mode!;
    const parts: string[] = [`<span class="phase">${m.phase}</span>`];
    if (m.timer !== null) {
      const seconds = Math.ceil(m.timer);
      parts.push(`<span class="timer">${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}</span>`);
    }
    if (m.primary !== null) {
      parts.push(`<span class="stat">${m.primary.label} <b class="stash">${m.primary.value}</b></span>`);
    }
    if (m.secondary !== null) {
      parts.push(`<span class="stat">${m.secondary.label} <b>${m.secondary.value}</b></span>`);
    }
    this.modePanel.innerHTML = parts.join('');
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
