import { describe, it } from 'vitest';
import { CollisionWorld } from './physics/collisionWorld.ts';
import { CharacterController, type MoveIntent } from './player/controller.ts';
import { DT, STEP_HEIGHT, CAP_RADIUS } from './physics/constants.ts';
import { MODULE, STAIR_RUN } from './build/partKit.ts';

const I = [0, 0, 0, 1] as const;
const idle: MoveIntent = { forward: 0, right: 0, jump: false, sprint: false, crouch: false, climb: 0 };

describe('step-up probe geometry', () => {
  it('traces a bot walking into a solid-block staircase', () => {
    const w = new CollisionWorld(1.0, 4096);
    // Solid stair: a full 0.5 x 0.25 block tread per step, deep enough to stand on.
    for (let i = 0; i < 6; i++) {
      const x = 2.0 + STAIR_RUN * i;
      for (let lv = 0; lv <= i; lv++)
        for (const zz of [-0.125, 0.125])
          w.addPart(7, 0, x, MODULE / 2 + lv * MODULE, zz, ...I, MODULE, MODULE / 2, MODULE / 2);
    }
    const c = new CharacterController(w, 1.0, 0.1, 0);
    for (let t = 0; t < 300; t++) {
      c.step(DT, { ...idle, right: 1 });
      if (t % 25 === 0) console.log(`   t=${String(t).padStart(3)} x=${c.x.toFixed(3)} y=${c.y.toFixed(3)} ground=${c.onGround}`);
    }
    console.log(`  solid stair final: x=${c.x.toFixed(3)} y=${c.y.toFixed(3)} (top tread y=${(MODULE * 6).toFixed(2)})`);
  });

  it('shows the step-up probe overshooting thin lumber', () => {
    // One plank laid flat (0.05 tall, 1m long) and one plank on edge (0.05 thick).
    for (const [label, hx, hy] of [
      ['flat plank 1.0m long, 0.05 tall', 0.5, 0.025],
      ['plank on edge, 0.05 thick, 0.25 tall', 0.025, 0.125],
      ['plank on edge, 0.05 thick, 0.50 tall (2 courses)', 0.025, 0.25],
      ['beam on edge, 0.10 thick, 0.50 tall', 0.05, 0.25],
      ['block 0.25 x 0.25', 0.125, 0.125],
    ] as const) {
      const w = new CollisionWorld(1.0, 4096);
      w.addPart(0, 0, 3.0, hy, 0, ...I, hx, hy, 4.0);
      const c = new CharacterController(w, 1.0, 0.1, 0);
      for (let t = 0; t < 240; t++) c.step(DT, { ...idle, right: 1 });
      const top = 2 * hy;
      const passed = c.x > 3.5;
      console.log(`  ${label.padEnd(52)} top=${top.toFixed(2)}m  final x=${c.x.toFixed(2)}  ` +
        `${passed ? 'STEPPED UP' : 'BLOCKED'}${top <= STEP_HEIGHT && !passed ? '   <-- under STEP_HEIGHT but still blocked' : ''}`);
    }
    console.log(`\n  probe offset is CAP_RADIUS+0.12 = ${(CAP_RADIUS + 0.12).toFixed(2)}m ahead of the feet;`);
    console.log(`  capsule surface sits ${CAP_RADIUS}m ahead, so the ray lands 0.12m PAST the contact face.`);
  });

  it('two-sample step probe fixes it (proposed patch)', () => {
    for (const [label, hx, hy] of [
      ['plank on edge 0.05 x 0.25', 0.025, 0.125],
      ['plank on edge 0.05 x 0.50', 0.025, 0.25],
      ['beam on edge 0.10 x 0.50', 0.05, 0.25],
    ] as const) {
      const w = new CollisionWorld(1.0, 4096);
      w.addPart(0, 0, 3.0, hy, 0, ...I, hx, hy, 4.0);
      // Emulate the patch: probe at radius+0.02 as well as radius+0.12.
      let bestRise = -1;
      for (const off of [CAP_RADIUS + 0.02, CAP_RADIUS + 0.07, CAP_RADIUS + 0.12]) {
        const feetX = 3.0 - hx - CAP_RADIUS - 0.02; // resting position against the face
        const hit = w.raycast(feetX + off, STEP_HEIGHT + 0.02, 0, 0, -1, 0, STEP_HEIGHT + 0.06);
        if (hit !== null && hit.ny >= 0.695) bestRise = Math.max(bestRise, hit.y);
      }
      console.log(`  ${label.padEnd(30)} multi-sample found surface at y=${bestRise.toFixed(3)} (top=${(2 * hy).toFixed(2)})`);
    }
  });
});
