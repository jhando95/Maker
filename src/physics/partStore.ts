/**
 * Storage for every placed part in the world.
 *
 * Structure-of-arrays rather than an array of objects: the collision gather
 * walks hundreds of parts per tick reading only centers and extents, and the
 * renderer uploads transforms straight to instance buffers. Both want tight
 * contiguous numeric arrays, and neither wants to chase pointers through
 * per-part objects.
 *
 * This is the authoritative world state. The renderer and the collision world
 * are both derived from it, which is what makes save/load and (later) network
 * replication a matter of serializing this one structure.
 */

import { obbAabb } from './capsuleObb.ts';
import type { Obb, PartId } from './types.ts';
import { NO_PART } from './types.ts';

/**
 * A part reference that survives slot reuse.
 *
 * Slots are recycled, so a bare index can silently come to mean a different
 * part after a remove and a place — the classic "you deleted the plank the undo
 * buffer was pointing at" bug. Pairing the index with the slot's generation
 * makes a stale reference detectable.
 */
export interface PartHandle {
  id: PartId;
  generation: number;
}

export class PartStore {
  private capacity: number;

  /** World-space centers, 3 floats per slot. */
  center: Float64Array;
  /** Box-local basis in world space, 9 floats per slot: u, v, w. */
  axes: Float64Array;
  /** Half-extents along u, v, w. */
  halfExtent: Float64Array;
  /** Cached world AABB, 3 floats each, kept in step with the transform. */
  aabbMin: Float64Array;
  aabbMax: Float64Array;
  /** Index into the part-kit definition table. */
  kind: Uint8Array;
  /** Colorway index, for per-instance tinting. */
  colorway: Uint8Array;
  /** 1 when the slot holds a live part. */
  alive: Uint8Array;
  /** Bumped whenever a slot is reused, so stale handles can be spotted. */
  generation: Uint32Array;

  /** Slots freed by removal, reused before growing. */
  private freeList: PartId[] = [];
  /** One past the highest slot ever used — the range worth iterating. */
  private highWater = 0;
  /** Number of live parts. */
  count = 0;

  constructor(initialCapacity = 1024) {
    this.capacity = initialCapacity;
    this.center = new Float64Array(initialCapacity * 3);
    this.axes = new Float64Array(initialCapacity * 9);
    this.halfExtent = new Float64Array(initialCapacity * 3);
    this.aabbMin = new Float64Array(initialCapacity * 3);
    this.aabbMax = new Float64Array(initialCapacity * 3);
    this.kind = new Uint8Array(initialCapacity);
    this.colorway = new Uint8Array(initialCapacity);
    this.alive = new Uint8Array(initialCapacity);
    this.generation = new Uint32Array(initialCapacity);
  }

  private grow(): void {
    const next = this.capacity * 2;
    const copy = <T extends Float64Array | Uint8Array | Uint32Array>(src: T, stride: number): T => {
      const dst = new (src.constructor as new (n: number) => T)(next * stride);
      dst.set(src as unknown as ArrayLike<number> & T);
      return dst;
    };
    this.center = copy(this.center, 3);
    this.axes = copy(this.axes, 9);
    this.halfExtent = copy(this.halfExtent, 3);
    this.aabbMin = copy(this.aabbMin, 3);
    this.aabbMax = copy(this.aabbMax, 3);
    this.kind = copy(this.kind, 1);
    this.colorway = copy(this.colorway, 1);
    this.alive = copy(this.alive, 1);
    this.generation = copy(this.generation, 1);
    this.capacity = next;
  }

  /** Highest slot index ever allocated, for iteration bounds. */
  get slotCount(): number {
    return this.highWater;
  }

  /**
   * Add a part. `quat` must be a unit quaternion.
   *
   * @returns a handle that stays valid until this part is removed.
   */
  add(
    kind: number,
    colorway: number,
    cx: number, cy: number, cz: number,
    qx: number, qy: number, qz: number, qw: number,
    hx: number, hy: number, hz: number,
  ): PartHandle {
    let id = this.freeList.pop();
    if (id === undefined) {
      if (this.highWater >= this.capacity) this.grow();
      id = this.highWater++;
    }

    this.center[id * 3] = cx;
    this.center[id * 3 + 1] = cy;
    this.center[id * 3 + 2] = cz;

    this.halfExtent[id * 3] = hx;
    this.halfExtent[id * 3 + 1] = hy;
    this.halfExtent[id * 3 + 2] = hz;

    this.setAxesFromQuaternion(id, qx, qy, qz, qw);

    this.kind[id] = kind;
    this.colorway[id] = colorway;
    this.alive[id] = 1;
    this.count++;

    this.recomputeAabb(id);
    return { id, generation: this.generation[id]! };
  }

  remove(id: PartId): boolean {
    if (id < 0 || id >= this.highWater || this.alive[id] === 0) return false;
    this.alive[id] = 0;
    // Bump on release so any handle still pointing here stops validating.
    this.generation[id] = (this.generation[id]! + 1) >>> 0;
    this.freeList.push(id);
    this.count--;
    return true;
  }

