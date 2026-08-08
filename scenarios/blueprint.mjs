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

  // ── The picker screen ───────────────────────────────────────────────────────
  //
  // `BlueprintStore` has had `save(name, parts, id)` and `remove(id)` since it
  // was written and nothing ever called either with intent: renaming and
  // deleting existed in the model and in no interface, and picking one meant
  // tapping a key until the right name went past.
  //
  // Driven through the menu's own callbacks and read back off the rendered DOM,
  // because those are the two halves that can disagree — and when they do it is
  // the screen that is wrong.
  const picker = await page.evaluate(async () => {
    const m = window.__maker;
    m.menu.show('blueprints');
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const mine = m.blueprintScreen.list().find((b) => !b.builtIn);
    const builtIn = m.blueprintScreen.list().find((b) => b.builtIn);
    return { mine, builtIn, rows: m.blueprintScreen.rows() };
  });

  assert(picker.mine !== undefined, 'the flood-fill save above should be in the list');
  assert(picker.builtIn !== undefined, 'and the built-ins should be too');
  assert(
    picker.rows.length >= 3,
    `the screen should draw a row each plus "hold nothing", saw ${picker.rows.length}`,
  );
  assert(
    picker.rows.some((r) => r.text.includes(`${picker.mine.parts} parts`)),
    `a row should price what it would cost: ${JSON.stringify(picker.rows.map((r) => r.text))}`,
  );

  // A built-in ships with the game and cannot be renamed or thrown away, so the
  // two buttons that would fail are not offered rather than offered and refused.
  const builtInRow = picker.rows.find((r) => r.text.startsWith(picker.builtIn.name));
  assert(builtInRow !== undefined, 'the built-in should have a row');
  assert(
    !builtInRow.buttons.includes('Delete') && !builtInRow.buttons.includes('Rename'),
    `a built-in should offer neither: ${JSON.stringify(builtInRow.buttons)}`,
  );

  const worked = await page.evaluate(async () => {
    const m = window.__maker;
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    const mine = m.blueprintScreen.list().find((b) => !b.builtIn);

    const pressed = m.blueprintScreen.hold(mine.id);
    await frame();
    const holding = m.blueprintScreen.list().find((b) => b.id === mine.id).held;
    // The row for *that* blueprint, not any lit row: a screen that marked all
    // of them would be as wrong as one that marked none.
    const marked = m.blueprintScreen.rows().filter((r) => r.held);
    const markedInDom = marked.length === 1 && marked[0].id === mine.id;

    const renamed = m.blueprintScreen.rename(mine.id, 'A better name');
    await frame();
    const after = m.blueprintScreen.list().find((b) => b.id === mine.id);

    // Still held after a rename: the id is stable across one, which is the
    // whole reason `save` takes an id rather than making a second blueprint.
    const stillHeld = after.held;

    const putBack = m.blueprintScreen.hold(null);
    await frame();
    const putAway = m.blueprintScreen.list().every((b) => !b.held)
      && m.blueprintScreen.rows().every((r) => !r.held);

    m.blueprintScreen.hold(mine.id);
    await frame();
    const gone = m.blueprintScreen.remove(mine.id);
    await frame();
    const left = m.blueprintScreen.list().some((b) => b.id === mine.id);
    // Nobody can hold a blueprint that no longer exists, or the preview goes on
    // showing a shape that cannot be stamped.
    //
    // Asked of the hand rather than of the list, because a deleted blueprint
    // has no row for `held` to be false on: the first version of this check
    // walked the list, which cannot be anything but true once the entry is
    // gone, and it passed with the clearing deleted.
    const nothingHeld = m.blueprints.held() === null;

    const stillDrawn = m.blueprintScreen.rows().some((r) => r.id === mine.id);

    return {
      pressed, holding, markedInDom, renamed, name: after.name, stillHeld, putBack,
      putAway, gone, left, nothingHeld, stillDrawn,
    };
  });

  assert(worked.pressed, 'the screen should offer a Hold button to press');
  assert(worked.holding, 'holding one from the screen should hold it');
  assert(worked.markedInDom, 'and the row should say so, not just the model');
  assert(worked.renamed && worked.name === 'A better name', `renaming failed: ${worked.name}`);
  assert(worked.stillHeld, 'a rename keeps the id, so it should still be the one in hand');
  assert(worked.putBack, 'and a "Put away" row while something is held');
  assert(worked.putAway, 'putting it away should leave nothing held');
  assert(worked.gone && !worked.left, 'deleting should remove it from the list');
  assert(!worked.stillDrawn, 'and take its row off the screen');
  assert(worked.nothingHeld, 'and nobody should be left holding what was deleted');

  await page.evaluate(() => window.__maker.hideOverlay());
  await frames(page, 4);

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
    + ' the connected group, four quarter turns land exactly where they started, and'
    + ' a picker screen holds, renames and deletes them — refusing to offer either on a'
    + ' built-in, and leaving nobody holding what it just threw away');
}
