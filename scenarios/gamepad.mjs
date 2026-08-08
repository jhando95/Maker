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

/**
 * Wait for a number of animation frames.
 *
 * The only unit that means anything here. The pad poll, the simulation and the
 * renderer all advance on the frame, and under software GL a frame is a quarter
 * of a second — so a 200ms wall-clock wait routinely contains none at all, and
 * whatever it then measures is a stale value from before the wait began.
 */
const frames = (page, count) =>
  page.evaluate(
    (n) => new Promise((resolve) => {
      let seen = 0;
      const step = () => { if (++seen >= n) resolve(); else requestAnimationFrame(step); };
      requestAnimationFrame(step);
    }),
    count,
  );

/**
 * Run frames until the player stops moving, and return where they stopped.
 *
 * A consequence check, not the assertion: coming to rest proves nothing on its
 * own, since walking into a fence also stops you. It is here to catch a player
 * still travelling long after the input is provably clear.
 */
async function restingPlace(page) {
  let last = await playerPos(page);
  for (let i = 0; i < 40; i++) {
    await frames(page, 2);
    const now = await playerPos(page);
    if (Math.hypot(now.x - last.x, now.z - last.z) < 0.01) return now;
    last = now;
  }
  throw new Error('gamepad scenario: the player never stopped after the pad was unplugged');
}

