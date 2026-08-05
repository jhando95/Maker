import { describe, it, expect } from 'vitest';
import { CharacterController, type MoveIntent } from './controller.ts';
import { CollisionWorld } from '../physics/collisionWorld.ts';
import { DT, JUMP_HEIGHT, STEP_HEIGHT, WALK_SPEED, SPRINT_SPEED } from '../physics/constants.ts';
import { MODULE, STAIR_RUN } from '../build/partKit.ts';

const I = [0, 0, 0, 1] as const;

const idle: MoveIntent = {
  forward: 0, right: 0, jump: false, sprint: false, crouch: false, climb: 0,
};
const intent = (o: Partial<MoveIntent> = {}): MoveIntent => ({ ...idle, ...o });

/** Run the controller for `seconds` at the fixed timestep. */
function run(c: CharacterController, seconds: number, mi: MoveIntent = idle): void {
  const ticks = Math.round(seconds / DT);
  for (let i = 0; i < ticks; i++) c.step(DT, mi);
}

/** A flat platform whose top surface is at `top`. */
function platform(w: CollisionWorld, cx: number, top: number, cz: number, hx = 4, hz = 4): void {
  w.addPart(0, 0, cx, top - 0.025, cz, ...I, hx, 0.025, hz);
}

describe('CharacterController — basics', () => {
  it('settles on the ground and stays there', () => {
    const w = new CollisionWorld();
    const c = new CharacterController(w, 0, 2, 0);
    run(c, 2);
    expect(c.onGround).toBe(true);
    expect(c.y).toBeGreaterThan(-0.02);
    expect(c.y).toBeLessThan(0.05);
    // Not vibrating.
    const y1 = c.y;
    run(c, 0.5);
    expect(Math.abs(c.y - y1)).toBeLessThan(0.005);
  });

  it('walks at roughly the configured speed', () => {
    const w = new CollisionWorld();
    const c = new CharacterController(w, 0, 0.05, 0);
    run(c, 0.5);
    const startX = c.x;
    run(c, 1.0, intent({ right: 1 }));
    const travelled = c.x - startX;
    // Allow for the acceleration ramp at the start.
    expect(travelled).toBeGreaterThan(WALK_SPEED * 0.75);
    expect(travelled).toBeLessThan(WALK_SPEED * 1.05);
  });

  it('sprints faster than it walks', () => {
    const w = new CollisionWorld();
    const walk = new CharacterController(w, 0, 0.05, 0);
    const sprint = new CharacterController(w, 0, 0.05, 0);
    run(walk, 0.5);
    run(sprint, 0.5);
    const wx = walk.x;
    const sx = sprint.x;
    run(walk, 1.5, intent({ right: 1 }));
    run(sprint, 1.5, intent({ right: 1, sprint: true }));
    expect(sprint.x - sx).toBeGreaterThan(walk.x - wx);
    expect(sprint.x - sx).toBeLessThan(SPRINT_SPEED * 1.6);
  });

  it('does not move faster diagonally', () => {
    const w = new CollisionWorld();
    const straight = new CharacterController(w, 0, 0.05, 0);
    const diagonal = new CharacterController(w, 0, 0.05, 0);
    run(straight, 0.5);
    run(diagonal, 0.5);
    const s0 = straight.x;
    const d0x = diagonal.x;
    const d0z = diagonal.z;

    run(straight, 1.0, intent({ right: 1 }));
    run(diagonal, 1.0, intent({ right: 1, forward: 1 }));

    const straightDist = straight.x - s0;
    const diagDist = Math.hypot(diagonal.x - d0x, diagonal.z - d0z);
    expect(diagDist).toBeCloseTo(straightDist, 1);
  });

  it('jumps to roughly the configured height', () => {
    const w = new CollisionWorld();
    const c = new CharacterController(w, 0, 0.05, 0);
    run(c, 0.5);
    const base = c.y;

    let peak = base;
    c.step(DT, intent({ jump: true }));
    for (let i = 0; i < 120; i++) {
      c.step(DT, idle);
      if (c.y > peak) peak = c.y;
    }
    expect(peak - base).toBeGreaterThan(JUMP_HEIGHT * 0.85);
    expect(peak - base).toBeLessThan(JUMP_HEIGHT * 1.2);
  });

  it('cannot double jump', () => {
    const w = new CollisionWorld();
    const c = new CharacterController(w, 0, 0.05, 0);
    run(c, 0.5);
    c.step(DT, intent({ jump: true }));
    // Track the peak while holding jump for the whole flight; a second jump
    // would show up as the apex exceeding a single jump's height.
    let peak = c.y;
    for (let i = 0; i < 120; i++) {
      c.step(DT, intent({ jump: true }));
      if (c.y > peak) peak = c.y;
    }
    expect(peak).toBeLessThan(JUMP_HEIGHT * 1.2);
  });
});