  isAlive(id: PartId): boolean {
    return id >= 0 && id < this.highWater && this.alive[id] === 1;
  }

  /** True if the handle still refers to the part it was issued for. */
  isValid(handle: PartHandle): boolean {
    return this.isAlive(handle.id) && this.generation[handle.id] === handle.generation;
  }

  private setAxesFromQuaternion(
    id: PartId,
    qx: number, qy: number, qz: number, qw: number,
  ): void {
    const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
    const xx = qx * x2, xy = qx * y2, xz = qx * z2;
    const yy = qy * y2, yz = qy * z2, zz = qz * z2;
    const wx = qw * x2, wy = qw * y2, wz = qw * z2;

    const o = id * 9;
    // Columns of the rotation matrix: the rotated basis vectors.
    this.axes[o] = 1 - (yy + zz);
    this.axes[o + 1] = xy + wz;
    this.axes[o + 2] = xz - wy;

    this.axes[o + 3] = xy - wz;
    this.axes[o + 4] = 1 - (xx + zz);
    this.axes[o + 5] = yz + wx;

    this.axes[o + 6] = xz + wy;
    this.axes[o + 7] = yz - wx;
    this.axes[o + 8] = 1 - (xx + yy);
  }

  /**
   * Refresh the cached world AABB for a slot.
   *
   * Projecting the box onto a world axis: the extent is the sum over local axes
   * of half-extent times that axis's component magnitude.
   */
  private recomputeAabb(id: PartId): void {
    const o = id * 9;
    const h = id * 3;
    const hx = this.halfExtent[h]!;
    const hy = this.halfExtent[h + 1]!;
    const hz = this.halfExtent[h + 2]!;

    const ex = Math.abs(this.axes[o]!) * hx + Math.abs(this.axes[o + 3]!) * hy + Math.abs(this.axes[o + 6]!) * hz;
    const ey = Math.abs(this.axes[o + 1]!) * hx + Math.abs(this.axes[o + 4]!) * hy + Math.abs(this.axes[o + 7]!) * hz;
    const ez = Math.abs(this.axes[o + 2]!) * hx + Math.abs(this.axes[o + 5]!) * hy + Math.abs(this.axes[o + 8]!) * hz;

    const c = id * 3;
    this.aabbMin[c] = this.center[c]! - ex;
    this.aabbMin[c + 1] = this.center[c + 1]! - ey;
    this.aabbMin[c + 2] = this.center[c + 2]! - ez;
    this.aabbMax[c] = this.center[c]! + ex;
    this.aabbMax[c + 1] = this.center[c + 1]! + ey;
    this.aabbMax[c + 2] = this.center[c + 2]! + ez;
  }

  /**
   * Fill `out` with slot `id`'s box.
   *
   * Callers pass a reusable Obb so the collision gather does not allocate one
   * per part per tick.
   */
  readObb(id: PartId, out: Obb): Obb {
    const c = id * 3;
    const o = id * 9;
    out.cx = this.center[c]!;
    out.cy = this.center[c + 1]!;
    out.cz = this.center[c + 2]!;
    out.ux = this.axes[o]!;
    out.uy = this.axes[o + 1]!;
    out.uz = this.axes[o + 2]!;
    out.vx = this.axes[o + 3]!;
    out.vy = this.axes[o + 4]!;
    out.vz = this.axes[o + 5]!;
    out.wx = this.axes[o + 6]!;
    out.wy = this.axes[o + 7]!;
    out.wz = this.axes[o + 8]!;
    out.hx = this.halfExtent[c]!;
    out.hy = this.halfExtent[c + 1]!;
    out.hz = this.halfExtent[c + 2]!;
    return out;
  }

  readAabb(id: PartId): {
    minX: number; minY: number; minZ: number;
    maxX: number; maxY: number; maxZ: number;
  } {
    const c = id * 3;
    return {
      minX: this.aabbMin[c]!, minY: this.aabbMin[c + 1]!, minZ: this.aabbMin[c + 2]!,
      maxX: this.aabbMax[c]!, maxY: this.aabbMax[c + 1]!, maxZ: this.aabbMax[c + 2]!,
    };
  }

  /** Iterate live slots. */
  *live(): Generator<PartId> {
    for (let i = 0; i < this.highWater; i++) {
      if (this.alive[i] === 1) yield i;
    }
  }

  clear(): void {
    this.alive.fill(0);
    this.freeList.length = 0;
    this.highWater = 0;
    this.count = 0;
  }
}

/** An OBB scratch object, for callers that need one to pass to readObb. */
export function makeObb(): Obb {
  return {
    cx: 0, cy: 0, cz: 0,
    ux: 1, uy: 0, uz: 0,
    vx: 0, vy: 1, vz: 0,
    wx: 0, wy: 0, wz: 1,
    hx: 0.5, hy: 0.5, hz: 0.5,
  };
}

export { NO_PART, obbAabb };
