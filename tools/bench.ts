/**
 * Simulation benchmark.
 *
 * Measures the CPU cost of one tick at realistic scale. Deliberately separate
 * from the screenshot harness, which runs under software GL and can say nothing
 * useful about frame rate — but the simulation cost measured here is the same
 * on any machine, because none of it touches the GPU.
 *
 * The budget is one 60Hz tick: 16.67ms total, of which simulation should want a
 * small fraction so the renderer has the rest.
 *
 *   npx vite-node tools/bench.ts
 */

import { CollisionWorld } from '../src/physics/collisionWorld.ts';
import { CharacterController, type MoveIntent } from '../src/player/controller.ts';
import { BuildSystem } from '../src/build/buildSystem.ts';
import { PartRenderer } from '../src/render/partRenderer.ts';
import { Snapper } from '../src/build/snapping.ts';
import { ProjectileSystem } from '../src/game/projectiles.ts';
import { NavField } from '../src/game/navField.ts';
import { Bot, BOT_TIERS } from '../src/game/bot.ts';
import { FortDefenseMode } from '../src/game/fortDefense.ts';
import { sameForEveryone, type ModeContext } from '../src/game/gameMode.ts';
import { ActorRoster, LOCAL_ACTOR_ID } from '../src/game/actor.ts';
import { CameraRig } from '../src/player/cameraRig.ts';
import { Rng } from '../src/core/rng.ts';
import { DT } from '../src/physics/constants.ts';
import { getPartKind } from '../src/build/partKit.ts';

const TICK_BUDGET_MS = 1000 / 60;

interface Result {
  name: string;
  msPerOp: number;
  opsPerTick: number;
  note?: string;
}

const results: Result[] = [];

/** Time `fn`, after a warm-up so the measurement reflects optimized code. */
function bench(name: string, iterations: number, fn: () => void, opsPerTick = 1, note?: string): void {
  const warm = Math.max(50, Math.floor(iterations / 10));
  for (let i = 0; i < warm; i++) fn();

  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const total = performance.now() - start;

  results.push({ name, msPerOp: total / iterations, opsPerTick, note });
}

const idle: MoveIntent = {
  forward: 0, right: 0, jump: false, sprint: false, crouch: false, climb: 0,
};

/** A world with a dense fort near the origin plus scattered sprawl. */
function buildWorld(partCount: number): { world: CollisionWorld; build: BuildSystem } {
  const world = new CollisionWorld(1.0, 8192);
  const build = new BuildSystem(world, new PartRenderer());
  const rng = new Rng('bench');

  // A fort: walls of planks on edge around the origin.
  let placed = 0;
  for (let course = 0; course < 6 && placed < partCount * 0.4; course++) {
    for (let i = 0; i < 40 && placed < partCount * 0.4; i++) {
      const a = (i / 40) * Math.PI * 2;
      const r = 5;
      build.applyPlace({
        kind: 0, colorway: 0,
        x: Math.sin(a) * r, y: 0.125 + course * 0.25, z: Math.cos(a) * r,
        qx: 0, qy: Math.sin(-a / 2), qz: 0, qw: Math.cos(-a / 2),
      });
      placed++;
    }
  }
  // Sprawl, so the broadphase holds a realistic number of parts.
  while (placed < partCount) {
    build.applyPlace({
      kind: placed % 3, colorway: placed % 8,
      x: rng.signed(22), y: 0.1 + (placed % 12) * 0.25, z: rng.signed(22),
      qx: 0, qy: 0, qz: 0, qw: 1,
    });
    placed++;
  }
  return { world, build };
}

console.log('Building benchmark world…');
const { world, build } = buildWorld(3000);
console.log(`world: ${world.partCount} parts, ${world.hash.stats().cells} hash cells\n`);

// ── Collision ────────────────────────────────────────────────────────────────
const player = new CharacterController(world, 4.6, 0.5, 0);
for (let i = 0; i < 30; i++) player.step(DT, idle);

const cap = {
  ax: player.x, ay: player.y + 0.32, az: player.z,
  bx: player.x, by: player.y + 1.38, bz: player.z,
  radius: 0.32,
};

bench('collisionWorld.gatherContacts', 20000, () => {
  world.gatherContacts(cap, 0.04);
}, 6, 'several per tick: substeps plus depenetration');

bench('collisionWorld.raycast (6m)', 20000, () => {
  world.raycast(player.x, player.y + 1.5, player.z, 0.6, -0.3, 0.7, 6);
}, 3, 'build aim, footstep surface, camera boom');

