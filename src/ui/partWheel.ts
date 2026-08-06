/**
 * A radial part picker, opened by holding a key.
 *
 * The hotbar it replaces was eight boxes across the bottom of the screen,
 * permanently, for a choice a player makes maybe twice a minute. That is a lot
 * of the screen — the part of it you are looking through while aiming — spent
 * on something that is nearly always just telling you what you already picked.
 *
 * A wheel is the standard answer because it is the right one. Under pointer
 * lock there is no cursor to move, so the pick is made by *direction*: the
 * accumulated mouse movement gives an angle, the angle names a wedge, and
 * letting go commits it. Direction is far cheaper to aim than a position — you
 * flick, you do not travel — and the whole thing is gone the moment you release,
 * so it costs nothing at all while you are playing.
 *
 * The geometry lives here, separate from the DOM, because "which wedge is this
 * angle in" is the part that can be wrong in ways a screenshot will not show.
 */

/**
 * How far the mouse must move before the wheel commits to a direction.
 *
 * Opening the wheel and releasing without moving should keep what you had, not
 * pick whatever wedge happens to sit at zero degrees.
 */
export const DEAD_ZONE_PX = 26;

/**
 * Which wedge an offset points at, or null inside the dead zone.
 *
 * Wedge 0 is at the top and they run clockwise, matching how the DOM lays them
 * out and how people read a clock face. Screen +y is down, hence the negation.
 */
export function wedgeAt(dx: number, dy: number, count: number, deadZone = DEAD_ZONE_PX): number | null {
  if (count <= 0) return null;
  if (Math.hypot(dx, dy) < deadZone) return null;

  // atan2(x, -y) puts zero at the top and increases clockwise.
  let angle = Math.atan2(dx, -dy);
  if (angle < 0) angle += Math.PI * 2;

  const step = (Math.PI * 2) / count;
  // Offset by half a wedge so a wedge is centred on its own direction rather
  // than starting at it.
  return Math.floor((angle + step / 2) / step) % count;
}

/** Where the centre of wedge `i` sits, as a unit offset in screen space. */
export function wedgeDirection(i: number, count: number): { x: number; y: number } {
  const angle = (i / count) * Math.PI * 2;
  return { x: Math.sin(angle), y: -Math.cos(angle) };
}

export interface WheelEntry {
  label: string;
  detail: string;
  /** Swatch colour, as a CSS colour string. */
  color: string;
}

const STYLE = `
.mk-wheel {
  position: absolute; left: 50%; top: 50%;
  width: 0; height: 0;
  pointer-events: none;
  opacity: 0; transition: opacity 0.09s ease-out;
}
.mk-wheel.open { opacity: 1; }

/* A scrim behind the wheel.
   Measured from a screenshot: eight translucent chips over a sunlit backyard
   are individually legible and collectively unreadable, because the thing you
   are scanning for — which one is lit — is a contrast difference competing with
   grass, timber and sky. Darkening what is behind them costs nothing while the
   wheel is shut and makes the choice instant while it is open. */
.mk-wheel-scrim {
  position: fixed; inset: 0;
  background: radial-gradient(circle at 50% 50%,
    rgba(16, 12, 11, 0.62) 0px, rgba(16, 12, 11, 0.5) 210px, rgba(16, 12, 11, 0) 340px);
  opacity: 0; transition: opacity 0.09s ease-out;
}
.mk-wheel.open .mk-wheel-scrim { opacity: 1; }
.mk-wheel-hub {
  position: absolute; left: 50%; top: 50%;
  width: 96px; height: 96px; margin: -48px 0 0 -48px;
  border-radius: 50%;
  background: rgba(28, 22, 20, 0.72);
  border: 2px solid rgba(255,255,255,0.16);
  backdrop-filter: blur(5px);
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  text-align: center;
}
.mk-wheel-hub .pick { font-size: 13px; font-weight: 800; line-height: 1.15; padding: 0 6px; color: #ffd76a; }
.mk-wheel-hub .dims { font-size: 9.5px; opacity: 0.65; margin-top: 2px; }

.mk-wedge {
  position: absolute; left: 50%; top: 50%;
  width: 84px; margin: -27px 0 0 -42px;
  padding: 7px 4px; box-sizing: border-box;
  border-radius: 11px;
  background: rgba(28, 22, 20, 0.62);
  border: 2px solid rgba(255,255,255,0.14);
  backdrop-filter: blur(4px);
  text-align: center;
  /* Only the movement eases. Colour changes instantly on purpose: the lit chip
     is the thing you are scanning for, and a fade is a delay on exactly the
     signal you opened the wheel to read. (Transitioning them also measured as
     not applying at all under the repaint this does every frame.) */
  transition: transform 0.07s ease-out;
}
.mk-wedge .name { font-size: 10.5px; font-weight: 700; line-height: 1.1; }
.mk-wedge .dims { font-size: 8.5px; opacity: 0.62; }
/* Unselected chips step back so the lit one is the only thing with weight. */
.mk-wedge:not(.selected) { opacity: 0.72; }
.mk-wedge .swatch {
  display: inline-block; width: 9px; height: 9px; border-radius: 3px;
  border: 1.5px solid rgba(255,255,255,0.65); vertical-align: -1px; margin-right: 3px;
}
.mk-wedge.selected {
  background: #f4a259;
  border-color: #fff;
  color: #2a201d;
  box-shadow: 0 0 0 3px rgba(244, 162, 89, 0.35), 0 6px 16px rgba(0,0,0,0.45);
}
.mk-wedge.selected .dims { opacity: 0.85; }
.mk-wedge.selected .swatch { border-color: rgba(42,32,29,0.6); }

/* The chip that stands in for the whole hotbar while the wheel is shut. */
.mk-chip {
  position: absolute; left: 50%; bottom: 16px; transform: translateX(-50%);
  display: flex; align-items: center; gap: 7px;
  padding: 6px 12px; border-radius: 999px;
  background: rgba(28, 22, 20, 0.5); backdrop-filter: blur(4px);
  font-size: 12px; white-space: nowrap;
}
.mk-chip b { font-weight: 800; }
.mk-chip .dims { opacity: 0.6; font-size: 10.5px; }
.mk-chip .cost {
  color: var(--wood); font-weight: 800; font-size: 10.5px;
  padding: 1px 5px; border-radius: var(--r-sm);
  background: rgba(224, 176, 112, 0.16);
}
.mk-chip .hint { opacity: 0.5; font-size: 10.5px; margin-left: 3px; }
`;

