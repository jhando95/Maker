/**
 * Input: raw devices in, named actions out.
 *
 * Nothing in the game reads `KeyW`. Systems ask for actions like `moveForward`
 * or `placePart`, which keeps rebinding, gamepad support, and (later) replaying
 * a recorded input stream for netcode debugging all possible without touching
 * gameplay code.
 *
 * Edge detection (`pressed`/`released`) is resolved per simulation tick rather
 * than per frame. A render frame can occur without a simulation tick, and on a
 * high-refresh display several frames can pass between ticks; sampling edges on
 * frames would let a click fire twice or vanish entirely. Devices write into a
 * pending buffer, and `beginTick()` folds that buffer into the tick's state.
 */

export const ACTIONS = [
  'moveForward',
  'moveBack',
  'moveLeft',
  'moveRight',
  'jump',
  'sprint',
  'crouch',

  'placePart',
  'removePart',
  'freeAim', // hold to suspend snapping
  'cycleSnap', // step through competing snap candidates
  'rotateCW',
  'rotateCCW',
  'rotatePitch',
  'rotateRoll',
  'resetRotation',
  'repeatPlace',

  'nextPart',
  'prevPart',
  'hotbar1',
  'hotbar2',
  'hotbar3',
  'hotbar4',
  'hotbar5',
  'hotbar6',
  'hotbar7',
  'hotbar8',

  'toggleCamera',
  'partWheel',
  'interact',

  /**
   * Talking to people.
   *
   * `ping` is on the middle mouse button because that is where every game that
   * has one puts it: it has to be reachable without letting go of movement or
   * aim, and it is the one comms action taken while something is happening.
   * Chat and the emote wheel are keyboard, because both stop you playing.
   */
  'ping',
  'chatNear',
  'chatTeam',
  'emoteWheel',
  'pushToTalk',
  'cycleBlueprint',
  'saveBlueprint',

  'debugToggle',
  'debugFreeCam',
] as const;

export type Action = (typeof ACTIONS)[number];

/** Default keyboard/mouse bindings. Mouse buttons are `Mouse0`..`Mouse4`. */
export const DEFAULT_BINDINGS: Record<string, Action> = {
  KeyW: 'moveForward',
  ArrowUp: 'moveForward',
  KeyS: 'moveBack',
  ArrowDown: 'moveBack',
  KeyA: 'moveLeft',
  ArrowLeft: 'moveLeft',
  KeyD: 'moveRight',
  ArrowRight: 'moveRight',
  Space: 'jump',
  ShiftLeft: 'sprint',
  ShiftRight: 'sprint',
  // Crouch used to be double-bound here and on C. C went to push-to-talk, which
  // had no key at all and needs one under the left hand; see the note there.
  ControlLeft: 'crouch',

  Mouse0: 'placePart',
  Mouse2: 'removePart',
  AltLeft: 'freeAim',
  KeyR: 'cycleSnap',
  KeyQ: 'rotateCCW',
  KeyE: 'rotateCW',
  KeyZ: 'rotatePitch',
  KeyX: 'rotateRoll',
  KeyT: 'resetRotation',
  KeyG: 'repeatPlace',

  Digit1: 'hotbar1',
  Digit2: 'hotbar2',
  Digit3: 'hotbar3',
  Digit4: 'hotbar4',
  Digit5: 'hotbar5',
  Digit6: 'hotbar6',
  Digit7: 'hotbar7',
  Digit8: 'hotbar8',

  KeyV: 'toggleCamera',
  Tab: 'partWheel',
  KeyF: 'interact',

  Mouse1: 'ping',
  Enter: 'chatNear',
  // The convention everywhere: the same key with a modifier is the team's
  // channel. Bound as its own action rather than as a modifier check, so it can
  // be rebound by somebody who does not have a comfortable Shift.
  KeyY: 'chatTeam',
  KeyB: 'emoteWheel',
  // C, taken from crouch — which keeps Left Control and loses nothing.
  //
  // Push-to-talk has to be held while moving and aiming, so it has to sit under
  // the left hand. Every genuinely unbound key fails that: the free letters are
  // all on the right of the keyboard, Alt is intercepted by the browser, and
  // CapsLock does not fire a reliable keyup on macOS — which for a *hold* key
  // means a microphone that stays open after the player lets go, the worst
  // possible failure for this particular feature.
  //
  // So one of two conventional keys had to give up its second binding, and
  // crouch was already double-bound while push-to-talk had nothing. Both
  // actions still land on a key players expect to find them on.
  KeyC: 'pushToTalk',
  // Blueprints. Both free, both away from the movement keys on purpose: one
  // chooses what you are holding and the other saves what you built, and
  // neither is pressed in the middle of anything.
  KeyM: 'cycleBlueprint',
  KeyN: 'saveBlueprint',

  Backquote: 'debugToggle',
  KeyP: 'debugFreeCam',
};

