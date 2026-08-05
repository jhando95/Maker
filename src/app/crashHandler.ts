/**
 * What the player sees when something throws.
 *
 * The default is a black canvas and a message only in the devtools console —
 * indistinguishable, to a player, from the game simply not working. Since the
 * render loop is a requestAnimationFrame callback, a throw inside it is not
 * caught by anything: the frame dies, no further frames are scheduled, and the
 * last good image sits frozen on screen forever.
 *
 * So the loop is wrapped, the first failure is shown plainly, and the player is
 * given the one thing that makes a bug report useful: the actual error, ready to
 * copy.
 */

export interface CrashInfo {
  message: string;
  stack: string;
  /** What the game was doing — 'render', 'simulation', or a subsystem name. */
  phase: string;
  when: string;
  userAgent: string;
  /** Extra state the game chooses to attach, e.g. part count and mode. */
  context: Record<string, unknown>;
}

const STYLE = `
.mk-crash {
  position: fixed; inset: 0; z-index: 100;
  display: flex; align-items: center; justify-content: center;
  background: rgba(20, 16, 14, 0.94);
  font-family: ui-rounded, "Nunito", "Segoe UI", system-ui, sans-serif;
  color: #fff; padding: 24px; box-sizing: border-box;
}
.mk-crash-card {
  background: rgba(40, 32, 28, 0.96);
  border: 3px solid #d8564f; border-radius: 16px;
  padding: 24px 28px; max-width: 640px; width: 100%;
  max-height: 84vh; overflow-y: auto;
}
.mk-crash h2 { margin: 0 0 6px; font-size: 24px; color: #ff9f6a; }
.mk-crash p { margin: 0 0 16px; font-size: 14px; opacity: 0.85; line-height: 1.5; }
.mk-crash pre {
  background: rgba(0,0,0,0.45); border-radius: 9px; padding: 12px;
  font-family: ui-monospace, monospace; font-size: 11.5px; line-height: 1.45;
  overflow-x: auto; white-space: pre-wrap; word-break: break-word;
  max-height: 240px; margin: 0 0 16px;
}
.mk-crash button {
  font: inherit; font-size: 15px; font-weight: 800;
  padding: 11px 18px; margin-right: 8px;
  border: none; border-radius: 10px; cursor: pointer;
  color: #3a2c2a; background: #f4a259; border-bottom: 4px solid #c47a35;
}
.mk-crash button.mk-crash-secondary {
  background: rgba(255,255,255,0.14); color: #fff; border-bottom-color: rgba(0,0,0,0.3);
}
`;

export class CrashHandler {
  private shown = false;
  private readonly getContext: () => Record<string, unknown>;

  /** Called on the first crash, so the loop can be stopped and audio silenced. */
  onCrash: ((info: CrashInfo) => void) | null = null;

  constructor(getContext: () => Record<string, unknown> = () => ({})) {
    this.getContext = getContext;

    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);

    // Errors outside the loop — an event handler, a failed import — reach here.
    window.addEventListener('error', (e) => {
      this.report(e.error instanceof Error ? e.error : new Error(String(e.message)), 'window');
    });
    window.addEventListener('unhandledrejection', (e) => {
      const reason: unknown = e.reason;
      this.report(reason instanceof Error ? reason : new Error(String(reason)), 'promise');
    });
  }

  /**
   * Run `fn`, showing the crash screen if it throws.
   *
   * Returns false once a crash has been reported, so the caller can stop
   * scheduling further work rather than throwing sixty times a second.
   */
  guard(phase: string, fn: () => void): boolean {
    if (this.shown) return false;
    try {
      fn();
      return true;
    } catch (err) {
      this.report(err instanceof Error ? err : new Error(String(err)), phase);
      return false;
    }
  }

  report(error: Error, phase: string): void {
    // Only the first is shown. A crash in the loop usually repeats, and a wall
    // of identical dialogs buries the one that mattered.
    if (this.shown) return;
    this.shown = true;

    const info: CrashInfo = {
      message: error.message,
      stack: error.stack ?? '(no stack)',
      phase,
      when: new Date().toISOString(),
      userAgent: navigator.userAgent,
      context: safeContext(this.getContext),
    };

    console.error(`[maker] crash during ${phase}`, error);
    this.onCrash?.(info);
    this.render(info);
  }

  get hasCrashed(): boolean {
    return this.shown;
  }

  private render(info: CrashInfo): void {
    const root = document.createElement('div');
    root.className = 'mk-crash';

    const card = document.createElement('div');
    card.className = 'mk-crash-card';

    const h = document.createElement('h2');
    h.textContent = 'Something broke';
    card.appendChild(h);

    const p = document.createElement('p');
    p.textContent =
      'The game hit an error and stopped. Your saved builds and settings are ' +
      'untouched. Copying the details below into a bug report is the most ' +
      'useful thing you can do with this.';
    card.appendChild(p);

    const pre = document.createElement('pre');
    pre.textContent = formatReport(info);
    card.appendChild(pre);

    const reload = document.createElement('button');
    reload.textContent = 'Reload';
    reload.addEventListener('click', () => location.reload());
    card.appendChild(reload);

    const copy = document.createElement('button');
    copy.className = 'mk-crash-secondary';
    copy.textContent = 'Copy details';
    copy.addEventListener('click', () => {
      void navigator.clipboard?.writeText(formatReport(info)).then(
        () => { copy.textContent = 'Copied'; },
        () => { copy.textContent = 'Copy failed — select the text above'; },
      );
    });
    card.appendChild(copy);

    root.appendChild(card);
    document.body.appendChild(root);
  }
}

export function formatReport(info: CrashInfo): string {
  return [
    `Maker crash report`,
    `when:    ${info.when}`,
    `phase:   ${info.phase}`,
    `error:   ${info.message}`,
    `browser: ${info.userAgent}`,
    ``,
    `context: ${describe(info.context)}`,
    ``,
    info.stack,
  ].join('\n');
}

/**
 * JSON.stringify throws on a cycle or a BigInt, and a crash report that throws
 * while being formatted loses the error it was written to preserve. Falling
 * back to per-key description keeps whatever is representable.
 */
function describe(context: Record<string, unknown>): string {
  try {
    return JSON.stringify(context, null, 2);
  } catch {
    const lines = Object.entries(context).map(([k, v]) => {
      try {
        return `  ${k}: ${JSON.stringify(v)}`;
      } catch {
        return `  ${k}: (unserializable)`;
      }
    });
    return `{\n${lines.join('\n')}\n}`;
  }
}

/**
 * Collect diagnostic context without letting it cause a second failure.
 *
 * The context getter reads live game state, which is exactly the state that has
 * just gone wrong — so it is entirely plausible for it to throw too, and losing
 * the original error to a crash inside the crash handler is the worst outcome
 * available.
 */
export function safeContext(getContext: () => Record<string, unknown>): Record<string, unknown> {
  try {
    return getContext();
  } catch (err) {
    return { contextError: err instanceof Error ? err.message : String(err) };
  }
}