describe('CharacterController — built structures', () => {
  it('steps up onto a single board without jumping', () => {
    const w = new CollisionWorld();
    // A board laid flat: one module tall, well under the step height. Wide
    // enough that the walk below finishes on top of it rather than past it.
    w.addPart(0, 0, 6, MODULE / 2, 0, ...I, 5, MODULE / 2, 2);
    const c = new CharacterController(w, 0, 0.05, 0);
    run(c, 0.4);
    run(c, 1.0, intent({ right: 1 }));
    expect(c.y).toBeGreaterThan(MODULE - 0.05);
    expect(c.x).toBeGreaterThan(1.5);
  });

  it('is blocked by a ledge above the step height', () => {
    const w = new CollisionWorld();
    const tall = STEP_HEIGHT + 0.5;
    w.addPart(0, 0, 2, tall / 2, 0, ...I, 1, tall / 2, 2);
    const c = new CharacterController(w, 0, 0.05, 0);
    run(c, 0.4);
    run(c, 2.0, intent({ right: 1 }));
    expect(c.y).toBeLessThan(0.1);
    expect(c.x).toBeLessThan(1.2);
  });

  it('walks up a player-built staircase', () => {
    const w = new CollisionWorld();
    // Ten steps at the kit's rise and run.
    for (let i = 0; i < 10; i++) {
      const top = MODULE * (i + 1);
      const cx = STAIR_RUN * i + STAIR_RUN / 2;
      w.addPart(0, 0, cx, top / 2, 0, ...I, STAIR_RUN / 2, top / 2, 1);
    }
    const c = new CharacterController(w, -1, 0.05, 0);
    run(c, 0.4);

    // Track the peak rather than the finish. The flight is only ten steps long,
    // so a controller that climbs briskly reaches the top and walks off the far
    // end well inside the window — asserting the final height would reward a
    // slower climb.
    let peak = c.y;
    for (let i = 0; i < Math.round(4.0 / DT); i++) {
      c.step(DT, intent({ right: 1 }));
      if (c.y > peak) peak = c.y;
    }
    expect(peak).toBeGreaterThan(MODULE * 6);
  });

  it('walks down a staircase without launching off the steps', () => {
    const w = new CollisionWorld();
    for (let i = 0; i < 10; i++) {
      const top = MODULE * (i + 1);
      const cx = STAIR_RUN * i + STAIR_RUN / 2;
      w.addPart(0, 0, cx, top / 2, 0, ...I, STAIR_RUN / 2, top / 2, 1);
    }
    // Start at the top and walk back down.
    const c = new CharacterController(w, STAIR_RUN * 9.5, MODULE * 10 + 0.05, 0);
    run(c, 0.4);

    let airborneTicks = 0;
    const ticks = Math.round(4.0 / DT);
    for (let i = 0; i < ticks; i++) {
      c.step(DT, intent({ right: -1 }));
      if (!c.onGround) airborneTicks++;
    }

    expect(c.x).toBeLessThan(1.0);
    // Ground snapping should keep contact nearly the whole way down.
    expect(airborneTicks / ticks).toBeLessThan(0.2);
  });

  it('stands on a platform built above the ground', () => {
    const w = new CollisionWorld();
    platform(w, 0, 2.0, 0);
    const c = new CharacterController(w, 0, 4, 0);
    run(c, 2.0);
    expect(c.onGround).toBe(true);
    expect(c.y).toBeGreaterThan(1.95);
    expect(c.y).toBeLessThan(2.05);
  });

  it('does not fall through a floor of flush planks while running across it', () => {
    const w = new CollisionWorld();
    w.hasGround = false;
    // Planks laid edge to edge, exactly one module wide each. Long enough that
    // a full sprint stays on the floor rather than running off the end.
    for (let i = 0; i < 100; i++) {
      w.addPart(0, 0, i * MODULE, 0.975, 0, ...I, MODULE / 2, 0.025, 2);
    }
    const c = new CharacterController(w, 0, 1.05, 0);
    run(c, 0.4);

    let minY = c.y;
    const ticks = Math.round(2.0 / DT);
    for (let i = 0; i < ticks; i++) {
      c.step(DT, intent({ right: 1, sprint: true }));
      if (c.y < minY) minY = c.y;
    }
    // Never dropped through a seam.
    expect(minY).toBeGreaterThan(0.9);
    expect(c.x).toBeGreaterThan(1.5);
  });

  it('holds its line crossing seams rather than being deflected', () => {
    const w = new CollisionWorld();
    w.hasGround = false;
    for (let i = 0; i < 100; i++) {
      w.addPart(0, 0, i * MODULE, 0.975, 0, ...I, MODULE / 2, 0.025, 3);
    }
    const c = new CharacterController(w, 0, 1.05, 0);
    run(c, 0.4);
    const z0 = c.z;
    run(c, 2.0, intent({ right: 1 }));
    expect(Math.abs(c.z - z0)).toBeLessThan(0.05);
  });
});

