/**
 * The world's collision state and every query run against it.
 *
 * Owns the part store and the one spatial hash. Character collision, the build
 * system's aim ray, and snap-candidate lookup all come through here, so there is
 * exactly one place where "what is in the world" is answered.
 */

import { SpatialHash, type Aabb } from './spatialHash.ts';
import { PartStore, makeObb, type PartHandle, type LocalCollisionProxy } from './partStore.ts';
import { capsuleVsObb } from './capsuleObb.ts';
import { Feature, makeContact, type Capsule, type Contact, type Obb, type PartId } from './types.ts';
import {
  CONTACT_MARGIN,
  DEPEN_ITERS,
  MAX_PLANES,
  MAX_SUBSTEP,
  MAX_SUBSTEPS,
  MIN_GROUND_NORMAL_Y,
  OVERCLIP,
  PLANE_DUP_DOT,
  SKIN,
} from './constants.ts';

export interface RayHit {
  part: PartId;
  /** Distance along the ray. */
  distance: number;
  x: number; y: number; z: number;
  /** Outward surface normal at the hit. */
  nx: number; ny: number; nz: number;
  /** True when the ground plane was hit rather than a placed part. */
  isGround: boolean;
}

export interface MoveResult {
  x: number; y: number; z: number;
  /** Velocity after sliding along whatever was hit. */
  vx: number; vy: number; vz: number;
  onGround: boolean;
  /** Normal of the ground contact, when standing on something. */
  groundNx: number; groundNy: number; groundNz: number;
  /** True when the mover was pushed out of a surface it was already inside. */
  depenetrated: boolean;
}

/**
 * Ray against an oriented box, by slab clipping in the box's local frame.
 *
 * @returns distance along the ray, or -1 for a miss. On a hit, the outward face
 *   normal is written into `normalOut`.
 */
export function rayVsObb(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  box: Obb,
  maxDistance: number,
  normalOut: { x: number; y: number; z: number },
): number {
  // Into box-local space. The direction rotates; it is not translated.
  const px = ox - box.cx;
  const py = oy - box.cy;
  const pz = oz - box.cz;

  const lox = px * box.ux + py * box.uy + pz * box.uz;
  const loy = px * box.vx + py * box.vy + pz * box.vz;
  const loz = px * box.wx + py * box.wy + pz * box.wz;

  const ldx = dx * box.ux + dy * box.uy + dz * box.uz;
  const ldy = dx * box.vx + dy * box.vy + dz * box.vz;
  const ldz = dx * box.wx + dy * box.wy + dz * box.wz;

  let tMin = 0;
  let tMax = maxDistance;
  // Which local axis produced tMin, and its sign — that is the face we entered.
  let hitAxis = 0;
  let hitSign = 1;

  const slab = (o: number, d: number, h: number, axis: number): boolean => {
    if (Math.abs(d) < 1e-12) {
      // Parallel to this slab: a miss unless already between its planes.
      return o >= -h && o <= h;
    }
    const inv = 1 / d;
    let t1 = (-h - o) * inv;
    let t2 = (h - o) * inv;
    let sign = -1;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
      sign = 1;
    }
    if (t1 > tMin) {
      tMin = t1;
      hitAxis = axis;
      hitSign = sign;
    }
    if (t2 < tMax) tMax = t2;
    return tMin <= tMax;
  };

  if (!slab(lox, ldx, box.hx, 0)) return -1;
  if (!slab(loy, ldy, box.hy, 1)) return -1;
  if (!slab(loz, ldz, box.hz, 2)) return -1;
  if (tMin < 0 || tMin > maxDistance) return -1;

  // Local face normal back out to world.
  let nlx = 0;
  let nly = 0;
  let nlz = 0;
  if (hitAxis === 0) nlx = hitSign;
  else if (hitAxis === 1) nly = hitSign;
  else nlz = hitSign;

  normalOut.x = nlx * box.ux + nly * box.vx + nlz * box.wx;
  normalOut.y = nlx * box.uy + nly * box.vy + nlz * box.wy;
  normalOut.z = nlx * box.uz + nly * box.vz + nlz * box.wz;
  return tMin;
}

