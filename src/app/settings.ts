/**
 * Player settings, persisted to localStorage.
 *
 * Stored under a versioned key. A stored blob from an older shape is discarded
 * rather than migrated: settings are cheap to re-pick, and migration code for a
 * dozen scalars costs more than it saves. What matters is that a corrupt or
 * stale blob can never crash the boot path, which is why every read is
 * defensive and falls back to the default.
 */

const STORAGE_KEY = 'maker.settings.v1';

export interface Settings {
  /** Radians of view rotation per pixel of mouse movement. */
  sensitivity: number;
  invertY: boolean;
  /** First-person vertical field of view, in degrees. */
  fov: number;
  shadows: boolean;
  outlines: boolean;
  /**
   * Show a small frame-rate readout while playing.
   *
   * Off by default, and its own setting rather than a corner of the debug
   * overlay: that one answers a developer's questions — how high is the player,
   * how many parts are in the world — and a player who wants to know whether
   * their machine is keeping up should not have to read past them.
   */
  showStats: boolean;
  showMinimap: boolean;
  /**
   * Whether to hear the two chat channels.
   *
   * Two settings rather than one, because they are two different decisions:
   * team chat is people you are playing with and proximity chat is whoever
   * happens to be nearby, and the reason to silence one is almost never the
   * reason to silence the other.
   *
   * Kept here rather than sent anywhere. Muting is a statement about your own
   * screen — telling the host would make it something that has to survive a
   * reconnect and, worse, something the muted player could be told about.
   */
  muteTeamChat: boolean;
  muteNearChat: boolean;
  /**
   * Whether to use the microphone at all.
   *
   * **Off by default, and that is not timidity.** Turning this on asks the
   * browser for the microphone, and a game that raises a permission prompt
   * before the player has decided they want to talk to anybody has spent the
   * one prompt it gets on a question they had no context for. A refused prompt
   * is sticky, so the cost of asking too early is that the feature is dead
   * until they go and find the site settings.
   */
  voiceEnabled: boolean;
  /**
   * Hold a key to talk, or send continuously.
   *
   * Push-to-talk by default. Open mic is what you want when everyone is in a
   * quiet room and a menace otherwise, and the failure mode is not symmetric:
   * the person broadcasting their television has no idea they are doing it.
   */
  voicePushToTalk: boolean;
  /** Silence your own microphone without giving the permission back. */
  micMuted: boolean;
  /** How loud everybody else is, on top of the distance falloff. */
  voiceVolume: number;
  /**
   * Render scale, 0.5 to 1. Below 1 renders smaller and upscales.
   *
   * With `autoQuality` on this is a ceiling rather than a fixed value: the
   * governor picks something at or below it.
   */
  renderScale: number;
  /** Let the game lower the render scale by itself when frames are being missed. */
  autoQuality: boolean;
  masterVolume: number;
  sfxVolume: number;
  /**
   * Ghost colours that stay distinguishable for the ~8% of players with
   * red-green colour blindness, for whom the default green/red valid-invalid
   * pair is the single worst choice a builder could make.
   */
  colorblindGhost: boolean;
  /**
   * Whether the spray can is in the hotbar at all.
   *
   * On by default and switchable off, which is the honest way to ship a toy
   * into a shared world: it is the one feature here that exists purely to be
   * silly, it is the one that can be used to annoy somebody, and a host who
   * decides their lobby does not want paint on the fence should not have to
   * ask anybody to behave.
   */
  sprayCan: boolean;
  /**
   * Say on screen what the garden sounds like.
   *
   * An accessibility option that is also a gameplay one. The collapse sound
   * carries forty-eight metres against a placement's twenty-four, and
   * `gameSounds.collapsed` says why: in a mode where two people are dismantling
   * each other's forts it is the only warning the other one gets. A player who
   * cannot hear it is not missing flavour, they are missing the warning.
   *
   * Off by default, because it is a second thing on the screen for somebody who
   * did not ask for it — and every caption obeys the range of the sound it
   * stands in for, so turning it on is never an advantage.
   */
  captions: boolean;
  /** Hold to crouch, or press to toggle. */
  toggleCrouch: boolean;
  toggleSprint: boolean;

