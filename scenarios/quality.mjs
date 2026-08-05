/**
 * Proves adaptive quality reacts to a machine that cannot keep up.
 *
 * The decision logic is unit-tested against a model of a machine. What that
 * cannot show is whether the decision reaches the renderer: whether the drawing
 * buffer actually shrinks, and whether the game keeps drawing correctly at a
 * scale it was not started at.
 *
 * This container is the test case. There is no GPU, the software rasterizer
 * misses the frame budget permanently, and the governor should walk the
 * resolution down to its floor and stop there — which is exactly what it is for.
 *
 *   node tools/shoot.mjs --scenario scenarios/quality.mjs --auto-quality
 */

const assert = (cond, message) => {
  if (!cond) throw new Error(`quality scenario: ${message}`);
};

const scale = (page) => page.evaluate(() => window.__maker.renderScale());
const bufferWidth = (page) =>
  page.evaluate(() => document.querySelector('canvas')?.width ?? 0);

export default async function (page) {
  await page.evaluate(() => window.__maker.hideOverlay());
  await page.evaluate(() => window.__maker.setAutoQuality(false));
  await page.waitForTimeout(400);

  const full = await scale(page);
  const fullWidth = await bufferWidth(page);
  assert(full.effective === 1, `should start at the player's setting, got ${full.effective}`);
  assert(!full.throttled, 'nothing should be throttled yet');
  assert(fullWidth > 0, 'the canvas should have a backing store');

  // ── Let it react to this machine ───────────────────────────────────────────
  await page.evaluate(() => window.__maker.setAutoQuality(true));
  await page.waitForTimeout(9000); // several one-second judgements, plus settle time

  const dropped = await scale(page);
  assert(
    dropped.effective < 1,
    `a machine missing every frame should lose resolution; still at ${dropped.effective}`,
  );
  assert(dropped.throttled, 'it should report that it is throttling');
  assert(dropped.effective >= 0.5, `must not fall through the floor; got ${dropped.effective}`);

  // The decision has to reach the renderer, not just the governor's own state.
  const droppedWidth = await bufferWidth(page);
  assert(
    droppedWidth < fullWidth,
    `the drawing buffer should shrink: ${fullWidth} -> ${droppedWidth}`,
  );
  assert(
    Math.abs(droppedWidth / fullWidth - dropped.effective) < 0.05,
    `buffer ${droppedWidth}/${fullWidth} should match scale ${dropped.effective}`,
  );

  // ── Turning it off hands control straight back ─────────────────────────────
  await page.evaluate(() => window.__maker.setAutoQuality(false));
  await page.waitForTimeout(500);
  const restored = await scale(page);
  assert(restored.effective === 1, `switching off should restore ${1}, got ${restored.effective}`);
  assert(!restored.throttled, 'nothing should report throttling once it is off');
  assert(
    Math.abs(await bufferWidth(page) - fullWidth) <= 1,
    'the drawing buffer should go back to full size',
  );

  console.log(
    `[quality] verified: 1.00 -> ${dropped.effective.toFixed(2)} under load, buffer followed, restored on disable`,
  );
}