describe('CharacterController — crouch', () => {
  it('crouching lowers the eye height', () => {
    const w = new CollisionWorld();
    const c = new CharacterController(w, 0, 0.05, 0);
    run(c, 0.5);
    const standing = c.eyeHeight;
    run(c, 0.5, intent({ crouch: true }));
    expect(c.crouching).toBe(true);
    expect(c.eyeHeight).toBeLessThan(standing - 0.3);
  });

  it('refuses to stand up under a low ceiling', () => {
    const w = new CollisionWorld();
    // A plank roof at 1.2m: too low to stand, high enough to crouch.
    w.addPart(0, 0, 0, 1.25, 0, ...I, 3, 0.05, 3);
    const c = new CharacterController(w, 0, 0.05, 0);
    run(c, 0.5, intent({ crouch: true }));
    expect(c.crouching).toBe(true);
    run(c, 0.5, idle);
    // Still crouching, because standing has nowhere to go.
    expect(c.crouching).toBe(true);
  });
});

describe('CharacterController — coyote time and jump buffer', () => {
  it('allows a jump just after leaving a ledge', () => {
    const w = new CollisionWorld();
    w.hasGround = false;
    w.addPart(0, 0, 0, 0.975, 0, ...I, 1, 0.025, 2);
    const c = new CharacterController(w, 0.5, 1.05, 0);
    run(c, 0.4);
    expect(c.onGround).toBe(true);

    // Walk off the edge, then jump a couple of ticks later.
    run(c, 0.15, intent({ right: 1 }));
    const yBefore = c.y;
    c.step(DT, intent({ right: 1, jump: true }));
    run(c, 0.1, intent({ right: 1 }));
    expect(c.y).toBeGreaterThan(yBefore);
  });

  it('fires a jump pressed just before landing', () => {
    const w = new CollisionWorld();
    const c = new CharacterController(w, 0, 1.2, 0);
    // Fall while holding jump; it should fire on touchdown rather than be eaten.
    let bounced = false;
    for (let i = 0; i < 200; i++) {
      c.step(DT, intent({ jump: true }));
      if (c.vy > 1) {
        bounced = true;
        break;
      }
    }
    expect(bounced).toBe(true);
  });
});

describe('CharacterController — interpolation', () => {
  it('samples between the previous and current tick', () => {
    const w = new CollisionWorld();
    const c = new CharacterController(w, 0, 0.05, 0);
    run(c, 0.5);
    run(c, 0.3, intent({ right: 1 }));

    const a = c.sample(0);
    const b = c.sample(1);
    const mid = c.sample(0.5);
    expect(mid.x).toBeCloseTo((a.x + b.x) / 2, 6);
    expect(a.x).toBeCloseTo(c.prevX, 6);
    expect(b.x).toBeCloseTo(c.x, 6);
  });
});

describe('CharacterController — step height across its advertised range', () => {
  /**
   * A design review measured the effective step height at 0.25m against an
   * advertised STEP_HEIGHT of 0.55: rises of 0.20 and 0.25 climbed, and every
   * rise from 0.30 to 0.55 silently failed. A player building half-metre steps
   * would find them unclimbable for no visible reason.
   */
  it('climbs every rise up to STEP_HEIGHT', () => {
    for (const rise of [0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, STEP_HEIGHT]) {
      const w = new CollisionWorld();
      // A wide ledge, so nothing about the geometry is marginal.
      w.addPart(0, 0, 6, rise / 2, 0, ...I, 5, rise / 2, 4);
      const c = new CharacterController(w, 0, 0.05, 0);
      run(c, 0.4);
      run(c, 1.4, intent({ right: 1 }));
      expect(c.y, `rise ${rise}`).toBeGreaterThan(rise - 0.06);
    }
  });

  it('still refuses anything above STEP_HEIGHT', () => {
    for (const rise of [STEP_HEIGHT + 0.15, STEP_HEIGHT + 0.5]) {
      const w = new CollisionWorld();
      w.addPart(0, 0, 6, rise / 2, 0, ...I, 5, rise / 2, 4);
      const c = new CharacterController(w, 0, 0.05, 0);
      run(c, 0.4);
      run(c, 1.4, intent({ right: 1 }));
      expect(c.y, `rise ${rise}`).toBeLessThan(0.12);
    }
  });
});
