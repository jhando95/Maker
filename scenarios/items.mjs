/**
 * The garden's items, in the real game, through the real movement code.
 *
 * The unit tests drive `applyItems` against a body on a flat floor, which is
 * the right way to ask what the effect is and cannot answer either of the two
 * questions that decide whether an item exists for the player: is the prop
 * actually where the effect thinks it is, and does the launch reach the thing
 * it was sized against. Both are claims about the map, and both have been
 * wrong once — a mat left under the treehouse deck, and a speed picked against
 * a gravity the game does not use.
 */
const assert = (c, m) => { if (!c) throw new Error(`items scenario: ${m}`); };

/** Where the porch roof is, read off the world rather than copied out of it. */
const PORCH_ROOF = 2.73;

export default async function (page) {
  await page.evaluate(() => {
    window.__maker.setAutoQuality(false);
    window.__maker.hideOverlay();
  });

  // ── The trampoline off the end of the porch ────────────────────────────────

  // Stand on the mat. Dropped onto it rather than placed at its height, so the
  // landing goes through the same contact the effect keys on.
  const bounce = await page.evaluate(() => {
    window.__maker.teleport(-6.6, 1.4, -8);
    window.__maker.lookAt(0, 0);
    return window.__maker.driveIntent(1.6, {});
  });
  assert(bounce.bounced, 'standing on the trampoline should launch the player');
  assert(
    bounce.peakY > PORCH_ROOF + 0.3,
    `the bounce should clear the porch roof, peaked at ${bounce.peakY.toFixed(2)}m`,
  );

  // Off the mat, the same intent does nothing at all. Without this the check
  // above passes just as well for a bounce that fires everywhere.
  const beside = await page.evaluate(() => {
    window.__maker.teleport(-10.5, 0.6, -8);
    return window.__maker.driveIntent(1.2, {});
  });
  assert(!beside.bounced, 'the lawn beside the trampoline should not launch anybody');
  assert(
    beside.peakY < 1.0,
    `standing on grass should stay on grass, peaked at ${beside.peakY.toFixed(2)}m`,
  );

  // The bounce is a route: run on, launch, drift, end up on the roof. This is
  // the whole point of the item and the only part a player would notice.
  //
  // Run on rather than dropped on, because the drift is the hard part. A pad
  // launches the moment a body enters its footprint, so a standing bounce goes
  // almost straight up and air acceleration alone will not carry it the two
  // metres to the roof inside the half-second it spends above roof height.
  // Arriving with walking speed already spent is how a player would do it.
  //
  // The drive stops at 1.7s for a reason worth keeping: a sprint held a second
  // longer crosses the whole roof and falls off the far side, which is exactly
  // what the first version of this measured. Landing on a roof and running off
  // it are not the same event and the final height cannot tell them apart.
  const onto = await page.evaluate(() => {
    window.__maker.teleport(-9.8, 0.6, -8);
    // `driveIntent` speaks the controller's own axes, which are the world's:
    // `right` is +X, and the porch is +X of the pad.
    return window.__maker.driveIntent(1.7, { right: 1, sprint: true });
  });
  assert(
    onto.y > PORCH_ROOF - 0.2,
    `the bounce should end on the porch roof, ended at ${onto.y.toFixed(2)}m`,
  );
  assert(onto.onGround, 'and standing on it, rather than still in the air');

  // ── The slide down the right-hand lane ─────────────────────────────────────

  // Dropped on at the spawn end and left alone. No intent at all, which is the
  // strong version of the claim and the one the map broke: the controller
  // brakes hard on a body that is not pushing, and the first implementation
  // lost that argument so completely that the slide moved a player slower than
  // walking. Six metres in eight tenths of a second is the slide winning it.
  const slid = await page.evaluate(() => {
    window.__maker.teleport(16.5, 0.5, -9);
    window.__maker.lookAt(0, 0);
    const from = window.__maker.player.z;
    const out = window.__maker.driveIntent(0.8, {});
    return { from, ...out };
  });
  assert(
    slid.z - slid.from > 6,
    `the slide should carry a still player up the lane, moved ${(slid.z - slid.from).toFixed(2)}m`,
  );
  assert(
    Math.abs(slid.x - 16.5) < 1.5,
    `and along its own length rather than sideways, drifted to x=${slid.x.toFixed(2)}`,
  );

  // Park where a person can see whether any of this looks like what it is:
  // back on the lawn, with the trampoline in the middle distance and the porch
  // roof it launches onto behind it. Every check above is a number, and a
  // number cannot say that a mat is buried in the grass or that a frame has
  // its legs on backwards.
  await page.evaluate(() => {
    window.__maker.teleport(-12, 0.5, -4);
    window.__maker.lookAt(-0.93, -0.06);
  });
  await page.screenshot({ path: `${process.env.RUNNER_TEMP ?? '/tmp'}/items.png` });

  console.log(`[items] verified: the trampoline peaks at ${bounce.peakY.toFixed(2)}m`
    + ` and lands a player on the porch roof at ${onto.y.toFixed(2)}m;`
    + ` the lawn beside it does nothing; the slide carries a still body`
    + ` ${(slid.z - slid.from).toFixed(2)}m up the lane`);
}
