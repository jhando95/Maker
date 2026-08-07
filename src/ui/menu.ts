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

export type Screen =
  | 'none' | 'title' | 'settings' | 'builds' | 'pause' | 'result' | 'controls' | 'lobby'
  | 'together';

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
      case 'together': this.renderTogether(); break;
      case 'lobby': this.renderLobby(); break;
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
  /**
   * The two connection fields, made once and kept.
   *
   * Built in the constructor rather than per render, so what somebody typed
   * survives a trip to the lobby and back. They were recreated on every render
   * before, which meant editing the address and then opening any other screen
   * silently put it back to the default.
   */
  private readonly relay = Menu.field('ws://localhost:8787', 'relay address');
  private readonly room = Menu.field('yard', 'room name', 'mk-input-short');

  private static field(value: string, label: string, extra = ''): HTMLInputElement {
    const el = document.createElement('input');
    el.type = 'text';
    el.className = `mk-input ${extra}`.trim();
    el.placeholder = value;
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
