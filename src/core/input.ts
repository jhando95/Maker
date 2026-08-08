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
 *
 * ## Two keys per action, and why that is the shape rather than a convenience
 *
 * An action owns an ordered pair of slots, and both are equal at the point a
 * key is read — `isDown('jump')` cannot tell you which of Space or the pad's A
 * button produced it, and should not be able to.
 *
 * It has to be *slots* rather than a set, because a player rebinding one of a
 * pair is choosing which one. The defaults already ship pairs — W and the up
 * arrow, either Shift — and the old model collapsed them the moment anybody
 * touched the screen: rebinding "move forward" deleted every code the action
 * had and wrote one. Somebody who moved forward onto a different letter lost
 * the arrow key as well, silently, and the only clue was that the arrows
 * stopped working. So the pair is the unit, and rebinding writes into a slot.
 *
 * The lookup that a keydown actually consults is derived from the slots rather
 * than kept beside them. Two structures that must agree is a bug waiting for a
 * rebind; one that is rebuilt from the other cannot drift.
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
   * The spray can, which is a ninth thing to hold rather than a ninth key.
   *
   * Slot 9, beside the eight parts, and while it is out the place button
   * sprays and the part-cycling keys cycle the tag. Every key a left hand can
   * reach was already bound — and inventing two more for a toy would have put
   * the least important feature in the game on the least reachable keys.
   */
  'toolSpray',

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

  // The spray can. Held, not tapped — a stroke should be a line rather than a
  // row of taps. G is already the repeat-place key and Backquote is the debug
  // toggle, so this takes two that nothing else wants: X for the can and Z for
  // cycling what it puts down, both under the left hand while it is on WASD.
  Digit9: 'toolSpray',

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

/**
 * How many keys one action can carry.
 *
 * Two, and the number is here rather than spelled `[a, b]` everywhere so that
 * a third is a one-line change and not an archaeology exercise. Everything
 * below indexes slots rather than assuming a pair.
 */
export const BINDING_SLOTS = 2;

/** One action as the controls screen shows it. */
export interface BindableAction {
  action: Action;
  label: string;
}

/**
 * Every action a player can rebind, grouped the way the screen lists them.
 *
 * Grouped rather than one flat list because the list is now thirty-five rows
 * long: a wall of that many labelled buttons is a thing nobody finds anything
 * in. The groups are the same five the settings screen already uses.
 *
 * The rule this file holds itself to is that **everything is here except the
 * two debug keys**, and a test asserts it. The previous list covered twenty of
 * forty-one actions, and the twenty-one it left out were not chosen — they were
 * whatever had been added since the screen was written. Push-to-talk was among
 * them, which is the worst possible one to leave fixed: the comment beside its
 * default spends a paragraph explaining that no good key was available, and a
 * player on a keyboard where C is somewhere else had no way to move it.
 */
export const BINDING_GROUPS: ReadonlyArray<{
  title: string;
  actions: ReadonlyArray<BindableAction>;
}> = [
  {
    title: 'Moving',
    actions: [
      { action: 'moveForward', label: 'Move forward' },
      { action: 'moveBack', label: 'Move back' },
      { action: 'moveLeft', label: 'Move left' },
      { action: 'moveRight', label: 'Move right' },
      { action: 'jump', label: 'Jump / mantle' },
      { action: 'sprint', label: 'Sprint' },
      { action: 'crouch', label: 'Crouch' },
    ],
  },
  {
    title: 'Building',
    actions: [
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
      { action: 'interact', label: 'Undo' },
    ],
  },

  {
    title: 'Choosing a part',
    actions: [
      { action: 'partWheel', label: 'Part wheel' },
      { action: 'nextPart', label: 'Next part' },
      { action: 'prevPart', label: 'Previous part' },
      { action: 'hotbar1', label: 'Slot 1' },
      { action: 'hotbar2', label: 'Slot 2' },
      { action: 'hotbar3', label: 'Slot 3' },
      { action: 'hotbar4', label: 'Slot 4' },
      { action: 'hotbar5', label: 'Slot 5' },
      { action: 'hotbar6', label: 'Slot 6' },
      { action: 'hotbar7', label: 'Slot 7' },
      { action: 'hotbar8', label: 'Slot 8' },
      { action: 'toolSpray', label: 'Spray can' },
    ],
  },
  {
    title: 'Blueprints',
    actions: [
      { action: 'cycleBlueprint', label: 'Next blueprint' },
      { action: 'saveBlueprint', label: 'Save what you built' },
    ],
  },
  {
    title: 'Talking',
    actions: [
      { action: 'pushToTalk', label: 'Push to talk' },
      { action: 'ping', label: 'Ping' },
      { action: 'chatNear', label: 'Chat' },
      { action: 'chatTeam', label: 'Team chat' },
      { action: 'emoteWheel', label: 'Emotes' },
    ],
  },
  {
    title: 'View',
    actions: [{ action: 'toggleCamera', label: 'Camera' }],
  },
];

