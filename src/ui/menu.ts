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
import { installTheme } from './theme.ts';

export type Screen = 'none' | 'title' | 'settings' | 'builds' | 'pause' | 'result' | 'controls';

const STYLE = `
.mk-menu {
  position: fixed; inset: 0; z-index: 20;
  font-family: var(--font);
  color: var(--text); user-select: none;
  display: flex; align-items: center; justify-content: center;
  background: radial-gradient(ellipse at 50% 40%, rgba(20,16,14,0.42), rgba(20,16,14,0.78));
}
.mk-menu.mk-off { display: none; }

/*
 * A card with the same hard outline everything solid in this world has, rather
 * than a floating pane of dark glass. The menus and the HUD were styled where
 * each was written and had drifted into two different programs; both are drawn
 * from theme.ts now, so a change lands in both or neither.
 */
/*
 * Cardboard, not dark glass.
 *
 * The first pass kept the card dark and gave it the world's ink outline, and
 * the outline simply vanished — #2b201c on #3a2b25 is the same colour twice.
 * An outline needs something bright to outline. Going light also earns the
 * theme: a full-screen menu with nothing behind it can afford to be a sign
 * somebody made, while the in-game panels stay dark because they sit over a
 * sunlit lawn you still need to see through. Same outline, same radii, same
 * type, two surfaces — the fill is the only thing that differs, and it differs
 * for a reason.
 */
.mk-card {
  background: var(--card);
  color: var(--ink);
  border: 3px solid var(--ink);
  border-radius: var(--r-lg);
  padding: 26px 30px;
  min-width: 360px; max-width: 580px;
  max-height: 82vh; overflow-y: auto;
  box-shadow: 0 7px 0 var(--ink), 0 26px 46px rgba(0,0,0,0.5);
  animation: mk-pop-in 0.22s var(--pop);
}
.mk-title {
  font-size: 66px; font-weight: 900; letter-spacing: -2px;
  text-align: center; margin: 0 0 2px;
  color: var(--sun);
  /* The same hard outline the world's geometry gets, at title scale. */
  text-shadow:
    -3px 0 var(--ink), 3px 0 var(--ink), 0 -3px var(--ink), 0 3px var(--ink),
    -3px -3px var(--ink), 3px -3px var(--ink), -3px 3px var(--ink), 3px 3px var(--ink),
    0 7px 0 var(--ink);
}
.mk-tag { text-align: center; color: rgba(43,32,28,0.62); font-size: 13px; margin: 0 0 24px;
  font-weight: 700; }
.mk-h2 { font-size: 21px; font-weight: 900; margin: 0 0 18px; text-align: center;
  letter-spacing: -0.3px; }

.mk-btn {
  display: block; width: 100%; box-sizing: border-box;
  margin: 0 0 10px; padding: 13px 16px;
  font: inherit; font-size: 16px; font-weight: 900;
  color: var(--ink); background: var(--sun);
  border: 2px solid var(--ink); border-bottom-width: 5px; border-radius: var(--r-md);
  cursor: pointer; text-align: center;
  transition: transform 0.06s, filter 0.12s;
}
.mk-btn:hover { filter: brightness(1.07); transform: translateY(-1px); }
.mk-btn:focus-visible { outline: 3px solid var(--water); outline-offset: 3px; }
/* Press moves the button onto its own shadow, which is most of what makes a
   flat cartoon button feel physical. */
.mk-btn:active { transform: translateY(3px); border-bottom-width: 2px; }
.mk-btn.mk-secondary { background: #e6d3ae; color: var(--ink); }
.mk-btn.mk-danger { background: #d8564f; color: var(--text); border-color: var(--ink); }

.mk-row {
  display: flex; align-items: center; gap: 12px;
  padding: 10px 0; border-bottom: 2px solid rgba(43,32,28,0.14);
}
.mk-row label { flex: 1; font-size: 14px; font-weight: 700; }
.mk-row .mk-val {
  min-width: 52px; text-align: right; font-size: 13px; font-weight: 800;
  color: rgba(43,32,28,0.7); font-variant-numeric: tabular-nums;
}
.mk-row input[type=range] { width: 168px; accent-color: var(--sun); }
.mk-row input[type=checkbox] { width: 19px; height: 19px; accent-color: var(--sun); }

.mk-slot {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 12px; margin-bottom: 7px;
  background: rgba(43,32,28,0.07); border-radius: var(--r-md); border: 2px solid rgba(43,32,28,0.16);
}
.mk-slot .mk-name { flex: 1; font-weight: 700; font-size: 14px; }
.mk-slot .mk-meta { font-size: 11px; opacity: 0.65; }
.mk-slot button {
  font: inherit; font-size: 12px; font-weight: 700; padding: 5px 11px;
  border: none; border-radius: 7px; cursor: pointer;
  background: #f4a259; color: #3a2c2a;
}
.mk-slot button.mk-x { background: rgba(43,32,28,0.12); color: var(--ink); }
.mk-empty { opacity: 0.6; font-size: 13px; text-align: center; padding: 18px 0; }

.mk-result-big { font-size: 44px; font-weight: 900; text-align: center; margin: 0 0 4px; }
.mk-result-big.win { color: #8fe3a0; }
.mk-result-big.lose { color: #ff9f6a; }
.mk-stats { text-align: center; color: rgba(43,32,28,0.75); font-size: 14px; margin: 0 0 20px;
  line-height: 1.6; font-weight: 700; }

.mk-hint { text-align: center; font-size: 11.5px; opacity: 0.55; margin-top: 14px; }
.mk-btn.mk-mode { margin-bottom: 3px; }
/* Sits directly under its button and is deliberately quiet: the name is the
   choice, this is the reason. */
.mk-net { display: flex; gap: 6px; margin: 6px 0 2px; }
.mk-input {
  flex: 1; min-width: 0;
  font: inherit; font-size: 13px; font-weight: 700;
  padding: 7px 9px;
  color: var(--ink);
  background: #fff8ec;
  border: var(--edge); border-radius: var(--r-sm);
}
.mk-input-short { flex: 0 0 88px; }
.mk-input::placeholder { color: rgba(43, 32, 28, 0.45); font-weight: 600; }

.mk-blurb {
  font-size: 12px; opacity: 0.6; line-height: 1.4;
  margin: 0 0 12px; padding: 0 4px; text-align: center;
}
.mk-bind {
  display: flex; align-items: center; gap: 10px;
  padding: 7px 0; border-bottom: 2px solid rgba(43,32,28,0.12);
}
.mk-bind label { flex: 1; font-size: 13.5px; }
.mk-bind button {
  min-width: 108px; padding: 6px 12px;
  font: inherit; font-size: 12.5px; font-weight: 700;
  border: none; border-radius: 8px; cursor: pointer;
  background: #e6d3ae; color: var(--ink); border: 2px solid var(--ink);
}
.mk-bind button:hover { background: #f0e0bf; }
.mk-bind button.listening { background: #f4a259; color: #3a2c2a; }
.mk-name-input {
  width: 100%; box-sizing: border-box; margin-bottom: 10px;
  padding: 10px 12px; font: inherit; font-size: 14px;
  border-radius: var(--r-sm); border: 2px solid var(--ink);
  background: #e6d3ae; color: var(--ink);
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
  /**
   * Open the yard to other people, or go and stand in somebody else's.
   *
   * The relay address is a text field rather than a lobby browser, because a
   * lobby browser needs a service to list lobbies and this needs nothing but a
   * machine both players can reach.
   */
  onHost(url: string, room: string): void;
  onJoin(url: string, room: string): void;
  onLeaveSession(): void;
  /** A line about the connection, or null when playing alone. */
  sessionStatus(): string | null;
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

    installTheme();
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

  /**
   * Hosting and joining, on the title screen rather than behind a submenu.
   *
   * The whole point of the project is party modes played with other people, and
   * a feature that is the point should not be two clicks further away than
   * "Settings". The room name is what lets two pairs of players share one relay
   * without walking into each other's game.
   */
  private buildPlayTogether(): void {
    const status = this.callbacks.sessionStatus();
    if (status !== null) {
      const line = document.createElement('div');
      line.className = 'mk-blurb';
      line.textContent = status;
      this.card.appendChild(line);
      this.button('Play Alone Again', () => {
        this.callbacks.onLeaveSession();
        this.show('title');
      }, 'mk-secondary');
      return;
    }

    const row = document.createElement('div');
    row.className = 'mk-net';

    const url = document.createElement('input');
    url.type = 'text';
    url.className = 'mk-input';
    url.placeholder = 'ws://localhost:8787';
    url.value = 'ws://localhost:8787';
    url.setAttribute('aria-label', 'relay address');

    const room = document.createElement('input');
    room.type = 'text';
    room.className = 'mk-input mk-input-short';
    room.placeholder = 'room';
    room.value = 'yard';
    room.setAttribute('aria-label', 'room name');

    row.append(url, room);
    this.card.appendChild(row);

    this.button('Host a Yard', () => {
      this.callbacks.onHost(url.value.trim(), room.value.trim() || 'yard');
      this.show('title');
    }, 'mk-secondary');
    this.button('Join a Yard', () => {
      this.callbacks.onJoin(url.value.trim(), room.value.trim() || 'yard');
      this.show('title');
    }, 'mk-secondary');
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
    tag.textContent = 'Build it yourself. Then find out if it holds.';
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
    this.buildPlayTogether();
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
