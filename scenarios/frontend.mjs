/**
 * The screens a player meets before they play, and the readout for when they do.
 *
 * Menus are the one part of this game with no simulation behind them, which is
 * exactly why they need a browser: there is nothing to unit-test but the
 * callbacks, and every way they go wrong is a layout. The title screen ran off
 * the bottom of a 720-line window with no way to scroll — so Settings, the last
 * thing on it, could not be reached at all — and that is invisible to every
 * kind of test except one that measures the card against the window.
 */
const assert = (c, m) => { if (!c) throw new Error(`frontend scenario: ${m}`); };

/** Does the menu card fit in the window it is drawn in? */
const cardFits = (page) => page.evaluate(() => {
  const card = document.querySelector('.mk-card');
  if (card === null) return null;
  const r = card.getBoundingClientRect();
  return {
    top: r.top,
    bottom: r.bottom,
    height: r.height,
    window: window.innerHeight,
    scrolls: card.scrollHeight > card.clientHeight + 1,
  };
});

const show = (page, screen) => page.evaluate((s) => {
  window.__maker.setAutoQuality(false);
  window.__maker.menu.show(s);
}, screen);

/** Every row on the controls screen, as a player sees it. */
const bindRows = (page) => page.evaluate(() => [...document.querySelectorAll('.mk-bind')].map((el) => ({
  label: el.querySelector('label')?.textContent ?? '',
  keys: [...el.querySelectorAll('.keys button')].map((b) => b.textContent ?? ''),
})));

const bindRow = async (page, label) => {
  const row = (await bindRows(page)).find((r) => r.label === label);
  assert(row !== undefined, `there is no "${label}" row on the controls screen`);
  return row;
};

/**
 * Arm one slot and press something into it.
 *
 * The click has to go through the page rather than through Playwright's mouse,
 * because the capture the click arms *also* listens for mousedown anywhere in
 * the card — that is how a mouse button gets bound — and a synthetic click
 * lands before the listener exists while a driver-level one races it.
 */
async function captureInto(page, label, slot, press) {
  await page.evaluate(([wanted, index]) => {
    const row = [...document.querySelectorAll('.mk-bind')]
      .find((el) => el.querySelector('label')?.textContent === wanted);
    if (row === undefined) throw new Error(`no row called ${wanted}`);
    row.querySelectorAll('.keys button')[index].click();
  }, [label, slot]);
  // The capture is armed synchronously by that click, so the key can go now.
  await press();
  await page.waitForFunction(
    () => document.querySelector('.mk-bind button.listening') === null,
    undefined, { timeout: 4000, polling: 'raf' },
  );
}

/**
 * Hold a key until the game agrees the action is down.
 *
 * Same shape as `wheel.mjs`, and for the same reason: headless Chromium drops a
 * key sent while the renderer is taking focus back, and input is folded at a
 * tick boundary rather than on the frame the key arrived.
 */
async function heldDown(page, key, action) {
  for (let attempt = 0; attempt < 6; attempt++) {
    await page.keyboard.down(key);
    try {
      await page.waitForFunction(
        (a) => window.__maker.actionDown(a) === true,
        action, { timeout: 3000, polling: 'raf' },
      );
      return;
    } catch {
      await page.keyboard.up(key);
    }
  }
  throw new Error(`frontend scenario: ${key} never drove ${action} — the rebind did not reach the game`);
}

