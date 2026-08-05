/**
 * Polls connected pads and feeds the input layer.
 *
 * Separate from gamepad.ts on purpose: everything that decides *what a stick
 * means* lives there and is a pure function, so it can be tested against
 * synthetic pads. What lives here is the one thing that cannot be pure — the
 * held-state-to-edges conversion, which needs memory of the last poll.
 *
 * The Gamepad API has no events for buttons, so pads must be polled. Polling
 * happens once per render frame rather than once per simulation tick, which is
 * exactly how the keyboard already behaves: devices write into a pending buffer
 * whenever they like, and the tick boundary folds it. It also means the pad
 * keeps working while the game is paused, which is what makes Start able to
 * unpause it.
 *
 * There are no gamepadconnected listeners. Every poll already reports which
 * pads exist, so a pad unplugged mid-sprint stops sprinting on the next frame
 * without anything having to be notified — one code path instead of two that
 * could disagree.
 */

import type { Action } from './input.ts';
import {
  mergePads, readPads, IDLE_INTENT,
  type PadIntent, type PadOptions, type PadSnapshot,
  DEFAULT_PAD_OPTIONS,
} from './gamepad.ts';

/**
 * The part of Input a pad touches.
 *
 * Narrow on purpose: it lets the manager be tested against a recording sink,
 * without a DOM, and makes the coupling visible — a pad can press actions and
 * set axes, and nothing else.
 */
export interface ActionSink {
  pressAction(action: Action): void;
  releaseAction(action: Action): void;
  setPadAxes(moveX: number, moveZ: number, lookYawRate: number, lookPitchRate: number): void;
}

export class GamepadManager {
  private readonly sink: ActionSink;
  private options: PadOptions = { ...DEFAULT_PAD_OPTIONS };
  private previous: PadIntent = IDLE_INTENT;
  private startWasDown = false;
  private connected = 0;

  enabled = true;

  /** Fires on the frame Start goes down, so the caller can open or close the menu. */
  onStart: (() => void) | null = null;

  constructor(sink: ActionSink) {
    this.sink = sink;
  }

  setOptions(options: Partial<PadOptions>): void {
    this.options = { ...this.options, ...options };
  }

  get padCount(): number {
    return this.connected;
  }

  /**
   * Read every pad and apply the result. Call once per render frame.
   *
   * `snapshots` is injectable so the whole path — including the edge detection,
   * which is the part with state and therefore the part that can be wrong — can
   * be driven from a test, or from a headless browser that has no pads.
   */
  poll(snapshots: readonly PadSnapshot[] = readPads()): PadIntent {
    this.connected = snapshots.length;

    if (!this.enabled || snapshots.length === 0) {
      // Turning the pad off, or unplugging it, must not leave anything held —
      // and "anything" includes the sticks. Checking only for held buttons
      // meant a pad pulled out mid-push left its last axes applied and walked
      // the player away on their own. IDLE_INTENT is compared by identity
      // because releaseAll is the only thing that assigns it.
      if (this.previous !== IDLE_INTENT) this.releaseAll();
      return IDLE_INTENT;
    }

    const intent = mergePads(snapshots, this.options, this.previous);

    // Only edges are pushed. Input tracks held state itself, and re-pressing a
    // held action every frame would make wasPressed() true on every tick the
    // button was down — one trigger pull would place a part sixty times a
    // second.
    for (const action of intent.down) {
      if (!this.previous.down.has(action)) this.sink.pressAction(action);
    }
    for (const action of this.previous.down) {
      if (!intent.down.has(action)) this.sink.releaseAction(action);
    }

    this.sink.setPadAxes(intent.moveX, intent.moveZ, intent.lookYawRate, intent.lookPitchRate);

    if (intent.start && !this.startWasDown) this.onStart?.();
    this.startWasDown = intent.start;

    this.previous = intent;
    return intent;
  }

  /** Drop everything the pad was holding. */
  releaseAll(): void {
    for (const action of this.previous.down) this.sink.releaseAction(action);
    this.sink.setPadAxes(0, 0, 0, 0);
    this.previous = IDLE_INTENT;
    this.startWasDown = false;
  }
}
