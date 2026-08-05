/**
 * A few structures already standing when the game opens.
 *
 * Onboarding without a tutorial. A half-built fort with a ladder up one side and
 * a staircase up the other shows a new player what the kit is for and what a
 * finished thing looks like, in the time it takes to look around. They are built
 * from the same placement records the build system produces, so everything here
 * is something a player could have made — and could take apart.
 */

import * as THREE from 'three';
import { BuildSystem, type PlacementRecord } from '../build/buildSystem.ts';
import { MODULE, STAIR_RUN, PART_KINDS } from '../build/partKit.ts';

const kindId = (key: string): number => {
  const found = PART_KINDS.findIndex((k) => k.key === key);
  if (found === -1) throw new Error(`unknown part key ${key}`);
  return found;
};

const q = new THREE.Quaternion();
const e = new THREE.Euler();

function record(
  key: string,
  colorway: number,
  x: number, y: number, z: number,
  rx = 0, ry = 0, rz = 0,
): PlacementRecord {
  q.setFromEuler(e.set(rx, ry, rz, 'YXZ'));
  return { kind: kindId(key), colorway, x, y, z, qx: q.x, qy: q.y, qz: q.z, qw: q.w };
}

const HALF_PI = Math.PI / 2;

/**
 * Where the starter set is planted.
 *
 * The back-left lawn, which is open. It used to sit at the origin, which was
 * open grass and is now the middle of the house — so the whole set was quietly
 * embedded in a wall, which is exactly the failure applyPlaceIfClear exists to
 * make visible rather than invisible.
 */
export const STARTER_ORIGIN = { x: -10, z: 14 } as const;

export function seedStarterStructures(build: BuildSystem): void {
  const records: PlacementRecord[] = [];

  // ── A raised platform, four posts and a plank deck ─────────────────────────
  const deckY = 1.5;
  const deckHalf = 1.0;
  for (const [px, pz] of [
    [-deckHalf + 0.1, -deckHalf + 0.1],
    [deckHalf - 0.1, -deckHalf + 0.1],
    [-deckHalf + 0.1, deckHalf - 0.1],
    [deckHalf - 0.1, deckHalf - 0.1],
  ]) {
    // Posts are authored along +X, so a quarter turn about Z stands them up.
    records.push(record('post', 1, px, 0.75, pz, 0, 0, HALF_PI));
  }
  // Deck: long planks laid side by side at exactly one module pitch, so the
  // surface is continuous with no gaps to fall through.
  for (let i = 0; i < 8; i++) {
    records.push(record('plank_long', 0, 0, deckY, -0.875 + i * MODULE));
  }

  // ── A staircase up to the deck, at the kit's rise and run ─────────────────
  //
  // Built from stacked blocks rather than cut-to-length supports. Parts have
  // fixed dimensions — there is no scaling in this game — so a 1.5m post used
  // to hold up a 0.25m step sticks 1.25m into the air. Blocks are exactly one
  // module cubed, so stacking i+1 of them under step i lands flush every time.
  for (let i = 0; i < 6; i++) {
    const x = 1.4 + STAIR_RUN * i;
    for (const z of [0.375, 0.625]) {
      for (let level = 0; level <= i; level++) {
        records.push(record('block', 1, x, MODULE / 2 + level * MODULE, z));
      }
    }
    // Tread laid across the top of the stack.
    records.push(record('plank_short', 3, x, MODULE * (i + 1) + 0.025, 0.5));
  }

  // ── A ladder up the far side ──────────────────────────────────────────────
  const ladderX = -1.15;
  for (const rz of [-0.4, 0.4]) {
    // Rails standing vertically.
    records.push(record('plank_long', 2, ladderX, 1.0, rz, 0, 0, HALF_PI));
  }
  // Rungs at one module pitch — the same spacing as a stair rise, which is why
  // a player who builds "some rungs" gets something climbable.
  for (let i = 0; i < 6; i++) {
    records.push(record('plank_short', 3, ladderX + 0.06, MODULE * (i + 1), 0, 0, HALF_PI, 0));
  }

  // ── A low wall to hide behind, hinting at the party modes ─────────────────
  //
  // Planks stood on edge and stacked. Rotating a plank a quarter turn about its
  // own long axis puts its 0.25m width vertical, so each course adds one module
  // of height and the courses meet with no gap.
  for (let course = 0; course < 3; course++) {
    for (let run = 0; run < 3; run++) {
      records.push(
        record('plank_long', 4 + (course % 2), 4.6, MODULE / 2 + course * MODULE, -2 + run * 2.0, HALF_PI, HALF_PI, 0),
      );
    }
  }

  // ── A ramp and a leaning panel, showing parts need not be axis-aligned ────
  records.push(record('ramp', 6, -4.0, 0.25, 2.0));
  records.push(record('panel', 5, -6.0, 0.62, 2.0, 0, 0, Math.PI / 3));

  // Offset onto open ground, and skipped rather than forced where the map has
  // something standing. A starter structure with a gap in it is a small
  // disappointment; one growing through a shed is a bug report.
  for (const r of records) {
    build.applyPlaceIfClear({ ...r, x: r.x + STARTER_ORIGIN.x, z: r.z + STARTER_ORIGIN.z });
  }
}
