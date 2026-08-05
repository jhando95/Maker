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
  'toggleBuildMode',
  'interact',

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
  ControlLeft: 'crouch',
  KeyC: 'crouch',

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
  Tab: 'toggleBuildMode',
  KeyF: 'interact',

  Backquote: 'debugToggle',
  KeyP: 'debugFreeCam',
};

interface ActionState {
  /** Held right now. */
  down: boolean;
  /** Went down during the tick that just began. */
  pressed: boolean;
  /** Came up during the tick that just began. */
  released: boolean;
}

export class Input {
  private readonly bindings: Record<string, Action>;
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

  private pointerLocked = false;
  private enabled = true;

  private readonly element: HTMLElement;
  private readonly disposers: Array<() => void> = [];

  /** Fires when pointer lock is gained or lost, so the UI can show/hide a prompt. */
  onPointerLockChange: ((locked: boolean) => void) | null = null;

  constructor(element: HTMLElement, bindings: Record<string, Action> = DEFAULT_BINDINGS) {
    this.element = element;
    this.bindings = bindings;
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
      this.queueDown(this.bindings[`Mouse${e.button}`]);
    });

    this.on(window, 'mouseup', (e) => {
      this.queueUp(this.bindings[`Mouse${e.button}`]);
    });

    this.on(this.element, 'contextmenu', (e) => e.preventDefault());

    this.on(window, 'mousemove', (e) => {
      if (!this.pointerLocked) return;
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
   */
  get moveAxis(): { x: number; z: number } {
    let x = 0;
    let z = 0;
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

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers.length = 0;
  }
}