export default async function (page) {
  await page.evaluate(() => window.__maker.hideOverlay());
  await installFakePad(page);

  // Pads are read on the render frame, and software GL renders a handful of
  // frames a second. Wait for the count rather than for a duration, or this
  // races the frame loop and fails whenever the machine is having a bad moment.
  await page
    .waitForFunction(() => window.__maker.padCount() === 1, null, { timeout: 20_000 })
    .catch(() => {
      throw new Error('gamepad scenario: the fake pad was never picked up');
    });

  // ── The left stick moves the player ────────────────────────────────────────
  //
  // Software GL runs this at a handful of frames a second, so every push gets a
  // generous window. Distances here only have to separate "moved" from "did not
  // move" — how a stick maps to a speed is pinned exactly in the unit tests,
  // where the frame rate cannot get in the way.
  // The front lawn, not the origin. The origin used to be open grass and is now
  // the middle of the house, so a stick test there measured a player standing
  // inside a wall and going nowhere.
  const START = [-8, 0.6, -14];

  const push = async (axes, ms) => {
    await page.evaluate((p) => window.__maker.teleport(p[0], p[1], p[2]), START);
    await page.evaluate(() => window.__maker.lookAt(0, 0));
    // Land before measuring, on the condition rather than on a timer: 600ms is
    // too long on a fast machine and can be no frames at all on a slow one.
    await page
      .waitForFunction(() => window.__maker.stats().player.onGround, null, { timeout: 20_000 })
      .catch(() => { throw new Error('gamepad scenario: the player never landed at the start'); });

    const from = await playerPos(page);
    await setPad(page, { axes });
    // A real duration, this one: it is how long the stick is held for.
    await page.waitForTimeout(ms);
    await clearPad(page);
    // Then let the steps owed to that push land, so the distance includes all
    // of the walking and not just whatever happened to be rendered.
    await restingPlace(page);
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
  // Wait for the view to actually turn rather than for 900ms of wall clock,
  // which at four frames a second can hold three frames or none.
  // Yaw wraps at ±π, so compare the shortest signed arc.
  await page
    .waitForFunction((y) => {
      const d = window.__maker.getCameraYaw() - y;
      return Math.abs(Math.atan2(Math.sin(d), Math.cos(d))) > 0.5;
    }, yaw0, { timeout: 20_000 })
    .catch(() => { throw new Error('gamepad scenario: the right stick should turn the view'); });
  await clearPad(page);

  const yaw1 = await yaw(page);
  const arc = Math.atan2(Math.sin(yaw1 - yaw0), Math.cos(yaw1 - yaw0));
  // Positive stick-x turns right, which is decreasing yaw. The magnitude is
  // already guaranteed by the wait above; the direction is what is under test.
  assert(arc < 0, `stick right should turn right (yaw down); got ${arc.toFixed(2)}rad`);

  // Releasing must stop it dead. Waiting for the poll to see the centred stick
  // first, because "the yaw did not change" passes for free during a window
  // that contained no frames at all — which is how this read green on a slow
  // machine and red on a fast one.
  await page
    .waitForFunction(() => {
      const look = window.__maker.padLook();
      return Math.abs(look.yaw) < 1e-9 && Math.abs(look.pitch) < 1e-9;
    }, null, { timeout: 20_000 })
    .catch(() => {
      throw new Error('gamepad scenario: releasing the stick never cleared the look rate');
    });
  const settled = await yaw(page);
  await frames(page, 6);
  assert(
    Math.abs(await yaw(page) - settled) < 1e-6,
    'the view must stop turning when the stick is released',
  );

  // ── The trigger places a part ──────────────────────────────────────────────
  await page.evaluate((p) => window.__maker.teleport(p[0], p[1], p[2]), START);
  await page.evaluate(() => window.__maker.lookAt(0, -0.5));
  await frames(page, 2);

  const parts = () => page.evaluate(() => window.__maker.stats().parts);

  const before = await parts();
  await setPad(page, { buttons: { 7: 1 } }); // RT
  await page
    .waitForFunction((n) => window.__maker.stats().parts > n, before, { timeout: 20_000 })
    .catch(() => { throw new Error('gamepad scenario: the right trigger should place a part'); });

  // Holding builds a stream, exactly as holding the left mouse button does —
  // the trigger is a button, not a special case.
  await clearPad(page);
  await frames(page, 3);
  const atRelease = await parts();
  // Frames rather than a duration, because "the count did not change" is a
  // claim that passes for free if the loop never ran during the wait.
  await frames(page, 8);
  const later = await parts();
  // The edge detection is what stops a released trigger from placing forever.
  assert(later === atRelease, `releasing must stop placement; ${atRelease} -> ${later}`);

  // ── The d-pad changes what you are holding ─────────────────────────────────
  //
  // `gamepad.ts` has bound d-pad left and right to `prevPart`/`nextPart` since
  // it was written, and nothing anywhere read those two actions — so both
  // buttons did nothing at all, silently, for as long as the pad has existed.
  // Nobody noticed because the pad also has a part wheel and the wheel is the
  // better way to pick. Found by putting every action on the controls screen:
  // an action somebody can bind a key to had better do something.
  await clearPad(page);
  await frames(page, 3);
  const heldBefore = await page.evaluate(() => window.__maker.getSelectedPart());
  await setPad(page, { buttons: { 15: 1 } }); // D→
  await page
    .waitForFunction(
      (was) => window.__maker.getSelectedPart() !== was,
      heldBefore, { timeout: 20_000 },
    )
    .catch(() => { throw new Error('gamepad scenario: d-pad right should pick the next part'); });
  const heldAfter = await page.evaluate(() => window.__maker.getSelectedPart());

  // And back, so this is a step rather than a one-way door.
  await clearPad(page);
  await frames(page, 3);
  await setPad(page, { buttons: { 14: 1 } }); // D←
  await page
    .waitForFunction(
      (was) => window.__maker.getSelectedPart() === was,
      heldBefore, { timeout: 20_000 },
    )
    .catch(() => {
      throw new Error(`gamepad scenario: d-pad left should step back from ${heldAfter}`);
    });
  await clearPad(page);
  await frames(page, 3);

  // ── Unplugging must not leave anything held ────────────────────────────────
  //
  // Checked on the input itself, not on the player's feet, and both halves of
  // that matter because both were wrong.
  //
  // The old version pushed the stick, unplugged, waited 200ms and sampled the
  // position. At four frames a second that wait held no frames, so it sampled
  // from before the player had moved at all; the next sample then straddled the
  // frame where the loop runs its whole backlog of fixed steps at once, and the
  // walking already owed to the stick *before* the unplug read as drift after
  // it. Nothing was stuck — the measurement was on the wrong clock.
  //
  // Measuring position at all is the deeper mistake. A stuck stick and a
  // released one look identical the moment the player reaches a fence, and this
  // lawn has one: with the guard disabled on purpose, a position check watched
  // the player walk 3.8m into the boundary, come to a stop, and pass.
  const stickAxes = () => page.evaluate(() => window.__maker.moveAxis());
  const magnitude = (a) => Math.hypot(a.x, a.z);

  await setPad(page, { axes: [0, -1, 0, 0] });
  await frames(page, 3);
  const pushed = await stickAxes();
  assert(
    magnitude(pushed) > 0.5,
    `the stick should register as pushed before unplugging; got ${magnitude(pushed).toFixed(3)}`,
  );

  await page.evaluate(() => { navigator.getGamepads = () => []; });
  await page
    .waitForFunction(() => window.__maker.padCount() === 0, null, { timeout: 20_000 })
    .catch(() => { throw new Error('gamepad scenario: the unplug was never noticed'); });

  const released = await stickAxes();
  assert(
    magnitude(released) < 1e-6,
    `an unplugged pad must leave nothing held; stick still reads ${magnitude(released).toFixed(3)}`,
  );
  assert(await page.evaluate(() => window.__maker.padCount()) === 0, 'the pad should be gone');

  // And the consequence: no input means the player comes to rest.
  await restingPlace(page);

  // ── The hints follow the device ────────────────────────────────────────────
  // Still pad hints: the device only changes back when a key or the mouse is
  // actually used, not when a controller is unplugged.
  const helpText = await page.evaluate(() => document.querySelector('.maker-help')?.textContent ?? '');
  // A token only the pad help contains. 'LT' rather than 'Alt', which the
  // keyboard help shows and which differs only by case.
  assert(helpText.includes('D←'), `hints should be pad hints while a pad is in use:\n${helpText}`);

  // ── And the menus, which the pad could not reach at all ────────────────────
  //
  // Every screen in this project was click-only. There was a gamepad layer and
  // it drove the game: a player on a controller had to put it down and find the
  // mouse to change a setting or pick a mode. That is a papercut on a PC and the
  // whole job for any console build, where there is no mouse to reach for.
  //
  // Driven through real keys and a real fake pad rather than by calling the
  // menu's own methods, because the half most likely to be wrong is the wiring:
  // a highlight model that works perfectly and is never fed anything is exactly
  // the bug this cannot be allowed to have.

  await page.evaluate(() => {
    window.__maker.menu.show('title');
  });

  // Nothing is highlighted until somebody asks for it. A ring that appears on
  // load would put a mouse user's attention on a button they are not looking at.
  const cold = await page.evaluate(() => ({
    focused: window.__maker.menu.focused,
    rings: document.querySelectorAll('.mk-focus').length,
  }));
  assert(cold.focused === null, `nothing should be highlighted before it is asked for, saw ${cold.focused}`);
  assert(cold.rings === 0, `and nothing drawn, saw ${cold.rings}`);

  await page.keyboard.press('ArrowDown');
  await page
    .waitForFunction(() => window.__maker.menu.focused !== null, null, { timeout: 20_000 })
    .catch(() => { throw new Error('gamepad scenario: an arrow key never woke the highlight'); });

  const first = await page.evaluate(() => ({
    focused: window.__maker.menu.focused,
    rings: document.querySelectorAll('.mk-focus').length,
  }));
  assert(first.rings === 1, `exactly one thing should be highlighted, saw ${first.rings}`);

  // Moving is a different thing, not a repaint of the same one — and there is
  // still exactly one ring afterwards, which is the assertion that catches a
  // highlight that lights up everything it has ever been on.
  await page.keyboard.press('ArrowDown');
  await page
    .waitForFunction(
      (was) => window.__maker.menu.focused !== was, first.focused, { timeout: 20_000 },
    )
    .catch(() => { throw new Error('gamepad scenario: a second arrow never moved the highlight'); });

  const moved = await page.evaluate(() => document.querySelectorAll('.mk-focus').length);
  assert(moved === 1, `moving should leave one ring behind it, saw ${moved}`);

  // ── A is confirm, and it is not rebindable ────────────────────────────────
  //
  // Walked rather than assumed, and walked in two directions because the title
  // screen genuinely needs both: the mode cards are a two-column grid and the
  // five buttons under them — Free Build, Locker, Saved Builds, Blueprints,
  // Settings — are a single row. A flat next/previous cursor would have made
  // this one long list; what it actually is is a shape, and the highlight has to
  // agree with the shape a player can see.
  const press = async (key, times = 1) => {
    for (let i = 0; i < times; i++) {
      await page.evaluate((k) => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
      }, key);
      await frames(page, 1);
    }
  };

  const walkTo = async (key, wanted, limit) => {
    for (let i = 0; i < limit; i++) {
      const now = await page.evaluate(() => window.__maker.menu.focused ?? '');
      if (now.includes(wanted)) return true;
      await press(key);
    }
    return await page.evaluate(
      (w) => (window.__maker.menu.focused ?? '').includes(w), wanted,
    );
  };

  // ── The stick moves it too, and means the same thing an arrow does ────────
  //
  // Asserted as an equivalence rather than as "something changed", which was the
  // first version and could not fail: up and down both change the highlight, so
  // a stick wired upside down passed. From one starting point, a push down and a
  // press of Down have to land on the same thing.
  await installFakePad(page);
  await page
    .waitForFunction(() => window.__maker.padCount() > 0, null, { timeout: 20_000 })
    .catch(() => { throw new Error('gamepad scenario: the fake pad was never picked up again'); });

  const focusedNow = () => page.evaluate(() => window.__maker.menu.focused);
  const startFrom = async (label) => {
    assert(await walkTo('ArrowDown', label, 24), `the highlight should be able to reach ${label}`);
  };

  await startFrom('Play With Friends');
  await press('ArrowDown');
  const viaKey = await focusedNow();
  assert(viaKey !== null && !viaKey.includes('Play With Friends'), 'Down should have moved off it');

  await startFrom('Play With Friends');
  await setPad(page, { axes: [0, 1, 0, 0] });
  await page
    .waitForFunction(
      () => !(window.__maker.menu.focused ?? '').includes('Play With Friends'),
      null, { timeout: 20_000 },
    )
    .catch(() => { throw new Error('gamepad scenario: the left stick never moved the highlight'); });
  const viaStick = await focusedNow();
  await clearPad(page);
  assert(
    viaStick === viaKey,
    `pushing the stick down should mean what pressing Down means: key gave "${viaKey}", stick gave "${viaStick}"`,
  );

  assert(await walkTo('ArrowDown', 'Free Build', 20), 'down should reach the bottom row');
  assert(await walkTo('ArrowRight', 'Settings', 8), 'and right should run along it to Settings');

  await setPad(page, { buttons: { 0: 1 } });
  await page
    .waitForFunction(() => window.__maker.menu.current === 'settings', null, { timeout: 20_000 })
    .catch(() => { throw new Error('gamepad scenario: A never pressed the highlighted button'); });
  await clearPad(page);

  // ── And B goes back ────────────────────────────────────────────────────────
  await new Promise((r) => setTimeout(r, 60));
  await setPad(page, { buttons: { 1: 1 } });
  await page
    .waitForFunction(() => window.__maker.menu.current === 'title', null, { timeout: 20_000 })
    .catch(() => { throw new Error('gamepad scenario: B never stepped back out of Settings'); });
  await clearPad(page);

  // The highlight survived the round trip: somebody who put the mouse down does
  // not get it taken away from them by changing screen.
  // Survives the round trip, ring and all. The ring is the half that is easy to
  // lose: a screen is rebuilt from scratch on every render, so the element the
  // class was on no longer exists, and the index alone would still report a
  // label while the player saw nothing.
  const after = await page.evaluate(() => ({
    focused: window.__maker.menu.focused,
    rings: document.querySelectorAll('.mk-focus').length,
  }));
  assert(after.focused !== null, 'the highlight should survive a change of screen');
  assert(after.rings === 1, `and still be drawn afterwards, saw ${after.rings} rings`);

  await page.evaluate(() => { window.__maker.menu.show('none'); window.__maker.hideOverlay(); });

  console.log('[gamepad] verified: analog move, rate-based look, trigger place, clean unplug,'
    + ' pad hints, and a menu a controller can actually drive — arrows and the stick move one'
    + ' highlight, A presses it, B steps back out');
}
