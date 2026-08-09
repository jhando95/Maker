/**
 * The Forge's fly camera: J toggles flight in Free Build, W flies where you
 * look, landing drops you back into gravity. Real keys through the real input
 * path, because the toggle, the intent, and the round guard are all wiring.
 */
const assert = (c, m) => { if (!c) throw new Error(`fly scenario: ${m}`); };

export default async function (page) {
  await page.evaluate(() => {
    window.__maker.setAutoQuality(false);
    window.__maker.hideOverlay();
    window.__maker.teleport(0, 0.5, 30);
    window.__maker.lookAt(0, 0.35);
  });
  await page.waitForFunction(() => window.__maker.stats().player.onGround === true,
    null, { timeout: 20000, polling: 'raf' });

  const before = await page.evaluate(() => window.__maker.stats().player);

  // Toggle flight and fly along the look for a second and a half.
  await page.keyboard.press('j');
  await page.keyboard.down('w');
  await new Promise((r) => setTimeout(r, 1500));
  await page.keyboard.up('w');

  const airborne = await page.evaluate(() => window.__maker.stats().player);
  assert(!airborne.onGround, 'flying should leave the ground');
  assert(airborne.y > before.y + 0.5, `looking up and holding W should climb, y ${airborne.y.toFixed(2)}`);

  // Land: gravity resumes and the body comes down.
  await page.keyboard.press('j');
  await page.waitForFunction(() => window.__maker.stats().player.onGround === true,
    null, { timeout: 20000, polling: 'raf' })
    .catch(() => { throw new Error('fly scenario: landing never reached the ground'); });

  console.log(`[fly] verified: J lifts, W flies along the look (rose ${(airborne.y - before.y).toFixed(2)}m), J lands and gravity resumes`);
}
