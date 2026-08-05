/**
 * Uniform spatial hash over axis-aligned bounds.
 *
 * This is the one broadphase in the game, deliberately. Collision queries, the
 * build system's aim ray, and snap-candidate lookup all go through it, so a
 * board placed by the build system is immediately visible to the character
 * controller with no second index to keep in sync.
 *
 * A hash rather than a BVH because building spams insert and remove: a hash
 * pays only for the cells an object touches, while a BVH would need a refit or
 * rebuild every time a player lays down a plank. Query cost scales with local
 * density, not with world size, so a 200-part fort costs the same to walk
 * through whether the world holds 200 parts or 20,000.
 */

export interface Aabb {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

export class SpatialHash<T extends number = number> {
  readonly cellSize: number;
  private readonly invCellSize: number;

  /** Cell key -> ids occupying that cell. */
  private readonly cells = new Map<number, T[]>();
  /** id -> the cell keys it was inserted into, so removal does not have to search. */
  private readonly membership = new Map<T, number[]>();

  /**
   * Reused across queries so a per-frame query does not allocate. Query results
   * are only valid until the next query — callers must copy if they need to hold on.
   */
  private readonly resultSet = new Set<T>();
  private readonly resultArr: T[] = [];

  constructor(cellSize = 1.0) {
    this.cellSize = cellSize;
    this.invCellSize = 1 / cellSize;
  }

  /**
   * Pack integer cell coordinates into one number.
   *
   * Number keys keep Map lookups on the fast path; string keys like
   * `${x},${y},${z}` allocate on every query.
   *
   * The packing must fit in the 2^53 integers a double represents exactly.
   * Three axes therefore get 17 bits each (2^51 total) — going wider silently
   * truncates the low bits and makes distinct cells collide, which shows up as
   * phantom collision candidates rather than as an error. 17 bits biased gives
   * a +/-65,536 cell range per axis, or +/-65km at 1m cells.
   */
  private static readonly BITS = 17;
  private static readonly BIAS = 1 << (SpatialHash.BITS - 1); // 65536
  private static readonly LIMIT = 1 << SpatialHash.BITS; // 131072
  private static readonly MUL_Y = 2 ** SpatialHash.BITS;
  private static readonly MUL_X = 2 ** (SpatialHash.BITS * 2);

  private static key(cx: number, cy: number, cz: number): number {
    const bx = cx + SpatialHash.BIAS;
    const by = cy + SpatialHash.BIAS;
    const bz = cz + SpatialHash.BIAS;
    return bx * SpatialHash.MUL_X + by * SpatialHash.MUL_Y + bz;
  }

  /** True if a cell coordinate is inside the representable range. */
  private static inRange(c: number): boolean {
    const b = c + SpatialHash.BIAS;
    return b >= 0 && b < SpatialHash.LIMIT;
  }

  private cellCoord(v: number): number {
    return Math.floor(v * this.invCellSize);
  }

