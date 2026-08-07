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
import { formatCode, MAX_NAME } from '../app/identity.ts';
import type { BuildSlot } from '../app/buildStore.ts';
import { installTheme } from './theme.ts';
import { describeKey } from '../core/input.ts';
import {
  BROWS, CLOTH_COLOURS, EYE_COLOURS, HAIR_COLOURS, HAIR_STYLES, MARK_SHAPES,
  MARK_SLOTS, MOUTHS, SKIN_TONES, blankMark,
  type Appearance, type Mark, type MarkSlot,
} from '../game/appearance.ts';

export type Screen =
  | 'none' | 'title' | 'settings' | 'builds' | 'pause' | 'result' | 'controls' | 'lobby'
  | 'together' | 'locker';

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

/*
 * The mode grid.
 *
 * Two columns, so five modes are three rows rather than ten items. Each card
 * carries its own blurb, which is the change that actually saved the height:
 * a full-width button with a line of grey text orphaned underneath it costs
 * twice the space and reads as two things.
 */
.mk-modes { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 14px; }
.mk-mode-card {
  display: flex; flex-direction: column; gap: 3px; text-align: left;
  padding: 11px 13px; font: inherit;
  color: var(--ink); background: var(--sun);
  border: 2px solid var(--ink); border-bottom-width: 5px; border-radius: var(--r-md);
  cursor: pointer;
  transition: transform 0.06s, filter 0.12s;
}
.mk-mode-card b { font-size: 15px; font-weight: 900; letter-spacing: -0.2px; }
.mk-mode-card span { font-size: 11px; font-weight: 700; line-height: 1.35; color: rgba(43,32,28,0.66); }
.mk-mode-card:hover { filter: brightness(1.07); transform: translateY(-1px); }
.mk-mode-card:focus-visible { outline: 3px solid var(--water); outline-offset: 3px; }
.mk-mode-card:active { transform: translateY(3px); border-bottom-width: 2px; }
.mk-mode-card.mk-disabled:hover { filter: none; transform: none; }

/* Three equal buttons on one line, for actions that are not the main event. */
.mk-actions { display: flex; gap: 8px; }
.mk-actions .mk-btn { margin-bottom: 0; font-size: 14px; padding: 11px 8px; }

/* A labelled rule, for splitting a long screen into sections. */
.mk-section {
  display: flex; align-items: center; gap: 10px;
  margin: 18px 0 6px;
  font-size: 11px; font-weight: 900; letter-spacing: 1.2px; text-transform: uppercase;
  color: rgba(43,32,28,0.5);
}
.mk-section::after {
  content: ''; flex: 1; height: 2px; background: rgba(43,32,28,0.16); border-radius: 1px;
}
.mk-btn.mk-mode { margin-bottom: 3px; }
.mk-disabled { opacity: 0.45; cursor: not-allowed; }
/* Louder than the blurbs it sits among, because it is the one line that
   explains why the buttons above it do nothing. Quiet here is how somebody
   concludes the game is broken. */
.mk-why { color: var(--alarm); font-weight: 700; }

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

/* ── The lobby ──────────────────────────────────────────────────────────────
   Its own block because it is the one screen that is mostly a list rather
   than a stack of buttons, and a list needs a row that reads left to right:
   who, what they are doing, and what you can do about it. */
.mk-code {
  display: flex; align-items: center; justify-content: center; gap: 10px;
  margin: 2px 0 14px;
}
.mk-code b {
  font-size: 22px; letter-spacing: 3px; font-family: ui-monospace, monospace;
  color: var(--ink);
}
.mk-list { margin: 0 0 12px; display: flex; flex-direction: column; gap: 4px; }
.mk-row {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 9px; border: var(--edge); border-radius: var(--r-sm);
  background: #fff8ec; font-size: 13px; font-weight: 700;
}
.mk-row .who { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; text-align: left; }
/* Presence as a word, not only a colour: a coloured dot alone is unreadable to
   anybody who cannot tell the two greens apart, and this screen is a list of
   people whose whole purpose is knowing which of them you can play with. */
.mk-row .state { font-size: 11px; opacity: 0.65; text-transform: uppercase;
  letter-spacing: 0.5px; }
