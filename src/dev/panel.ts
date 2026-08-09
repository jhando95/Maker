/**
 * The tuning panel. Only ever in a build made with `MAKER_DEV_TOOLS=1`.
 *
 * A slider per registered knob, grouped by the prefix on its key, with the
 * value live: moving one changes the game underneath it rather than on the next
 * reload. That is the point — the questions this answers are "does three metres
 * feel better than four", and a question you have to reload to re-ask gets asked
 * once and answered from a guess.
 *
 * Two things it deliberately does not do.
 *
 * **It does not save.** A tweak that lives in a browser's storage is a game that
 * behaves differently on the machine it was tuned on. `Copy` puts the changed
 * values on the clipboard as lines with their source files attached, and tuning
 * ends in a commit or it did not happen.
 *
 * **It does not hide behind a password.** There is nothing to hide behind one:
 * this file is not in the public build, which is a fact about the output rather
 * than a promise made by the program. `MAKER_DEV_PANEL` below is the string
 * `npm run check:public` greps the bundle for.
 */

import type { Tuning } from '../app/tuning.ts';

/** The marker `check:public` looks for. Do not shorten it or make it clever. */
export const MAKER_DEV_PANEL = 'MAKER_DEV_PANEL_PRESENT';

const STYLE = `
.mk-dev {
  position: absolute; left: 14px; top: 14px; z-index: 40;
  width: 300px; max-height: 78vh; overflow-y: auto;
  padding: 10px 12px 12px;
  font: 12px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace;
  color: #f4ece4; background: rgba(20, 16, 15, 0.93);
  border: 1px solid rgba(255,255,255,0.16); border-radius: 10px;
  backdrop-filter: blur(6px);
}
.mk-dev.mk-hidden { display: none; }
.mk-dev h2 { margin: 0 0 8px; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; opacity: 0.65; }
.mk-dev .mk-dev-group { margin: 10px 0 4px; font-weight: 700; color: #ffd76a; }
.mk-dev label { display: block; margin: 7px 0; }
.mk-dev .mk-dev-top { display: flex; justify-content: space-between; gap: 8px; }
.mk-dev .mk-dev-val { opacity: 0.8; }
.mk-dev .mk-dev-changed .mk-dev-val { color: #8fe388; font-weight: 700; }
.mk-dev input[type=range] { width: 100%; margin: 2px 0 0; }
.mk-dev .mk-dev-help { opacity: 0.45; font-size: 11px; }
.mk-dev .mk-dev-buttons { display: flex; gap: 6px; margin-top: 12px; }
.mk-dev button {
  flex: 1; padding: 6px 8px; font: inherit; cursor: pointer;
  color: #f4ece4; background: rgba(255,255,255,0.08);
  border: 1px solid rgba(255,255,255,0.18); border-radius: 6px;
}
.mk-dev button:hover { background: rgba(255,255,255,0.16); }
.mk-dev .mk-dev-out {
  margin-top: 8px; padding: 6px; max-height: 22vh; overflow: auto;
  white-space: pre-wrap; word-break: break-word;
  background: rgba(0,0,0,0.35); border-radius: 6px; font-size: 11px;
}
`;

export class DevPanel {
  readonly root: HTMLDivElement;
  private readonly out: HTMLPreElement;

  constructor(parent: HTMLElement, private readonly tuning: Tuning) {
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);

    this.root = document.createElement('div');
    this.root.className = 'mk-dev mk-hidden';
    this.root.dataset.marker = MAKER_DEV_PANEL;

    const title = document.createElement('h2');
    title.textContent = 'Tuning — F8';
    this.root.appendChild(title);

    let group = '';
    for (const knob of tuning.all()) {
      const prefix = knob.key.split('.')[0] ?? '';
      if (prefix !== group) {
        group = prefix;
        const heading = document.createElement('div');
        heading.className = 'mk-dev-group';
        heading.textContent = group;
        this.root.appendChild(heading);
      }
      this.root.appendChild(this.rowFor(knob.key));
    }

    const buttons = document.createElement('div');
    buttons.className = 'mk-dev-buttons';
    buttons.appendChild(this.button('Copy changes', () => {
      const source = tuning.asSource();
      this.out.textContent = source;
      void navigator.clipboard?.writeText(source);
    }));
    buttons.appendChild(this.button('Reset all', () => {
      tuning.reset();
      this.refresh();
      this.out.textContent = '';
    }));
    this.root.appendChild(buttons);

    this.out = document.createElement('pre');
    this.out.className = 'mk-dev-out';
    this.root.appendChild(this.out);

    parent.appendChild(this.root);

    // On window, and on `keydown` with the game's own handlers untouched: this
    // is a tool, and a tool that steals a key the game uses is a tool that
    // changes the thing it is measuring.
    window.addEventListener('keydown', (e) => {
      if (e.key === 'F8') { e.preventDefault(); this.toggle(); }
    });
  }

  private button(label: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  private rowFor(key: string): HTMLLabelElement {
    const knob = this.tuning.all().find((k) => k.key === key)!;
    const row = document.createElement('label');
    row.dataset.knob = key;

    const top = document.createElement('div');
    top.className = 'mk-dev-top';
    const name = document.createElement('span');
    name.textContent = knob.label;
    const value = document.createElement('span');
    value.className = 'mk-dev-val';
    top.append(name, value);
    row.appendChild(top);

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = String(knob.min);
    slider.max = String(knob.max);
    slider.step = String(knob.step);
    slider.value = String(knob.value);
    slider.addEventListener('input', () => {
      this.tuning.set(key, Number(slider.value));
      this.refresh();
    });
    row.appendChild(slider);

    if (knob.help !== undefined) {
      const help = document.createElement('div');
      help.className = 'mk-dev-help';
      help.textContent = knob.help;
      row.appendChild(help);
    }
    return row;
  }

  /** Redraw the numbers. Called on every change, including ones from elsewhere. */
  refresh(): void {
    for (const knob of this.tuning.all()) {
      const row = this.root.querySelector<HTMLElement>(`[data-knob="${CSS.escape(knob.key)}"]`);
      if (row === null) continue;
      const slider = row.querySelector('input');
      if (slider !== null) slider.value = String(knob.value);
      const value = row.querySelector('.mk-dev-val');
      if (value !== null) value.textContent = String(knob.value);
      row.classList.toggle('mk-dev-changed', knob.value !== knob.initial);
    }
  }

  toggle(): void {
    this.root.classList.toggle('mk-hidden');
    if (!this.root.classList.contains('mk-hidden')) this.refresh();
  }

  get open(): boolean {
    return !this.root.classList.contains('mk-hidden');
  }
}