/**
 * The same list, flattened.
 *
 * Derived rather than written twice, because two lists that must contain the
 * same actions is exactly the arrangement where one of them quietly stops.
 */
export const BINDABLE: ReadonlyArray<BindableAction> =
  BINDING_GROUPS.flatMap((group) => group.actions);

/**
 * What to call an action out loud.
 *
 * Falls back to the action's own name, which is only reachable for the debug
 * keys — and is better than an empty string if one ever ends up in a message.
 */
export function labelFor(action: Action): string {
  return BINDABLE.find((entry) => entry.action === action)?.label ?? action;
}

/**
 * Actions deliberately kept off the controls screen.
 *
 * Both are developer keys rather than controls. Listing them would teach every
 * player that the game has a debug overlay, and a rebindable free camera is a
 * feature nobody asked for.
 */
export const UNBINDABLE: ReadonlyArray<Action> = ['debugToggle', 'debugFreeCam'];

/**
 * Human-readable name for a key code or mouse button.
 *
 * The long tail matters more than it used to. Before, a player could only land
 * on the twenty keys the screen offered; now they can bind anything, and a
 * button reading `BracketLeft` is a button reading the wrong thing.
 */
export function describeKey(code: string): string {
  if (code.startsWith('Mouse')) {
    const n = Number(code.slice(5));
    return n === 0 ? 'Left Mouse' : n === 1 ? 'Middle Mouse' : n === 2 ? 'Right Mouse' : `Mouse ${n}`;
  }
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  if (code.startsWith('Arrow')) return `${code.slice(5)} Arrow`;
  const named: Record<string, string> = {
    Space: 'Space', ShiftLeft: 'L Shift', ShiftRight: 'R Shift',
    ControlLeft: 'L Ctrl', ControlRight: 'R Ctrl',
    AltLeft: 'L Alt', AltRight: 'R Alt',
    MetaLeft: 'L Cmd', MetaRight: 'R Cmd',
    Tab: 'Tab', Backquote: '`', Enter: 'Enter', CapsLock: 'Caps',
    Backspace: 'Backspace', Delete: 'Del', Insert: 'Ins',
    Home: 'Home', End: 'End', PageUp: 'Page Up', PageDown: 'Page Down',
    Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
    Backslash: '\\', Semicolon: ';', Quote: "'",
    Comma: ',', Period: '.', Slash: '/',
  };
  return named[code] ?? code;
}

/** An empty pair, for an action nothing is bound to. */
function emptySlots(): (string | null)[] {
  return new Array<string | null>(BINDING_SLOTS).fill(null);
}

/**
 * Turn a flat code-to-action map into per-action slots.
 *
 * Exported because both the store's migration and `Input` itself need it, and
 * because the rule it encodes is worth stating once: **the order codes appear
 * in the map is the order they take slots.** `DEFAULT_BINDINGS` lists `KeyW`
 * before `ArrowUp`, so W is the primary and the arrow is the alternate, and a
 * test pins that rather than leaving it to whoever edits the literal next.
 *
 * Codes past the last slot are dropped, which is why the same test also
 * asserts no action in the defaults has more than `BINDING_SLOTS` of them —
 * otherwise adding a third would silently lose one.
 */
export function slotsFromMap(map: Record<string, Action | string>): Record<string, (string | null)[]> {
  const out: Record<string, (string | null)[]> = {};
  for (const [code, action] of Object.entries(map)) {
    const slots = (out[action] ??= emptySlots());
    const free = slots.indexOf(null);
    if (free !== -1) slots[free] = code;
  }
  return out;
}

