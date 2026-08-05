/**
 * Fixed-timestep game loop.
 *
 * Simulation advances in fixed increments so that movement and collision are
 * frame-rate independent and reproducible — the same inputs produce the same
 * result on a 60Hz laptop and a 144Hz desktop. That reproducibility is what
 * makes server-authoritative multiplayer and client prediction possible later,
 * so it is worth having from the first commit rather than retrofitting.
 *
 * Rendering runs once per animation frame at whatever rate the display allows,
 * and interpolates between the previous and current simulation states using the
 * leftover accumulator time. Without that interpolation, a 144Hz display showing
 * a 60Hz simulation judders visibly.
 */

export interface LoopCallbacks {
  /** Advance the simulation by exactly `dt` seconds. Called 0..N times per frame. */
  fixedUpdate(dt: number, tick: number): void;
  /**
   * Draw a frame. `alpha` is how far we are between the last two simulation
   * states, in [0,1] — use it to interpolate rendered transforms.
   */
  render(alpha: number, frameDt: number): void;
}

export interface LoopOptions {
  /** Simulation rate in Hz. */
  tickRate?: number;
  /**
   * Ceiling on how much time a single frame may contribute. Prevents the
   * "spiral of death" where a long stall (tab backgrounded, GC pause, the
   * debugger) queues hundreds of catch-up ticks, which takes even longer,
   * which queues more ticks. We drop the excess time instead.
   */
  maxFrameTime?: number;
}

export class GameLoop {
  readonly tickRate: number;
  readonly fixedDt: number;

  private readonly maxFrameTime: number;
  private readonly callbacks: LoopCallbacks;

  private accumulator = 0;
  private lastTime = 0;
  private rafId: number | null = null;
  private running = false;

  /** Number of simulation steps taken since start. */
  tick = 0;

  /**
   * When paused, frames keep rendering but no simulation runs.
   *
   * Rendering must continue so a menu drawn over the world is not sitting on a
   * frozen, stale frame — and so the camera can keep drifting behind it.
   */
  private paused = false;

  /** Rolling render-frame timing, for the debug overlay. */
  private frameTimes: number[] = [];

  constructor(callbacks: LoopCallbacks, options: LoopOptions = {}) {
    this.callbacks = callbacks;
    this.tickRate = options.tickRate ?? 60;
    this.fixedDt = 1 / this.tickRate;
    this.maxFrameTime = options.maxFrameTime ?? 0.25;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now() / 1000;
    this.accumulator = 0;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private schedule(): void {
    this.rafId = requestAnimationFrame(() => this.frame());
  }

  private frame(): void {
    if (!this.running) return;

    const now = performance.now() / 1000;
    let frameTime = now - this.lastTime;
    this.lastTime = now;

    if (frameTime > this.maxFrameTime) frameTime = this.maxFrameTime;

    this.frameTimes.push(frameTime);
    if (this.frameTimes.length > 120) this.frameTimes.shift();

    if (!this.paused) {
      this.accumulator += frameTime;

      while (this.accumulator >= this.fixedDt) {
        this.callbacks.fixedUpdate(this.fixedDt, this.tick);
        this.tick++;
        this.accumulator -= this.fixedDt;
      }
    }

    // Leftover time as a fraction of a tick: how far the render sits between
    // the previous simulation state and the current one.
    const alpha = this.accumulator / this.fixedDt;
    this.callbacks.render(alpha, frameTime);

    this.schedule();
  }

  /** Average frames per second over the recent window. */
  get fps(): number {
    if (this.frameTimes.length === 0) return 0;
    const sum = this.frameTimes.reduce((a, b) => a + b, 0);
    return this.frameTimes.length / sum;
  }

  /**
   * Pause or resume simulation.
   *
   * Resuming drops the accumulator rather than carrying it. Time spent in a
   * menu is not time the world owes: carrying it would fire a burst of catch-up
   * ticks the instant play resumes, teleporting the player and any bots. The
   * clock is also re-based, or the first frame back would report the entire
   * paused duration as one enormous frame.
   */
  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    if (!paused) {
      this.accumulator = 0;
      this.lastTime = performance.now() / 1000;
    }
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /**
   * Whether frames are still being scheduled.
   *
   * Distinct from paused: a paused loop keeps drawing, a stopped one does not
   * come back without start(). The crash handler stops it, and the headless
   * harness checks this to confirm it stayed stopped.
   */
  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Run a fixed number of simulation steps without rendering. Used by tests and
   * by the debug API to advance the world deterministically.
   */
  stepManual(steps: number): void {
    for (let i = 0; i < steps; i++) {
      this.callbacks.fixedUpdate(this.fixedDt, this.tick);
      this.tick++;
    }
  }
}