  gamepadEnabled: boolean;
  /** Stick look speed at full deflection, in radians per second. */
  gamepadLookSpeed: number;
  /** Radial stick deadzone, as a fraction of full deflection. */
  gamepadDeadzone: number;
  /**
   * What time of day the garden is in.
   *
   * `round` is the interesting one and the default: the afternoon gets late as
   * the round runs, so a game that goes the distance ends at dusk with the
   * streetlights coming on. The three fixed settings are there because a player
   * who wants the golden hour for a screenshot should not have to play four
   * minutes of a round to get it — and because "the light keeps changing" is a
   * thing some people find distracting and should be able to switch off.
   */
  timeOfDay: 'round' | 'afternoon' | 'golden' | 'dusk';
}

export const DEFAULT_SETTINGS: Settings = {
  sensitivity: 0.0022,
  invertY: false,
  fov: 72,
  shadows: true,
  outlines: true,
  showStats: false,
  showMinimap: true,
  muteTeamChat: false,
  muteNearChat: false,
  voiceEnabled: false,
  voicePushToTalk: true,
  micMuted: false,
  voiceVolume: 1,
  renderScale: 1,
  autoQuality: true,
  masterVolume: 0.7,
  sfxVolume: 1,
  colorblindGhost: false,
  sprayCan: true,
  captions: false,
  toggleCrouch: false,
  toggleSprint: false,
  gamepadEnabled: true,
  gamepadLookSpeed: 2.6,
  gamepadDeadzone: 0.16,
  timeOfDay: 'round',
};

/** Bounds for every numeric setting, so a hand-edited blob cannot break the game. */
const RANGES: Partial<Record<keyof Settings, [number, number]>> = {
  sensitivity: [0.0004, 0.008],
  fov: [55, 110],
  renderScale: [0.5, 1],
  masterVolume: [0, 1],
  sfxVolume: [0, 1],
  gamepadLookSpeed: [0.8, 6],
  // Above half the stick's travel there is not enough range left to aim with,
  // and a deadzone of zero makes a worn stick drift on its own.
  gamepadDeadzone: [0, 0.5],
};

/**
 * The allowed values for every setting that is a word rather than a number.
 *
 * `load` checks types and not values, which is enough while everything is a
 * boolean or a number and stops being enough the moment one is a word: a
 * hand-edited blob saying `"timeOfDay": "midnight"` is a string, passes the
 * typeof check, and leaves the game asking for a time that does not exist.
 */
const CHOICES: Partial<Record<keyof Settings, readonly string[]>> = {
  timeOfDay: ['round', 'afternoon', 'golden', 'dusk'],
};

function clampSetting<K extends keyof Settings>(key: K, value: Settings[K]): Settings[K] {
  const choices = CHOICES[key];
  if (choices !== undefined) {
    return (typeof value === 'string' && choices.includes(value)
      ? value : DEFAULT_SETTINGS[key]) as Settings[K];
  }
  const range = RANGES[key];
  if (range === undefined || typeof value !== 'number') return value;
  return Math.max(range[0], Math.min(range[1], value)) as Settings[K];
}

export type SettingsListener = (settings: Readonly<Settings>) => void;

export class SettingsStore {
  private values: Settings;
  private readonly listeners = new Set<SettingsListener>();

  constructor(initial?: Partial<Settings>) {
    this.values = { ...DEFAULT_SETTINGS, ...this.load(), ...initial };
  }

  get current(): Readonly<Settings> {
    return this.values;
  }

  get<K extends keyof Settings>(key: K): Settings[K] {
    return this.values[key];
  }

  set<K extends keyof Settings>(key: K, value: Settings[K]): void {
    const clamped = clampSetting(key, value);
    if (this.values[key] === clamped) return;
    this.values[key] = clamped;
    this.save();
    this.emit();
  }

  reset(): void {
    this.values = { ...DEFAULT_SETTINGS };
    this.save();
    this.emit();
  }

