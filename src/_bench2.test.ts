import { describe, it } from 'vitest';
import { CollisionWorld } from './physics/collisionWorld.ts';
import { Rng } from './core/rng.ts';

const I = [0, 0, 0, 1] as const;

function timeIt(label: string, iters: number, fn: () => void): number {
  for (let i = 0; i < Math.min(iters, 50); i++) fn();
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  const dt = performance.now() - t0;
  const us = (dt * 1000) / iters;
  console.log(`  ${label.padEnd(50)} ${us.toFixed(1)} us/op  (${(us / 1000).toFixed(3)} ms)`);
  return us;
}

/**
 * A coarse 2.5D nav grid over a WxW yard at `cell` metres.
 * Each cell stores: ground height, and blocked flag.
 */
class NavGrid {
  readonly n: number;
  readonly cell: number;
  readonly origin: number;
  height: Float32Array;
  blocked: Uint8Array;
  // dijkstra scratch
  dist: Float32Array;
  from: Int32Array;

  constructor(extent: number, cell: number) {
    this.cell = cell;
    this.n = Math.ceil((extent * 2) / cell);
    this.origin = -extent;
    this.height = new Float32Array(this.n * this.n);
    this.blocked = new Uint8Array(this.n * this.n);
    this.dist = new Float32Array(this.n * this.n);
    this.from = new Int32Array(this.n * this.n);
  }

  /** Probe a column with one downward ray; mark blocked if step-up can't reach it. */
  probeCell(w: CollisionWorld, ix: number, iz: number, maxProbeY: number): void {
    const x = this.origin + (ix + 0.5) * this.cell;
    const z = this.origin + (iz + 0.5) * this.cell;
    const hit = w.raycast(x, maxProbeY, z, 0, -1, 0, maxProbeY + 1);
    const i = iz * this.n + ix;
    this.height[i] = hit === null ? 0 : hit.y;
    this.blocked[i] = 0;
  }

  probeAll(w: CollisionWorld, maxProbeY: number): void {
    for (let iz = 0; iz < this.n; iz++) {
      for (let ix = 0; ix < this.n; ix++) this.probeCell(w, ix, iz, maxProbeY);
    }
  }

  /** Mark edges blocked where the height difference exceeds step height. */
  markSteps(stepHeight: number): void {
    const n = this.n;
    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) {
        const i = iz * n + ix;
        const h = this.height[i]!;
        let walls = 0;
        if (ix > 0 && Math.abs(this.height[i - 1]! - h) > stepHeight) walls++;
        if (ix < n - 1 && Math.abs(this.height[i + 1]! - h) > stepHeight) walls++;
        if (iz > 0 && Math.abs(this.height[i - n]! - h) > stepHeight) walls++;
        if (iz < n - 1 && Math.abs(this.height[i + n]! - h) > stepHeight) walls++;
        if (walls >= 4) this.blocked[i] = 1;
      }
    }
  }

  /**
   * Single-source Dijkstra over the whole grid from `goal` — the flow field.
   * Uses a bucketed queue (uniform-ish edge costs), so no binary heap needed.
   */
  flood(goalIx: number, goalIz: number, stepHeight: number): number {
    const n = this.n;
    const total = n * n;
    this.dist.fill(Infinity);
    this.from.fill(-1);
    // Simple FIFO with cost tiebreak: BFS on a uniform grid is enough here;
    // use a 2-bucket trick for cardinal vs diagonal.
    const queue = new Int32Array(total * 4);
    let head = 0;
    let tail = 0;
    const start = goalIz * n + goalIx;
    this.dist[start] = 0;
    queue[tail++] = start;
    let expanded = 0;

    while (head < tail) {
      const cur = queue[head++]!;
      const d = this.dist[cur]!;
      expanded++;
      const cx = cur % n;
      const cz = (cur / n) | 0;
      const h = this.height[cur]!;
      for (let k = 0; k < 8; k++) {
        const dx = k === 0 ? 1 : k === 1 ? -1 : k === 2 ? 0 : k === 3 ? 0 : k === 4 ? 1 : k === 5 ? 1 : k === 6 ? -1 : -1;
        const dz = k === 0 ? 0 : k === 1 ? 0 : k === 2 ? 1 : k === 3 ? -1 : k === 4 ? 1 : k === 5 ? -1 : k === 6 ? 1 : -1;
        const nx = cx + dx;
        const nz = cz + dz;
        if (nx < 0 || nz < 0 || nx >= n || nz >= n) continue;
        const ni = nz * n + nx;
        if (this.blocked[ni] === 1) continue;
        const dh = this.height[ni]! - h;
        if (dh > stepHeight) continue; // cannot climb up
        if (dh < -3.0) continue; // too big a drop
        const cost = (dx !== 0 && dz !== 0 ? 1.414 : 1) + (dh > 0 ? dh * 2 : 0);
        const nd = d + cost;
        if (nd < this.dist[ni]!) {
          this.dist[ni] = nd;
          this.from[ni] = cur;
          if (tail < queue.length) queue[tail++] = ni;
        }
      }
    }
    return expanded;
  }
}

describe('nav bench', () => {
  it('grid probe + flow field costs', () => {
    const w = new CollisionWorld(1.0, 8192);
    const rng = new Rng('yard');
    // A yard with several forts.
    for (let f = 0; f < 12; f++) {
      const bx = rng.range(-18, 18);
      const bz = rng.range(-18, 18);
      for (let c = 0; c < 8; c++) {
        for (let s = 0; s < 6; s++) {
          w.addPart(0, 0, bx + s * 1.0, 0.125 + c * 0.25, bz, ...I, 0.5, 0.125, 0.025);
        }
      }
    }
    console.log(`\nWorld: ${w.partCount} parts`);

    for (const cell of [1.0, 0.75, 0.5]) {
      const g = new NavGrid(24, cell);
      console.log(`\n--- nav grid ${g.n}x${g.n} @ ${cell}m (${g.n * g.n} cells)`);
      timeIt('full probeAll (raycast every cell)', 30, () => g.probeAll(w, 12));
      g.probeAll(w, 12);
      g.markSteps(0.55);
      timeIt('markSteps', 200, () => g.markSteps(0.55));
      let exp = 0;
      timeIt('flood (full-grid flow field from one goal)', 200, () => { exp = g.flood(g.n >> 1, g.n >> 1, 0.55); });
      console.log(`      expansions: ${exp}`);
      // Incremental: one part placed touches ~3x3 cells
      const cells = Math.ceil(2.0 / cell) + 1;
      timeIt(`incremental reprobe of ${cells}x${cells} cells (one part placed)`, 20000, () => {
        for (let a = 0; a < cells; a++) for (let b = 0; b < cells; b++) g.probeCell(w, 10 + a, 10 + b, 12);
      });
    }
  }, 900000);
});
