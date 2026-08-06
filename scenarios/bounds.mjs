/**
 * The edge of the world, in the real game.
 *
 * This scenario exists because the holes it checks were found by driving the
 * real player around and nothing else would have found them. Every one of the
 * three was invisible to the unit suite, and two of them were invisible to a
 * screenshot as well — you have to walk.
 *
 * What was true before this:
 *
 * - Sprinting outward for eight seconds left the detailed lawn behind and kept
 *   going. `CollisionWorld.groundY` is a height with no edges, so a body at
 *   x = 5000 stands on solid ground.
 * - The picket fence is drawn by `scene.ts` as batched props, which are never
 *   collided with. The one thing in the world that looks like a boundary let
 *   anybody walk straight through it.
 * - A body below the ground plane settled wedged at −1.19m, reported itself
 *   grounded, and could not move in any direction. A soft-lock, not an exploit.
 */
const assert = (c, m) => { if (!c) throw new Error(`bounds scenario: ${m}`); };

/** Has to match `PLAY_HALF`, and the first check proves it does. */
const HALF = 58;

export default async function (page) {
  await page.evaluate(() => {
    window.__maker.setAutoQuality(false);
    window.__maker.hideOverlay();
  });

  const half = await page.evaluate(() => window.__maker.playHalf());
  assert(half === HALF, `this scenario is written against ${HALF}m, the game says ${half}`);

  // ── You cannot walk out ─────────────────────────────────────────────────────

  // Twenty seconds of sprinting at each wall, from ten metres inside it. Long
  // enough to cross forty metres of open ground, so anything short of a real
  // barrier ends up well past the line.
  const walls = await page.evaluate((h) => {
    const out = [];
    const runs = [
      ['east', h - 10, 0, { right: 1 }],
      ['west', -(h - 10), 0, { right: -1 }],
      ['north', 0, h - 10, { forward: 1 }],
      ['south', 0, -(h - 10), { forward: -1 }],
      ['north-east corner', h - 10, h - 10, { right: 1, forward: 1 }],
    ];
    for (const [name, x, z, intent] of runs) {
      window.__maker.teleport(x, 0.6, z);
      const r = window.__maker.driveIntent(20, { ...intent, sprint: true });
      out.push({ name, x: r.x, z: r.z });
    }
    return out;
  }, HALF);

  for (const run of walls) {
    assert(
      Math.abs(run.x) <= HALF && Math.abs(run.z) <= HALF,
      `sprinting ${run.name} left the world, ending at (${run.x.toFixed(1)}, ${run.z.toFixed(1)})`,
    );
  }
  // And the runs over open ground actually got there, so this is a wall
  // stopping a sprint rather than five sprints that never reached the edge.
  // Measured, those four stop at 57.6m — the wall at 58 less a capsule radius.
  //
  // The south run is the exception and is left out on purpose: it runs into the
  // cul-de-sac, and the neighbours' front doors stop it at 47.4m. That is the
  // map doing the job before the boundary has to, which is the right order —
  // a player who never reaches an invisible wall never learns there is one.
  const open = walls.filter((w) => w.name !== 'south');
  for (const run of open) {
    const reached = Math.max(Math.abs(run.x), Math.abs(run.z));
    assert(reached > HALF - 3, `the ${run.name} run only reached ${reached.toFixed(1)}m`);
  }
  const south = walls.find((w) => w.name === 'south');
  assert(
    south.z < -40,
    `the south run should reach the far side of the street, it got to z=${south.z.toFixed(1)}`,
  );

  // ── You cannot be put out ───────────────────────────────────────────────────

  // The layer a wall cannot provide. Teleported past it, which is exactly what
  // a bad spawn or a launcher nobody thought about looks like from here.
  const put = await page.evaluate(() => {
    window.__maker.teleport(4000, 0.6, -4000);
    const r = window.__maker.driveIntent(0.5, {});
    return { x: r.x, z: r.z };
  });
  assert(
    Math.abs(put.x) <= HALF && Math.abs(put.z) <= HALF,
    `a body put outside stayed there, at (${put.x.toFixed(1)}, ${put.z.toFixed(1)})`,
  );

  // ── You cannot get under it ─────────────────────────────────────────────────

  // The soft-lock. Before the floor existed this ended at −1.19m, grounded,
  // wedged inside the house's collision box and unable to move — quitting was
  // the only way out.
  const under = await page.evaluate(() => {
    window.__maker.teleport(0, -40, 0);
    const settled = window.__maker.driveIntent(0.5, {});
    // And then prove it can move, which is the half that "y is sensible" misses.
    const before = { x: settled.x, z: settled.z };
    const walked = window.__maker.driveIntent(1.5, { forward: 1, sprint: true });
    return {
      y: settled.y,
      moved: Math.hypot(walked.x - before.x, walked.z - before.z),
    };
  });
  assert(under.y > -1, `a body dropped under the world stayed at ${under.y.toFixed(2)}m`);
  assert(under.moved > 1, `and could not walk away from where it landed (${under.moved.toFixed(2)}m)`);

  // ── You cannot build out there ──────────────────────────────────────────────

  // Through `applyPlaceIfClear`, which is the apply side — the same call the
  // host makes when a guest asks it to place something. The client's own reach
  // limit lives in the snapper and constrains an honest player and nobody else.
  const built = await page.evaluate((h) => {
    const far = window.__maker.build.applyPlaceIfClear({
      kind: 0, colorway: 0, x: 400, y: 0.125, z: 400, qx: 0, qy: 0, qz: 0, qw: 1,
    });
    const edge = window.__maker.build.applyPlaceIfClear({
      kind: 0, colorway: 0, x: h + 3, y: 0.125, z: 0, qx: 0, qy: 0, qz: 0, qw: 1,
    });
    const sky = window.__maker.build.applyPlaceIfClear({
      kind: 0, colorway: 0, x: 6, y: 500, z: 12, qx: 0, qy: 0, qz: 0, qw: 1,
    });
    const ok = window.__maker.build.applyPlaceIfClear({
      kind: 0, colorway: 0, x: 6, y: 0.125, z: 12, qx: 0, qy: 0, qz: 0, qw: 1,
    });
    return { far, edge, sky, ok };
  }, HALF);
  assert(!built.far, 'a plank four hundred metres away was accepted');
  assert(!built.edge, 'a plank just past the boundary was accepted');
  assert(!built.sky, 'a plank five hundred metres up was accepted');
  assert(built.ok, 'and an ordinary plank on the lawn was refused, which is worse');

  // ── A frame worth looking at ────────────────────────────────────────────────

  // Pressed against the north wall, looking back at the neighbourhood. The
  // point of the picture is that there is nothing to see out here and the
  // player is still standing on real lawn rather than on the seam.
  await page.evaluate((h) => {
    window.__maker.teleport(0, 0.6, h - 12);
    window.__maker.lookAt(0, -0.04);
  }, HALF);
  await page.screenshot({ path: `${process.env.RUNNER_TEMP ?? '/tmp'}/bounds.png` });

  const far = walls.map((w) => Math.max(Math.abs(w.x), Math.abs(w.z)).toFixed(1)).join(', ');
  console.log(`[bounds] verified: five sprints reach ${far}m and none of them leave;`
    + ` a body put at 4000m is back inside; one dropped 40m under the world lands and walks;`
    + ` and the world refuses planks at 400m, past the edge and 500m up`);
}
