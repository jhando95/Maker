/**
 * Proves a controller actually drives the game.
 *
 * The mapping from sticks to intent is unit-tested; what cannot be unit-tested
 * is whether that intent reaches the player — the poll runs on the render frame,
 * the actions land in a buffer, the tick folds them, and the character
 * controller moves. That chain only exists in a browser.
 *
 * Rather than injecting snapshots past the poll, this replaces
 * navigator.getGamepads, so the game reads the fake pad through exactly the path
 * a real one takes, readPads included.
 *
 *   node tools/shoot.mjs --scenario scenarios/gamepad.mjs --out shots/pad.png
 */

const assert = (cond, message) => {
  if (!cond) throw new Error(`gamepad scenario: ${message}`);
};

/** Install a fake pad whose state the scenario can set from the page. */
async function installFakePad(page) {
  await page.evaluate(() => {
    const state = {
      connected: true,
      id: 'Fake Pad (STANDARD GAMEPAD)',
      index: 0,
      mapping: 'standard',
      axes: [0, 0, 0, 0],
      buttonValues: new Array(17).fill(0),
      timestamp: 0,
    };
    window.__fakePad = state;
    navigator.getGamepads = () => [{
      ...state,
      buttons: state.buttonValues.map((v) => ({ value: v, pressed: v > 0.5, touched: v > 0 })),
    }];
  });
}

const setPad = (page, { axes, buttons }) =>
  page.evaluate(({ axes, buttons }) => {
    if (axes) window.__fakePad.axes = axes;
    if (buttons) {
      window.__fakePad.buttonValues = new Array(17).fill(0);
      for (const [i, v] of Object.entries(buttons)) window.__fakePad.buttonValues[Number(i)] = v;
    }
  }, { axes, buttons });

const clearPad = (page) => setPad(page, { axes: [0, 0, 0, 0], buttons: {} });

const playerPos = (page) => page.evaluate(() => window.__maker.stats().player);
const yaw = (page) => page.evaluate(() => window.__maker.getCameraYaw());

export default async function (page) {
  await page.evaluate(() => window.__maker.hideOverlay());
  await installFakePad(page);
  await page.waitForTimeout(300);

  const seen = await page.evaluate(() => ({
    count: window.__maker.padCount(),
    raw: navigator.getGamepads().length,
    connected: navigator.getGamepads()[0]?.connected,
  }));
  assert(seen.count === 1, `the pad should be seen: ${JSON.stringify(seen)}`);

  // ── The left stick moves the player ────────────────────────────────────────
  //
  // Software GL runs this at a handful of frames a second, so every push gets a
  // generous window. Distances here only have to separate "moved" from "did not
  // move" — how a stick maps to a speed is pinned exactly in the unit tests,
  // where the frame rate cannot get in the way.
  const push = async (axes, ms) => {
    await page.evaluate(() => window.__maker.teleport(0, 0.6, 0));
    await page.evaluate(() => window.__maker.lookAt(0, 0));
    await page.waitForTimeout(600); // land and settle before measuring

    const from = await playerPos(page);
    await setPad(page, { axes });
    await page.waitForTimeout(ms);
    await clearPad(page);
    await page.waitForTimeout(250);
    const to = await playerPos(page);
    return { from, to, distance: Math.hypot(to.x - from.x, to.z - from.z) };
  };

  const full = await push([0, -1, 0, 0], 1600);
  assert(full.distance > 1.0, `stick forward should walk; moved ${full.distance.toFixed(2)}m`);
  // At yaw 0 the camera faces -Z, so forward is -Z.
  assert(
    full.to.z < full.from.z - 0.5,
    `forward should be -Z at yaw 0; z went ${full.from.z.toFixed(2)} -> ${full.to.z.toFixed(2)}`,
  );

  assert(
    await page.evaluate(() => window.__maker.inputDevice()) === 'gamepad',
    'touching the stick should claim the device',
  );

  const half = await push([0, -0.45, 0, 0], 1600);
  assert(half.distance > 0.1, `a half stick should still move; moved ${half.distance.toFixed(2)}m`);
  assert(
    half.distance < full.distance,
    `a half stick should be slower: ${half.distance.toFixed(2)}m vs ${full.distance.toFixed(2)}m`,
  );

  // Sideways, to prove the stick's two axes are not crossed.
  const right = await push([1, 0, 0, 0], 1400);
  assert(
    right.to.x > right.from.x + 0.5,
    `stick right should strafe +X at yaw 0; x went ${right.from.x.toFixed(2)} -> ${right.to.x.toFixed(2)}`,
  );

  // ── The right stick turns the camera, at a rate ────────────────────────────
  const yaw0 = await yaw(page);
  await setPad(page, { axes: [0, 0, 1, 0] });
  await page.waitForTimeout(900);
  await clearPad(page);
  await page.waitForTimeout(250);
  const yaw1 = await yaw(page);

  // Yaw wraps at ±π, so compare the shortest signed arc.
  const arc = Math.atan2(Math.sin(yaw1 - yaw0), Math.cos(yaw1 - yaw0));
  assert(Math.abs(arc) > 0.5, `the right stick should turn the view; turned ${arc.toFixed(2)}rad`);
  // Positive stick-x turns right, which is decreasing yaw.
  assert(arc < 0, `stick right should turn right (yaw down); got ${arc.toFixed(2)}rad`);

  const settled = await yaw(page);
  await page.waitForTimeout(300);
  assert(
    Math.abs(await yaw(page) - settled) < 1e-6,
    'the view must stop turning when the stick is released',
  );

  // ── The trigger places a part ──────────────────────────────────────────────
  await page.evaluate(() => window.__maker.teleport(0, 0.5, 0));
  await page.evaluate(() => window.__maker.lookAt(0, -0.5));
  await page.waitForTimeout(250);

  const parts = () => page.evaluate(() => window.__maker.stats().parts);

  const before = await parts();
  await setPad(page, { buttons: { 7: 1 } }); // RT
  await page.waitForTimeout(800);
  const held = await parts();
  assert(held > before, 'the right trigger should place a part');

  // Holding builds a stream, exactly as holding the left mouse button does —
  // the trigger is a button, not a special case.
  await clearPad(page);
  await page.waitForTimeout(300);
  const atRelease = await parts();
  await page.waitForTimeout(600);
  const later = await parts();
  // The edge detection is what stops a released trigger from placing forever.
  assert(later === atRelease, `releasing must stop placement; ${atRelease} -> ${later}`);

  // ── Unplugging must not leave anything held ────────────────────────────────
  await setPad(page, { axes: [0, -1, 0, 0] });
  await page.waitForTimeout(200);
  await page.evaluate(() => { navigator.getGamepads = () => []; });
  await page.waitForTimeout(200);
  const droppedAt = await playerPos(page);
  await page.waitForTimeout(600);
  const settledAt = await playerPos(page);
  const drift = Math.hypot(settledAt.x - droppedAt.x, settledAt.z - droppedAt.z);
  assert(drift < 0.4, `an unplugged pad must stop the player; drifted ${drift.toFixed(2)}m`);
  assert(await page.evaluate(() => window.__maker.padCount()) === 0, 'the pad should be gone');

  // ── The hints follow the device ────────────────────────────────────────────
  // Still pad hints: the device only changes back when a key or the mouse is
  // actually used, not when a controller is unplugged.
  const helpText = await page.evaluate(() => document.querySelector('.maker-help')?.textContent ?? '');
  assert(helpText.includes('L Stick'), `hints should be pad hints while a pad is in use:\n${helpText}`);

  console.log('[gamepad] verified: analog move, rate-based look, trigger place, clean unplug, pad hints');
}