export default async function (page) {
  // ── The title screen fits ───────────────────────────────────────────────────

  await show(page, 'title');
  const title = await cardFits(page);
  assert(title !== null, 'the title screen should draw a card');
  assert(
    title.bottom <= title.window && title.top >= 0,
    `the card runs off the window: ${title.top.toFixed(0)}..${title.bottom.toFixed(0)} of ${title.window}`,
  );
  assert(!title.scrolls, 'and it should not need scrolling to reach the last button');

  // Every mode is offered, and each says what it is. A grid of names with no
  // blurbs makes the player pick blind and find out ninety seconds later.
  const modes = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.mk-mode-card')];
    return cards.map((c) => ({
      name: c.querySelector('b')?.textContent ?? '',
      blurb: c.querySelector('span')?.textContent ?? '',
    }));
  });
  assert(modes.length >= 4, `every mode should be on the title screen, saw ${modes.length}`);
  for (const m of modes) {
    assert(m.name.length > 0, 'a mode card with no name');
    assert(m.blurb.length > 12, `"${m.name}" should say what it is, got "${m.blurb}"`);
  }

  // And the relay address is not on it. A websocket URL was the first thing a
  // new player saw under the mode list, which is an answer to a question
  // almost nobody has.
  const inputsOnTitle = await page.evaluate(() => document.querySelectorAll('.mk-card input').length);
  assert(inputsOnTitle === 0, `the title screen should have no text fields, found ${inputsOnTitle}`);

  // ── And so does everything behind it ────────────────────────────────────────

  for (const screen of ['together', 'settings', 'controls', 'builds']) {
    await show(page, screen);
    const box = await cardFits(page);
    assert(box !== null, `${screen} should draw a card`);
    assert(
      box.top >= 0 && box.bottom <= box.window + 1,
      `${screen} runs off the window: ${box.top.toFixed(0)}..${box.bottom.toFixed(0)} of ${box.window}`,
    );
  }

  // Settings is grouped rather than being one long undifferentiated column.
  await show(page, 'settings');
  const sections = await page.evaluate(
    () => [...document.querySelectorAll('.mk-section')].map((e) => e.textContent),
  );
  assert(sections.length >= 4, `settings should be in sections, saw ${sections.length}`);
  assert(
    sections.some((s) => /picture/i.test(s)),
    `and the first of them should be the picture, got ${sections.join(', ')}`,
  );

  // ── The controls screen ─────────────────────────────────────────────────────
  //
  // Everything here is a claim about a chain that only exists in a browser: a
  // click arms a capture, a real keydown is caught in the capture phase before
  // the game can act on it, and what comes out the far end is what the game
  // responds to. The unit suite checks the binding rules; nothing but this can
  // check that pressing the key you just chose does the thing.

  await show(page, 'controls');
  const rows = await bindRows(page);
  assert(rows.length >= 30, `every control should be listed, saw ${rows.length}`);
  for (const row of rows) {
    assert(
      row.keys.length === 2,
      `"${row.label}" should offer two keys, drew ${row.keys.length}`,
    );
  }
  // The specific regression. The old screen listed twenty of forty-one actions,
  // and the ones it left out were not chosen — they were whatever had been
  // added since it was written. Push-to-talk was among them, which is the worst
  // one to leave fixed: it has to be held while moving, so it is the binding
  // most likely to be wrong for somebody's hands.
  for (const wanted of ['Push to talk', 'Ping', 'Next blueprint', 'Slot 1', 'Crouch']) {
    assert(
      rows.some((r) => r.label === wanted),
      `"${wanted}" cannot be rebound by anybody — it is not on the screen`,
    );
  }
  const groups = await page.evaluate(
    () => [...document.querySelectorAll('.mk-group')].map((e) => e.textContent),
  );
  assert(groups.length >= 5, `thirty-five rows need grouping, saw ${groups.length} headings`);

  // ── Changing the second key leaves the first alone ──────────────────────────
  //
  // The bug the whole slot model exists for: rebinding used to wipe every key
  // an action had, so somebody moving forward onto another letter silently lost
  // the arrow key too.
  await captureInto(page, 'Jump / mantle', 1, () => page.keyboard.press('h'));
  const jump = await bindRow(page, 'Jump / mantle');
  assert(jump.keys[1] === 'H', `the second key should be H, drew "${jump.keys[1]}"`);
  assert(jump.keys[0] === 'Space', `and the first should be untouched, drew "${jump.keys[0]}"`);
  const boundTo = await page.evaluate(() => window.__maker.bindingFor('KeyH'));
  assert(boundTo === 'jump', `the game should read KeyH as jump, it reads ${boundTo}`);

  // And the key actually works. Reading the binding map proves the screen wrote
  // somewhere; this proves it wrote to the thing a keypress consults.
  await page.evaluate(() => {
    window.__maker.menu.show('none');
    window.__maker.hideOverlay();
  });
  await heldDown(page, 'h', 'jump');
  await page.keyboard.up('h');

  // ── Backspace empties a slot ────────────────────────────────────────────────
  await show(page, 'controls');
  await captureInto(page, 'Jump / mantle', 1, () => page.keyboard.press('Backspace'));
  const cleared = await bindRow(page, 'Jump / mantle');
  assert(cleared.keys[1] === '—', `a cleared slot should read as empty, drew "${cleared.keys[1]}"`);
  assert(cleared.keys[0] === 'Space', 'and clearing one must not take the other');
  const afterClear = await page.evaluate(() => window.__maker.bindingFor('KeyH'));
  assert(afterClear === null, `KeyH should mean nothing now, it means ${afterClear}`);

  // ── Taking a key says whose it was ──────────────────────────────────────────
  //
  // A code can only mean one thing, so binding one somebody else has *must*
  // take it. Doing that silently is a control that stops working with no
  // explanation attached.
  await captureInto(page, 'Jump / mantle', 1, () => page.keyboard.press('w'));
  const note = await page.evaluate(
    () => document.querySelector('.mk-hint')?.textContent ?? '',
  );
  assert(
    /taken from Move forward/i.test(note),
    `the screen should say which control lost W, it said "${note}"`,
  );
  const robbed = await bindRow(page, 'Move forward');
  assert(robbed.keys[0] === '—', `and show it gone, Move forward still reads "${robbed.keys[0]}"`);
  assert(robbed.keys[1] === 'Up Arrow', 'while keeping the key it did not lose');

  // ── Reset puts it all back ──────────────────────────────────────────────────
  await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('.mk-card button')];
    buttons.find((b) => /reset controls/i.test(b.textContent ?? ''))?.click();
  });
  const restored = await bindRow(page, 'Move forward');
  assert(
    restored.keys[0] === 'W' && restored.keys[1] === 'Up Arrow',
    `reset should restore both keys, drew "${restored.keys.join(' / ')}"`,
  );

  // ── The frame-rate readout ──────────────────────────────────────────────────

  // Off by default: a permanent number in the corner is a thing the player
  // chose, not a thing the game decided they wanted.
  await page.evaluate(() => {
    window.__maker.menu.show('none');
    window.__maker.hideOverlay();
    window.__maker.settings.set('showStats', false);
  });
  await new Promise((r) => setTimeout(r, 400));
  const hidden = await page.evaluate(() => {
    const el = document.querySelector('.maker-stats');
    return el === null || el.classList.contains('maker-hidden');
  });
  assert(hidden, 'the frame-rate readout should be off until somebody asks for it');

  await page.evaluate(() => window.__maker.settings.set('showStats', true));
  await new Promise((r) => setTimeout(r, 900));
  const stats = await page.evaluate(() => {
    const el = document.querySelector('.maker-stats');
    return el === null ? null : { hidden: el.classList.contains('maker-hidden'), text: el.textContent };
  });
  assert(stats !== null && !stats.hidden, 'and on once they do');
  // Four numbers, and the one that matters is the second: an average frame rate
  // hides exactly the stutter a player notices, so the worst frame is shown
  // beside it.
  assert(/\d+ fps/.test(stats.text), `it should say a frame rate, got "${stats.text}"`);
  assert(/[\d.]+ ms/.test(stats.text), `and a frame time, got "${stats.text}"`);
  assert(/low \d+/.test(stats.text), `and the worst frame, got "${stats.text}"`);
  assert(/\d+ draws/.test(stats.text), `and the draw count, got "${stats.text}"`);

  await page.evaluate(() => {
    window.__maker.teleport(0, 0.6, 16);
    window.__maker.lookAt(Math.PI, -0.05);
  });
  await new Promise((r) => setTimeout(r, 500));
  await page.screenshot({ path: `${process.env.RUNNER_TEMP ?? '/tmp'}/frontend.png` });

  console.log(`[frontend] verified: ${modes.length} mode cards on a title screen that fits,`
    + ` no relay address on it, ${sections.length} settings sections, four screens inside`
    + ` the window, ${rows.length} rebindable controls in ${groups.length} groups with two`
    + ` keys each — rebound, cleared, stolen and reset, and the new key drove the game —`
    + ` and a frame-rate readout that stays off until asked: "${stats.text}"`);
}
