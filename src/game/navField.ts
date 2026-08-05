/**
 * Flow-field navigation over player-built terrain.
 *
 * Bots originally steered straight at the objective and, when blocked, fanned
 * out a few probe rays to find a gap. That fails on exactly the structure the
 * game is about: given a U-shaped fort with its opening on the far side, a
 * steering bot walks into the near wall, probes two metres either way, finds
 * walls, and stays there. It never improves, because local probing has no
 * representation of "the way in is twenty metres around".
 *
 * That mattered beyond the bots looking stupid. Fort Defense is supposed to
 * teach the player where their fort failed; if a gap is never found, a leaky
 * fort scores as a perfect one and the lesson is wrong.
 *
 * So routing is global: one breadth-first flood from the objective across a
 * coarse grid, shared by every bot and rebuilt a few times a second. Bots read a
 * direction out of it and keep their local steering for the last metre, where
 * the grid is too coarse to be trusted. Neither layer does the other's job.
 *
 * The grid is 2D. Bots walk on the ground toward a ground-level objective, so
 * the cost of a layered grid — one flood per standable height per column — buys
 * nothing yet. A mode whose objective sits on top of a structure would need it.
 */

import type { CollisionWorld } from '../physics/collisionWorld.ts';
import { CAP_HEIGHT, STEP_HEIGHT } from '../physics/constants.ts';
import { MODULE } from '../build/partKit.ts';

/**
 * Cell size.
 *
 * Three modules, so cell boundaries land on the build lattice and a wall built
 * on-grid falls on a boundary instead of straddling two cells. Also wider than
 * the capsule's 0.64m diameter, so a cell that reads as open genuinely fits a
 * bot.
 */
export const CELL = MODULE * 3;

/** Unreachable cells carry this cost. */
export const UNREACHABLE = 0xffff;

export class NavField {
  readonly cells: number;
  readonly originX: number;
  readonly originZ: number;

  /** BFS cost from the objective, in cells. */
  private readonly cost: Uint16Array;
  /** 1 where a bot cannot stand. */
  private readonly blocked: Uint8Array;

  /** Frontier queue, preallocated so a rebuild never allocates. */
  private readonly queue: Int32Array;

  private goalI = -1;
  private goalJ = -1;

  constructor(halfExtent = 26) {
    this.cells = Math.ceil((halfExtent * 2) / CELL);
    this.originX = -halfExtent;
    this.originZ = -halfExtent;
    const n = this.cells * this.cells;
    this.cost = new Uint16Array(n);
    this.blocked = new Uint8Array(n);
    this.queue = new Int32Array(n);
    this.cost.fill(UNREACHABLE);
  }

  private index(i: number, j: number): number {
    return j * this.cells + i;
  }

  cellOf(x: number, z: number): { i: number; j: number } {
    return {
      i: Math.floor((x - this.originX) / CELL),
      j: Math.floor((z - this.originZ) / CELL),
    };
  }

  inBounds(i: number, j: number): boolean {
    return i >= 0 && j >= 0 && i < this.cells && j < this.cells;
  }

  /**
   * Re-derive which cells are passable, then flood from the goal.
   *
   * A cell is blocked when anything occupies the band a bot's body would pass
   * through: from one step height above the ground (below that it can step over)
   * up to head height (above that it can walk under). Testing that band rather
   * than the whole column is what lets bots walk beneath a raised platform
   * instead of treating it as a wall.
   */
  rebuild(world: CollisionWorld, goalX: number, goalZ: number): void {
    const half = CELL * 0.5;
    // Shrink slightly so a part that merely touches a boundary does not block
    // both cells it borders.
    const inset = 0.04;

    for (let j = 0; j < this.cells; j++) {
      for (let i = 0; i < this.cells; i++) {
        const cx = this.originX + i * CELL + half;
        const cz = this.originZ + j * CELL + half;
        // Query the hash directly: CollisionWorld.queryAabb allocates a fresh
        // array per call, which at a few thousand cells per rebuild is real.
        const probeMinX = cx - half + inset;
        const probeMaxX = cx + half - inset;
        const probeMinY = world.groundY + STEP_HEIGHT + 0.02;
        const probeMaxY = world.groundY + CAP_HEIGHT - 0.1;
        const probeMinZ = cz - half + inset;
        const probeMaxZ = cz + half - inset;

        const hits = world.hash.queryAabb({
          minX: probeMinX, minY: probeMinY, minZ: probeMinZ,
          maxX: probeMaxX, maxY: probeMaxY, maxZ: probeMaxZ,
        });

        // The hash answers with everything sharing a CELL, not everything
        // overlapping. Treating that as the answer massively over-blocks: one
        // 0.1m post reported ~5 square metres solid, and a doorway needed to be
        // two metres wide before any route through it could be found. A real
        // AABB test against each candidate is what makes the field mean
        // anything.
        //
        // The hash's result buffer is reused by the next query, so it must be
        // consumed before anything else touches the hash.
        let solid = 0;
        for (let k = 0; k < hits.length; k++) {
          const id = hits[k]!;
          if (!world.store.isAlive(id)) continue;
          const box = world.store.readAabb(id);
          if (
            probeMinX < box.maxX && probeMaxX > box.minX &&
            probeMinY < box.maxY && probeMaxY > box.minY &&
            probeMinZ < box.maxZ && probeMaxZ > box.minZ
          ) {
            solid = 1;
            break;
          }
        }
        this.blocked[this.index(i, j)] = solid;
      }
    }

    this.flood(goalX, goalZ);
  }

