import { describe, it } from 'vitest';
import { CollisionWorld } from './physics/collisionWorld.ts';
import { CharacterController, type MoveIntent } from './player/controller.ts';
import { DT } from './physics/constants.ts';
import { Rng } from './core/rng.ts';

const I = [0, 0, 0, 1] as const;

/** A wall of planks-on-edge at x = wx, spanning z. */
function wall(w: CollisionWorld, wx: number, z0: number, z1: number, courses: number): number {
  let n = 0;
  for (let c = 0; c < courses; c++) {
    for (let z = z0; z < z1; z += 2.0) {
      w.addPart(0, 0, wx, 0.125 + c * 0.25, z + 1.0, ...I, 0.025, 0.125, 1.0);
      n++;
    }
  }
  return n;
}

/** Deck of long planks side by side. */
function deck(w: CollisionWorld, cx: number, y: number, cz: number, spanX: number, spanZ: number): number {
  let n = 0;
  for (let z = -spanZ / 2; z < spanZ / 2; z += 0.25) {
    w.addPart(0, 0, cx, y, cz + z + 0.125, ...I, spanX / 2, 0.025, 0.125);
    n++;
  }
  return n;
}

const idle: MoveIntent = { forward: 0, right: 0, jump: false, sprint: false, crouch: false, climb: 0 };

function timeIt(label: string, iters: number, fn: () => void): number {
  for (let i = 0; i < Math.min(iters, 3000); i++) fn();
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  const dt = performance.now() - t0;
  const us = (dt * 1000) / iters;
  console.log(`  ${label.padEnd(48)} ${us.toFixed(2)} us/op`);
  return us;
}

/** Count of parts whose AABB is within r of a point. */
function localDensity(w: CollisionWorld, x: number, y: number, z: number, r: number): number {
  return w.queryAabb({ minX: x - r, minY: y - r, minZ: z - r, maxX: x + r, maxY: y + r, maxZ: z + r }).length;
}

describe('bench', () => {
  it('controller cost vs local density', () => {
    // ── Scenario A: open lawn, one fort somewhere else. Bot walks on grass.
    {
      const w = new CollisionWorld(1.0, 8192);
      let n = 0;
      n += wall(w, 20, -10, 10, 8);
      console.log(`\nA) open lawn (${n} parts, 0 near bot, density@3m=${localDensity(w, 0, 0, 0, 3)})`);
      const c = new CharacterController(w, 0, 0.1, 0);
      for (let i = 0; i < 60; i++) c.step(DT, idle);
      timeIt('step: walking on flat grass, nothing nearby', 200000, () =>
        c.step(DT, { ...idle, forward: 0.0001, right: 0.0001 }));
      timeIt('step: standing still on grass', 200000, () => c.step(DT, idle));
    }

    // ── Scenario B: bot walking on a built deck (contacts every tick).
    {
      const w = new CollisionWorld(1.0, 8192);
      const n = deck(w, 0, 1.5, 0, 20, 20);
      const c = new CharacterController(w, 0, 1.6, 0);
      for (let i = 0; i < 90; i++) c.step(DT, idle);
      console.log(`\nB) walking on a deck (${n} parts, density@2m=${localDensity(w, c.x, c.y, c.z, 2)}) y=${c.y.toFixed(2)} ground=${c.onGround}`);
      timeIt('step: walking on plank deck', 200000, () => c.step(DT, { ...idle, forward: 0.0001 }));
    }

    // ── Scenario C: bot pressed into a wall (the "blocked" case we care about).
    {
      const w = new CollisionWorld(1.0, 8192);
      wall(w, 1.0, -6, 6, 10);
      const c = new CharacterController(w, 0.2, 0.1, 0);
      for (let i = 0; i < 60; i++) c.step(DT, { ...idle, right: 1 });
      console.log(`\nC) pressed into wall, x=${c.x.toFixed(3)} density@2m=${localDensity(w, c.x, c.y, c.z, 2)}`);
      timeIt('step: pushing into a wall (step-up probe fires)', 200000, () =>
        c.step(DT, { ...idle, right: 1 }));
    }

    // ── Scenario D: dense junk pile — worst realistic case.
    {
      const w = new CollisionWorld(1.0, 8192);
      const rng = new Rng('pile');
      let n = 0;
      for (let i = 0; i < 400; i++) {
        w.addPart(0, 0, rng.range(-3, 3), rng.range(0, 3), rng.range(-3, 3), ...I, 0.5, 0.025, 0.125);
        n++;
      }
      const c = new CharacterController(w, 0, 3.5, 0);
      for (let i = 0; i < 120; i++) c.step(DT, idle);
      console.log(`\nD) junk pile (${n} parts in 6m box, density@2m=${localDensity(w, c.x, c.y, c.z, 2)}) y=${c.y.toFixed(2)}`);
      timeIt('step: inside a dense junk pile', 100000, () => c.step(DT, { ...idle, forward: 1 }));
    }

    // ── Probe costs against a big world, for comparison.
    {
      const w = new CollisionWorld(1.0, 8192);
      const rng = new Rng('big');
      for (let i = 0; i < 3000; i++) {
        w.addPart(0, 0, rng.range(-25, 25), rng.range(0, 5), rng.range(-25, 25), ...I, 0.5, 0.025, 0.125);
      }
      console.log(`\nE) probe costs, 3000 parts over a 50m yard (density@2m=${localDensity(w, 0, 1, 0, 2)})`);
      timeIt('raycast 1.2m (whisker)', 400000, () => { w.raycast(0, 1, 0, 1, 0, 0, 1.2); });
      timeIt('raycast 3m (long whisker)', 400000, () => { w.raycast(0, 1, 0, 1, 0, 0, 3); });
      timeIt('raycast 30m (line of sight)', 200000, () => { w.raycast(0, 1, 0, 1, 0, 0, 30); });
      timeIt('raycast 2.5m down (ground probe)', 400000, () => { w.raycast(0, 3, 0, 0, -1, 0, 2.5); });
      const cap = { ax: 0, ay: 0.32, az: 0, bx: 0, by: 1.38, bz: 0, radius: 0.32 };
      timeIt('hasRoom (capsule fit probe)', 400000, () => { w.hasRoom(cap); });
      timeIt('queryAabb 2m box', 200000, () => { localDensity(w, 0, 1, 0, 2); });
    }
  }, 900000);
});
