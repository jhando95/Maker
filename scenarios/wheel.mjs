/**
 * Proves the part wheel opens, tracks the mouse and commits a choice.
 *
 * The geometry is unit-tested. What only exists in a browser is the chain from
 * a held key, through the mouse deltas that would otherwise be swinging the
 * camera, to a different part actually being selected — plus whether the thing
 * is legible, which is what the screenshot is for.
 *
 *   node tools/shoot.mjs --scenario scenarios/wheel.mjs --out shots/wheel.png
 */

const assert = (cond, message) => {
  if (!cond) throw new Error(`wheel scenario: ${message}`);
};

/**
 * Hold a key until it visibly takes effect.
 *
 * Headless Chromium drops a key event sent immediately after an evaluate — the
 * renderer has not taken focus back yet — so a single keyboard.down is a coin
 * flip. Pressing until the game agrees it is held tests the same thing without
 * the flake.
 */
async function holdKey(page, key, check) {
  for (let attempt = 0; attempt < 6; attempt++) {
    await page.keyboard.down(key);
    await page.waitForTimeout(250);
    if (await page.evaluate(check)) return;
    await page.keyboard.up(key);
    await page.waitForTimeout(100);
  }
  throw new Error(`wheel scenario: ${key} never registered as held`);
}

/** Release, likewise, until the game agrees. Key-up gets dropped the same way. */
async function releaseKey(page, key, check) {
  for (let attempt = 0; attempt < 6; attempt++) {
    await page.keyboard.up(key);
    await page.waitForTimeout(250);
    if (await page.evaluate(check)) return;
  }
  throw new Error(`wheel scenario: ${key} never registered as released`);
}

const wheelIsOpen = () => window.__maker.hud.partWheel.isOpen;
const wheelIsShut = () => !window.__maker.hud.partWheel.isOpen;

const state = (page) =>
  page.evaluate(() => ({
    open: window.__maker.hud.partWheel.isOpen,
    selection: window.__maker.hud.partWheel.selection,
    part: window.__maker.getSelectedPart(),
    yaw: window.__maker.getCameraYaw(),
    wedges: document.querySelectorAll('.mk-wedge').length,
    chip: document.querySelector('.mk-chip')?.textContent ?? '',
    hotbarSlots: [...document.querySelectorAll('.maker-slot')]
      .filter((el) => el.offsetParent !== null).length,
  }));

export default async function (page) {
  await page.evaluate(() => window.__maker.hideOverlay());
  await page.waitForTimeout(400);

  const before = await state(page);
  assert(!before.open, 'the wheel should start shut');
  // The whole point: the eight-slot bar is gone from the screen.
  assert(before.hotbarSlots === 0, `the old hotbar should be gone, saw ${before.hotbarSlots} slots`);
  assert(before.chip.length > 0, 'the chip should name the held part');

  // ── Opening ────────────────────────────────────────────────────────────────
  await holdKey(page, 'Tab', wheelIsOpen);

  const open = await state(page);
  assert(open.open, 'holding Tab should open the wheel');
  assert(open.wedges > 1, `the wheel needs wedges, saw ${open.wedges}`);
  assert(open.selection === null, 'nothing should be selected before the mouse moves');

  // ── Aiming ─────────────────────────────────────────────────────────────────
  // Straight down is the wedge opposite the top one. Injected rather than moved
  // for real: the game ignores the mouse unless the pointer is locked, and a
  // headless page has no gesture to grant lock from.
  await page.evaluate(() => window.__maker.look(0, 200));
  // Wait for the tick to fold it in rather than for a duration: software GL
  // renders a handful of frames a second, so any sleep short enough to be
  // pleasant is also short enough to race.
  await page
    .waitForFunction(() => window.__maker.hud.partWheel.selection !== null, null, { timeout: 15_000 })
    .catch(() => { throw new Error('wheel scenario: moving the mouse never selected a wedge'); });

  const aimed = await state(page);
  assert(aimed.selection !== null, 'moving the mouse should select a wedge');
  assert(
    aimed.selection !== aimed.part,
    `aiming should move off the held part; both are ${aimed.part}`,
  );
  assert(
    Math.abs(aimed.yaw - open.yaw) < 1e-6,
    `the camera must not turn while the wheel is open; yaw moved ${(aimed.yaw - open.yaw).toFixed(4)}`,
  );

  await page.screenshot({ path: process.env.WHEEL_SHOT ?? 'shots/wheel.png' });

  // ── Committing ─────────────────────────────────────────────────────────────
  const wanted = aimed.selection;
  await releaseKey(page, 'Tab', wheelIsShut);

  const after = await state(page);
  assert(!after.open, 'releasing should shut the wheel');
  assert(after.part === wanted, `should have selected ${wanted}, got ${after.part}`);
  assert(after.chip.length > 0, 'the chip should still name the held part');

  // ── A tap with no aim keeps what you had ───────────────────────────────────
  await holdKey(page, 'Tab', wheelIsOpen);
  await releaseKey(page, 'Tab', wheelIsShut);
  const tapped = await state(page);
  assert(
    tapped.part === wanted,
    `a tap with no direction must change nothing; ${wanted} became ${tapped.part}`,
  );

  // ── The camera works again afterwards ──────────────────────────────────────
  const yawBefore = tapped.yaw;
  await page.evaluate(() => window.__maker.look(200, 0));
  await page
    .waitForFunction(
      (y) => Math.abs(window.__maker.getCameraYaw() - y) > 0.01, yawBefore, { timeout: 15_000 },
    )
    .catch(() => { throw new Error('wheel scenario: the camera never turned again'); });
  const moved = await state(page);
  assert(
    Math.abs(moved.yaw - yawBefore) > 0.01,
    'the mouse should turn the camera again once the wheel is shut',
  );

  console.log('[wheel] verified: opens, aims without turning the camera, commits, taps are no-ops');
}