/** Which kind of device the player is currently using. */
export type InputDevice = 'keyboard' | 'gamepad';

interface ActionState {
  /** Held right now. */
  down: boolean;
  /** Went down during the tick that just began. */
  pressed: boolean;
  /** Came up during the tick that just began. */
  released: boolean;
}

/** Actions a player can rebind, in the order the settings screen lists them. */
export const BINDABLE: ReadonlyArray<{ action: Action; label: string }> = [
  { action: 'moveForward', label: 'Move forward' },
  { action: 'moveBack', label: 'Move back' },
  { action: 'moveLeft', label: 'Move left' },
  { action: 'moveRight', label: 'Move right' },
  { action: 'jump', label: 'Jump' },
  { action: 'sprint', label: 'Sprint' },
  { action: 'crouch', label: 'Crouch' },
  { action: 'placePart', label: 'Place / throw' },
  { action: 'removePart', label: 'Remove part' },
  { action: 'freeAim', label: 'Free aim' },
  { action: 'cycleSnap', label: 'Next snap' },
  { action: 'repeatPlace', label: 'Repeat step' },
  { action: 'rotateCCW', label: 'Turn left' },
  { action: 'rotateCW', label: 'Turn right' },
  { action: 'rotatePitch', label: 'Tilt' },
  { action: 'rotateRoll', label: 'Roll' },
  { action: 'resetRotation', label: 'Reset rotation' },
  { action: 'partWheel', label: 'Part wheel' },
  { action: 'toggleCamera', label: 'Camera' },
  { action: 'interact', label: 'Undo' },
];

/** Human-readable name for a key code or mouse button. */
export function describeKey(code: string): string {
  if (code.startsWith('Mouse')) {
    const n = Number(code.slice(5));
    return n === 0 ? 'Left Mouse' : n === 1 ? 'Middle Mouse' : n === 2 ? 'Right Mouse' : `Mouse ${n}`;
  }
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Arrow')) return `${code.slice(5)} Arrow`;
  const named: Record<string, string> = {
    Space: 'Space', ShiftLeft: 'L Shift', ShiftRight: 'R Shift',
    ControlLeft: 'L Ctrl', ControlRight: 'R Ctrl',
    AltLeft: 'L Alt', AltRight: 'R Alt',
    Tab: 'Tab', Backquote: '`', Enter: 'Enter',
  };
  return named[code] ?? code;
}

export class Input {
  private bindings: Record<string, Action>;
  private readonly state = new Map<Action, ActionState>();

  /** Device events land here and are folded in at the next tick boundary. */
  private readonly pendingDown = new Set<Action>();
  private readonly pendingUp = new Set<Action>();

  /** Accumulated mouse delta in pixels since the last tick. */
  private mouseDx = 0;
  private mouseDy = 0;
  /** Consumed snapshot of the above, valid for the current tick. */
  private tickMouseDx = 0;
  private tickMouseDy = 0;

  /** Accumulated wheel delta since the last tick, in notches. */
  private wheelDelta = 0;
  private tickWheelDelta = 0;

  /**
   * Analog movement from a stick, in the same local space as `moveAxis`.
   *
   * Kept separate from the digital actions rather than folded into them,
   * because a stick carries a magnitude and a key does not: pushing a stick a
   * third of the way must walk, not run.
   */
  private analogMoveX = 0;
  private analogMoveZ = 0;

  /** Stick look, in radians per second. Not pixels — see gamepad.ts. */
  private padLookYaw = 0;
  private padLookPitch = 0;

  private pointerLocked = false;
  private enabled = true;

  /**
   * The device the player last actually used.
   *
   * Only so the on-screen hints can say LB when there is a pad in someone's
   * hands and Q when there is not. Nothing in gameplay reads it.
   */
  private device: InputDevice = 'keyboard';
  onDeviceChange: ((device: InputDevice) => void) | null = null;

  private readonly element: HTMLElement;
  private readonly disposers: Array<() => void> = [];

  /** Fires when pointer lock is gained or lost, so the UI can show/hide a prompt. */
  onPointerLockChange: ((locked: boolean) => void) | null = null;

  constructor(element: HTMLElement, bindings: Record<string, Action> = DEFAULT_BINDINGS) {
    this.element = element;
    this.bindings = { ...bindings };
    for (const action of ACTIONS) {
      this.state.set(action, { down: false, pressed: false, released: false });
    }
    this.attach();
  }