bench('characterController.step', 20000, () => {
  player.step(DT, { ...idle, right: 1 });
}, 1, 'once per tick for the player');

// ── Building ─────────────────────────────────────────────────────────────────
const snapper = new Snapper(world);
const plank = getPartKind(0);
bench('snapper.solve', 2000, () => {
  snapper.solve({
    ox: 4.6, oy: 2.0, oz: 0,
    dx: 0.2, dy: -0.4, dz: -0.9,
    kind: plank,
    yawSteps: 0, pitchSteps: 0, rollSteps: 0,
    freeAim: false, fine: false, cycleIndex: 0,
  });
}, 1, 'every tick while building');

// ── Navigation ───────────────────────────────────────────────────────────────
const nav = new NavField(26);
bench('navField.rebuild', 60, () => {
  nav.rebuild(world, 0, 0);
}, 0.2, 'five times a second, so a fifth of a tick');

// ── Bots ─────────────────────────────────────────────────────────────────────
const projectiles = new ProjectileSystem(world);
const bots: Bot[] = [];
for (let i = 0; i < 15; i++) {
  const a = (i / 15) * Math.PI * 2;
  const b = new Bot(i + 1, world, new Rng(`bot-${i}`), BOT_TIERS.normal!, Math.sin(a) * 18, 0.5, Math.cos(a) * 18);
  b.targetX = 0; b.targetY = 0; b.targetZ = 0;
  b.aimX = player.x; b.aimY = player.y; b.aimZ = player.z;
  b.hasAim = true;
  bots.push(b);
}
for (let i = 0; i < 60; i++) for (const b of bots) b.update(DT, projectiles, false, nav);

bench('bot.update x15', 3000, () => {
  for (const b of bots) b.update(DT, projectiles, false, nav);
}, 1, 'a full wave, every tick');

// ── Projectiles ──────────────────────────────────────────────────────────────
const targets = bots.map((b) => b.asTarget());
for (let i = 0; i < 40; i++) {
  projectiles.spawn(0, 2, 0, Math.cos(i), 0.4, Math.sin(i), 16, 0);
}
bench('projectiles.update (40 live)', 5000, () => {
  projectiles.update(DT, targets);
}, 1, 'every tick');

// ── Whole mode tick ──────────────────────────────────────────────────────────
const camera = new CameraRig(world, 1.6);
const ctx: ModeContext = {
  world, build, player, camera, projectiles,
  actors: new ActorRoster({ id: LOCAL_ACTOR_ID, kind: 'local', team: 'left', controller: player }),
  rng: new Rng('bench-round'),
  emit: () => {},
  worldChanged: () => {},
};
const mode = new FortDefenseMode();
mode.start(ctx);
// Skip to a live wave.
for (let i = 0; i < 60 * 80; i++) {
  mode.fixedUpdate(DT, ctx, sameForEveryone());
  if (mode.phase === 'wave' && mode.bots.length > 0) break;
}

bench('fortDefense.fixedUpdate', 3000, () => {
  mode.fixedUpdate(DT, ctx, sameForEveryone());
}, 1, `whole mode, ${mode.bots.length} bots`);

// ── Report ───────────────────────────────────────────────────────────────────
console.log('per-op cost, and the share of a 16.67ms tick it would take:\n');
const pad = (s: string, n: number) => s.padEnd(n);
console.log(pad('operation', 34) + pad('ms/op', 12) + pad('per tick', 10) + pad('% of tick', 11) + 'note');
console.log('-'.repeat(110));

let totalPerTick = 0;
for (const r of results) {
  const perTick = r.msPerOp * r.opsPerTick;
  totalPerTick += perTick;
  const pct = (perTick / TICK_BUDGET_MS) * 100;
  console.log(
    pad(r.name, 34) +
    pad(r.msPerOp.toFixed(4), 12) +
    pad(String(r.opsPerTick), 10) +
    pad(pct.toFixed(2) + '%', 11) +
    (r.note ?? ''),
  );
}

console.log('-'.repeat(110));
// Not a sum of a real frame — the mode tick already contains the bot and
// projectile work — but it bounds the parts that are independent.
console.log(`\nheaviest single line: ${((Math.max(...results.map(r => r.msPerOp * r.opsPerTick)) / TICK_BUDGET_MS) * 100).toFixed(1)}% of a tick`);
console.log(`(rows overlap: the mode tick includes bots and projectiles, so ${totalPerTick.toFixed(2)}ms is an over-count)`);
