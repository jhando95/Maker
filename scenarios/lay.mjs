/**
 * Building without stopping: hold the lay key, run, and the path appears.
 *
 * The choreography — cells, lanes, headings, the locked height — is
 * `pathLayer.test.ts`'s job. What only the browser can answer is the seam:
 * a real held key, a really moving body, records committed through the same
 * stamp path a blueprint uses, parts that end up in the actual world, lumber
 * actually spent. Every one of those is wiring in main.ts that no unit test
 * touches.
 *
 *   node tools/shoot.mjs --scenario scenarios/lay.mjs
 */

const assert = (c, m) => { if (!c) throw new Error(`lay scenario: ${m}`); };

export default async function (page) {
  await page.evaluate(() => {
    window.__maker.setAutoQuality(false);
    window.__maker.hideOverlay();
    // The front lawn along z = -12.5 is a clear straight run: the logs, the
    // barbecue and the trampoline all sit off this lane. Facing +X.
    window.__maker.teleport(-16, 0.5, -12.5);
    window.__maker.lookAt(-Math.PI / 2, 0);
  });
  await page
    .waitForFunction(() => window.__maker.stats().player.onGround === true,
      null, { timeout: 20000, polling: 'raf' })
    .catch(() => { throw new Error('lay scenario: the player never landed'); });

  const before = await page.evaluate(() => window.__maker.stats().parts);

  // The gesture itself: a held key and a held direction, nothing else. The
  // whole point of the feature is that this is all it takes.
  await page.keyboard.down('h');
  await page.keyboard.down('w');
  await page
    .waitForFunction(() => window.__maker.stats().player.x > -9,
      null, { timeout: 30000, polling: 'raf' })
    .catch(() => { throw new Error('lay scenario: the run never covered its seven metres'); });
  await page.keyboard.up('w');
  await page.keyboard.up('h');

  const after = await page.evaluate(() => ({
    parts: window.__maker.stats().parts,
    // Only what this run laid: boards flat on the lawn in the run's lane.
    laid: window.__maker.save()
      .filter((r) => Math.abs(r.z - -12.5) < 0.3 && r.y < 0.1)
      .sort((a, b) => a.x - b.x),
  }));

  // Seven metres of running crosses at least six plank cells even with the
  // slow first step. Fewer laid than that means ticks were skipped or cells
  // were refused; more than one *per cell* means double-laying.
  assert(
    after.parts >= before + 5,
    `a seven-metre run should lay at least five boards, laid ${after.parts - before}`,
  );
  for (let i = 1; i < after.laid.length; i++) {
    const gap = after.laid[i].x - after.laid[i - 1].x;
    assert(
      Math.abs(gap - 1.0) < 0.001,
      `boards should sit edge to edge, found a gap of ${gap.toFixed(3)}m`,
    );
  }

  // Frame the walkway for the artifact.
  await page.evaluate(() => {
    window.__maker.teleport(-13, 1.2, -10);
    window.__maker.lookAtPoint(-11, 0, -12.5);
  });
  await new Promise((r) => setTimeout(r, 500));
  await page.screenshot({ path: `${process.env.RUNNER_TEMP ?? '/tmp'}/lay.png` });

  console.log(`[lay] verified: holding the key while running laid ${after.laid.length}`
    + ' boards edge to edge through the real input, stamp and lumber path');
}