  private on<K extends keyof DocumentEventMap>(
    target: EventTarget,
    type: K,
    handler: (ev: DocumentEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ): void {
    const h = handler as EventListener;
    target.addEventListener(type, h, options);
    this.disposers.push(() => target.removeEventListener(type, h, options));
  }

  private attach(): void {
    this.on(window, 'keydown', (e) => {
      // Tab would move focus off the canvas and Space would scroll the page.
      if (this.bindings[e.code]) e.preventDefault();
      if (e.repeat) return; // auto-repeat is not a new press
      this.useDevice('keyboard');
      this.queueDown(this.bindings[e.code]);
    });

    this.on(window, 'keyup', (e) => {
      if (this.bindings[e.code]) e.preventDefault();
      this.queueUp(this.bindings[e.code]);
    });

    this.on(this.element, 'mousedown', (e) => {
      // Clicking the canvas is how you enter the game; only treat clicks as
      // gameplay input once the pointer is actually locked.
      if (!this.pointerLocked) {
        void this.requestPointerLock();
        return;
      }
      this.useDevice('keyboard');
      this.queueDown(this.bindings[`Mouse${e.button}`]);
    });

    this.on(window, 'mouseup', (e) => {
      this.queueUp(this.bindings[`Mouse${e.button}`]);
    });

    this.on(this.element, 'contextmenu', (e) => e.preventDefault());

    this.on(window, 'mousemove', (e) => {
      if (!this.pointerLocked) return;
      // A resting mouse still emits the odd one-pixel jitter, and letting that
      // claim the device would flip the hints back and forth under a player
      // who is holding a pad and never touched the mouse.
      if (Math.abs(e.movementX) + Math.abs(e.movementY) > 2) this.useDevice('keyboard');
      this.mouseDx += e.movementX;
      this.mouseDy += e.movementY;
    });

    this.on(
      window,
      'wheel',
      (e) => {
        if (!this.pointerLocked) return;
        e.preventDefault();
        // Normalize across devices: we only care about direction and count.
        this.wheelDelta += Math.sign(e.deltaY);
      },
      { passive: false },
    );

    this.on(document, 'pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === this.element;
      if (!this.pointerLocked) this.releaseAll();
      this.onPointerLockChange?.(this.pointerLocked);
    });

    // Losing focus mid-key leaves that key stuck down forever otherwise —
    // alt-tabbing while holding W would walk you into the sunset.
    this.on(window, 'blur', () => this.releaseAll());
  }

  private queueDown(action: Action | undefined): void {
    if (!action || !this.enabled) return;
    this.pendingDown.add(action);
    this.pendingUp.delete(action);
  }

  private queueUp(action: Action | undefined): void {
    if (!action) return;
    this.pendingUp.add(action);
  }

  private releaseAll(): void {
    for (const action of ACTIONS) {
      if (this.state.get(action)!.down) this.pendingUp.add(action);
    }
    this.mouseDx = 0;
    this.mouseDy = 0;
    this.wheelDelta = 0;
    this.analogMoveX = 0;
    this.analogMoveZ = 0;
    this.padLookYaw = 0;
    this.padLookPitch = 0;
  }

  private useDevice(device: InputDevice): void {
    if (this.device === device) return;
    this.device = device;
    this.onDeviceChange?.(device);
  }

  get lastDevice(): InputDevice {
    return this.device;
  }

  /**
   * Push a pad button edge in. Routed through the same queues as a key, so a
   * pad and a keyboard cannot disagree about whether an action is held.
   */
  pressAction(action: Action): void {
    this.useDevice('gamepad');
    this.queueDown(action);
  }

  releaseAction(action: Action): void {
    this.queueUp(action);
  }

  /**
   * Set stick movement and look for this frame.
   *
   * Overwritten rather than accumulated: a stick reports where it is, not how
   * far it has moved, so the newest reading is the whole truth. Zeroed when
   * input is disabled, or a menu opened mid-push would leave the player walking
   * into a wall behind it.
   */
  setPadAxes(moveX: number, moveZ: number, lookYawRate: number, lookPitchRate: number): void {
    if (!this.enabled) {
      this.analogMoveX = 0;
      this.analogMoveZ = 0;
      this.padLookYaw = 0;
      this.padLookPitch = 0;
      return;
    }
    this.analogMoveX = moveX;
    this.analogMoveZ = moveZ;
    this.padLookYaw = lookYawRate;
    this.padLookPitch = lookPitchRate;
    if (moveX !== 0 || moveZ !== 0 || lookYawRate !== 0 || lookPitchRate !== 0) {
      this.useDevice('gamepad');
    }
  }

  /** Stick look for this tick, in radians per second. Multiply by dt. */
  get padLook(): { yaw: number; pitch: number } {
    return { yaw: this.padLookYaw, pitch: this.padLookPitch };
  }