/** The radius the wedges sit at, in pixels. */
const RADIUS = 132;

export class PartWheel {
  readonly root: HTMLDivElement;

  private readonly hub: HTMLDivElement;
  private readonly hubPick: HTMLDivElement;
  private readonly hubDims: HTMLDivElement;
  private readonly wedges: HTMLDivElement[] = [];

  private entries: readonly WheelEntry[] = [];
  private open = false;
  private dx = 0;
  private dy = 0;
  private highlighted: number | null = null;
  private current = 0;

  constructor(parent: HTMLElement) {
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);

    this.root = document.createElement('div');
    this.root.className = 'mk-wheel';

    const scrim = document.createElement('div');
    scrim.className = 'mk-wheel-scrim';
    this.root.appendChild(scrim);

    this.hub = document.createElement('div');
    this.hub.className = 'mk-wheel-hub';
    this.hubPick = document.createElement('div');
    this.hubPick.className = 'pick';
    this.hubDims = document.createElement('div');
    this.hubDims.className = 'dims';
    this.hub.append(this.hubPick, this.hubDims);
    this.root.appendChild(this.hub);

    parent.appendChild(this.root);
  }

  /** Set the choices. Rebuilds the wedges only when the count changes. */
  setEntries(entries: readonly WheelEntry[]): void {
    this.entries = entries;
    if (this.wedges.length !== entries.length) this.rebuild();
    this.paint();
  }

  private rebuild(): void {
    for (const w of this.wedges) w.remove();
    this.wedges.length = 0;

    for (let i = 0; i < this.entries.length; i++) {
      const wedge = document.createElement('div');
      wedge.className = 'mk-wedge';
      const dir = wedgeDirection(i, this.entries.length);
      wedge.style.transform = `translate(${dir.x * RADIUS}px, ${dir.y * RADIUS}px)`;
      wedge.innerHTML = '<div class="name"></div><div class="dims"></div>';
      this.root.appendChild(wedge);
      this.wedges.push(wedge);
    }
  }

  /**
   * Open the wheel, centred on nothing.
   *
   * The offset resets to zero so every open starts from the middle — carrying
   * the last direction over would make the wheel pick something the instant it
   * appeared.
   */
  show(currentIndex: number): void {
    this.open = true;
    this.current = currentIndex;
    this.dx = 0;
    this.dy = 0;
    this.highlighted = null;
    this.root.classList.add('open');
    this.paint();
  }

  /** Feed mouse movement while open. Pixels, same units as the look delta. */
  move(dx: number, dy: number): void {
    if (!this.open) return;
    this.dx += dx;
    this.dy += dy;
    // Clamped so a long sweep does not leave the offset far outside the wheel,
    // which would make small corrections feel unresponsive.
    const len = Math.hypot(this.dx, this.dy);
    if (len > RADIUS) {
      this.dx = (this.dx / len) * RADIUS;
      this.dy = (this.dy / len) * RADIUS;
    }
    this.highlighted = wedgeAt(this.dx, this.dy, this.entries.length);
    this.paint();
  }

  /**
   * Close, returning the chosen index — or null if nothing was aimed at.
   *
   * Null rather than "whatever was closest" so a tap that opens and closes the
   * wheel is a no-op, which is what a player who changed their mind expects.
   */
  hide(): number | null {
    this.open = false;
    this.root.classList.remove('open');
    const picked = this.highlighted;
    this.highlighted = null;
    return picked;
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** What the wheel would pick right now, for the chip and for tests. */
  get selection(): number | null {
    return this.highlighted;
  }

  private paint(): void {
    const shown = this.highlighted ?? this.current;
    const entry = this.entries[shown];
    this.hubPick.textContent = entry?.label ?? '';
    this.hubDims.textContent = entry?.detail ?? '';

    for (let i = 0; i < this.wedges.length; i++) {
      const wedge = this.wedges[i]!;
      const e = this.entries[i];
      if (e === undefined) continue;

      const name = wedge.querySelector('.name')!;
      name.innerHTML = `<span class="swatch" style="background:${e.color}"></span>${e.label}`;
      wedge.querySelector('.dims')!.textContent = e.detail;

      const selected = i === this.highlighted;
      wedge.classList.toggle('selected', selected);
      const dir = wedgeDirection(i, this.entries.length);
      const push = selected ? 1.1 : 1;
      wedge.style.transform =
        `translate(${dir.x * RADIUS * push}px, ${dir.y * RADIUS * push}px) scale(${selected ? 1.18 : 1})`;
    }
  }
}