export class CollisionWorld {
  readonly store: PartStore;
  readonly hash: SpatialHash;

  /**
   * Bumped on every add or remove.
   *
   * Lets derived structures — the navigation grid, anything else that scans the
   * whole world — skip work when nothing has changed. During a wave the world is
   * frozen because building is disabled, so this is the difference between
   * rescanning five thousand cells five times a second and doing nothing.
   */
  version = 0;

  /** Height of the implicit flat ground plane. */
  groundY = 0;
  /** When false, the ground plane is ignored entirely (useful for tests). */
  hasGround = true;

  /**
   * Parts that belong to the map rather than to a player.
   *
   * A house you can walk through is scenery, and scenery cannot be the thing two
   * teams fight over. But a house made of ordinary parts is one a player can
   * take apart, and a map whose central wall can be deleted is not a map.
   *
   * So fixtures are collided with, raycast against, snapped to and routed around
   * exactly like any other part — the only difference is that the build system
   * refuses to remove them. Everything that makes the house useful to build
   * against still works; only demolition is off.
   */
  private readonly fixtures = new Set<PartId>();

  /**
   * Fixtures that can be climbed anyway — ladder rungs nailed to a trunk.
   *
   * The climb rule is "any near-vertical surface you can reach", which is the
   * right rule for player-built structures: nail rungs between two rails and the
   * game recognises a ladder without being told. Applied to the map it is the
   * wrong rule entirely, because it means shimmying up a flat stucco wall onto
   * the roof — and the roof being hard to reach is the reason the house is in
   * the middle of the map at all.
   *
   * So: you can climb what you built. You cannot climb the neighbourhood, except
   * where the neighbourhood already has a ladder on it.
   */
  private readonly climbable = new Set<PartId>();

  private readonly obbScratch: Obb = makeObb();
  private readonly contactPool: Contact[] = [];
  private readonly contacts: Contact[] = [];
  private readonly rayNormal = { x: 0, y: 0, z: 0 };

  /** Clip planes accumulated while sliding, as flat xyz triples. */
  private readonly planes = new Float64Array(MAX_PLANES * 3);

  constructor(cellSize = 1.0, initialCapacity = 1024) {
    this.store = new PartStore(initialCapacity);
    this.hash = new SpatialHash(cellSize);
    for (let i = 0; i < 32; i++) this.contactPool.push(makeContact());
  }

  addPart(
    kind: number,
    colorway: number,
    cx: number, cy: number, cz: number,
    qx: number, qy: number, qz: number, qw: number,
    hx: number, hy: number, hz: number,
    /** Collision shape in the part's local frame, when it differs from its box. */
    proxy?: LocalCollisionProxy | null,
  ): PartHandle {
    const handle = this.store.add(kind, colorway, cx, cy, cz, qx, qy, qz, qw, hx, hy, hz, proxy);
    this.hash.insert(handle.id, this.store.readAabb(handle.id));
    this.version++;
    return handle;
  }

  /**
   * Add a part that belongs to the map and cannot be removed by a player.
   *
   * Same arguments as addPart. The map's visible geometry is drawn separately by
   * the scenery batch, so nothing here is rendered — these are the solid shapes
   * underneath it, and the two must be generated from one description or they
   * drift and players clip through a wall that is plainly there.
   */
  addFixture(
    kind: number,
    colorway: number,
    cx: number, cy: number, cz: number,
    qx: number, qy: number, qz: number, qw: number,
    hx: number, hy: number, hz: number,
    proxy?: LocalCollisionProxy | null,
    options: { climbable?: boolean } = {},
  ): PartHandle {
    const handle = this.addPart(kind, colorway, cx, cy, cz, qx, qy, qz, qw, hx, hy, hz, proxy);
    this.fixtures.add(handle.id);
    if (options.climbable === true) this.climbable.add(handle.id);
    return handle;
  }

