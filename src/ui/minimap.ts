/**
 * A map of the neighbourhood, in the corner.
 *
 * The compass this game already has answers "which way is the flag" and cannot
 * answer "which way is *round*". A backyard with a house in the middle is a maze
 * the first six times you play it, and Tag runs the length of a street — a
 * direction is not a route.
 *
 * ## Three layers on three clocks, and why that is the whole design
 *
 * The naive minimap is a second camera rendering the scene from above, which
 * doubles every draw call in the game to show a picture that is mostly identical
 * to the last one. The second-naive one is a canvas that redraws every fence and
 * every plank every frame, which is a few thousand paths at sixty hertz.
 *
 * What is actually on a map is three things changing at wildly different rates:
 *
 * - **The neighbourhood** — house, fences, road, kerbs. Never moves. Drawn once,
 *   at boot, into an offscreen canvas covering the whole world.
 * - **What people have built.** Changes when somebody builds, a few times a
 *   minute. Its own offscreen canvas, rebuilt when `worldChanged()` says so and
 *   at most once a frame however many placements land in one tick.
 * - **People and objectives.** Every frame, and there are a handful of them.
 *
 * So a frame costs two `drawImage` calls and a dozen little paths, whatever is
 * in the world. The expensive layers are paid for when they change, by the thing
 * that changed them.
 *
 * The offscreen canvases are allocated once and never replaced, which is the
 * same rule every render batch in this project follows and the reason the soak
 * can assert that a long session grows by nothing.
 */

import { PLAY_HALF } from '../world/bounds.ts';
import { viewFor, projectClamped, type MapView } from './minimapModel.ts';

/** Pixels per metre in the offscreen layers. */
const BAKE_SCALE = 8;

/** How wide the baked world is, in metres — the play area with a margin. */
const BAKE_SPAN = PLAY_HALF * 2 + 8;

const BAKE_PX = Math.round(BAKE_SPAN * BAKE_SCALE);

/** How many metres the map shows across, near and far. */
export const ZOOMS = [26, 44, 76] as const;

/** A thing on the map that is not part of the world. */
export interface MapMarker {
  x: number;
  z: number;
  /** A CSS colour. */
  color: string;
  /** Bigger for an objective than for a person. */
  size: number;
  /** Drawn as a ring rather than a disc, for a thing that is a place. */
  hollow?: boolean;
}

/** Anything with a footprint, which is all a map cares about. */
export interface MapBox {
  x: number;
  z: number;
  /** Half-extents along the world axes, already accounting for any rotation. */
  hw: number;
  hd: number;
  color: string;
}

const STYLE = `
.mk-map {
  position: absolute; right: 14px; top: 14px;
  width: 168px; height: 168px;
  border-radius: 12px; overflow: hidden;
  border: 2px solid rgba(43,32,28,0.55);
  background: #a8c98a;
  box-shadow: 0 4px 14px rgba(0,0,0,0.28);
  pointer-events: none;
}
.mk-map canvas { display: block; width: 100%; height: 100%; }
.mk-map.mk-hidden { display: none; }
`;

export class Minimap {
  readonly root: HTMLDivElement;

  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  /** The neighbourhood, drawn once. */
  private readonly world: HTMLCanvasElement;
  /** What people have built, redrawn when it changes. */
  private readonly built: HTMLCanvasElement;
  private builtDirty = true;
  private builtOf: (() => readonly MapBox[]) | null = null;

  private zoom = 1;
  private size = 168;

  constructor(parent: HTMLElement) {
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);

    this.root = document.createElement('div');
    this.root.className = 'mk-map';
    this.canvas = document.createElement('canvas');
    this.root.appendChild(this.canvas);
    parent.appendChild(this.root);

    this.world = document.createElement('canvas');
    this.world.width = BAKE_PX;
    this.world.height = BAKE_PX;
    this.built = document.createElement('canvas');
    this.built.width = BAKE_PX;
    this.built.height = BAKE_PX;