  /** Insert an id under the given bounds. Re-inserting an existing id moves it. */
  insert(id: T, bounds: Aabb): void {
    if (this.membership.has(id)) this.remove(id);

    const x0 = this.cellCoord(bounds.minX);
    const y0 = this.cellCoord(bounds.minY);
    const z0 = this.cellCoord(bounds.minZ);
    const x1 = this.cellCoord(bounds.maxX);
    const y1 = this.cellCoord(bounds.maxY);
    const z1 = this.cellCoord(bounds.maxZ);

    // Out-of-range coordinates would wrap into another cell's key and show up
    // as phantom collisions somewhere else entirely. Refuse loudly instead.
    if (
      !SpatialHash.inRange(x0) || !SpatialHash.inRange(y0) || !SpatialHash.inRange(z0) ||
      !SpatialHash.inRange(x1) || !SpatialHash.inRange(y1) || !SpatialHash.inRange(z1)
    ) {
      throw new RangeError(
        `SpatialHash: bounds out of representable range for id ${id} ` +
          `(${bounds.minX},${bounds.minY},${bounds.minZ})-(${bounds.maxX},${bounds.maxY},${bounds.maxZ})`,
      );
    }

    const keys: number[] = [];
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        for (let cz = z0; cz <= z1; cz++) {
          const k = SpatialHash.key(cx, cy, cz);
          let bucket = this.cells.get(k);
          if (bucket === undefined) {
            bucket = [];
            this.cells.set(k, bucket);
          }
          bucket.push(id);
          keys.push(k);
        }
      }
    }
    this.membership.set(id, keys);
  }

  remove(id: T): boolean {
    const keys = this.membership.get(id);
    if (keys === undefined) return false;

    for (const k of keys) {
      const bucket = this.cells.get(k);
      if (bucket === undefined) continue;
      const i = bucket.indexOf(id);
      // Swap-pop: order within a cell carries no meaning, so avoid the O(n) shift.
      if (i !== -1) {
        bucket[i] = bucket[bucket.length - 1]!;
        bucket.pop();
      }
      if (bucket.length === 0) this.cells.delete(k);
    }
    this.membership.delete(id);
    return true;
  }

  has(id: T): boolean {
    return this.membership.has(id);
  }

  get size(): number {
    return this.membership.size;
  }

  clear(): void {
    this.cells.clear();
    this.membership.clear();
  }

  /**
   * Ids whose cells overlap the given bounds.
   *
   * These are broadphase candidates, not confirmed overlaps — an id is returned
   * if it shares any cell, so callers must still run a narrowphase test. The
   * returned array is reused between calls.
   */
  queryAabb(bounds: Aabb): readonly T[] {
    this.resultSet.clear();
    this.resultArr.length = 0;

    const x0 = this.cellCoord(bounds.minX);
    const y0 = this.cellCoord(bounds.minY);
    const z0 = this.cellCoord(bounds.minZ);
    const x1 = this.cellCoord(bounds.maxX);
    const y1 = this.cellCoord(bounds.maxY);
    const z1 = this.cellCoord(bounds.maxZ);

    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        for (let cz = z0; cz <= z1; cz++) {
          const bucket = this.cells.get(SpatialHash.key(cx, cy, cz));
          if (bucket === undefined) continue;
          for (const id of bucket) {
            if (!this.resultSet.has(id)) {
              this.resultSet.add(id);
              this.resultArr.push(id);
            }
          }
        }
      }
    }
    return this.resultArr;
  }

  /** Ids near a point, within `radius`. Broadphase only. */
  querySphere(x: number, y: number, z: number, radius: number): readonly T[] {
    return this.queryAabb({
      minX: x - radius,
      minY: y - radius,
      minZ: z - radius,
      maxX: x + radius,
      maxY: y + radius,
      maxZ: z + radius,
    });
  }

  /**
   * Ids along a ray, gathered by walking the cells the ray passes through
   * (3D DDA / Amanatides-Woo).
   *
   * Walking cells rather than testing the ray's bounding box matters for the
   * build aim ray: a 6m ray pointing diagonally has a bounding box covering
   * hundreds of cells but actually crosses only a dozen or so.
   *
   * Ids come back in roughly front-to-back order — cells are visited in order,
   * though ids within one cell are unordered — so a caller looking for the
   * nearest hit can stop early once its best hit precedes the current cell.
   */
  queryRay(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxDistance: number,
  ): readonly T[] {
    this.resultSet.clear();
    this.resultArr.length = 0;

    const len = Math.hypot(dx, dy, dz);
    if (len === 0) return this.resultArr;
    const nx = dx / len;
    const ny = dy / len;
    const nz = dz / len;

    let cx = this.cellCoord(ox);
    let cy = this.cellCoord(oy);
    let cz = this.cellCoord(oz);

    const stepX = nx > 0 ? 1 : nx < 0 ? -1 : 0;
    const stepY = ny > 0 ? 1 : ny < 0 ? -1 : 0;
    const stepZ = nz > 0 ? 1 : nz < 0 ? -1 : 0;

    // Distance along the ray to the next cell boundary on each axis, and the
    // distance between successive boundaries. Axis-parallel rays never cross a
    // boundary on the other axes, hence the Infinity guards.
    const nextBoundary = (c: number, step: number, o: number, n: number): number => {
      if (step === 0) return Infinity;
      const edge = step > 0 ? (c + 1) * this.cellSize : c * this.cellSize;
      return (edge - o) / n;
    };

    let tMaxX = nextBoundary(cx, stepX, ox, nx);
    let tMaxY = nextBoundary(cy, stepY, oy, ny);
    let tMaxZ = nextBoundary(cz, stepZ, oz, nz);

    const tDeltaX = stepX === 0 ? Infinity : this.cellSize / Math.abs(nx);
    const tDeltaY = stepY === 0 ? Infinity : this.cellSize / Math.abs(ny);
    const tDeltaZ = stepZ === 0 ? Infinity : this.cellSize / Math.abs(nz);

    let t = 0;
    // Bounded so a degenerate direction can never spin forever.
    const maxSteps = Math.ceil(maxDistance / this.cellSize) * 3 + 8;

    for (let i = 0; i < maxSteps; i++) {
      const bucket = this.cells.get(SpatialHash.key(cx, cy, cz));
      if (bucket !== undefined) {
        for (const id of bucket) {
          if (!this.resultSet.has(id)) {
            this.resultSet.add(id);
            this.resultArr.push(id);
          }
        }
      }

      if (tMaxX < tMaxY && tMaxX < tMaxZ) {
        t = tMaxX;
        if (t > maxDistance) break;
        cx += stepX;
        tMaxX += tDeltaX;
      } else if (tMaxY < tMaxZ) {
        t = tMaxY;
        if (t > maxDistance) break;
        cy += stepY;
        tMaxY += tDeltaY;
      } else {
        t = tMaxZ;
        if (t > maxDistance) break;
        cz += stepZ;
        tMaxZ += tDeltaZ;
      }
    }

    return this.resultArr;
  }

  /** Occupancy stats for the debug overlay. */
  stats(): { cells: number; objects: number; avgPerCell: number; maxPerCell: number } {
    let total = 0;
    let max = 0;
    for (const bucket of this.cells.values()) {
      total += bucket.length;
      if (bucket.length > max) max = bucket.length;
    }
    return {
      cells: this.cells.size,
      objects: this.membership.size,
      avgPerCell: this.cells.size === 0 ? 0 : total / this.cells.size,
      maxPerCell: max,
    };
  }
}
