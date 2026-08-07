/**
 * Saving something you built, and putting it down again.
 *
 * The arithmetic — anchoring, rotation, cost, the flood fill — is all in
 * `blueprint.test.ts` and belongs there. What only a browser can answer is
 * whether the pieces are joined up: that the flood fill runs against the *real*
 * collision world rather than a list of boxes a test wrote, that a stamp goes
 * through the same placement path a single plank does, and that the preview a
 * player judges by is drawn from the same records that get placed.
 *
 * Every one of those is a seam, and every seam here can be wrong while both
 * sides of it are right.
 *
 *   node tools/shoot.mjs --scenario scenarios/blueprint.mjs --out shots/blueprint.png
 */

const assert = (cond, message) => {
  if (!cond) throw new Error(`blueprint scenario: ${message}`);
};

const frames = (page, n) => page.evaluate((count) => new Promise((resolve) => {
  let seen = 0;
  const step = () => { if (++seen >= count) resolve(); else requestAnimationFrame(step); };
  requestAnimationFrame(step);
}), n);

const parts = (page) => page.evaluate(() => window.__maker.stats().parts);

export default async function (page) {
  await page.evaluate(() => {
    window.__maker.setAutoQuality(false);
    window.__maker.hideOverlay();
    // Out on the cul-de-sac, aiming steeply down. Both halves of that were
    // arrived at by measuring rather than by picking somewhere that sounded
    // empty: in the back garden the top two treads of an eight-step staircase
    // land inside the tree, and a shallow aim floats the whole thing a metre up
    // where the eaves are. `blueprints.blockers()` exists because a refused
    // stamp is all-or-nothing and therefore says nothing about which part was
    // in the way — it said, immediately, and both times.
    window.__maker.teleport(0, 0.6, 40);
    window.__maker.lookAt(0, -0.9);
  });
  // Wait to be *standing*, not for four frames. The teleport puts the player
  // 0.6m up and they fall from there, and every anchor here is a ray from that
  // eye — so an aim taken mid-fall is an aim from a height nobody chose.
  await page.waitForFunction(
    () => window.__maker.stats().player.onGround === true,
    undefined, { timeout: 20000, polling: 'raf' },
  ).catch(() => { throw new Error('blueprint scenario: the player never landed'); });
  await frames(page, 2);

  // ── The ones that ship with the game ───────────────────────────────────────
  const shipped = await page.evaluate(() => window.__maker.blueprints.list());
  assert(shipped.length >= 3, `there should be blueprints to start with, saw ${shipped.length}`);
  assert(
    shipped.every((b) => b.builtIn),
    'nothing should be saved before the player has saved anything',
  );
  assert(
    shipped.every((b) => b.parts > 0 && b.cost > 0),
    `a blueprint with no parts or no price is not one: ${JSON.stringify(shipped)}`,
  );

  const stairs = shipped.find((b) => b.id === 'built:stairs');
  assert(stairs !== undefined, 'the stairs should ship with the game');

  // ── Stamping one ───────────────────────────────────────────────────────────
  //
  // Through the debug surface rather than by clicking, because what is being
  // checked is the placement path and not the mouse. The preview is asserted
  // first: a stamp that places parts the player never saw a preview of is a
  // stamp they did not choose.
  const before = await parts(page);
  const preview = await page.evaluate((id) => {
    window.__maker.blueprints.select(id);
    return {
      drawn: window.__maker.blueprints.preview(),
      records: window.__maker.blueprints.records()?.length ?? 0,
    };
  }, stairs.id);
  assert(
    preview.records === stairs.parts,
    `the preview should describe every part, ${preview.records} of ${stairs.parts}`,
  );
  assert(
    preview.drawn === stairs.parts,
    `and draw every one of them, ${preview.drawn} meshes for ${stairs.parts} parts`,
  );

  // Kept, because the second attempt below is made of exactly these.
  const placedAt = await page.evaluate(() => window.__maker.blueprints.records());
  assert(
    Array.isArray(placedAt) && placedAt.length === stairs.parts,
    `the records to be placed should be the whole blueprint, saw ${placedAt?.length}`,
  );
  const stamped = await page.evaluate(() => window.__maker.blueprints.stamp());
  assert(stamped, 'stamping on open lawn should work');
  const after = await parts(page);
  assert(
    after === before + stairs.parts,
    `a stamp should add the whole thing at once: ${before} -> ${after}, expected`
    + ` ${before + stairs.parts}`,
  );

  // ── All of it, or none of it ───────────────────────────────────────────────
  //
  // Stamping a blueprint into the space it already occupies has to be refused
  // outright, and — the part that matters — must not place the parts that
  // happen to fit. Half a staircase, charged for in full, is the failure this
  // rule exists for.
  //
  // The **same records**, not a second aim, and that is the whole point. This
  // used to call `stamp()` twice and hope the second aim still collided with
  // the first, which is not a thing the scenario controlled: the moment the
  // staircase exists the ray lands on *it*, so the second attempt snaps a metre
  // up onto a tread and is a different placement in a different place. Measured,
  // the anchor moves from y 0.15 to y 1.125 the instant a single frame runs
  // between the two calls, and the count of parts in the way falls from thirty
  // to twelve — still refused, but by a margin that was never the claim and that
  // a slower runner eventually spent. CI turned red on exactly that.
  //
  // Handing back the records the first stamp used removes the aiming from a
  // question that was never about aiming. The aimed path is already proven —
  // the first stamp is the one that used it.
  const blockedFrom = await parts(page);
  const again = await page.evaluate((rs) => window.__maker.blueprints.stampThese(rs), placedAt);
  assert(!again, 'stamping into the space it already occupies should be refused');
  assert(
    (await parts(page)) === blockedFrom,
    'and must not leave the parts that happened to fit behind',
  );

  // ── Saving what you just built ─────────────────────────────────────────────
  //
  // The flood fill against the real world. Aim at the staircase that is now
  // standing there and save it; what comes back has to be the staircase, not
  // one plank and not the lawn.
  const looked = await page.evaluate(() => {
    // A step past the top of it, looking back down the run. The angle was
    // swept rather than reasoned about, and it is narrow for a reason worth
    // knowing: the treads rise away from the player while the aim ray falls, so
    // the two diverge and every "obviously looking at it" angle passes cleanly
    // underneath the whole staircase. `blueprints.aimed()` reports which part
    // is under the crosshair, which turned twenty minutes of guessing into one
    // sweep.
    window.__maker.teleport(0, 0.6, 41.5);
    window.__maker.lookAt(0, -0.3);
    return true;
  });
  assert(looked, 'the player should be able to stand back and look at it');
  await frames(page, 6);

  const captured = await page.evaluate(() => {
    const ok = window.__maker.blueprints.capture();
    const list = window.__maker.blueprints.list();
    return { ok, saved: window.__maker.blueprints.saved(), list };
  });
  assert(captured.ok, 'looking at your own staircase and saving it should work');
  assert(captured.saved === 1, `it should be kept, saw ${captured.saved} saved`);

  const mine = captured.list.find((b) => !b.builtIn);
  assert(mine !== undefined, 'and appear in the list');
  assert(
    mine.parts > 1,
    `the flood fill should take the whole connected group, not one part;`
    + ` saw ${mine.parts}`,
  );
  assert(
    mine.parts <= stairs.parts,
    `and nothing that is not joined to it — saw ${mine.parts} against a`
    + ` ${stairs.parts}-part staircase on an empty lawn`,
  );

  // ── Turning it ─────────────────────────────────────────────────────────────
  //
  // Four quarter turns have to come back to the same coordinates. Checked here
  // and not only in the unit test because the records the game stamps are the
  // ones that have been through selection, rotation and the aim point — three
  // places a rotation can be applied twice or not at all.
  await page.evaluate(() => {
    window.__maker.teleport(8, 0.6, 40);
    window.__maker.lookAt(0, -1.0);
  });
  await frames(page, 4);
  const spun = await page.evaluate((id) => {
    window.__maker.blueprints.select(id);
    const start = window.__maker.blueprints.records();
    window.__maker.blueprints.turn(1);
    const quarter = window.__maker.blueprints.records();
    window.__maker.blueprints.turn(3);
    const round = window.__maker.blueprints.records();
    return { start, quarter, round };
  }, stairs.id);
  assert(spun.start !== null && spun.round !== null, 'there should be records to turn');
  assert(
    JSON.stringify(spun.start) !== JSON.stringify(spun.quarter),
    'a quarter turn should move the parts',
  );
  assert(
    JSON.stringify(spun.start) === JSON.stringify(spun.round),
    'and four of them should land back on exactly the same coordinates',
  );

  // ── Putting the plank back in your hands ───────────────────────────────────
  const cleared = await page.evaluate(() => {
    window.__maker.blueprints.select(null);
    return { held: window.__maker.blueprints.held(), drawn: window.__maker.blueprints.preview() };
  });
  assert(cleared.held === null, 'selecting nothing should hold nothing');
  assert(cleared.drawn === 0, 'and take the preview off the lawn');

  // Frame the stamped staircase for the artifact.
  await page.evaluate(() => {
    window.__maker.teleport(4, 0.6, 41);
    window.__maker.lookAt(0.5, -0.2);
  });
  await frames(page, 6);
  await page.screenshot({ path: `${process.env.RUNNER_TEMP ?? '/tmp'}/blueprint.png` });

  console.log('[blueprint] verified: the built-ins are there and priced, a stamp draws every'
    + ' part it is about to place and places all of them at once, stamping into itself is'
    + ' refused without leaving a partial one behind, a flood fill off the real world saves'
    + ' the connected group, and four quarter turns land exactly where they started');
}