    const ctx = this.canvas.getContext('2d');
    if (ctx === null) throw new Error('minimap: no 2d context');
    this.ctx = ctx;
    this.setSize(this.size);
  }

  setSize(px: number): void {
    this.size = px;
    // Drawn at device resolution and scaled down by CSS, or a map of thin
    // fences is a map of grey mush on any display worth having.
    const ratio = Math.min(globalThis.devicePixelRatio ?? 1, 2);
    this.canvas.width = Math.round(px * ratio);
    this.canvas.height = Math.round(px * ratio);
    this.root.style.width = `${px}px`;
    this.root.style.height = `${px}px`;
  }

  setVisible(on: boolean): void {
    this.root.classList.toggle('mk-hidden', !on);
  }

  /** Cycle through the zoom levels. Returns the span now shown, in metres. */
  cycleZoom(): number {
    this.zoom = (this.zoom + 1) % ZOOMS.length;
    return ZOOMS[this.zoom]!;
  }

  get span(): number {
    return ZOOMS[this.zoom]!;
  }

  /** Bake the neighbourhood. Called once, with the map's own solid geometry. */
  setWorld(boxes: readonly MapBox[]): void {
    paint(this.world, boxes);
  }

  /**
   * Where to get the built parts from, and a note that they have changed.
   *
   * A getter rather than an array so the map pulls when it is ready rather than
   * being pushed at on every placement — ten planks stamped in one tick are one
   * rebuild, not ten.
   */
  setBuiltSource(source: () => readonly MapBox[]): void {
    this.builtOf = source;
    this.builtDirty = true;
  }

  invalidateBuilt(): void {
    this.builtDirty = true;
  }

  /** Draw a frame. Cheap by construction: two blits and a few markers. */
  draw(playerX: number, playerZ: number, heading: number, markers: readonly MapMarker[]): void {
    if (this.builtDirty && this.builtOf !== null) {
      paint(this.built, this.builtOf());
      this.builtDirty = false;
    }

    const view = viewFor(playerX, playerZ, this.span, this.size, PLAY_HALF);
    const ctx = this.ctx;
    const px = this.canvas.width;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, px, px);

    // The window into the baked layers, in their own pixels.
    const half = BAKE_SPAN / 2;
    const sx = (view.centreX - view.span / 2 + half) * BAKE_SCALE;
    const sy = (view.centreZ - view.span / 2 + half) * BAKE_SCALE;
    const sw = view.span * BAKE_SCALE;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.world, sx, sy, sw, sw, 0, 0, px, px);
    ctx.drawImage(this.built, sx, sy, sw, sw, 0, 0, px, px);

    // Markers are in map pixels; the canvas is in device pixels.
    const k = px / this.size;
    ctx.scale(k, k);

    for (const marker of markers) {
      const p = projectClamped(view, marker.x, marker.z, marker.size + 1);
      ctx.beginPath();
      ctx.arc(p.x, p.y, marker.size, 0, Math.PI * 2);
      if (marker.hollow === true || p.clamped) {
        ctx.strokeStyle = marker.color;
        ctx.lineWidth = 2;
        ctx.stroke();
      } else {
        ctx.fillStyle = marker.color;
        ctx.fill();
      }
    }

    drawPlayer(ctx, view, playerX, playerZ, heading);
  }
}

/**
 * The player, as an arrow pointing where they are looking.
 *
 * A dot would be cheaper and would answer half the question. On a north-up map
 * the thing a player needs and cannot get anywhere else is which way they are
 * facing relative to the map — a dot leaves them turning on the spot to find
 * out.
 */
function drawPlayer(
  ctx: CanvasRenderingContext2D, view: MapView, x: number, z: number, heading: number,
): void {
  const p = projectClamped(view, x, z, 6);
  ctx.save();
  ctx.translate(p.x, p.y);
  // Yaw is measured from -z and turns the same way the map does.
  ctx.rotate(-heading);
  ctx.beginPath();
  ctx.moveTo(0, -7);
  ctx.lineTo(5, 6);
  ctx.lineTo(0, 3);
  ctx.lineTo(-5, 6);
  ctx.closePath();
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#2b201c';
  ctx.lineWidth = 1.6;
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/** Redraw a whole baked layer from a list of footprints. */
function paint(canvas: HTMLCanvasElement, boxes: readonly MapBox[]): void {
  const ctx = canvas.getContext('2d');
  if (ctx === null) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const half = BAKE_SPAN / 2;
  for (const box of boxes) {
    ctx.fillStyle = box.color;
    ctx.fillRect(
      (box.x - box.hw + half) * BAKE_SCALE,
      (box.z - box.hd + half) * BAKE_SCALE,
      Math.max(1, box.hw * 2 * BAKE_SCALE),
      Math.max(1, box.hd * 2 * BAKE_SCALE),
    );
  }
}