  isFixture(id: PartId): boolean {
    return this.fixtures.has(id);
  }

  /** Everything a player placed, plus the bits of the map that have rungs on them. */
  isClimbable(id: PartId): boolean {
    return !this.fixtures.has(id) || this.climbable.has(id);
  }

  get fixtureCount(): number {
    return this.fixtures.size;
  }

  removePart(id: PartId): boolean {
    if (!this.store.isAlive(id)) return false;
    this.hash.remove(id);
    this.fixtures.delete(id);
    this.climbable.delete(id);
    this.version++;
    return this.store.remove(id);
  }

  get partCount(): number {
    return this.store.count;
  }

  clear(): void {
    this.store.clear();
    this.hash.clear();
    this.fixtures.clear();
    this.climbable.clear();
    this.version++;
  }

  /**
   * Nearest hit along a ray, against placed parts and the ground plane.
   *
   * The broadphase returns candidates in roughly front-to-back cell order, but
   * ids within one cell are unordered and a part can straddle several cells, so
   * every candidate is still tested and the closest kept.
   */
  raycast(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxDistance: number,
  ): RayHit | null {
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-12) return null;
    const nx = dx / len;
    const ny = dy / len;
    const nz = dz / len;

    let best = maxDistance;
    let bestPart = -1;
    let bestNx = 0;
    let bestNy = 1;
    let bestNz = 0;

    const candidates = this.hash.queryRay(ox, oy, oz, nx, ny, nz, maxDistance);
    // Copy out: readAabb and other queries would clobber the shared buffer.
    for (let i = 0; i < candidates.length; i++) {
      const id = candidates[i]!;
      if (!this.store.isAlive(id)) continue;
      const box = this.store.readObb(id, this.obbScratch);
      const t = rayVsObb(ox, oy, oz, nx, ny, nz, box, best, this.rayNormal);
      if (t >= 0 && t < best) {
        best = t;
        bestPart = id;
        bestNx = this.rayNormal.x;
        bestNy = this.rayNormal.y;
        bestNz = this.rayNormal.z;
      }
    }

    // The ground plane is implicit rather than a part, so test it separately.
    let groundHit = false;
    if (this.hasGround && ny < -1e-9) {
      const t = (this.groundY - oy) / ny;
      if (t >= 0 && t < best) {
        best = t;
        bestPart = -1;
        bestNx = 0;
        bestNy = 1;
        bestNz = 0;
        groundHit = true;
      }
    }

    if (bestPart === -1 && !groundHit) return null;

