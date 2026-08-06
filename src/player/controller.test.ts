import { describe, it, expect } from 'vitest';
import { CharacterController, type MoveIntent } from './controller.ts';
import { CollisionWorld } from '../physics/collisionWorld.ts';
import {
  DT, JUMP_HEIGHT, STEP_HEIGHT, WALK_SPEED, SPRINT_SPEED,
  MANTLE_MAX_HEIGHT, MANTLE_DURATION,
} from '../physics/constants.ts';
import { MODULE, STAIR_RUN } from '../build/partKit.ts';
import { BuildSystem } from '../build/buildSystem.ts';
import { PartRenderer } from '../render/partRenderer.ts';
import { neighborhoodSlabs, installFixtures, HOUSE, TREEHOUSE } from '../world/neighborhood.ts';
import { Rng } from '../core/rng.ts';

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

describe('a ladder you nailed together yourself', () => {
  /**
   * The payoff for the entire build system, and it had never been checked.
   *
   * The promise is that there is no ladder *object* — you nail rungs to
   * something and the game recognises it. That is a claim about three systems
   * agreeing (the part kit's module size, the collision world, and the climb
   * probe) and nothing was holding them together. If the rung pitch ever drifts
   * from the reach, every structure a player builds silently stops working and
   * the only symptom is that climbing "feels broken".
   */
  function backyardLadder(rungPitch: number): CharacterController {
    const world = new CollisionWorld();
    const build = new BuildSystem(world, new PartRenderer());

    // Ground to stand on.
    for (let i = -3; i <= 3; i++) {
      for (let j = -3; j <= 3; j++) {
        build.applyPlace({
          kind: 0, colorway: 0,
          x: i * 0.9, y: -0.1, z: j * 0.9, qx: 0, qy: 0, qz: 0, qw: 1,
        });
      }
    }
    // A wall, planks on edge.
    for (let course = 0; course < 12; course++) {
      build.applyPlace({
        kind: 0, colorway: 1,
        x: 0, y: 0.125 + course * 0.25, z: -1,
        qx: 0, qy: 0, qz: Math.sin(Math.PI / 4), qw: Math.cos(Math.PI / 4),
      });
    }
    // Rungs on its face.
    for (let r = 0; r < 10; r++) {
      build.applyPlace({
        kind: 0, colorway: 2,
        x: 0, y: 0.3 + r * rungPitch, z: -0.86, qx: 0, qy: 0, qz: 0, qw: 1,
      });
    }
    return new CharacterController(world, 0, 0.5, -0.2);
  }

  function climb(player: CharacterController, seconds = 8): number {
    let highest = player.y;
    for (let i = 0; i < Math.round(seconds / DT); i++) {
      player.step(DT, {
        forward: -1, right: 0, jump: false, sprint: false, crouch: false, climb: 1,
      });
      highest = Math.max(highest, player.y);
    }
    return highest;
  }

  it('can be climbed at the kit\u2019s own rung pitch', () => {
    // One module. A player stacking parts on the grid gets this for free, which
    // is the entire design — they are not told the rule, they land on it.
    const player = backyardLadder(MODULE);
    const highest = climb(player);
    expect(player.climbing).toBe(true);
    expect(highest).toBeGreaterThan(2);
  });

  it('but a flush wall is not, because there is nothing to hold', () => {
    // The rule that makes the rungs mean something.
    //
    // This test first ran the other way round: any near-vertical thing you built
    // was climbable, so a rungless wall took the player up three metres and
    // rungs were decoration. That reads as generous and is quietly corrosive —
    // a wall you build never stops *you*, so building tall costs nothing, and
    // the moment a second person is in the yard a fort stops working against the
    // only opponent that matters.
    const world = new CollisionWorld();
    const build = new BuildSystem(world, new PartRenderer());
    for (let i = -3; i <= 3; i++) {
      for (let j = -3; j <= 3; j++) {
        build.applyPlace({
          kind: 0, colorway: 0,
          x: i * 0.9, y: -0.1, z: j * 0.9, qx: 0, qy: 0, qz: 0, qw: 1,
        });
      }
    }
    for (let course = 0; course < 12; course++) {
      build.applyPlace({
        kind: 0, colorway: 1,
        x: 0, y: 0.125 + course * 0.25, z: -1,
        qx: 0, qy: 0, qz: Math.sin(Math.PI / 4), qw: Math.cos(Math.PI / 4),
      });
    }

    const player = new CharacterController(world, 0, 0.5, -0.2);
    let highest = player.y;
    for (let i = 0; i < Math.round(8 / DT); i++) {
      player.step(DT, {
        forward: -1, right: 0, jump: true, sprint: false, crouch: false, climb: 1,
      });
      highest = Math.max(highest, player.y);
    }
    expect(highest).toBeLessThan(0.5 + JUMP_HEIGHT + STEP_HEIGHT);
  });

  it('counts boards nailed flat to a wall, the cheapest ladder there is', () => {
    // The threshold has to sit under one plank thickness or the most obvious
    // improvised ladder — slap some boards on the face of a wall — would not
    // work, and a player would conclude that ladders are broken rather than
    // that theirs was subtly wrong.
    const world = new CollisionWorld();
    const build = new BuildSystem(world, new PartRenderer());
    for (let i = -3; i <= 3; i++) {
      for (let j = -3; j <= 3; j++) {
        build.applyPlace({
          kind: 0, colorway: 0, x: i * 0.9, y: -0.1, z: j * 0.9,
          qx: 0, qy: 0, qz: 0, qw: 1,
        });
      }
    }
    for (let course = 0; course < 12; course++) {
      build.applyPlace({
        kind: 0, colorway: 1, x: 0, y: 0.125 + course * 0.25, z: -1,
        qx: 0, qy: 0, qz: Math.sin(Math.PI / 4), qw: Math.cos(Math.PI / 4),
      });
    }
    // Boards flat against the face, protruding by their own thickness.
    for (let r = 0; r < 10; r++) {
      build.applyPlace({
        kind: 0, colorway: 2, x: 0, y: 0.35 + r * MODULE, z: -0.95,
        qx: 0, qy: 0, qz: 0, qw: 1,
      });
    }
    const player = new CharacterController(world, 0, 0.5, -0.2);
    expect(climb(player)).toBeGreaterThan(2);
  });

  it('still lets you up the treehouse ladder the map ships', () => {
    // The one ladder in the game a player did not build. Tightening the climb
    // rule is exactly the kind of change that breaks it silently, so it gets a
    // test of its own rather than being covered by the built-ladder cases.
    //
    // Only asserts that the ladder engages and gains real height. It stalls
    // around 2.65m rather than reaching the 4.5m deck, which is a separate
    // pre-existing bug — measured identical with and without the handhold rule,
    // so this is not the place to pin a number that documents it.
    const world = new CollisionWorld();
    installFixtures(world, neighborhoodSlabs(new Rng('map')));
    const player = new CharacterController(world, TREEHOUSE.x, 0.5, TREEHOUSE.z - 1.25);
    let highest = player.y;
    for (let i = 0; i < Math.round(10 / DT); i++) {
      player.step(DT, {
        forward: 1, right: 0, jump: false, sprint: false, crouch: false, climb: 1,
      });
      highest = Math.max(highest, player.y);
    }
    expect(player.climbing).toBe(true);
    expect(highest).toBeGreaterThan(2);
  });

  it('and the neighbourhood is not climbable, however vertical it is', () => {
    // The other half of the rule, and the reason it is worth having: the house
    // is a wall you go over rather than up. Without the fixture exception, flat
    // stucco would be a ladder and the map's whole shape would be optional.
    const world = new CollisionWorld();
    installFixtures(world, neighborhoodSlabs(new Rng('map')));

    // A blank side wall, not the front. The first attempt stood at the front
    // door and measured the player climbing the porch steps, which is a
    // staircase doing exactly what a staircase should.
    const player = new CharacterController(world, HOUSE.halfWidth + 0.4, 0.5, 0);
    let highest = player.y;
    for (let i = 0; i < Math.round(8 / DT); i++) {
      // MoveIntent.right is world X despite the name, so this walks into the
      // wall at -X.
      player.step(DT, {
        forward: 0, right: -1, jump: true, sprint: false, crouch: false, climb: 1,
      });
      highest = Math.max(highest, player.y);
    }
    expect(player.climbing).toBe(false);
    // No better than jumping on the spot. Written from the constants rather
    // than as a number, because the number is exactly what a jump reaches and
    // a hand-picked threshold lands on the wrong side of it — this failed at
    // 1.67m against a guessed 1.6m, which was the character jumping and nothing
    // else. The eaves are at 5m, so a real climb fails this by miles.
    expect(highest).toBeLessThan(0.5 + JUMP_HEIGHT + STEP_HEIGHT);
  });
});