  /** Breadth-first cost from the goal outward. */
  private flood(goalX: number, goalZ: number): void {
    this.cost.fill(UNREACHABLE);

    const goal = this.cellOf(goalX, goalZ);
    this.goalI = goal.i;
    this.goalJ = goal.j;
    if (!this.inBounds(goal.i, goal.j)) return;

    let head = 0;
    let tail = 0;
    const start = this.index(goal.i, goal.j);
    this.cost[start] = 0;
    this.queue[tail++] = start;

    // Four-connected rather than eight. Diagonal steps would let a route slip
    // through the corner where two walls meet, which is a gap a bot cannot
    // actually walk through.
    while (head < tail) {
      const current = this.queue[head++]!;
      const ci = current % this.cells;
      const cj = (current / this.cells) | 0;
      const next = this.cost[current]! + 1;

      for (let d = 0; d < 4; d++) {
        const ni = ci + (d === 0 ? 1 : d === 1 ? -1 : 0);
        const nj = cj + (d === 2 ? 1 : d === 3 ? -1 : 0);
        if (!this.inBounds(ni, nj)) continue;
        const n = this.index(ni, nj);
        if (this.blocked[n] === 1) continue;
        if (this.cost[n]! <= next) continue;
        this.cost[n] = next;
        this.queue[tail++] = n;
      }
    }
  }

  /** Cost at a world position, or UNREACHABLE. */
  costAt(x: number, z: number): number {
    const { i, j } = this.cellOf(x, z);
    if (!this.inBounds(i, j)) return UNREACHABLE;
    return this.cost[this.index(i, j)]!;
  }

  isBlocked(x: number, z: number): boolean {
    const { i, j } = this.cellOf(x, z);
    if (!this.inBounds(i, j)) return true;
    return this.blocked[this.index(i, j)] === 1;
  }

  /**
   * Direction of steepest descent toward the goal, or null when there is no
   * route from here.
   *
   * Returns a world-space unit vector aimed at the centre of the best
   * neighbouring cell rather than at the neighbour's axis. Aiming along the axis
   * makes bots move in staircase steps; aiming at the centre keeps them smooth.
   */
  direction(x: number, z: number): { dx: number; dz: number } | null {
    const { i, j } = this.cellOf(x, z);
    if (!this.inBounds(i, j)) return null;

    const here = this.cost[this.index(i, j)]!;
    if (here === 0) return null; // standing on the goal
    if (here === UNREACHABLE) return null;

    let bestCost = here;
    let bestI = i;
    let bestJ = j;

    // Eight-connected when *reading* the field, so movement is not restricted to
    // the four directions the flood used. A diagonal is only taken when both of
    // its component neighbours are also open, which keeps bots out of corners.
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (di === 0 && dj === 0) continue;
        const ni = i + di;
        const nj = j + dj;
        if (!this.inBounds(ni, nj)) continue;
        const n = this.index(ni, nj);
        if (this.blocked[n] === 1) continue;
        if (di !== 0 && dj !== 0) {
          if (this.blocked[this.index(ni, j)] === 1) continue;
          if (this.blocked[this.index(i, nj)] === 1) continue;
        }
        const c = this.cost[n]!;
        if (c < bestCost) {
          bestCost = c;
          bestI = ni;
          bestJ = nj;
        }
      }
    }

    if (bestI === i && bestJ === j) return null;

    const tx = this.originX + bestI * CELL + CELL * 0.5;
    const tz = this.originZ + bestJ * CELL + CELL * 0.5;
    const dx = tx - x;
    const dz = tz - z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) return null;
    return { dx: dx / len, dz: dz / len };
  }

  /**
   * Is the objective walled off from here?
   *
   * Answered by reading the field, not by inferring from a bot's speed. A local
   * probe cannot tell a sealed fort from a doorway twenty metres around, which
   * is precisely the case that matters.
   */
  isSealedFrom(x: number, z: number): boolean {
    return this.costAt(x, z) === UNREACHABLE;
  }

  /** Diagnostics for the debug overlay. */
  stats(): { cells: number; blocked: number; reachable: number } {
    let blocked = 0;
    let reachable = 0;
    for (let i = 0; i < this.cost.length; i++) {
      if (this.blocked[i] === 1) blocked++;
      if (this.cost[i]! !== UNREACHABLE) reachable++;
    }
    return { cells: this.cost.length, blocked, reachable };
  }

  get goal(): { i: number; j: number } {
    return { i: this.goalI, j: this.goalJ };
  }
}