    return {
      part: bestPart,
      distance: best,
      x: ox + nx * best,
      y: oy + ny * best,
      z: oz + nz * best,
      nx: bestNx, ny: bestNy, nz: bestNz,
      isGround: groundHit,
    };
  }

  /** Live part ids whose bounds overlap the given box. Broadphase only. */
  queryAabb(bounds: Aabb): PartId[] {
    const out: PartId[] = [];
    for (const id of this.hash.queryAabb(bounds)) {
      if (this.store.isAlive(id)) out.push(id);
    }
    return out;
  }

  /**
   * Every contact between the capsule and nearby parts, within `margin`.
   *
   * The returned array is reused between calls.
   */
  gatherContacts(cap: Capsule, margin = CONTACT_MARGIN): Contact[] {
    this.contacts.length = 0;

    const reach = cap.radius + margin;
    const bounds: Aabb = {
      minX: Math.min(cap.ax, cap.bx) - reach,
      minY: Math.min(cap.ay, cap.by) - reach,
      minZ: Math.min(cap.az, cap.bz) - reach,
      maxX: Math.max(cap.ax, cap.bx) + reach,
      maxY: Math.max(cap.ay, cap.by) + reach,
      maxZ: Math.max(cap.az, cap.bz) + reach,
    };

    const candidates = this.hash.queryAabb(bounds);
    for (let i = 0; i < candidates.length; i++) {
      const id = candidates[i]!;
      if (!this.store.isAlive(id)) continue;
      if (this.contacts.length >= this.contactPool.length) break;

      const box = this.store.readObb(id, this.obbScratch);
      const out = this.contactPool[this.contacts.length]!;
      if (capsuleVsObb(cap, box, out, margin)) {
        out.part = id;
        this.contacts.push(out);
      }
    }

    // Ground plane as a synthetic face contact.
    if (this.hasGround && this.contacts.length < this.contactPool.length) {
      const lowest = Math.min(cap.ay, cap.by);
      const gap = lowest - this.groundY;
      if (gap < reach) {
        const out = this.contactPool[this.contacts.length]!;
        out.part = -1;
        out.nx = 0; out.ny = 1; out.nz = 0;
        out.depth = cap.radius - gap;
        out.px = cap.ay <= cap.by ? cap.ax : cap.bx;
        out.py = lowest;
        out.pz = cap.ay <= cap.by ? cap.az : cap.bz;
        out.qx = out.px;
        out.qy = this.groundY;
        out.qz = out.pz;
        out.feature = Feature.Face;
        out.clampedAxes = 2;
        out.t = cap.ay <= cap.by ? 0 : 1;
        this.contacts.push(out);
      }
    }

    this.removeInternalEdges(this.contacts);
    return this.contacts;
  }

  /**
   * Suppress contacts on seams between flush-placed parts.
   *
   * Two boards laid side by side share an edge that is not really an exposed
   * edge — it is interior to a continuous surface. A capsule crossing it gets an
   * Edge contact whose normal points diagonally out of the seam and shoves the
   * player sideways for no visible reason. It is the single most noticeable
   * collision artefact in a game where players build flush surfaces constantly.
   *
   * The fix: an Edge or Vertex contact is bogus when some other part in the
   * gather presents a Face contact whose plane the edge point already lies on.
   * That face's normal is the real surface normal, so the edge contact is
   * redirected onto it rather than dropped, which keeps the depenetration depth.
   */
  private removeInternalEdges(contacts: Contact[]): void {
    for (let i = 0; i < contacts.length; i++) {
      const e = contacts[i]!;
      if (e.feature === Feature.Face || e.feature === Feature.Inside) continue;

      for (let j = 0; j < contacts.length; j++) {
        if (i === j) continue;
        const f = contacts[j]!;
        if (f.feature !== Feature.Face) continue;

        // Facing broadly the same way — a seam, not a genuine corner.
        const align = e.nx * f.nx + e.ny * f.ny + e.nz * f.nz;
        if (align <= 0.05 || align > 0.999) continue;

        // The edge point sits on the face's plane, so the surface is continuous.
        const dx = e.qx - f.qx;
        const dy = e.qy - f.qy;
        const dz = e.qz - f.qz;
        const distToPlane = Math.abs(dx * f.nx + dy * f.ny + dz * f.nz);
        if (distToPlane > 0.01) continue;

        // Re-express the penetration along the true surface normal. Projecting
        // shortens it by the angle between them, which is exactly right: pushing
        // along the face normal has to cover less distance than the diagonal.
        e.nx = f.nx;
        e.ny = f.ny;
        e.nz = f.nz;
        e.depth *= align;
        e.feature = Feature.Face;
        break;
      }
    }
  }

  /**
   * Push a capsule out of anything it is currently inside.
   *
   * Iterated because one push cannot be guaranteed to clear a capsule: the whole
   * spine translates, so a point that was not the closest can become the closest
   * afterwards.
   *
   * @returns true if any correction was applied.
   */
  depenetrate(cap: Capsule): boolean {
    let moved = false;
    for (let iter = 0; iter < DEPEN_ITERS; iter++) {
      const contacts = this.gatherContacts(cap, 0);
      let maxDepth = 0;
      let px = 0;
      let py = 0;
      let pz = 0;

      // Take the deepest correction per pass rather than summing every contact,
      // which would double-count two faces that overlap and eject the capsule.
      for (const c of contacts) {
        const target = c.depth + SKIN;
        if (target > maxDepth) {
          maxDepth = target;
          px = c.nx * target;
          py = c.ny * target;
          pz = c.nz * target;
        }
      }

      if (maxDepth <= 1e-7) break;
      cap.ax += px; cap.ay += py; cap.az += pz;
      cap.bx += px; cap.by += py; cap.bz += pz;
      moved = true;
    }
    return moved;
  }

  /**
   * Clip a velocity so it no longer drives into a plane.
   *
   * Quake's PM_ClipVelocity. The overclip factor pushes very slightly past the
   * plane, so the next iteration does not immediately re-collide with the
   * surface it just resolved and stall.
   */
  private static clipVelocity(
    vx: number, vy: number, vz: number,
    nx: number, ny: number, nz: number,
    out: { x: number; y: number; z: number },
  ): void {
    let backoff = vx * nx + vy * ny + vz * nz;
    backoff *= backoff < 0 ? OVERCLIP : 1 / OVERCLIP;
    out.x = vx - nx * backoff;
    out.y = vy - ny * backoff;
    out.z = vz - nz * backoff;
  }

  private readonly clipped = { x: 0, y: 0, z: 0 };

  /**
   * Move a capsule by a displacement, sliding along whatever it meets.
   *
   * Discrete overlap plus depenetration rather than a true time-of-impact sweep.
   * Tunnelling would require crossing 2*radius + part thickness in one step, and
   * the substep cap makes that geometrically impossible, so the extra complexity
   * of a sweep buys nothing here.
   *
   * `cap` is mutated in place to the resolved position.
   */
  moveAndSlide(cap: Capsule, dx: number, dy: number, dz: number, vx: number, vy: number, vz: number): MoveResult {
    const depenetrated = this.depenetrate(cap);

    let remainingX = dx;
    let remainingY = dy;
    let remainingZ = dz;

    let onGround = false;
    let groundNx = 0;
    let groundNy = 1;
    let groundNz = 0;

    const total = Math.hypot(dx, dy, dz);
    const substeps = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(total / MAX_SUBSTEP)));

    for (let step = 0; step < substeps; step++) {
      let stepX = remainingX / (substeps - step);
      let stepY = remainingY / (substeps - step);
      let stepZ = remainingZ / (substeps - step);

      let planeCount = 0;

      // Up to MAX_PLANES attempts: each blocked attempt adds a constraint and
      // retries with the velocity clipped against everything accumulated.
      for (let attempt = 0; attempt <= MAX_PLANES; attempt++) {
        cap.ax += stepX; cap.ay += stepY; cap.az += stepZ;
        cap.bx += stepX; cap.by += stepY; cap.bz += stepZ;

        const contacts = this.gatherContacts(cap, 0);
        let deepest: Contact | null = null;
        let deepestDepth = 1e-6;

        for (const c of contacts) {
          if (c.depth > deepestDepth) {
            deepestDepth = c.depth;
            deepest = c;
          }
          if (c.depth > -SKIN && c.ny >= MIN_GROUND_NORMAL_Y) {
            onGround = true;
            groundNx = c.nx;
            groundNy = c.ny;
            groundNz = c.nz;
          }
        }

        if (deepest === null) break;

        // Back the attempted motion out and try again under the new constraint.
        cap.ax -= stepX; cap.ay -= stepY; cap.az -= stepZ;
        cap.bx -= stepX; cap.by -= stepY; cap.bz -= stepZ;

        if (planeCount < MAX_PLANES) {
          // Skip a plane we already have; duplicates waste attempts and can
          // over-constrain the motion to zero in a corner.
          let duplicate = false;
          for (let p = 0; p < planeCount; p++) {
            const d =
              this.planes[p * 3]! * deepest.nx +
              this.planes[p * 3 + 1]! * deepest.ny +
              this.planes[p * 3 + 2]! * deepest.nz;
            if (d > PLANE_DUP_DOT) {
              duplicate = true;
              break;
            }
          }
          if (!duplicate) {
            this.planes[planeCount * 3] = deepest.nx;
            this.planes[planeCount * 3 + 1] = deepest.ny;
            this.planes[planeCount * 3 + 2] = deepest.nz;
            planeCount++;
          }
        }

        // Re-clip the step against every accumulated plane.
        let cx = stepX;
        let cy = stepY;
        let cz = stepZ;
        for (let p = 0; p < planeCount; p++) {
          CollisionWorld.clipVelocity(
            cx, cy, cz,
            this.planes[p * 3]!, this.planes[p * 3 + 1]!, this.planes[p * 3 + 2]!,
            this.clipped,
          );
          cx = this.clipped.x;
          cy = this.clipped.y;
          cz = this.clipped.z;
        }

        // Two planes meeting form a crease; slide along their intersection.
        if (planeCount === 2) {
          const n0x = this.planes[0]!, n0y = this.planes[1]!, n0z = this.planes[2]!;
          const n1x = this.planes[3]!, n1y = this.planes[4]!, n1z = this.planes[5]!;
          let ex = n0y * n1z - n0z * n1y;
          let ey = n0z * n1x - n0x * n1z;
          let ez = n0x * n1y - n0y * n1x;
          const elen = Math.hypot(ex, ey, ez);
          if (elen > 1e-6) {
            ex /= elen; ey /= elen; ez /= elen;
            const along = stepX * ex + stepY * ey + stepZ * ez;
            cx = ex * along;
            cy = ey * along;
            cz = ez * along;
          }
        }

        stepX = cx;
        stepY = cy;
        stepZ = cz;

        // Fully blocked: nothing left to try this substep.
        if (Math.hypot(stepX, stepY, stepZ) < 1e-7) {
          stepX = 0; stepY = 0; stepZ = 0;
          break;
        }
      }

      remainingX -= stepX;
      remainingY -= stepY;
      remainingZ -= stepZ;
    }

    // Clip the reported velocity the same way, so the caller's next tick does
    // not keep accelerating into a wall it is already flush against.
    const contacts = this.gatherContacts(cap, SKIN * 2);
    let outVx = vx;
    let outVy = vy;
    let outVz = vz;
    for (const c of contacts) {
      if (c.depth < -SKIN * 2) continue;
      const into = outVx * c.nx + outVy * c.ny + outVz * c.nz;
      if (into < 0) {
        CollisionWorld.clipVelocity(outVx, outVy, outVz, c.nx, c.ny, c.nz, this.clipped);
        outVx = this.clipped.x;
        outVy = this.clipped.y;
        outVz = this.clipped.z;
      }
      if (c.ny >= MIN_GROUND_NORMAL_Y) {
        onGround = true;
        groundNx = c.nx;
        groundNy = c.ny;
        groundNz = c.nz;
      }
    }

    return {
      x: cap.ax, y: cap.ay, z: cap.az,
      vx: outVx, vy: outVy, vz: outVz,
      onGround,
      groundNx, groundNy, groundNz,
      depenetrated,
    };
  }

  /**
   * Is there room for the capsule here? Used before standing up from a crouch
   * and before committing a mantle.
   */
  hasRoom(cap: Capsule): boolean {
    const contacts = this.gatherContacts(cap, 0);
    for (const c of contacts) {
      if (c.depth > SKIN) return false;
    }
    return true;
  }

  stats(): { parts: number; hash: ReturnType<SpatialHash['stats']> } {
    return { parts: this.store.count, hash: this.hash.stats() };
  }
}

export { makeObb };
export type { Capsule, Contact, Obb, PartId, PartHandle, LocalCollisionProxy };
