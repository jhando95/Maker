/**
 * Menus: title, settings, saved builds, pause, and the round result.
 *
 * DOM over the canvas, like the HUD. Text stays crisp at any resolution, costs
 * no draw calls, and a slider is a slider rather than something to reimplement
 * in a shader. The 3D scene keeps rendering behind it, so the menu sits over a
 * live backyard instead of a frozen frame.
 *
 * The menu owns no game state. It is handed callbacks and a settings store, and
 * reports what the player asked for.
 */

import { SettingsStore, type Settings } from '../app/settings.ts';
import type { BuildSlot } from '../app/buildStore.ts';

export type Screen = 'none' | 'title' | 'settings' | 'builds' | 'pause' | 'result' | 'controls';

const STYLE = `
.mk-menu {
  position: fixed; inset: 0; z-index: 20;
  font-family: ui-rounded, "Nunito", "Segoe UI", system-ui, sans-serif;
  color: #fff; user-select: none;
  display: flex; align-items: center; justify-content: center;
  background: radial-gradient(ellipse at 50% 40%, rgba(20,16,14,0.35), rgba(20,16,14,0.7));
  backdrop-filter: blur(3px);
}
.mk-menu.mk-off { display: none; }

.mk-card {
  background: rgba(30, 24, 21, 0.86);
  border: 3px solid rgba(255,255,255,0.14);
  border-radius: 18px;
  padding: 26px 30px;
  min-width: 340px; max-width: 560px;
  max-height: 82vh; overflow-y: auto;
  box-shadow: 0 18px 50px rgba(0,0,0,0.45);
}
.mk-title {
  font-size: 62px; font-weight: 900; letter-spacing: -1.5px;
  text-align: center; margin: 0 0 2px;
  color: #ffd76a; text-shadow: 0 4px 0 #a8722a, 0 8px 18px rgba(0,0,0,0.4);
}
.mk-tag { text-align: center; opacity: 0.75; font-size: 13px; margin: 0 0 22px; }
.mk-h2 { font-size: 20px; font-weight: 800; margin: 0 0 16px; text-align: center; }

.mk-btn {
  display: block; width: 100%; box-sizing: border-box;
  margin: 0 0 9px; padding: 12px 16px;
  font: inherit; font-size: 16px; font-weight: 800;
  color: #3a2c2a; background: #f4a259;
  border: none; border-bottom: 4px solid #c47a35; border-radius: 11px;
  cursor: pointer; text-align: center;
  transition: transform 0.06s, filter 0.12s;
}
.mk-btn:hover { filter: brightness(1.08); }
/* Press moves the button onto its own shadow, which is most of what makes a
   flat cartoon button feel physical. */
.mk-btn:active { transform: translateY(3px); border-bottom-width: 1px; }
.mk-btn.mk-secondary {
  background: rgba(255,255,255,0.13); color: #fff; border-bottom-color: rgba(0,0,0,0.3);
}
.mk-btn.mk-danger { background: #d8564f; color: #fff; border-bottom-color: #92302b; }

.mk-row {
  display: flex; align-items: center; gap: 12px;
  padding: 9px 0; border-bottom: 1px solid rgba(255,255,255,0.08);
}
.mk-row label { flex: 1; font-size: 14px; }
.mk-row .mk-val {
  min-width: 52px; text-align: right; font-size: 13px;
  opacity: 0.85; font-variant-numeric: tabular-nums;
}
.mk-row input[type=range] { width: 168px; accent-color: #f4a259; }
.mk-row input[type=checkbox] { width: 19px; height: 19px; accent-color: #f4a259; }

.mk-slot {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 12px; margin-bottom: 7px;
  background: rgba(255,255,255,0.07); border-radius: 10px;
}
.mk-slot .mk-name { flex: 1; font-weight: 700; font-size: 14px; }
.mk-slot .mk-meta { font-size: 11px; opacity: 0.65; }
.mk-slot button {
  font: inherit; font-size: 12px; font-weight: 700; padding: 5px 11px;
  border: none; border-radius: 7px; cursor: pointer;
  background: #f4a259; color: #3a2c2a;
}
.mk-slot button.mk-x { background: rgba(255,255,255,0.16); color: #fff; }
.mk-empty { opacity: 0.6; font-size: 13px; text-align: center; padding: 18px 0; }

.mk-result-big { font-size: 44px; font-weight: 900; text-align: center; margin: 0 0 4px; }
.mk-result-big.win { color: #8fe3a0; }
.mk-result-big.lose { color: #ff9f6a; }
.mk-stats { text-align: center; opacity: 0.85; font-size: 14px; margin: 0 0 20px; line-height: 1.6; }

.mk-hint { text-align: center; font-size: 11.5px; opacity: 0.55; margin-top: 14px; }
.mk-btn.mk-mode { margin-bottom: 3px; }
/* Sits directly under its button and is deliberately quiet: the name is the
   choice, this is the reason. */
.mk-blurb {
  font-size: 12px; opacity: 0.6; line-height: 1.4;
  margin: 0 0 12px; padding: 0 4px; text-align: center;
}
.mk-bind {
  display: flex; align-items: center; gap: 10px;
  padding: 7px 0; border-bottom: 1px solid rgba(255,255,255,0.08);
}
.mk-bind label { flex: 1; font-size: 13.5px; }
.mk-bind button {
  min-width: 108px; padding: 6px 12px;
  font: inherit; font-size: 12.5px; font-weight: 700;
  border: none; border-radius: 8px; cursor: pointer;
  background: rgba(255,255,255,0.13); color: #fff;
}
.mk-bind button:hover { background: rgba(255,255,255,0.22); }
.mk-bind button.listening { background: #f4a259; color: #3a2c2a; }
.mk-name-input {
  width: 100%; box-sizing: border-box; margin-bottom: 10px;
  padding: 10px 12px; font: inherit; font-size: 14px;
  border-radius: 9px; border: 2px solid rgba(255,255,255,0.18);
  background: rgba(0,0,0,0.3); color: #fff;
}
`;

