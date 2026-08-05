/**
 * Proves the crash screen actually works, in a real browser.
 *
 * This is the one subsystem whose test cannot be a unit test in good faith:
 * its entire job is to survive a throw inside a requestAnimationFrame callback
 * and put something on screen, and neither of those exists outside a browser.
 * So force a real crash and check what a player would actually see.
 *
 *   node tools/shoot.mjs --scenario scenarios/crash.mjs --allow-errors \
 *     --out shots/crash.png
 *
 * --allow-errors is required: this run logs a genuine console error on purpose.
 */

const assert = (cond, message) => {
  if (!cond) throw new Error(`crash scenario: ${message}`);
};

export default async function (page) {
  await page.evaluate(() => window.__maker.hideOverlay());
  await page.waitForTimeout(300);

  const before = await page.evaluate(() => ({
    running: window.__maker.isRunning(),
    crashed: window.__maker.crash.hasCrashed,
    overlays: document.querySelectorAll('.mk-crash').length,
  }));
  assert(before.running, 'loop should be running before the crash');
  assert(!before.crashed, 'nothing should have crashed yet');
  assert(before.overlays === 0, 'no crash overlay should exist yet');

  // A throw from inside the fixed update, i.e. the path that matters — not a
  // direct call to report(), which would prove only that report() renders.
  await page.evaluate(() => {
    window.__maker.crashNextTick();
  });
  await page.waitForTimeout(500);

  const after = await page.evaluate(() => {
    const el = document.querySelector('.mk-crash');
    const pre = el?.querySelector('pre');
    return {
      running: window.__maker.isRunning(),
      crashed: window.__maker.crash.hasCrashed,
      overlays: document.querySelectorAll('.mk-crash').length,
      visible: el ? getComputedStyle(el).display !== 'none' : false,
      heading: el?.querySelector('h2')?.textContent ?? '',
      report: pre?.textContent ?? '',
      buttons: [...(el?.querySelectorAll('button') ?? [])].map((b) => b.textContent),
      pointerLocked: Boolean(document.pointerLockElement),
    };
  });

  assert(after.crashed, 'the handler should have recorded the crash');
  assert(after.overlays === 1, `expected exactly one overlay, saw ${after.overlays}`);
  assert(after.visible, 'the overlay must actually be visible');
  assert(after.heading.length > 0, 'the overlay needs a heading');
  assert(!after.pointerLocked, 'pointer lock must be released so Reload is clickable');

  // The loop must stop, or it throws again every frame and buries the screen
  // in console noise. This is the specific regression the guard exists for.
  assert(!after.running, 'the loop must stop after a crash');

  // The report is the only thing that makes a bug report useful.
  for (const needle of ['phase:', 'error:', 'context:', 'scenario crash']) {
    assert(after.report.includes(needle), `report is missing ${needle}\n---\n${after.report}`);
  }
  // Context is captured from live game state, so it must have real values in it.
  assert(/"parts":\s*\d+/.test(after.report), `report has no part count\n---\n${after.report}`);

  assert(
    after.buttons.some((t) => /reload/i.test(t ?? '')),
    `expected a Reload button, saw ${JSON.stringify(after.buttons)}`,
  );

  // A second crash must not stack a second dialog over the first.
  await page.evaluate(() => window.__maker.crash.report(new Error('second'), 'test'));
  await page.waitForTimeout(150);
  const stacked = await page.evaluate(() => document.querySelectorAll('.mk-crash').length);
  assert(stacked === 1, `a second crash stacked ${stacked} overlays`);

  const stillFirst = await page.evaluate(
    () => document.querySelector('.mk-crash pre')?.textContent ?? '',
  );
  assert(
    stillFirst.includes('scenario crash') && !stillFirst.includes('second'),
    'the first error must be the one kept, not the last',
  );

  console.log('[crash] overlay verified: single dialog, loop stopped, report populated');
}
