/**
 * Proves a can of paint actually paints, and that the paint knows what it is on.
 *
 * The rules are arithmetic and unit-tested; the decals are matrices and tested
 * against three.js. What only exists in a browser is the join between them and
 * the real world: a raycast has to come back with a **surface normal** that a
 * mark can lie in, and the mark has to disappear when the plank it is on does.
 * Neither is checkable anywhere else, and the second one is the whole reason
 * tags record a part id.
 *
 *   node tools/shoot.mjs --scenario scenarios/spray.mjs --out shots/spray.png
 */

const assert = (cond, message) => {
  if (!cond) throw new Error(`spray scenario: ${message}`);
};

const frames = (page, count) => page.evaluate((n) => new Promise((resolve) => {
  let seen = 0;
  const step = () => { if (++seen >= n) resolve(); else requestAnimationFrame(step); };
  requestAnimationFrame(step);
}), count);

/** Clear lawn, well away from the house and everything in the garden. */
const AT = { x: 6.5, z: 13.5 };

export default async function (page) {
  // Into the world: the title menu pauses the loop, and a paused loop cannot
  // be asked what the crosshair is on.
  await page.evaluate(() => {
    window.__maker.hideOverlay();
    window.__maker.setHudVisible(false);
  });

  // ── The can is a ninth thing to hold ───────────────────────────────────────
  const out = await page.evaluate(() => window.__maker.spray.take(true));
  assert(out === true, 'the can should come out when it is asked for');

  // ── A mark on the lawn lies flat on it ─────────────────────────────────────
  await page.evaluate((a) => window.__maker.teleport(a.x, 0.6, a.z + 1.2), AT);
  await page.waitForFunction(() => window.__maker.stats().player.onGround === true,
    null, { timeout: 8000 });
  await frames(page, 2);

  const onGrass = await page.evaluate((a) => {
    window.__maker.spray.style(2, 3);
    return window.__maker.spray.at(a.x, 0, a.z);
  }, AT);
  assert(onGrass, 'spraying at the lawn in front of you should leave a mark');

  let tags = await page.evaluate(() => window.__maker.spray.tags());
  assert(tags.length === 1, `one mark, and there are ${tags.length}`);
  // The claim that can only be made here: the normal came off the world rather
  // than off the camera. A mark on the ground points straight up whoever
  // sprayed it and from wherever they were standing.
  assert(
    tags[0].ny > 0.9,
    `a mark on the lawn should lie flat on it, and its normal is`
    + ` (${tags[0].nx}, ${tags[0].ny}, ${tags[0].nz})`,
  );
  assert(
    tags[0].part === -1,
    'and it is on the map, which nothing can take away',
  );
  assert(
    (await page.evaluate(() => window.__maker.spray.drawn())) === 1,
    'and it should be drawn',
  );

  // ── A mark on a plank is on that plank ─────────────────────────────────────
  // Beside the spot the lawn mark went, which the collapse scenario has already
  // established is clear ground — four metres out turned out to have something
  // of the map in it, and a refused stamp is a scenario that proves nothing.
  const HANG = { x: AT.x + 1.6, y: 1.0, z: AT.z };
  // Stood on its edge — a quarter turn about X — so it is a wall rather than a
  // floor tile. A panel is a 5cm slab and lies flat under an identity rotation,
  // which is how the first version of this check ended up spraying its top face
  // and asserting that a mark on a wall pointed straight up.
  const built = await page.evaluate((h) => window.__maker.blueprints.stampThese([
    {
      kind: 5, colorway: 0, x: h.x, y: h.y, z: h.z,
      qx: Math.SQRT1_2, qy: 0, qz: 0, qw: Math.SQRT1_2,
    },
  ]), HANG);
  assert(built, `a panel should go down to spray on at ${HANG.x}, ${HANG.y}, ${HANG.z}`);

  await page.evaluate((h) => window.__maker.teleport(h.x, 0.6, h.z + 1.4), HANG);
  await page.waitForFunction(() => window.__maker.stats().player.onGround === true,
    null, { timeout: 8000 });
  await frames(page, 2);
  const onPanel = await page.evaluate((h) => window.__maker.spray.at(h.x, h.y, h.z), HANG);
  assert(onPanel, 'spraying at a panel you are standing next to should work');

  tags = await page.evaluate(() => window.__maker.spray.tags());
  assert(tags.length === 2, `two marks now, and there are ${tags.length}`);
  const onPart = tags.find((t) => t.part >= 0);
  assert(onPart !== undefined, 'the second should know which part it is on');
  assert(
    Math.abs(onPart.ny) < 0.5,
    `and a mark on an upright panel should not be lying flat: ny ${onPart.ny}`,
  );

  // ── And it goes when the plank goes ────────────────────────────────────────
  //
  // The reason a tag records a part at all. Parts vanish in groups now — take a
  // leg out and a tower goes — and a mark left behind by the one it was
  // sprayed on hangs in mid-air, which reads as a rendering bug and is a
  // bookkeeping one.
  const down = await page.evaluate((h) => window.__maker.blueprints.demolishNear(h.x, h.y, h.z), HANG);
  assert(down.length === 1, `the panel should come down, ${down.length} did`);
  await frames(page, 2);

  tags = await page.evaluate(() => window.__maker.spray.tags());
  assert(
    tags.length === 1 && tags[0].part === -1,
    `the mark on it should have gone with it, leaving ${tags.length}`,
  );
  assert(
    (await page.evaluate(() => window.__maker.spray.drawn())) === 1,
    'and the renderer should agree, rather than still drawing a mark on nothing',
  );

  // ── Switched off, the can is not in anybody's hand ─────────────────────────
  await page.evaluate(() => window.__maker.settings.set('sprayCan', false));
  const denied = await page.evaluate(() => window.__maker.spray.take(true));
  assert(denied === false, 'a lobby that has turned the can off should not hand one out');
  await page.evaluate(() => window.__maker.settings.set('sprayCan', true));

  console.log(`[spray] verified: a mark on the lawn lies flat on it with a normal off the`
    + ` world rather than off the camera, a mark on a panel knows which part it is on and`
    + ` stands upright with it, that mark goes when the panel does — in the list and in the`
    + ` renderer — and the Settings toggle really does put the can away`);
}