  /** Subscribe to changes. Returns an unsubscribe function. */
  subscribe(listener: SettingsListener): () => void {
    this.listeners.add(listener);
    // Fire immediately so a subscriber does not have to apply defaults itself.
    listener(this.values);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of this.listeners) l(this.values);
  }

  private load(): Partial<Settings> {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw === null) return {};
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return {};

      // Take only keys we recognise, with the right primitive type. A blob
      // written by a newer build, or edited by hand, must not smuggle in
      // unexpected shapes.
      const out: Partial<Settings> = {};
      for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>) {
        const value = (parsed as Record<string, unknown>)[key];
        if (typeof value === typeof DEFAULT_SETTINGS[key]) {
          out[key] = clampSetting(key, value as Settings[typeof key]) as never;
        }
      }
      return out;
    } catch {
      // Private browsing, a quota error, or malformed JSON. Defaults are fine.
      return {};
    }
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.values));
    } catch {
      // Storage unavailable; settings simply do not persist this session.
    }
  }
}

const BINDINGS_KEY = 'maker.bindings.v2';
/** What a player who last ran the game before actions had two slots has. */
const BINDINGS_KEY_V1 = 'maker.bindings.v1';

/** An action's keys, in slot order. `null` is an empty slot. */
export type BindingSlots = Record<string, (string | null)[]>;

/**
 * Key bindings persist separately from settings.
 *
 * They are keyed by arbitrary action names rather than a fixed set of fields,
 * so the type-checked key-by-key validation the settings store uses does not
 * apply. Keeping them apart means a bad bindings blob cannot take the settings
 * with it.
 *
 * The stored shape is action to slots, which is the shape the game holds them
 * in. It used to be the inverse — code to action — and that could not express
 * the thing the format now exists for: which of an action's two keys is the
 * primary. An object's key order carries it by accident in JavaScript, and a
 * semantic resting on `Object.keys` ordering is one `delete` away from being
 * wrong with nothing to show for it.
 */
export function loadBindings(): BindingSlots | null {
  const current = read(BINDINGS_KEY, parseSlots);
  if (current !== null) return current;
  // Nothing at v2: an existing player's keys are in the old flat map, and
  // dropping them on an upgrade would silently reset controls somebody chose.
  return read(BINDINGS_KEY_V1, parseFlatMap);
}

function read<T>(key: string, parse: (value: object) => T | null): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parse(parsed);
  } catch {
    // Private browsing, a quota error, or malformed JSON. Defaults are fine.
    return null;
  }
}

function parseSlots(parsed: object): BindingSlots | null {
  const out: BindingSlots = {};
  for (const [action, slots] of Object.entries(parsed)) {
    if (!Array.isArray(slots)) continue;
    // Entry by entry rather than trusting the array: this blob survives a
    // version of the game the player is no longer running.
    const kept = slots.map((code) => (typeof code === 'string' && code.length > 0 ? code : null));
    if (kept.some((code) => code !== null)) out[action] = kept;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * The v1 shape, turned into slots.
 *
 * Order is taken from the map as written, which is the same rule
 * `slotsFromMap` uses — and it is the best available answer, because the old
 * format never recorded which key was the primary.
 */
function parseFlatMap(parsed: object): BindingSlots | null {
  const out: BindingSlots = {};
  for (const [code, action] of Object.entries(parsed)) {
    if (typeof code !== 'string' || typeof action !== 'string' || code.length === 0) continue;
    (out[action] ??= []).push(code);
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function saveBindings(slots: BindingSlots): void {
  try {
    localStorage.setItem(BINDINGS_KEY, JSON.stringify(slots));
  } catch {
    // Storage unavailable; bindings simply do not persist this session.
  }
}

export function clearBindings(): void {
  try {
    localStorage.removeItem(BINDINGS_KEY);
    // The old key too, or "reset controls" would put the pre-upgrade bindings
    // back the next time the game started.
    localStorage.removeItem(BINDINGS_KEY_V1);
  } catch {
    /* nothing useful to do */
  }
}

/** Ghost colours, swapped for a colourblind-safe pair when requested. */
export function ghostColors(colorblind: boolean): { valid: number; invalid: number } {
  return colorblind
    // Blue/orange rather than green/red: distinguishable under every common
    // form of colour blindness, and still reads as go/stop.
    ? { valid: 0x6ec6ff, invalid: 0xff9f40 }
    : { valid: 0x8fe3a0, invalid: 0xff6b6b };
}