describe('CharacterController — mantling', () => {
  /**
   * A ledge of a given height, wide enough not to be a balance beam, with a
   * standing surface behind it.
   */
  function ledge(w: CollisionWorld, height: number): void {
    platform(w, 0, 0, 0, 6, 6);
    w.addPart(0, 0, 0, height / 2, -3.2, ...I, 3, height / 2, 2);
  }

  /**
   * Walk up to a ledge, ask for a pull-up, and stop the moment it resolves.
   *
   * Stopping is the part that matters. The first version of this held forward
   * for two seconds after the mantle, so the player strolled off the far side
   * of the block and every assertion measured where they had wandered to
   * rather than where the pull-up had put them — a test asserting on state it
   * had not established, which is the way nearly every check in this project
   * has managed to be wrong.
   */
  function pullUp(c: CharacterController): { mantled: boolean; ticks: number } {
    run(c, 0.9, intent({ forward: -1 }));
    let mantled = false;
    let ticks = 0;
    for (let i = 0; i < 240; i++) {
      c.step(DT, intent({ forward: -1, jump: true }));
      if (c.mantling) { mantled = true; ticks++; continue; }
      if (mantled) break;
    }
    return { mantled, ticks };
  }

  it('hauls the player over a ledge too tall to step onto', () => {
    // The whole point. Between the step-up's reach and chest height there used
    // to be nothing but a wall, so every obstacle was either ankle-high or
    // final.
    const w = new CollisionWorld();
    ledge(w, 1.2);
    const c = new CharacterController(w, 0, 0.05, 0);
    run(c, 0.3);

    expect(pullUp(c).mantled).toBe(true);
    expect(c.y, `ended at ${c.y.toFixed(2)}m, not on top of a 1.2m ledge`)
      .toBeGreaterThan(1.15);
    expect(c.z, 'ended on the near side of the ledge').toBeLessThan(-1.2);
    expect(c.onGround).toBe(true);
  });

  it('refuses a ledge above chest height, so a wall is still a wall', () => {
    // The threshold that makes building worth anything. Without it, mantling
    // would delete every fort in the game rather than pricing them.
    //
    // Asserted on whether a pull-up ever started rather than on where the
    // player ended up: they are holding jump against a wall, so they will be
    // somewhere between the floor and a jump apex, and that number says
    // nothing about the rule under test.
    const w = new CollisionWorld();
    ledge(w, MANTLE_MAX_HEIGHT + 0.5);
    const c = new CharacterController(w, 0, 0.05, 0);
    run(c, 0.3);
    expect(pullUp(c).mantled, 'climbed something that should have stopped them').toBe(false);
  });

  it('leaves a low step to the step-up rather than animating it', () => {
    // A half-second pull-up over a kerb would replace something free with
    // something slow.
    //
    // Asked from a standstill against the step rather than after walking in,
    // and that is the whole difficulty of the test: walking in means the
    // step-up has already carried the player over before jump is ever pressed,
    // so there is no ledge left to refuse and the check passes whatever the
    // rule says. Starting adjacent is the only way the question gets asked.
    const w = new CollisionWorld();
    ledge(w, STEP_HEIGHT - 0.1);
    const c = new CharacterController(w, 0, 0.05, 0);
    c.teleport(0, 0.05, -0.9);
    run(c, 0.3);

    let mantled = false;
    for (let i = 0; i < 8; i++) {
      c.step(DT, intent({ forward: -1, jump: true }));
      if (c.mantling) mantled = true;
    }
    expect(mantled, 'a step the player can walk over became a pull-up').toBe(false);
  });

  it('still gets a player up a low step, the free way', () => {
    // The other half of the claim above: refusing to animate it is only right
    // because walking over it already works. Its own controller, because the
    // test above leaves the player bouncing off a wall with jump held.
    const w = new CollisionWorld();
    ledge(w, STEP_HEIGHT - 0.1);
    const c = new CharacterController(w, 0, 0.05, 0);
    run(c, 0.3);
    run(c, 1.6, intent({ forward: -1 }));
    expect(c.y).toBeGreaterThan(STEP_HEIGHT - 0.2);
  });

  it('will not start without the jump, so walking into a fence is not a vault', () => {
    // Deliberate rather than automatic: being teleported over an obstacle you
    // walked into makes every low fence a suggestion.
    const w = new CollisionWorld();
    ledge(w, 1.2);
    const c = new CharacterController(w, 0, 0.05, 0);
    run(c, 0.3);

    let mantled = false;
    for (let i = 0; i < 180; i++) {
      c.step(DT, intent({ forward: -1 }));
      if (c.mantling) mantled = true;
    }
    expect(mantled, 'a mantle happened with no jump pressed').toBe(false);
    expect(c.y).toBeLessThan(0.5);
  });

  it('refuses a ledge with no room to stand on it', () => {
    // The check that makes a collisionless rail safe. The landing is proved
    // clear before the pull-up starts rather than discovered afterwards, or a
    // player ends up inside whatever is over the ledge.
    const w = new CollisionWorld();
    ledge(w, 1.2);
    // A lid over the ledge, high enough that the search still finds the ledge
    // below it and low enough that nobody could stand up there.
    //
    // The first version put it 350mm up and the mantle simply took the lid
    // instead — which was the right answer to a badly built question: a shelf
    // you can reach and stand on is a ledge, and the search finds the topmost
    // surface for exactly that reason.
    w.addPart(0, 0, 0, 1.9, -3.2, ...I, 3, 0.05, 2);
    const c = new CharacterController(w, 0, 0.05, 0);
    run(c, 0.3);
    expect(pullUp(c).mantled, 'pulled up into a gap too small to stand in').toBe(false);
  });

  it('takes the time it says it takes', () => {
    // The cost, and the reason mantling does not simply delete walls: for this
    // long the player is on a rail, and a soaker pointed at them cannot miss.
    const w = new CollisionWorld();
    ledge(w, 1.2);
    const c = new CharacterController(w, 0, 0.05, 0);
    run(c, 0.3);

    const { mantled, ticks } = pullUp(c);
    expect(mantled, 'never mantled at all').toBe(true);
    const seconds = ticks * DT;
    expect(seconds).toBeGreaterThan(MANTLE_DURATION * 0.8);
    expect(seconds).toBeLessThan(MANTLE_DURATION * 1.3);
  });

  it('arrives standing rather than launched', () => {
    const w = new CollisionWorld();
    ledge(w, 1.2);
    const c = new CharacterController(w, 0, 0.05, 0);
    run(c, 0.3);
    // Sampled during the pull-up as well as after it. The rail sets position
    // directly and never integrates velocity, so the only way speed survives
    // into it is by not being cleared when it starts — which is the line this
    // is really about.
    run(c, 0.9, intent({ forward: -1, sprint: true }));
    let worst = 0;
    let was = false;
    for (let i = 0; i < 240; i++) {
      c.step(DT, intent({ forward: -1, jump: true }));
      if (c.mantling) { was = true; worst = Math.max(worst, Math.hypot(c.vx, c.vy, c.vz)); }
      else if (was) break;
    }
    expect(was, 'never mantled').toBe(true);
    expect(worst, 'carried speed onto the rail').toBeLessThan(0.5);
    expect(Math.abs(c.vy), 'left the ledge with vertical speed').toBeLessThan(0.6);
  });

  it('survives being rewound mid-pull, which is what a guest does every snapshot', () => {
    // A mantle is the one movement that ignores gravity and input for several
    // ticks. A rewind that dropped it would replay those ticks as an ordinary
    // fall and put a guest somewhere the host never was — the largest possible
    // disagreement, out of the shortest possible gap.
    const w = new CollisionWorld();
    ledge(w, 1.2);
    const c = new CharacterController(w, 0, 0.05, 0);
    run(c, 0.3);
    run(c, 0.9, intent({ forward: -1 }));

    let saved = null;
    for (let i = 0; i < 240 && saved === null; i++) {
      c.step(DT, intent({ forward: -1, jump: true }));
      if (c.mantling) saved = c.capture();
    }
    expect(saved, 'never got into a pull-up to rewind').not.toBeNull();

    const finish = (): { x: number; y: number; z: number } => {
      for (let i = 0; i < 60; i++) c.step(DT, intent({ forward: -1, jump: true }));
      return { x: c.x, y: c.y, z: c.z };
    };
    const first = finish();
    c.restore(saved!);
    const second = finish();

    expect(second.x).toBeCloseTo(first.x, 6);
    expect(second.y).toBeCloseTo(first.y, 6);
    expect(second.z).toBeCloseTo(first.z, 6);
  });
});