.mk-dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; }
.mk-dot.online { background: var(--go); }
.mk-dot.queued { background: var(--warn); }
.mk-dot.playing { background: var(--accent); }
.mk-dot.offline { background: rgba(43,32,28,0.28); }
.mk-mini {
  font: inherit; font-size: 11px; font-weight: 800; cursor: pointer;
  padding: 4px 8px; border: var(--edge); border-radius: var(--r-sm);
  background: var(--paper); color: var(--ink);
}
.mk-mini:hover { background: #ffe9bd; }
.mk-empty { font-size: 12px; opacity: 0.5; text-align: center; padding: 8px 0 12px; }
.mk-invite {
  border: var(--edge); border-radius: var(--r-sm); background: #fff3d6;
  padding: 8px 10px; margin-bottom: 6px; font-size: 13px; font-weight: 700;
}
.mk-invite .mk-net { margin-top: 6px; }
.mk-searching { text-align: center; font-size: 13px; font-weight: 800; margin: 4px 0 10px; }
.mk-searching span { opacity: 0.6; font-weight: 700; }
.mk-input::placeholder { color: rgba(43, 32, 28, 0.45); font-weight: 600; }

.mk-blurb {
  font-size: 12px; opacity: 0.6; line-height: 1.4;
  margin: 0 0 12px; padding: 0 4px; text-align: center;
}
.mk-bind {
  display: flex; align-items: center; gap: 10px;
  padding: 7px 0; border-bottom: 2px solid rgba(43,32,28,0.12);
}
.mk-bind label { flex: 1; min-width: 0; }
.mk-bind label { flex: 1; font-size: 13.5px; }
.mk-bind button {
  min-width: 108px; padding: 6px 12px;
  font: inherit; font-size: 12.5px; font-weight: 700;
  border: none; border-radius: 8px; cursor: pointer;
  background: #e6d3ae; color: var(--ink); border: 2px solid var(--ink);
}
.mk-bind button:hover { background: #f0e0bf; }
.mk-bind button.empty { background: #d8c6a4; color: #8a7a5e; font-weight: 600; }
/* Fixed, so the two slots line up down the screen. Left to size themselves,
   "Down Arrow" shunts its pair left and the column reads as a ragged edge. */
.mk-bind .keys { display: flex; gap: 6px; flex: 0 0 auto; width: 232px; }
.mk-bind .keys button { flex: 1 1 0; min-width: 0; padding: 6px 4px; }
.mk-group {
  margin: 14px 0 4px; padding-bottom: 4px;
  font-size: 12px; font-weight: 800; letter-spacing: 0.09em; text-transform: uppercase;
  color: var(--ink); opacity: 0.62; border-bottom: 2px solid rgba(43, 32, 28, 0.18);
}
.mk-hint {
  margin: 2px 0 8px; font-size: 12.5px; line-height: 1.45;
  color: var(--ink); opacity: 0.7;
}
.mk-hint.said { opacity: 1; font-weight: 700; }
.mk-choice { display: flex; gap: 5px; flex-wrap: wrap; justify-content: flex-end; }
.mk-choice button {
  padding: 5px 10px; font: inherit; font-size: 12px; font-weight: 700;
  border: 2px solid var(--ink); border-radius: 7px; cursor: pointer;
  background: #e6d3ae; color: var(--ink);
}
.mk-choice button:hover { background: #f0e0bf; }
.mk-choice button.on { background: var(--sun); }

/*
 * The locker gets out of its own way.
 *
 * The preview is not a scene rendered into a panel — it is the player, standing
 * in the yard behind the menu, drawn by the same rig as everybody else. That is
 * worth more than any inset viewport could be: what you are looking at is
 * literally what other people will see, in the light they will see it in. It
 * only needs the card to move aside and the dimming to lift.
 */
.mk-menu.mk-locker {
  justify-content: flex-start; padding-left: 4vw;
  background: linear-gradient(90deg, rgba(20,16,14,0.62) 0%, rgba(20,16,14,0.36) 42%, rgba(20,16,14,0) 62%);
}
.mk-menu.mk-locker .mk-card { width: min(430px, 44vw); max-height: 88vh; }

.mk-tabs { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0 12px; }
.mk-tabs button {
  flex: 1 1 auto; padding: 7px 10px;
  font: inherit; font-size: 12.5px; font-weight: 800;
  border: 2px solid var(--ink); border-radius: 8px; cursor: pointer;
  background: #e6d3ae; color: var(--ink);
}
.mk-tabs button.on { background: var(--ink); color: #f3e6c8; }

.mk-swatches { display: flex; flex-wrap: wrap; gap: 7px; margin: 2px 0 12px; }
.mk-swatches button {
  width: 30px; height: 30px; padding: 0; cursor: pointer;
  border: 2px solid var(--ink); border-radius: 8px;
}
.mk-swatches button.on { outline: 3px solid #f4a259; outline-offset: 2px; }

.mk-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 2px 0 12px; }
.mk-chips button {
  padding: 6px 11px; font: inherit; font-size: 12.5px; font-weight: 700;
  border: 2px solid var(--ink); border-radius: 999px; cursor: pointer;
  background: #e6d3ae; color: var(--ink);
}
.mk-chips button.on { background: var(--ink); color: #f3e6c8; }

.mk-label {
  margin: 10px 0 3px; font-size: 12px; font-weight: 800;
  letter-spacing: 0.07em; text-transform: uppercase; opacity: 0.66;
}
.mk-preset {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 0; border-bottom: 2px solid rgba(43,32,28,0.12);
}
.mk-preset .who { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; font-weight: 700; }
.mk-preset button {
  padding: 5px 10px; font: inherit; font-size: 12px; font-weight: 700;
  border: 2px solid var(--ink); border-radius: 8px; cursor: pointer;
  background: #e6d3ae; color: var(--ink);
}
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
  /** One entry per slot, already made readable. `null` is an empty slot. */
  keys: ReadonlyArray<string | null>;
}

export interface BindingGroup {
  title: string;
  rows: ReadonlyArray<BindingRow>;
}

/** The locker, as the screen needs to see it. */
export interface LockerView {
  /** What is being edited. Already clamped; the screen never has to check. */
  appearance: Appearance;
  presets: ReadonlyArray<{ name: string }>;
  /** Full, so the Save button can say so rather than silently doing nothing. */
  full: boolean;
}

export interface MenuCallbacks {
  listBindings(): BindingGroup[];
  /**
   * The locker.
   *
   * A getter rather than state the menu holds, for the same reason the lobby is
   * one: what somebody is wearing lives in the game, is applied the instant it
   * changes, and a copy in the screen would be a second thing to keep in step.
   */
  locker(): LockerView;
  /** Wear this now. Every control calls it on every change — see `renderLocker`. */
  onLockerChange(appearance: Appearance): void;
  /** Frame the player, or put the camera back. */
  onLockerView(active: boolean): void;
  /** Turn on the spot, in radians. */
  onLockerTurn(delta: number): void;
  onLockerRandom(): void;
  /** Back to the look an actor id produces — the "I have not chosen" state. */
  onLockerReset(): void;
  onLockerSave(name: string): boolean;
  onLockerWear(name: string): boolean;
  onLockerDelete(name: string): boolean;
  /**
   * Put `code` in one of `action`'s slots.
   *
   * Returns the *label* of whatever action lost that key, or null if it was
   * free — a code can only mean one thing, so this screen has to be able to say
   * which control it just took away.
   */
  rebind(action: string, slot: number, code: string): string | null;
  clearBinding(action: string, slot: number): void;
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
  /**
   * The lobby, or null when there is no connection to one.
   *
   * A getter rather than state the menu keeps, because the lobby changes
   * underneath the screen — a friend comes online, a queue ticks — and a copy
   * would be a second thing to keep in step with the first.
   */
  lobby(): LobbyView | null;
  /** Connect to the lobby at this address, so friends and the queue work. */
  onOpenLobby(url: string): void;
  /** A line about the connection, or null when playing alone. */
  sessionStatus(): string | null;
  /**
   * Why a mode cannot be started right now, or null when it can.
   *
   * A reason rather than a boolean, because the answer the player needs is not
   * "no" — it is "the person hosting runs the game". A greyed-out button that
   * says nothing is how somebody concludes the game is broken.
   */
  modesBlocked(): string | null;
  onResume(): void;
  onRestart(): void;
  onQuitToTitle(): void;
  onSaveBuild(name: string): boolean;
  onLoadBuild(id: string): boolean;
  onDeleteBuild(id: string): void;
  listBuilds(): BuildSlot[];
}

/**
 * Everything the lobby screen draws and every button it offers.
 *
 * Named apart from `LobbyClient` so the menu depends on a shape rather than on
 * the network: this screen is the one place a wrong abstraction would be most
 * annoying to unpick, and a test can hand it a plain object.
 */
export interface LobbyView {
  connected: boolean;
  code: string | null;
  name: string;
  friends: ReadonlyArray<{ code: string; name: string; presence: string }>;
  party: { leaderCode: string; members: ReadonlyArray<{ code: string; name: string }> } | null;
  invitations: ReadonlyArray<{ party: string; from: { name: string } }>;
  queue: { mode: string; waiting: number; needed: number; seconds: number } | null;
  problem: string | null;
  /** Which modes the queue will take, in the order to offer them. */
  modes: ReadonlyArray<{ id: string; name: string }>;

  rename(name: string): void;
  addFriend(code: string): void;
  removeFriend(code: string): void;
  invite(code: string): void;
  accept(party: string): void;
  decline(party: string): void;
  leaveParty(): void;
  kick(code: string): void;
  joinQueue(mode: string): void;
  leaveQueue(): void;
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

  /**
   * Redraw the current screen, if it is one that changes underneath the player.
   *
   * The lobby does: a friend comes online, a queue ticks, an invitation
   * arrives. Everything else here is static once drawn, so this deliberately
   * repaints nothing unless the lobby is up — a menu that rebuilt itself on
   * every network message would throw away the text field somebody is typing
   * a friend code into.
   */
  refresh(): void {
    if (this.screen === 'lobby') this.render();
  }

  show(screen: Screen, result?: ResultInfo): void {
    const wasLocker = this.screen === 'locker';
    this.screen = screen;
    if (result !== undefined) this.result = result;
    this.root.classList.toggle('mk-off', screen === 'none');
    this.root.classList.toggle('mk-locker', screen === 'locker');
    // The preview is the player standing in the yard behind this card, so
    // opening and closing the locker is a camera move rather than a scene.
    if ((screen === 'locker') !== wasLocker) this.callbacks.onLockerView(screen === 'locker');
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
      case 'locker':
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
      case 'together': this.renderTogether(); break;
      case 'lobby': this.renderLobby(); break;
      case 'builds': this.renderBuilds(); break;
      case 'pause': this.renderPause(); break;
      case 'result': this.renderResult(); break;
      case 'controls': this.renderControls(); break;
      case 'locker': this.renderLocker(); break;
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
  /**
   * The two connection fields, made once and kept.
   *
   * Built in the constructor rather than per render, so what somebody typed
   * survives a trip to the lobby and back. They were recreated on every render
   * before, which meant editing the address and then opening any other screen
   * silently put it back to the default.
   */
  private readonly presetName = Menu.field('', 'outfit name', 'mk-name-input', 'Name this outfit');
  private readonly relay = Menu.field('ws://localhost:8787', 'relay address');
  private readonly room = Menu.field('yard', 'room name', 'mk-input-short');

  private static field(
    value: string, label: string, extra = '', placeholder = value,
  ): HTMLInputElement {
    const el = document.createElement('input');
    el.type = 'text';
    el.className = `mk-input ${extra}`.trim();
    el.placeholder = placeholder;
    el.value = value;
    el.setAttribute('aria-label', label);
    return el;
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

  /** A rule with a word on it, for splitting a long screen into things. */
  private section(text: string): void {
    const h = document.createElement('div');
    h.className = 'mk-section';
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

    // One card per mode, name and blurb together.
    //
    // It was a stack: a full-width button, then a line of grey text under it,
    // then the next button. Five of those plus five more buttons and two text
    // fields ran off the bottom of a 720-line window with no way to scroll, so
    // the last thing on the screen — Settings — could not be reached at all.
    //
    // A two-column grid halves the height and puts the blurb where it belongs,
    // which is inside the thing it describes rather than orphaned beneath it.
    const blocked = this.callbacks.modesBlocked();
    const grid = document.createElement('div');
    grid.className = 'mk-modes';
    for (const m of this.callbacks.listModes()) {
      const card = document.createElement('button');
      card.className = 'mk-mode-card';
      card.innerHTML = `<b>${m.name}</b><span>${m.blurb}</span>`;
      if (blocked !== null) {
        card.classList.add('mk-disabled');
        card.setAttribute('aria-disabled', 'true');
      } else {
        card.addEventListener('click', (e) => {
          e.stopPropagation();
          this.callbacks.onPlayMode(m.id);
        });
      }
      grid.appendChild(card);
    }
    this.card.appendChild(grid);

    if (blocked !== null) {
      const why = document.createElement('div');
      why.className = 'mk-blurb mk-why';
      why.textContent = blocked;
      this.card.appendChild(why);
    }

    // The one thing on this screen that is not a mode, given its own weight.
    // Everything the project is for happens on the other side of it.
    this.button('Play With Friends', () => this.show('together'));

    const row = document.createElement('div');
    row.className = 'mk-actions';
    this.card.appendChild(row);
    for (const [label, go] of [
      ['Free Build', () => this.callbacks.onPlaySandbox()],
      ['Locker', () => { this.returnTo = 'title'; this.show('locker'); }],
      ['Saved Builds', () => { this.returnTo = 'title'; this.show('builds'); }],
      ['Settings', () => { this.returnTo = 'title'; this.show('settings'); }],
    ] as Array<[string, () => void]>) {
      const b = document.createElement('button');
      b.className = 'mk-btn mk-secondary';
      b.textContent = label;
      b.addEventListener('click', (e) => { e.stopPropagation(); go(); });
      row.appendChild(b);
    }

    const hint = document.createElement('div');
    hint.className = 'mk-hint';
    hint.textContent = 'Click the game to capture the mouse. Escape to pause.';
    this.card.appendChild(hint);
  }

  /**
   * Everything about playing with other people, on a screen of its own.
   *
   * The relay address and the room name used to be two text fields on the
   * title screen, above the fold, on the front page of the game — a websocket
   * URL is the first thing a new player saw after the mode list. They are here
   * now, under the lobby that most people will use instead, because "type a
   * server address" is an answer to a question almost nobody has.
   */
  private renderTogether(): void {
    this.heading('Play With Friends');

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
      this.button('Back', () => this.show('title'), 'mk-secondary');
      return;
    }

    const blurb = document.createElement('div');
    blurb.className = 'mk-blurb';
    blurb.textContent = 'Get a friend code, make a party, and be dropped into a fresh yard together.';
    this.card.appendChild(blurb);

    this.button('Open the Lobby', () => {
      this.callbacks.onOpenLobby(this.relay.value.trim());
      this.show('lobby');
    });

    this.section('Straight to a yard');
    const direct = document.createElement('div');
    direct.className = 'mk-blurb';
    direct.textContent = 'Two people on one network who would rather not involve a matchmaker.';
    this.card.appendChild(direct);

    const row = document.createElement('div');
    row.className = 'mk-net';
    row.append(this.relay, this.room);
    this.card.appendChild(row);

    this.button('Host a Yard', () => {
      this.callbacks.onHost(this.relay.value.trim(), this.room.value.trim() || 'yard');
      this.show('title');
    }, 'mk-secondary');
    this.button('Join a Yard', () => {
      this.callbacks.onJoin(this.relay.value.trim(), this.room.value.trim() || 'yard');
      this.show('title');
    }, 'mk-secondary');

    this.button('Back', () => this.show('title'), 'mk-secondary');
  }

  /**
   * The lobby: your code, your friends, your party, and a queue.
   *
   * Everything on this screen is a list rather than a stack of buttons, which
   * is why it has a row style of its own. The order is deliberate and it is
   * the order somebody uses it in: find out who you are, add somebody, get
   * them into a party, then go and play.
   */
  private renderLobby(): void {
    const lobby = this.callbacks.lobby();
    this.heading('Play With Friends');
    if (lobby === null) {
      const line = document.createElement('div');
      line.className = 'mk-blurb';
      line.textContent = 'Not connected to a lobby.';
      this.card.appendChild(line);
      this.button('Back', () => this.show('title'), 'mk-secondary');
      return;
    }

    this.renderOwnCode(lobby);
    if (lobby.problem !== null) {
      const why = document.createElement('div');
      why.className = 'mk-blurb mk-why';
      why.textContent = lobby.problem;
      this.card.appendChild(why);
    }
    this.renderInvitations(lobby);
    this.renderParty(lobby);
    this.renderFriends(lobby);
    this.renderQueue(lobby);
    this.button('Back', () => this.show('title'), 'mk-secondary');
  }

  private renderOwnCode(lobby: LobbyView): void {
    const row = document.createElement('div');
    row.className = 'mk-code';
    const label = document.createElement('span');
    label.className = 'mk-blurb';
    label.style.margin = '0';
    label.textContent = lobby.connected ? 'your code' : 'your code (offline)';
    const code = document.createElement('b');
    // Grouped for reading aloud. Somebody is going to say this over a table.
    code.textContent = lobby.code === null ? '……' : formatCode(lobby.code);
    row.append(label, code);

    if (lobby.code !== null) {
      const copy = document.createElement('button');
      copy.className = 'mk-mini';
      copy.textContent = 'copy';
      copy.addEventListener('click', (e) => {
        e.stopPropagation();
        void navigator.clipboard?.writeText(formatCode(lobby.code ?? ''));
        copy.textContent = 'copied';
      });
      row.appendChild(copy);
    }
    this.card.appendChild(row);

    const name = document.createElement('input');
    name.type = 'text';
    name.className = 'mk-input';
    name.value = lobby.name;
    name.maxLength = MAX_NAME;
    name.setAttribute('aria-label', 'your name');
    // Committed on blur and on Enter rather than on every keystroke, or the
    // lobby gets a message per letter and every friend a redraw per letter.
    const commit = (): void => {
      if (name.value.trim() !== lobby.name) lobby.rename(name.value);
    };
    name.addEventListener('blur', commit);
    name.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
    });
    const nameRow = document.createElement('div');
    nameRow.className = 'mk-net';
    nameRow.appendChild(name);
    this.card.appendChild(nameRow);
  }

  private renderInvitations(lobby: LobbyView): void {
    for (const invitation of lobby.invitations) {
      const card = document.createElement('div');
      card.className = 'mk-invite';
      card.textContent = `${invitation.from.name} wants you in their party`;

      const row = document.createElement('div');
      row.className = 'mk-net';
      const yes = document.createElement('button');
      yes.className = 'mk-mini';
      yes.textContent = 'join them';
      yes.addEventListener('click', (e) => {
        e.stopPropagation();
        lobby.accept(invitation.party);
        this.render();
      });
      const no = document.createElement('button');
      no.className = 'mk-mini';
      no.textContent = 'no thanks';
      no.addEventListener('click', (e) => {
        e.stopPropagation();
        lobby.decline(invitation.party);
        this.render();
      });
      row.append(yes, no);
      card.appendChild(row);
      this.card.appendChild(card);
    }
  }

  private renderParty(lobby: LobbyView): void {
    const party = lobby.party;
    if (party === null || party.members.length < 2) return;
    this.heading('Your Party');

    const list = document.createElement('div');
    list.className = 'mk-list';
    const youLead = party.leaderCode === lobby.code;
    for (const member of party.members) {
      const row = document.createElement('div');
      row.className = 'mk-row';
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = member.code === party.leaderCode ? `${member.name} (leader)` : member.name;
      row.appendChild(who);
      // Only the leader can remove somebody, and never themselves — a leader
      // kicking themselves is just leaving, which has its own button.
      if (youLead && member.code !== lobby.code) {
        row.appendChild(this.mini('remove', () => { lobby.kick(member.code); this.render(); }));
      }
      list.appendChild(row);
    }
    this.card.appendChild(list);
    this.button('Leave Party', () => { lobby.leaveParty(); this.render(); }, 'mk-secondary');
  }

  private renderFriends(lobby: LobbyView): void {
    this.heading('Friends');

    const row = document.createElement('div');
    row.className = 'mk-net';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'mk-input';
    input.placeholder = 'friend code';
    input.setAttribute('aria-label', 'friend code');
    const add = (): void => {
      const typed = input.value.trim();
      if (typed.length === 0) return;
      lobby.addFriend(typed);
      input.value = '';
      this.render();
    };
    input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') { e.preventDefault(); add(); }
    });
    row.append(input, this.mini('add', add));
    this.card.appendChild(row);

    if (lobby.friends.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'mk-empty';
      empty.textContent = 'Nobody yet. Swap codes with somebody.';
      this.card.appendChild(empty);
      return;
    }

    const list = document.createElement('div');
    list.className = 'mk-list';
    for (const friend of lobby.friends) {
      const item = document.createElement('div');
      item.className = 'mk-row';

      const dot = document.createElement('span');
      dot.className = `mk-dot ${friend.presence}`;
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = friend.name;
      // The word as well as the dot, because a colour alone is unreadable to
      // anybody who cannot tell the two greens apart — and this list exists
      // precisely to say who you can play with right now.
      const state = document.createElement('span');
      state.className = 'state';
      state.textContent = friend.presence === 'playing' ? 'in a yard' : friend.presence;
      item.append(dot, who, state);

      if (friend.presence !== 'offline') {
        item.appendChild(this.mini('invite', () => { lobby.invite(friend.code); this.render(); }));
      }
      item.appendChild(this.mini('remove', () => { lobby.removeFriend(friend.code); this.render(); }));
      list.appendChild(item);
    }
    this.card.appendChild(list);
  }

  private renderQueue(lobby: LobbyView): void {
    this.heading('Queue');
    const queue = lobby.queue;
    if (queue !== null) {
      const line = document.createElement('div');
      line.className = 'mk-searching';
      const named = lobby.modes.find((m) => m.id === queue.mode)?.name ?? queue.mode;
      line.textContent = `Searching — ${named}  `;
      const detail = document.createElement('span');
      detail.textContent = `${queue.waiting}/${queue.needed} · ${queue.seconds}s`;
      line.appendChild(detail);
      this.card.appendChild(line);
      this.button('Cancel', () => { lobby.leaveQueue(); this.render(); }, 'mk-secondary');
      return;
    }

    // Only the leader may queue a party, so everybody else is told why rather
    // than shown buttons that refuse.
    if (lobby.party !== null && lobby.party.members.length > 1
      && lobby.party.leaderCode !== lobby.code) {
      const why = document.createElement('div');
      why.className = 'mk-blurb';
      why.textContent = 'Whoever started the party picks the game.';
      this.card.appendChild(why);
      return;
    }
    for (const mode of lobby.modes) {
      this.button(mode.name, () => { lobby.joinQueue(mode.id); this.render(); }, 'mk-secondary');
    }
  }

  /** A small inline button, for the right-hand end of a list row. */
  private mini(label: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = 'mk-mini';
    b.textContent = label;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
    return b;
  }

  private renderPause(): void {
    this.heading('Paused');
    this.button('Resume', () => this.callbacks.onResume());
    this.button('Settings', () => {
      this.returnTo = 'pause';
      this.show('settings');
    }, 'mk-secondary');
    this.button('Locker', () => {
      this.returnTo = 'pause';
      this.show('locker');
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

  /**
   * Settings, in sections.
   *
   * Fourteen rows in one undifferentiated column, is what this was: mouse
   * sensitivity, then shadows, then master volume, then crouch, then the
   * gamepad deadzone, each looking exactly as important as the last. Somebody
   * arriving to turn the shadows off had to read the lot.
   *
   * The order is by how often a person comes here for it — the picture first,
   * because that is what somebody with a slow machine is looking for, then
   * aiming, then sound, then the two that are set once and never again.
   */
  private renderSettings(): void {
    this.heading('Settings');
    const s = this.settings.current;

    this.section('Picture');
    this.toggle('Shadows', 'shadows', s.shadows);
    this.toggle('Outlines', 'outlines', s.outlines);
    this.slider(s.autoQuality ? 'Render scale (maximum)' : 'Render scale',
      'renderScale', s.renderScale, 0.5, 1, 0.05,
      (v) => `${Math.round(v * 100)}%`);
    // Re-rendered on change so the slider above relabels itself, which is the
    // only way the ceiling-versus-fixed distinction is visible.
    this.toggle('Lower resolution automatically if frames drop', 'autoQuality', s.autoQuality,
      () => this.render());
    // Next to the things it would be used to judge, rather than filed under a
    // heading of its own: somebody turning this on is about to change one of
    // the four settings above it and wants to see whether it helped.
    this.toggle('Show frame rate', 'showStats', s.showStats);
    // Under Picture rather than under Playing, because it changes nothing about
    // the game and everything about the picture — which is also why it is safe
    // to offer at all.
    this.choice('Time of day', 'timeOfDay', s.timeOfDay, [
      { value: 'round', label: 'Follow the round' },
      { value: 'afternoon', label: 'Afternoon' },
      { value: 'golden', label: 'Golden' },
      { value: 'dusk', label: 'Dusk' },
    ]);

    this.section('Looking around');
    this.slider('Mouse sensitivity', 'sensitivity', s.sensitivity, 0.0004, 0.008, 0.0002,
      (v) => `${Math.round(v * 10000) / 10}`);
    this.toggle('Invert vertical look', 'invertY', s.invertY);
    this.slider('Field of view', 'fov', s.fov, 55, 110, 1, (v) => `${Math.round(v)}°`);

    this.section('Talking');
    this.toggle('Hear team chat', 'muteTeamChat', !s.muteTeamChat, undefined, true);
    this.toggle('Hear people nearby', 'muteNearChat', !s.muteNearChat, undefined, true);
    // Voice first among the voice rows, because the three below it do nothing
    // until it is on — and a row of live-looking controls that are all inert is
    // how a player concludes the feature is broken rather than off.
    this.toggle('Voice chat', 'voiceEnabled', s.voiceEnabled, () => this.render());
    if (s.voiceEnabled) {
      this.toggle('Hold C to talk', 'voicePushToTalk', s.voicePushToTalk);
      this.toggle('Mute my microphone', 'micMuted', s.micMuted);
      this.slider('Voice volume', 'voiceVolume', s.voiceVolume, 0, 1, 0.05,
        (v) => `${Math.round(v * 100)}%`);
    }

    this.section('Sound');
    this.slider('Master volume', 'masterVolume', s.masterVolume, 0, 1, 0.05,
      (v) => `${Math.round(v * 100)}%`);
    this.slider('Effects volume', 'sfxVolume', s.sfxVolume, 0, 1, 0.05,
      (v) => `${Math.round(v * 100)}%`);

    this.section('Playing');
    this.toggle('Toggle crouch', 'toggleCrouch', s.toggleCrouch);
    this.toggle('Toggle sprint', 'toggleSprint', s.toggleSprint);
    this.toggle('Colourblind-friendly build colours', 'colorblindGhost', s.colorblindGhost);
    this.toggle('Spray can', 'sprayCan', s.sprayCan);
    this.toggle('Captions for sounds', 'captions', s.captions);

    this.section('Controller');
    this.toggle('Controller', 'gamepadEnabled', s.gamepadEnabled);
    // Shown in degrees per second: radians per second is the right unit for the
    // code and a meaningless one for a player choosing how fast to turn.
    this.slider('Look speed', 'gamepadLookSpeed', s.gamepadLookSpeed, 0.8, 6, 0.1,
      (v) => `${Math.round((v * 180) / Math.PI)}°/s`);
    this.slider('Deadzone', 'gamepadDeadzone', s.gamepadDeadzone, 0, 0.5, 0.01,
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
   * Clicking a slot arms a one-shot capture. The capture listens on the window
   * in the capture phase so it sees the key before anything else can act on it
   * — otherwise binding Escape would close the menu, and binding a movement key
   * would walk the player around behind the screen.
   *
   * Two buttons a row, because an action holds two keys and the screen has to
   * be able to address either. One button showing "W / Up Arrow" could display
   * a pair and never change one of them, which is what it used to do.
   */
  private renderControls(): void {
    this.heading('Controls');

    const hint = document.createElement('p');
    hint.className = this.bindNote === null ? 'mk-hint' : 'mk-hint said';
    // The two escape hatches have to be said somewhere. Neither is guessable,
    // and a player who cannot get out of a capture they opened by accident has
    // to reload the game to leave this screen.
    hint.textContent = this.bindNote
      ?? 'Two keys per control. Click one to change it — Esc cancels, Backspace clears it.';
    this.card.appendChild(hint);
    this.bindNote = null;

    for (const group of this.callbacks.listBindings()) {
      const title = document.createElement('div');
      title.className = 'mk-group';
      title.textContent = group.title;
      this.card.appendChild(title);

      for (const row of group.rows) {
        const el = document.createElement('div');
        el.className = 'mk-bind';

        const label = document.createElement('label');
        label.textContent = row.label;
        el.appendChild(label);

        const keys = document.createElement('div');
        keys.className = 'keys';
        row.keys.forEach((key, slot) => {
          const btn = document.createElement('button');
          btn.textContent = key ?? '—';
          if (key === null) btn.classList.add('empty');
          btn.title = slot === 0 ? 'Main key' : 'Second key';
          btn.addEventListener('click', () => {
            if (this.listening !== null) return;
            btn.classList.add('listening');
            btn.textContent = 'press…';
            this.beginCapture(row.action, slot, row.label);
          });
          keys.appendChild(btn);
        });
        el.appendChild(keys);

        this.card.appendChild(el);
      }
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

  // ── The locker ──────────────────────────────────────────────────────────────

  /** Which tab is open. Kept across renders, because every control re-renders. */
  private lockerTab = 0;
  /** Which mark is being painted. */
  private lockerSlot: MarkSlot = 'chest';

  /**
   * Everything you can choose about yourself.
   *
   * Every control applies **immediately** rather than on an OK button, and that
   * is the design rather than a shortcut: the preview is the player standing in
   * the yard behind this card, drawn by the same rig, in the same light, at the
   * distance other people will see them from. A change you have to confirm
   * before you can see it is a change you are guessing at.
   *
   * The whole screen re-renders on every change, which for forty-odd small
   * elements is nothing and removes the entire class of bug where a control
   * shows one thing and the character wears another.
   */
  private renderLocker(): void {
    const view = this.callbacks.locker();
    const a = view.appearance;
    const edit = (change: Partial<Appearance>): void => {
      this.callbacks.onLockerChange({ ...a, ...change });
      this.render();
    };

    this.heading('Locker');

    const hint = document.createElement('p');
    hint.className = 'mk-hint';
    hint.textContent = 'That is you, out on the lawn. Everything here is worn the moment you pick it.';
    this.card.appendChild(hint);

    // Turning on the spot, because half of an outfit is on the back and this is
    // the only screen where anybody will ever look at it.
    const spin = document.createElement('div');
    spin.className = 'mk-chips';
    for (const [label, delta] of [['↶ Turn', -0.6], ['Turn ↷', 0.6]] as const) {
      const b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('click', (e) => { e.stopPropagation(); this.callbacks.onLockerTurn(delta); });
      spin.appendChild(b);
    }
    this.card.appendChild(spin);

    const tabs = ['Face', 'Hair', 'Clothes', 'Shape', 'Paint', 'Outfits'];
    const bar = document.createElement('div');
    bar.className = 'mk-tabs';
    tabs.forEach((name, i) => {
      const b = document.createElement('button');
      b.textContent = name;
      if (i === this.lockerTab) b.classList.add('on');
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        this.lockerTab = i;
        this.render();
      });
      bar.appendChild(b);
    });
    this.card.appendChild(bar);

    switch (tabs[this.lockerTab]) {
      case 'Face':
        this.swatches('Skin', SKIN_TONES, a.skin, (i) => edit({ skin: i }));
        this.swatches('Eyes', EYE_COLOURS, a.eyes, (i) => edit({ eyes: i }));
        this.chips('Brows', BROWS.map((b) => b.name), a.brows, (i) => edit({ brows: i }));
        this.chips('Mouth', MOUTHS.map((m) => m.name), a.mouth, (i) => edit({ mouth: i }));
        break;

      case 'Hair':
        this.chips('Style', HAIR_STYLES.map((h) => h.name), a.hairStyle,
          (i) => edit({ hairStyle: i }));
        this.swatches('Colour', HAIR_COLOURS, a.hair, (i) => edit({ hair: i }));
        break;

      case 'Clothes': {
        this.swatches('Shirt', CLOTH_COLOURS, a.shirt, (i) => edit({ shirt: i }));
        this.swatches('Trousers', CLOTH_COLOURS, a.trousers, (i) => edit({ trousers: i }));
        this.swatches('Shoes', CLOTH_COLOURS, a.shoes, (i) => edit({ shoes: i }));
        // The one honest thing to say about a shirt in a game with sides.
        const note = document.createElement('p');
        note.className = 'mk-hint';
        note.textContent = 'In a game with teams you wear your team\u2019s shirt instead, so'
          + ' everybody can tell who is who. The rest of this is yours all round.';
        this.card.appendChild(note);
        break;
      }

      case 'Shape': {
        this.range('Head size', a.headSize, (v) => edit({ headSize: v }));
        this.range('Build', a.build, (v) => edit({ build: v }));
        // Said out loud, because somebody looking for a height slider deserves
        // to know it is missing on purpose rather than not built yet.
        const note = document.createElement('p');
        note.className = 'mk-hint';
        note.textContent = 'Both slide inside a fixed range, and there is no height:'
          + ' everybody has to be the same size to be hit, hidden and climbed over'
          + ' by the same rules.';
        this.card.appendChild(note);
        break;
      }

      case 'Paint': {
        this.chips(
          'Where', ['Chest', 'Back', 'Left arm', 'Right arm'],
          MARK_SLOTS.indexOf(this.lockerSlot),
          (i) => { this.lockerSlot = MARK_SLOTS[i]!; this.render(); },
        );
        const mark = a.marks[this.lockerSlot];
        const setMark = (change: Partial<Mark>): void => {
          edit({ marks: { ...a.marks, [this.lockerSlot]: { ...mark, ...change } } });
        };
        this.chips(
          'Shape',
          MARK_SHAPES.map((m) => (m === 'none' ? 'None' : m[0]!.toUpperCase() + m.slice(1))),
          mark.shape, (i) => setMark({ shape: i }),
        );
        if (mark.shape !== 0) {
          this.swatches('Colour', CLOTH_COLOURS, mark.colour, (i) => setMark({ colour: i }));
          this.range('Size', mark.size, (v) => setMark({ size: v }));
          this.range('Angle', mark.turn, (v) => setMark({ turn: v }));
        }
        this.button('Clear this one', () => {
          edit({ marks: { ...a.marks, [this.lockerSlot]: blankMark() } });
        }, 'mk-secondary');
        break;
      }

      case 'Outfits': {
        // One field, held across renders, because every control on this screen
        // re-renders the card and a fresh input would lose what was typed.
        this.card.appendChild(this.presetName);
        this.button(view.full ? 'Locker full' : 'Save outfit', () => {
          if (this.callbacks.onLockerSave(this.presetName.value)) {
            this.presetName.value = '';
            this.render();
          }
        });
        if (view.presets.length === 0) {
          const empty = document.createElement('p');
          empty.className = 'mk-hint';
          empty.textContent = 'Nothing saved yet. Keep an outfit here and you can put it'
            + ' back on in one click.';
          this.card.appendChild(empty);
        }
        for (const preset of view.presets) {
          const row = document.createElement('div');
          row.className = 'mk-preset';
          const who = document.createElement('span');
          who.className = 'who';
          who.textContent = preset.name;
          row.appendChild(who);
          for (const [label, act] of [
            ['Wear', () => this.callbacks.onLockerWear(preset.name)],
            ['Delete', () => this.callbacks.onLockerDelete(preset.name)],
          ] as Array<[string, () => boolean]>) {
            const b = document.createElement('button');
            b.textContent = label;
            b.addEventListener('click', (e) => { e.stopPropagation(); act(); this.render(); });
            row.appendChild(b);
          }
          this.card.appendChild(row);
        }
        break;
      }

      default:
        break;
    }

    const spacer = document.createElement('div');
    spacer.style.height = '10px';
    this.card.appendChild(spacer);

    this.button('Surprise me', () => { this.callbacks.onLockerRandom(); this.render(); }, 'mk-secondary');
    this.button('Start over', () => { this.callbacks.onLockerReset(); this.render(); }, 'mk-secondary');
    this.button('Done', () => this.show(this.returnTo));
  }

  /** A row of colour chips, one of them ringed. */
  private swatches(
    label: string, colours: readonly number[], selected: number, pick: (i: number) => void,
  ): void {
    this.label(label);
    const row = document.createElement('div');
    row.className = 'mk-swatches';
    colours.forEach((hex, i) => {
      const b = document.createElement('button');
      b.style.background = `#${hex.toString(16).padStart(6, '0')}`;
      b.setAttribute('aria-label', `${label} ${i + 1}`);
      if (i === selected) b.classList.add('on');
      b.addEventListener('click', (e) => { e.stopPropagation(); pick(i); });
      row.appendChild(b);
    });
    this.card.appendChild(row);
  }

  /** A row of named chips, one of them filled. */
  private chips(
    label: string, names: readonly string[], selected: number, pick: (i: number) => void,
  ): void {
    this.label(label);
    const row = document.createElement('div');
    row.className = 'mk-chips';
    names.forEach((name, i) => {
      const b = document.createElement('button');
      b.textContent = name;
      if (i === selected) b.classList.add('on');
      b.addEventListener('click', (e) => { e.stopPropagation(); pick(i); });
      row.appendChild(b);
    });
    this.card.appendChild(row);
  }

  /**
   * A 0-to-1 slider that is not bound to a setting.
   *
   * `slider` writes straight into the settings store, which is right for
   * everything on the settings screen and wrong for everything here: an
   * appearance is one record that travels, not nineteen independent fields.
   */
  private range(label: string, value: number, onChange: (v: number) => void): void {
    const row = document.createElement('div');
    row.className = 'mk-row';
    const l = document.createElement('label');
    l.textContent = label;
    row.appendChild(l);

    const input = document.createElement('input');
    input.type = 'range';
    input.min = '0';
    input.max = '1';
    input.step = '0.02';
    input.value = String(value);
    input.setAttribute('aria-label', label);
    // `input` rather than `change`, so the character moves under the thumb
    // rather than when it is let go.
    input.addEventListener('input', () => onChange(Number(input.value)));
    row.appendChild(input);
    this.card.appendChild(row);
  }

  private label(text: string): void {
    const el = document.createElement('div');
    el.className = 'mk-label';
    el.textContent = text;
    this.card.appendChild(el);
  }

  private listening: (() => void) | null = null;
  /** Said once, on the next render of the controls screen, then cleared. */
  private bindNote: string | null = null;

  private beginCapture(action: string, slot: number, label: string): void {
    const finish = (): void => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onMouse, true);
      this.listening = null;
      this.render();
    };

    const took = (from: string | null, key: string): void => {
      // A key can only mean one thing, so binding one somebody else had takes
      // it. Saying so is the difference between a control the player retired on
      // purpose and one that mysteriously stopped working.
      this.bindNote = from === null ? null : `${key} taken from ${from}`;
    };

    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      // Escape cancels rather than binding; a player who has bound Escape to
      // something has no way back out of a menu. Backspace and Delete empty the
      // slot, which is the only way to end up with a control on one key.
      if (e.code === 'Backspace' || e.code === 'Delete') {
        this.callbacks.clearBinding(action, slot);
        this.bindNote = `${label} cleared`;
      } else if (e.code !== 'Escape') {
        took(this.callbacks.rebind(action, slot, e.code), describeKey(e.code));
      }
      finish();
    };

    const onMouse = (e: MouseEvent): void => {
      // Only inside the card, or clicking Back would bind a mouse button.
      if (!(e.target instanceof Node) || !this.card.contains(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      const code = `Mouse${e.button}`;
      took(this.callbacks.rebind(action, slot, code), describeKey(code));
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
   *
   * `inverted` is for a setting stored as a negative and read as a positive.
   * The two chat mutes are the case, and it is worth the parameter rather than
   * relabelling them: a stored `muteTeamChat` says what the code does with it,
   * while a row reading "Mute team chat" with a tick in it is a double negative
   * a player has to unpick. "Hear team chat", ticked, is the same fact stated
   * the way somebody thinks about it.
   */
  private toggle<K extends keyof Settings>(
    label: string, key: K, value: boolean, afterChange?: () => void, inverted = false,
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
      const stored = inverted ? !input.checked : input.checked;
      this.settings.set(key, stored as Settings[K]);
      afterChange?.();
    });
    row.appendChild(input);

    this.card.appendChild(row);
  }

  /**
   * A row of words to pick between, for a setting that is not a number and not
   * a yes/no.
   *
   * Chips rather than a `<select>`, because the whole menu is chips and a
   * native dropdown in the middle of it looks like it belongs to a different
   * program — and because with four short options there is nothing to gain by
   * hiding three of them behind a click.
   */
  private choice<K extends keyof Settings>(
    label: string, key: K, value: string,
    options: ReadonlyArray<{ value: string; label: string }>,
  ): void {
    const row = document.createElement('div');
    row.className = 'mk-row';

    const l = document.createElement('label');
    l.textContent = label;
    row.appendChild(l);

    const group = document.createElement('div');
    group.className = 'mk-choice';
    for (const option of options) {
      const btn = document.createElement('button');
      btn.textContent = option.label;
      btn.dataset.value = option.value;
      if (option.value === value) btn.classList.add('on');
      btn.addEventListener('click', () => {
        this.settings.set(key, option.value as Settings[K]);
        this.render();
      });
      group.appendChild(btn);
    }
    row.appendChild(group);

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