export interface BindingRow {
  action: string;
  label: string;
  key: string;
}

export interface MenuCallbacks {
  listBindings(): BindingRow[];
  /** Returns false if the key could not be bound. */
  rebind(action: string, code: string): boolean;
  resetBindings(): void;
  onPlayMode(id: string): void;
  /** The modes the title screen should offer, in the order to show them. */
  listModes(): ReadonlyArray<{ id: string; name: string; blurb: string }>;
  onPlaySandbox(): void;
  onResume(): void;
  onRestart(): void;
  onQuitToTitle(): void;
  onSaveBuild(name: string): boolean;
  onLoadBuild(id: string): boolean;
  onDeleteBuild(id: string): void;
  listBuilds(): BuildSlot[];
}

export interface ResultInfo {
  won: boolean;
  /** The mode's own headline and figures, so this screen states no rules. */
  headline: string;
  lines: ReadonlyArray<{ label: string; value: string }>;
}

export class Menu {
  private readonly root: HTMLDivElement;
  private readonly card: HTMLDivElement;
  private readonly settings: SettingsStore;
  private readonly callbacks: MenuCallbacks;

  private screen: Screen = 'title';
  private result: ResultInfo | null = null;
  /** Where Back goes, since settings and builds are reachable from two places. */
  private returnTo: Screen = 'title';

  constructor(parent: HTMLElement, settings: SettingsStore, callbacks: MenuCallbacks) {
    this.settings = settings;
    this.callbacks = callbacks;

    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);

    this.root = document.createElement('div');
    this.root.className = 'mk-menu';
    this.card = document.createElement('div');
    this.card.className = 'mk-card';
    this.root.appendChild(this.card);
    parent.appendChild(this.root);