export class Input {
  /**
   * The source of truth: an ordered pair of codes per action, either of which
   * may be null. Nothing reads this on a keypress — see `lookup`.
   */
  private readonly slots = new Map<Action, (string | null)[]>();
  /**
   * Code to action, rebuilt from `slots` whenever they change.
   *
   * A keydown happens far more often than a rebind, so the fast direction gets
   * the plain object. Derived rather than maintained, because a lookup that can
   * disagree with the slots is a key that does nothing and a screen that says
   * it should.
   */
  private lookup: Record<string, Action> = {};
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
    for (const action of ACTIONS) {
      this.state.set(action, { down: false, pressed: false, released: false });
      this.slots.set(action, emptySlots());
    }
    this.setBindings(bindings);
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
      if (this.lookup[e.code]) e.preventDefault();
      if (e.repeat) return; // auto-repeat is not a new press
      this.useDevice('keyboard');
      this.queueDown(this.lookup[e.code]);
    });

    this.on(window, 'keyup', (e) => {
      if (this.lookup[e.code]) e.preventDefault();
      this.queueUp(this.lookup[e.code]);
    });

    this.on(this.element, 'mousedown', (e) => {
      // Clicking the canvas is how you enter the game; only treat clicks as
      // gameplay input once the pointer is actually locked.
      if (!this.pointerLocked) {
        void this.requestPointerLock();
        return;
      }
      this.useDevice('keyboard');
      this.queueDown(this.lookup[`Mouse${e.button}`]);
    });

    this.on(window, 'mouseup', (e) => {
      this.queueUp(this.lookup[`Mouse${e.button}`]);
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

  /**
   * Rebuild the code-to-action lookup, and let go of anything held.
   *
   * The release is not housekeeping. A key whose meaning changed while it was
   * down never sends a keyup for the action it *used* to be, so without this a
   * player who rebinds forward while leaning on W walks off across the lawn
   * with no way to stop.
   */
  private reindex(): void {
    const lookup: Record<string, Action> = {};
    for (const action of ACTIONS) {
      for (const code of this.slots.get(action)!) {
        if (code !== null) lookup[code] = action;
      }
    }
    this.lookup = lookup;
    this.releaseAll();
  }

  /** Both slots for an action, in order, `null` where nothing is bound. */
  slotsFor(action: Action): (string | null)[] {
    return [...this.slots.get(action)!];
  }

  /** Every code currently bound to an action, in slot order. */
  codesFor(action: Action): string[] {
    return this.slots.get(action)!.filter((code): code is string => code !== null);
  }

  /**
   * Put a key in one of an action's slots.
   *
   * Returns the action the key was taken from, or null if it was free. That
   * return is the whole reason this is not void: a code can only mean one
   * thing, so binding a key somebody else already had *has* to take it, and a
   * silent theft is a control that stops working with no explanation. The
   * screen says which one lost it.
   *
   * Moving a key onto the same action's other slot swaps them rather than
   * duplicating: a pair holding the same code twice is an action with one key
   * that looks like it has two.
   */
  setBinding(action: Action, code: string, slot = 0): Action | null {
    if (slot < 0 || slot >= BINDING_SLOTS) return null;
    const mine = this.slots.get(action)!;

    const already = mine.indexOf(code);
    if (already !== -1) {
      if (already === slot) return null;
      mine[already] = mine[slot] ?? null;
      mine[slot] = code;
      this.reindex();
      return null;
    }

    let took: Action | null = null;
    const owner = this.lookup[code];
    if (owner !== undefined && owner !== action) {
      const theirs = this.slots.get(owner)!;
      theirs[theirs.indexOf(code)] = null;
      took = owner;
    }
    mine[slot] = code;
    this.reindex();
    return took;
  }

  /**
   * Empty one slot.
   *
   * Worth having as its own verb: without it the only way out of a binding is
   * to put something else there, and a player who wants "no alternate" has to
   * park a key they will never press on it.
   */
  clearBinding(action: Action, slot: number): void {
    if (slot < 0 || slot >= BINDING_SLOTS) return;
    this.slots.get(action)![slot] = null;
    this.reindex();
  }

  /** Every action's slots, for persistence. */
  getBindingSlots(): Record<string, (string | null)[]> {
    const out: Record<string, (string | null)[]> = {};
    for (const action of ACTIONS) out[action] = this.slotsFor(action);
    return out;
  }

  /**
   * Restore slots, keeping only what still makes sense.
   *
   * Everything here is defensive because the input is a blob out of a player's
   * localStorage that may have been written by an older build: an action that
   * no longer exists is dropped, a code claimed twice goes to whoever the
   * iteration reaches first, and anything missing simply stays unbound rather
   * than reverting to the default. Silently reverting would be worse — a
   * player would rebind, and the next time the shape of this file changed some
   * of their keys would quietly come back.
   */
  setBindingSlots(slots: Record<string, (string | null)[] | undefined>): void {
    const claimed = new Set<string>();
    for (const action of ACTIONS) {
      const want = slots[action];
      const mine = this.slots.get(action)!;
      for (let i = 0; i < BINDING_SLOTS; i++) {
        const code = Array.isArray(want) ? want[i] : null;
        mine[i] = typeof code === 'string' && code.length > 0 && !claimed.has(code) ? code : null;
        if (mine[i] !== null) claimed.add(mine[i]!);
      }
    }
    this.reindex();
  }

  /** The flat code-to-action map. Read-only; `setBindingSlots` is the way in. */
  getBindings(): Record<string, Action> {
    return { ...this.lookup };
  }

  /** Take a flat map, in the shape `DEFAULT_BINDINGS` is written in. */
  setBindings(bindings: Record<string, Action>): void {
    this.setBindingSlots(slotsFromMap(bindings));
  }

  resetBindings(): void {
    this.setBindings(DEFAULT_BINDINGS);
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers.length = 0;
  }
}