  async requestPointerLock(): Promise<void> {
    try {
      await this.element.requestPointerLock();
    } catch {
      // Browsers rate-limit re-locking after an Escape; the user can click again.
    }
  }

  exitPointerLock(): void {
    if (this.pointerLocked) document.exitPointerLock();
  }

  get isPointerLocked(): boolean {
    return this.pointerLocked;
  }

  /**
   * Fold buffered device events into this tick's action state. Call exactly
   * once at the top of every fixed update, before any system reads input.
   */
  beginTick(): void {
    for (const action of ACTIONS) {
      const s = this.state.get(action)!;
      const goingDown = this.pendingDown.has(action);
      const goingUp = this.pendingUp.has(action);

      // A press and release inside one tick still registers as a full press,
      // then settles to up — a fast click is never swallowed.
      s.pressed = goingDown && !s.down;
      s.released = goingUp && (s.down || goingDown);
      if (goingUp) s.down = false;
      else if (goingDown) s.down = true;
    }
    this.pendingDown.clear();
    this.pendingUp.clear();

    this.tickMouseDx = this.mouseDx;
    this.tickMouseDy = this.mouseDy;
    this.mouseDx = 0;
    this.mouseDy = 0;

    this.tickWheelDelta = this.wheelDelta;
    this.wheelDelta = 0;
  }

  isDown(action: Action): boolean {
    return this.state.get(action)!.down;
  }

  wasPressed(action: Action): boolean {
    return this.state.get(action)!.pressed;
  }

  wasReleased(action: Action): boolean {
    return this.state.get(action)!.released;
  }

  /**
   * Push a look delta in, as if the mouse had moved.
   *
   * Real mouse movement is ignored unless the pointer is locked, and pointer
   * lock cannot be granted to a headless page — there is no gesture to grant it
   * from. Injecting at the same accumulator the mousemove handler writes to
   * exercises every line downstream of it, which is all the code that is ours.
   */
  injectLook(dx: number, dy: number): void {
    this.mouseDx += dx;
    this.mouseDy += dy;
  }

  /** Mouse movement during this tick, in pixels. */
  get lookDelta(): { x: number; y: number } {
    return { x: this.tickMouseDx, y: this.tickMouseDy };
  }

  /** Wheel notches during this tick. Positive is scroll-down. */
  get wheel(): number {
    return this.tickWheelDelta;
  }

  /**
   * Movement intent in local space, normalized so diagonals are not faster.
   * +x is right, +z is forward.
   *
   * Keyboard and stick are summed, then clamped. Summing rather than picking a
   * winner means a player can hold W and steer with the stick without either
   * device cutting the other out, and with only one device in use the sum is
   * just that device.
   */
  get moveAxis(): { x: number; z: number } {
    let x = this.analogMoveX;
    let z = this.analogMoveZ;
    if (this.isDown('moveForward')) z += 1;
    if (this.isDown('moveBack')) z -= 1;
    if (this.isDown('moveRight')) x += 1;
    if (this.isDown('moveLeft')) x -= 1;
    const len = Math.hypot(x, z);
    if (len > 1) {
      x /= len;
      z /= len;
    }
    return { x, z };
  }

  /** Which hotbar slot was pressed this tick, or -1. Zero-indexed. */
  get hotbarPressed(): number {
    for (let i = 0; i < 8; i++) {
      if (this.wasPressed(`hotbar${i + 1}` as Action)) return i;
    }
    return -1;
  }

  /** Suspend gameplay input (menus, pause) without tearing down listeners. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.releaseAll();
  }

  /** Every code currently bound to an action. */
  codesFor(action: Action): string[] {
    return Object.keys(this.bindings).filter((code) => this.bindings[code] === action);
  }

  /**
   * Bind a key to an action, replacing whatever that action was on.
   *
   * A code already used by a *different* action is released first: two actions
   * on one key means pressing it does both, which is never what someone
   * rebinding intended and is invisible until they hit the key.
   */
  setBinding(action: Action, code: string): void {
    for (const existing of this.codesFor(action)) delete this.bindings[existing];
    delete this.bindings[code];
    this.bindings[code] = action;
    // Whatever was held under the old binding must not stay stuck down.
    this.releaseAll();
  }

  /** The full map, for persistence. */
  getBindings(): Record<string, Action> {
    return { ...this.bindings };
  }

  setBindings(bindings: Record<string, Action>): void {
    this.bindings = { ...bindings };
    this.releaseAll();
  }

  resetBindings(): void {
    this.setBindings(DEFAULT_BINDINGS);
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers.length = 0;
  }
}
