/**
 * A pull-up, in the real game, over a wall the player built.
 *
 * The unit tests build a ledge out of two boxes in an empty world. This asks
 * the question that matters: does a mantle work against the actual fort a
 * player would make, on the actual map, through the real input path.
 */
const assert = (c, m) => { if (!c) throw new Error(`mantle scenario: ${m}`); };

export default async function (page) {
  const before = await page.evaluate(() => {
    window.__maker.setAutoQuality(false);
    window.__maker.hideOverlay();
    // Open lawn, facing a wall we are about to build.
    window.__maker.teleport(-6, 0.5, 8);
    window.__maker.lookAt(Math.PI, 0);
    // Three courses of planks on edge: 0.75m, over the step and under the chin.
    const w = [];
    for (let i = 0; i < 3; i++) {
      for (let k = -2; k <= 2; k++) {
        w.push(window.__maker.build.applyPlaceIfClear({
          kind: 0, colorway: 0,
          x: -6 + k * 1.0, y: 0.125 + i * 0.25, z: 5.5,
          qx: 0.5, qy: 0.5, qz: -0.5, qw: 0.5,
        }));
      }
    }
    window.__maker.worldChanged?.();
    return { placed: w.filter(Boolean).length, y: window.__maker.player.y };
  });
  assert(before.placed >= 9, `the wall should have gone up, placed ${before.placed}`);

  // Walk into it with no jump: a wall is a wall.
  const walked = await page.evaluate(() => window.__maker.driveIntent(1.2, { forward: -1 }));
  assert(walked.y < 0.4, `walking into a 0.75m wall should not climb it, reached ${walked.y}`);

  // Now ask for the pull-up.
  const over = await page.evaluate(
    () => window.__maker.driveIntent(1.6, { forward: -1, jump: true }));
  assert(over.mantled, 'holding jump against a shoulder-high wall should mantle it');
  assert(over.y > 0.7, `should have ended on top of the wall, at ${over.y.toFixed(2)}m`);

  await page.screenshot({ path: `${process.env.RUNNER_TEMP ?? '/tmp'}/mantle.png` });
  console.log(`[mantle] verified: a ${before.placed}-plank wall stops a walk and`
    + ` yields to a pull-up, ending at ${over.y.toFixed(2)}m`);
}