    this.show('title');
  }

  get current(): Screen {
    return this.screen;
  }

  get isOpen(): boolean {
    return this.screen !== 'none';
  }

  show(screen: Screen, result?: ResultInfo): void {
    this.screen = screen;
    if (result !== undefined) this.result = result;
    this.root.classList.toggle('mk-off', screen === 'none');
    if (screen === 'none') {
      this.card.innerHTML = '';
      return;
    }
    this.render();
  }

  /** Escape: pause during play, or step back out of a sub-screen. */
  handleEscape(): void {
    switch (this.screen) {
      case 'none':
        this.show('pause');
        break;
      case 'pause':
        this.callbacks.onResume();
        break;
      case 'controls':
        this.show('settings');
        break;
      case 'settings':
      case 'builds':
        this.show(this.returnTo);
        break;
      case 'result':
      case 'title':
        break;
    }
  }

  private render(): void {
    this.card.innerHTML = '';
    switch (this.screen) {
      case 'title': this.renderTitle(); break;
      case 'settings': this.renderSettings(); break;
      case 'builds': this.renderBuilds(); break;
      case 'pause': this.renderPause(); break;
      case 'result': this.renderResult(); break;
      case 'controls': this.renderControls(); break;
      case 'none': break;
    }
  }

  private button(label: string, onClick: () => void, variant = ''): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = `mk-btn ${variant}`.trim();
    b.textContent = label;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
    this.card.appendChild(b);
    return b;
  }

  private heading(text: string): void {
    const h = document.createElement('div');
    h.className = 'mk-h2';
    h.textContent = text;
    this.card.appendChild(h);
  }

  private renderTitle(): void {
    const title = document.createElement('h1');
    title.className = 'mk-title';
    title.textContent = 'Maker';
    this.card.appendChild(title);

    const tag = document.createElement('p');
    tag.className = 'mk-tag';
    tag.textContent = 'Build a fort. Defend it. Get soaked.';
    this.card.appendChild(tag);

    // One button per mode, each with a line saying what it is. A menu that
    // lists two names and no explanation makes the player pick blind and find
    // out ninety seconds later.
    for (const m of this.callbacks.listModes()) {
      const button = this.button(m.name, () => this.callbacks.onPlayMode(m.id));
      const blurb = document.createElement('div');
      blurb.className = 'mk-blurb';
      blurb.textContent = m.blurb;
      this.card.appendChild(blurb);
      button.classList.add('mk-mode');
    }

    this.button('Free Build', () => this.callbacks.onPlaySandbox(), 'mk-secondary');
    this.button('Saved Builds', () => {
      this.returnTo = 'title';
      this.show('builds');
    }, 'mk-secondary');
    this.button('Settings', () => {
      this.returnTo = 'title';
      this.show('settings');
    }, 'mk-secondary');

    const hint = document.createElement('div');
    hint.className = 'mk-hint';
    hint.textContent = 'Click the game to capture the mouse. Escape to pause.';
    this.card.appendChild(hint);
  }

  private renderPause(): void {
    this.heading('Paused');
    this.button('Resume', () => this.callbacks.onResume());
    this.button('Settings', () => {
      this.returnTo = 'pause';
      this.show('settings');
    }, 'mk-secondary');
    this.button('Saved Builds', () => {
      this.returnTo = 'pause';
      this.show('builds');
    }, 'mk-secondary');
    this.button('Restart Round', () => this.callbacks.onRestart(), 'mk-secondary');
    this.button('Quit to Title', () => this.callbacks.onQuitToTitle(), 'mk-danger');
  }

  private renderResult(): void {
    const r = this.result;
    const big = document.createElement('div');
    big.className = `mk-result-big ${r?.won === true ? 'win' : 'lose'}`;
    big.textContent = r?.headline ?? '';
    this.card.appendChild(big);

    const stats = document.createElement('div');
    stats.className = 'mk-stats';
    stats.innerHTML = (r?.lines ?? [])
      .map((l) => `${l.label}: <b>${l.value}</b>`)
      .join('<br>');
    this.card.appendChild(stats);

    this.button('Play Again', () => this.callbacks.onRestart());
    // Offered right here because the moment you want to keep a fort is the
    // moment you find out whether it worked.
    this.button('Save This Build', () => {
      this.returnTo = 'result';
      this.show('builds');
    }, 'mk-secondary');
    this.button('Quit to Title', () => this.callbacks.onQuitToTitle(), 'mk-secondary');
  }

  private renderSettings(): void {
    this.heading('Settings');
    const s = this.settings.current;

    this.slider('Mouse sensitivity', 'sensitivity', s.sensitivity, 0.0004, 0.008, 0.0002,
      (v) => `${Math.round(v * 10000) / 10}`);
    this.toggle('Invert vertical look', 'invertY', s.invertY);
    this.slider('Field of view', 'fov', s.fov, 55, 110, 1, (v) => `${Math.round(v)}°`);

    this.toggle('Shadows', 'shadows', s.shadows);
    this.toggle('Outlines', 'outlines', s.outlines);
    this.slider(s.autoQuality ? 'Render scale (maximum)' : 'Render scale',
      'renderScale', s.renderScale, 0.5, 1, 0.05,
      (v) => `${Math.round(v * 100)}%`);
    // Re-rendered on change so the slider above relabels itself, which is the
    // only way the ceiling-versus-fixed distinction is visible.
    this.toggle('Lower resolution automatically if frames drop', 'autoQuality', s.autoQuality,
      () => this.render());

    this.slider('Master volume', 'masterVolume', s.masterVolume, 0, 1, 0.05,
      (v) => `${Math.round(v * 100)}%`);
    this.slider('Effects volume', 'sfxVolume', s.sfxVolume, 0, 1, 0.05,
      (v) => `${Math.round(v * 100)}%`);

    this.toggle('Colourblind-friendly build colours', 'colorblindGhost', s.colorblindGhost);
    this.toggle('Toggle crouch', 'toggleCrouch', s.toggleCrouch);
    this.toggle('Toggle sprint', 'toggleSprint', s.toggleSprint);

    this.toggle('Controller', 'gamepadEnabled', s.gamepadEnabled);
    // Shown in degrees per second: radians per second is the right unit for the
    // code and a meaningless one for a player choosing how fast to turn.
    this.slider('Controller look speed', 'gamepadLookSpeed', s.gamepadLookSpeed, 0.8, 6, 0.1,
      (v) => `${Math.round((v * 180) / Math.PI)}°/s`);
    this.slider('Controller deadzone', 'gamepadDeadzone', s.gamepadDeadzone, 0, 0.5, 0.01,
      (v) => `${Math.round(v * 100)}%`);

    const spacer = document.createElement('div');
    spacer.style.height = '16px';
    this.card.appendChild(spacer);

    this.button('Controls', () => this.show('controls'), 'mk-secondary');
    this.button('Back', () => this.show(this.returnTo));
    this.button('Reset to defaults', () => {
      this.settings.reset();
      this.render();
    }, 'mk-secondary');
  }

  /**
   * Key rebinding.
   *
   * Clicking a row arms a one-shot capture. The capture listens on the window
   * in the capture phase so it sees the key before anything else can act on it
   * — otherwise binding Escape would close the menu, and binding a movement key
   * would walk the player around behind the screen.
   */
  private renderControls(): void {
    this.heading('Controls');

    for (const row of this.callbacks.listBindings()) {
      const el = document.createElement('div');
      el.className = 'mk-bind';

      const label = document.createElement('label');
      label.textContent = row.label;
      el.appendChild(label);

      const btn = document.createElement('button');
      btn.textContent = row.key;
      btn.addEventListener('click', () => {
        if (this.listening !== null) return;
        btn.classList.add('listening');
        btn.textContent = 'press a key…';
        this.beginCapture(row.action, () => this.render());
      });
      el.appendChild(btn);

      this.card.appendChild(el);
    }

    const spacer = document.createElement('div');
    spacer.style.height = '14px';
    this.card.appendChild(spacer);

    this.button('Back', () => this.show('settings'));
    this.button('Reset controls', () => {
      this.callbacks.resetBindings();
      this.render();
    }, 'mk-secondary');
  }

  private listening: (() => void) | null = null;

  private beginCapture(action: string, done: () => void): void {
    const finish = (): void => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onMouse, true);
      this.listening = null;
      done();
    };

    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      // Escape cancels rather than binding; a player who has bound Escape to
      // something has no way back out of a menu.
      if (e.code !== 'Escape') this.callbacks.rebind(action, e.code);
      finish();
    };

    const onMouse = (e: MouseEvent): void => {
      // Only inside the card, or clicking Back would bind a mouse button.
      if (!(e.target instanceof Node) || !this.card.contains(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      this.callbacks.rebind(action, `Mouse${e.button}`);
      finish();
    };

    this.listening = finish;
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onMouse, true);
  }

  private slider<K extends keyof Settings>(
    label: string, key: K, value: number,
    min: number, max: number, step: number,
    format: (v: number) => string,
  ): void {
    const row = document.createElement('div');
    row.className = 'mk-row';

    const l = document.createElement('label');
    l.textContent = label;
    row.appendChild(l);

    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    row.appendChild(input);

    const val = document.createElement('span');
    val.className = 'mk-val';
    val.textContent = format(value);
    row.appendChild(val);

    // 'input' rather than 'change', so the effect is audible or visible while
    // the slider is still being dragged — which is the only way to set a
    // sensitivity or a volume sensibly.
    input.addEventListener('input', () => {
      const v = Number(input.value);
      val.textContent = format(v);
      this.settings.set(key, v as Settings[K]);
    });

    this.card.appendChild(row);
  }

  /**
   * `afterChange` is for the rare toggle that changes how another row reads.
   * Re-rendering on every toggle would tear the screen out from under whoever
   * is clicking through it.
   */
  private toggle<K extends keyof Settings>(
    label: string, key: K, value: boolean, afterChange?: () => void,
  ): void {
    const row = document.createElement('div');
    row.className = 'mk-row';

    const l = document.createElement('label');
    l.textContent = label;
    row.appendChild(l);

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = value;
    input.addEventListener('change', () => {
      this.settings.set(key, input.checked as Settings[K]);
      afterChange?.();
    });
    row.appendChild(input);

    this.card.appendChild(row);
  }

  private renderBuilds(): void {
    this.heading('Saved Builds');

    const name = document.createElement('input');
    name.className = 'mk-name-input';
    name.placeholder = 'Name this build…';
    name.maxLength = 40;
    this.card.appendChild(name);

    this.button('Save current build', () => {
      const ok = this.callbacks.onSaveBuild(name.value.trim() || 'Untitled');
      name.value = '';
      if (!ok) {
        // Quota, or too many parts. Say so rather than failing silently.
        name.placeholder = 'Could not save — too large or storage full';
      }
      this.render();
    });

    const slots = this.callbacks.listBuilds();
    if (slots.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'mk-empty';
      empty.textContent = 'Nothing saved yet.';
      this.card.appendChild(empty);
    }

    for (const slot of slots) {
      const row = document.createElement('div');
      row.className = 'mk-slot';

      const info = document.createElement('div');
      info.className = 'mk-name';
      const when = new Date(slot.savedAt);
      info.innerHTML =
        `${escapeHtml(slot.name)}<div class="mk-meta">${slot.partCount} parts · ` +
        `${when.toLocaleDateString()} ${when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>`;
      row.appendChild(info);

      const load = document.createElement('button');
      load.textContent = 'Load';
      load.addEventListener('click', () => {
        this.callbacks.onLoadBuild(slot.id);
        this.render();
      });
      row.appendChild(load);

      const del = document.createElement('button');
      del.className = 'mk-x';
      del.textContent = '✕';
      del.title = 'Delete';
      del.addEventListener('click', () => {
        this.callbacks.onDeleteBuild(slot.id);
        this.render();
      });
      row.appendChild(del);

      this.card.appendChild(row);
    }

    const spacer = document.createElement('div');
    spacer.style.height = '14px';
    this.card.appendChild(spacer);
    this.button('Back', () => this.show(this.returnTo));
  }
}

/** Slot names come from the player, and land in innerHTML. */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}
