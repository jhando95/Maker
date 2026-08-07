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
  /** Hold to crouch, or press to toggle. */
  toggleCrouch: boolean;
  toggleSprint: boolean;

  gamepadEnabled: boolean;
  /** Stick look speed at full deflection, in radians per second. */
  gamepadLookSpeed: number;
  /** Radial stick deadzone, as a fraction of full deflection. */
  gamepadDeadzone: number;
}

export const DEFAULT_SETTINGS: Settings = {
  sensitivity: 0.0022,
  invertY: false,
  fov: 72,
  shadows: true,
  outlines: true,
  showStats: false,
  renderScale: 1,
  autoQuality: true,
  masterVolume: 0.7,
  sfxVolume: 1,
  colorblindGhost: false,
  toggleCrouch: false,
  toggleSprint: false,
  gamepadEnabled: true,
  gamepadLookSpeed: 2.6,
  gamepadDeadzone: 0.16,
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

function clampSetting<K extends keyof Settings>(key: K, value: Settings[K]): Settings[K] {
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

const BINDINGS_KEY = 'maker.bindings.v1';

/**
 * Key bindings persist separately from settings.
 *
 * They are a map of arbitrary key codes rather than a fixed set of fields, so
 * the type-checked key-by-key validation the settings store uses does not
 * apply. Keeping them apart means a bad bindings blob cannot take the settings
 * with it.
 */
export function loadBindings(): Record<string, string> | null {
  try {
    const raw = localStorage.getItem(BINDINGS_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const out: Record<string, string> = {};
    for (const [code, action] of Object.entries(parsed)) {
      if (typeof code === 'string' && typeof action === 'string') out[code] = action;
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}

export function saveBindings(bindings: Record<string, string>): void {
  try {
    localStorage.setItem(BINDINGS_KEY, JSON.stringify(bindings));
  } catch {
    // Storage unavailable; bindings simply do not persist this session.
  }
}

export function clearBindings(): void {
  try {
    localStorage.removeItem(BINDINGS_KEY);
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
