import { describe, it } from 'vitest';
import { CollisionWorld } from '/home/user/Maker/src/physics/collisionWorld.ts';
import { CharacterController, type MoveIntent } from '/home/user/Maker/src/player/controller.ts';
import { NavField } from '/home/user/Maker/src/game/navField.ts';
import { DT, STEP_HEIGHT, CAP_RADIUS } from '/home/user/Maker/src/physics/constants.ts';

const I = [0, 0, 0, 1] as const;
const idle: MoveIntent = { forward: 0, right: 0, jump: false, sprint: false, crouch: false, climb: 0 };
const mi = (o: Partial<MoveIntent> = {}): MoveIntent => ({ ...idle, ...o });

describe('probe', () => {
  it('thin lumber step-up table', () => {
    // wall along Z at x=2, of given thickness and height. Walk +X into it.
    const rows: string[] = [];
    for (const thick of [0.05, 0.10, 0.25]) {
      for (const height of [0.25, 0.50]) {
        const w = new CollisionWorld();
        w.addPart(0, 0, 2 + thick / 2, height / 2, 0, ...I, thick / 2, height / 2, 3);
        const c = new CharacterController(w, 0, 0.05, 0);
        for (let i = 0; i < 30; i++) c.step(DT, idle);
        for (let i = 0; i < 180; i++) c.step(DT, mi({ right: 1 }));
        rows.push(`thick=${thick.toFixed(2)} h=${height.toFixed(2)} -> x=${c.x.toFixed(3)} y=${c.y.toFixed(3)} ${c.x > 2.5 ? 'PASSED' : 'BLOCKED'}`);
      }
    }
    require('node:fs').appendFileSync('/tmp/probe.out', ['STEP-UP TABLE (STEP_HEIGHT=' + STEP_HEIGHT + ')\n' + rows.join('\n')].join(' ') + '\n');
  });

  it('where does the capsule actually rest against a thin wall', () => {
    const w = new CollisionWorld();
    const thick = 0.05, height = 0.5;
    w.addPart(0, 0, 2 + thick / 2, height / 2, 0, ...I, thick / 2, height / 2, 3);
    const c = new CharacterController(w, 0, 0.05, 0);
    for (let i = 0; i < 30; i++) c.step(DT, idle);
    for (let i = 0; i < 120; i++) c.step(DT, mi({ right: 1 }));
    const faceX = 2;
    require('node:fs').appendFileSync('/tmp/probe.out', [`rest x=${c.x.toFixed(4)} gap to face = ${(faceX - c.x - CAP_RADIUS).toFixed(4)} (SKIN=0.015)`].join(' ') + '\n');
    require('node:fs').appendFileSync('/tmp/probe.out', [`distance from capsule centre to wall FAR side = ${(faceX + thick - c.x).toFixed(4)}`].join(' ') + '\n');
    require('node:fs').appendFileSync('/tmp/probe.out', [`spec probe distances: ${(CAP_RADIUS+0.02).toFixed(3)} ${(CAP_RADIUS+0.07).toFixed(3)} ${(CAP_RADIUS+0.12).toFixed(3)}`].join(' ') + '\n');
  });

  it('nav rebuild cost at shipped settings', () => {
    // Realistic built-up yard: a fort of planks plus scattered parts.
    const world = new CollisionWorld();
    let n = 0;
    // 6-course perimeter fort 16m across, planks on edge
    for (let course = 0; course < 6; course++) {
      const y = 0.125 + course * 0.25;
      for (let i = 0; i < 64; i++) {
        const t = (i / 64) * Math.PI * 2;
        world.addPart(0, 0, Math.sin(t) * 8, y, Math.cos(t) * 8, ...I, 0.5, 0.125, 0.025); n++;
      }
    }
    // interior clutter
    for (let i = 0; i < 600; i++) {
      world.addPart(0, 0, (i % 30) * 0.5 - 7, 0.3 + (i % 5) * 0.3, Math.floor(i / 30) * 0.5 - 7, ...I, 0.25, 0.05, 0.125); n++;
    }
    const nav = new NavField(26);
    for (let i = 0; i < 10; i++) nav.rebuild(world, 0, 0);
    const t0 = performance.now();
    const iters = 30;
    for (let i = 0; i < iters; i++) nav.rebuild(world, 0, 0);
    const ms = (performance.now() - t0) / iters;
    require('node:fs').appendFileSync('/tmp/probe.out', [`NAV REBUILD: parts=${n} cells=${nav.cells}x${nav.cells} -> ${ms.toFixed(2)} ms per rebuild (runs every 12 ticks, in ONE tick)`].join(' ') + '\n');
    require('node:fs').appendFileSync('/tmp/probe.out', ['stats', nav.stats()].join(' ') + '\n');
  });

  it('controller step cost', () => {
    const world = new CollisionWorld();
    for (let i = 0; i < 500; i++) {
      world.addPart(0, 0, (i % 25) * 0.5 - 6, 0.3 + (i % 4) * 0.3, Math.floor(i / 25) * 0.5 - 5, ...I, 0.25, 0.05, 0.125);
    }
    const c = new CharacterController(world, -12, 0.05, 0);
    for (let i = 0; i < 60; i++) c.step(DT, idle);
    const t0 = performance.now();
    const iters = 20000;
    for (let i = 0; i < iters; i++) c.step(DT, mi({ right: 1 }));
    const us = (performance.now() - t0) / iters * 1000;
    require('node:fs').appendFileSync('/tmp/probe.out', [`CONTROLLER STEP: ${us.toFixed(2)} us  (final x=${c.x.toFixed(2)})`].join(' ') + '\n');
  });
});
