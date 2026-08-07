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
import { diffPixels, brighter } from '../tools/imgdiff.mjs';

const assert = (c, m) => { if (!c) throw new Error(`frontend scenario: ${m}`); };

const TMP = process.env.RUNNER_TEMP ?? '/tmp';

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

  // ── The afternoon gets late ─────────────────────────────────────────────────
  //
  // Driven through the setting rather than by writing the sun, because a
  // scenario that set the light directly would prove the shader works on a
  // value no player can produce. What comes back is read off the objects
  // three.js is really using.
  await page.evaluate(() => {
    window.__maker.teleport(-1.6, 0.83, 7.6);
    window.__maker.lookAt(Math.PI * 0.5, -0.05);
    window.__maker.setHudVisible(false);
  });
  await new Promise((r) => setTimeout(r, 300));

  const noon = await page.evaluate(() => window.__maker.setTimeOfDay('afternoon'));
  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot({ path: `${TMP}/frontend-afternoon.png` });

  const dusk = await page.evaluate(() => window.__maker.setTimeOfDay('dusk'));
  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot({ path: `${TMP}/frontend-dusk.png` });

  assert(
    dusk.elevation < noon.elevation,
    `the sun should go down: ${noon.elevation.toFixed(2)} -> ${dusk.elevation.toFixed(2)}`,
  );
  assert(
    Math.abs(dusk.azimuth - noon.azimuth) > 0.4,
    'and swing round, or the shadows only ever get longer in one direction',
  );
  assert(
    dusk.sunIntensity < noon.sunIntensity,
    'the key light should fade',
  );
  // The counter-intuitive half, and the one that keeps a cel-shaded evening
  // readable: dim the fill along with the key and a lawn, a fence and a kid all
  // land in the bottom band together.
  assert(
    dusk.fillIntensity > noon.fillIntensity,
    `and the fill should rise as it does: ${noon.fillIntensity} -> ${dusk.fillIntensity}`,
  );
  assert(
    dusk.fogFar < noon.fogFar && dusk.fogFar > 120,
    `haze should close in without hiding the horizon, far was ${dusk.fogFar}`,
  );

  // And it reaches pixels. Every claim above is about a number on an object;
  // this is the one that says the picture changed, and it is the check that
  // would survive somebody wiring the light to a scene nothing renders from.
  const day = diffPixels(`${TMP}/frontend-afternoon.png`, `${TMP}/frontend-dusk.png`);
  assert(
    day.diff > day.total * 0.5,
    `an afternoon and a dusk should barely share a pixel — only ${day.diff} of ${day.total} differ`,
  );

  // ── And the lamps come on ──────────────────────────────────────────────────
  //
  // Photographed on its own, which is the only way a glow can be. Comparing
  // dusk against noon moves the sky, the fog, the key, the fill and every
  // shadow in the yard, and a lamp is a few hundred pixels somewhere in the
  // middle of that — a diff proves nothing about which of them changed. So the
  // time of day is held exactly where it is and only the lamps move. Every
  // pixel that differs between these two shots is a lamp, and there is no other
  // reading available.
  assert(
    dusk.lamps >= 20,
    `the map should put lights in it, saw ${dusk.lamps}`,
  );
  assert(
    dusk.lampGlow === 1 && dusk.lampsDrawn === dusk.lamps,
    `at dusk every lamp should be up and drawn: ${dusk.lampsDrawn} of ${dusk.lamps}`
    + ` at ${dusk.lampGlow}`,
  );
  assert(
    noon.lampGlow === 0 && noon.lampsDrawn === 0,
    `and in the afternoon none of them should even be in the draw call, saw`
    + ` ${noon.lampsDrawn} at ${noon.lampGlow}`,
  );

  // Aimed at a light by its coordinates rather than by a yaw worked out by
  // hand — the first attempt pointed at a heading that turned out to contain no
  // lamp at all, and measured the camera still easing into place instead.
  await page.evaluate(() => {
    window.__maker.teleport(-9.75, 0.6, -20);
    window.__maker.lookAtPoint(-9.75, 5.05, -30);
  });
  // On the ground before anything is photographed. A teleported body is in
  // mid-air above wherever it was put, and the placement ghost is drawn where
  // the aim ray lands — so a camera still falling drags a green rectangle
  // across the middle distance, which is a moving picture to difference.
  await page.waitForFunction(() => window.__maker.stats().player.onGround === true,
    null, { timeout: 5000 });
  // Shot until two consecutive frames agree, rather than after a wait.
  //
  // The measurement below is a difference, and a difference is only about the
  // lamps if nothing else in the picture is moving. A fixed wait is a bet on
  // frame time: 400ms is thirty frames on a real card and *three* through
  // SwiftShader, and the placement ghost eases toward wherever the aim ray
  // lands. The first version of this bet 400ms, passed on my machine and read
  // 8,940 moving pixels on CI. So it asks the picture rather than the clock.
  const holdStill = async (a, b) => {
    let prev = a;
    let cur = b;
    const seen = [];
    await page.screenshot({ path: prev });
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 350));
      await page.screenshot({ path: cur });
      const moved = brighter(prev, cur);
      seen.push(moved.up + moved.down);
      // Quiet enough to stop early. Not zero — a few hundred pixels of this
      // yard move on their own — and not required either: see below.
      if (seen[seen.length - 1] <= 600) break;
      const swap = prev;
      prev = cur;
      cur = swap;
    }
    // The median rather than the last or the best, and *reported* rather than
    // demanded. Two earlier versions of this made stillness a precondition and
    // failed on it twice: first on a 400ms wait that was three frames through
    // SwiftShader, then on a loop that ran out of tries because the build ghost
    // was easing toward the aim ray a hand's width under the lamp. Both times
    // the lamps were working perfectly.
    //
    // So the picture is no longer asked to hold still. It is asked how much it
    // is moving, and the glow below has to beat that number several times over
    // — which is the claim that was wanted all along, and the only one that
    // cannot be defeated by finding a third thing that moves.
    const sorted = seen.slice().sort((x, y) => x - y);
    return { path: cur, restless: sorted[sorted.length >> 1], seen };
  };

  // Adaptive quality pinned for the measurement, and this is the reason the
  // check exists in this shape at all: the scaler changes the size of the
  // buffer the whole picture is drawn into, so while it is hunting, *every*
  // pixel is a changed pixel. On a machine that keeps up it settles at 1.00 and
  // is never noticed; on CI, at seven frames a second, it never stopped moving
  // and the settle loop ran out of tries. Turned off here and back on after, so
  // the rest of the scenario finds the game as it left it.
  await page.evaluate(() => window.__maker.setAutoQuality(false));
  const pinned = await page.evaluate(() => window.__maker.renderScale().effective);

  // And the aiming furniture out of the picture. The build ghost sits a hand's
  // width under the lamp this shot is framed on, easing toward wherever the aim
  // ray lands, and it is the one thing in a parked frame that is never quite
  // still. On CI it moved between two and nine thousand pixels between every
  // pair of frames — the settle loop reported that sequence, which is what the
  // sequence is for.
  await page.evaluate(() => window.__maker.setBuildPreview(false));

  const lit = await holdStill(`${TMP}/frontend-lamps-a.png`, `${TMP}/frontend-lamps-b.png`);
  const off = await page.evaluate(() => window.__maker.setLamps(0));
  assert(off.drawn === 0, `turning them off should empty the draw call, ${off.drawn} left`);
  const dark = await holdStill(`${TMP}/frontend-dark-a.png`, `${TMP}/frontend-dark-b.png`);
  // Whichever half of the pair was noisier sets the bar.
  const restless = Math.max(lit.restless, dark.restless);
  // The pin held. Without this the two shots could differ because they were
  // drawn at different resolutions, and the difference would be read as light.
  const held = await page.evaluate(() => window.__maker.renderScale().effective);
  assert(
    held === pinned,
    `the render scale moved under the measurement: ${pinned} -> ${held}`,
  );

  const glow = brighter(lit.path, dark.path);
  assert(
    glow.up > 4000 && glow.up > restless * 4,
    `the lamps should reach pixels — ${glow.up} of ${glow.total} got brighter against`
    + ` ${restless} moving on their own (lit ${lit.seen.join('/')},`
    + ` dark ${dark.seen.join('/')})`,
  );
  // Additive means added. A glow that takes light *out* of the picture is a
  // blend mode that is not the one this claims to be, and it would pass a plain
  // changed-pixel count without anybody noticing — half the pixels the wrong
  // way looks exactly like half the pixels the right way.
  assert(
    glow.down * 4 < glow.up,
    `a light should not darken anything: ${glow.down} pixels went down against`
    + ` ${glow.up} up`,
  );

  await page.evaluate(() => {
    window.__maker.setBuildPreview(true);
    window.__maker.setAutoQuality(true);
    window.__maker.setTimeOfDay('round');
    window.__maker.setHudVisible(true);
    window.__maker.teleport(0, 0.6, 16);
    window.__maker.lookAt(Math.PI, -0.05);
  });
  await new Promise((r) => setTimeout(r, 500));
  await page.screenshot({ path: `${process.env.RUNNER_TEMP ?? '/tmp'}/frontend.png` });

  console.log(`[frontend] verified: ${modes.length} mode cards on a title screen that fits,`
    + ` an afternoon that becomes a dusk the sun goes down and round for, with the fill`
    + ` rising as the key falls and ${Math.round((day.diff / day.total) * 100)}% of the`
    + ` picture changing, ${dusk.lamps} lamps that draw nothing at all until it gets late`
    + ` and then put ${glow.up} pixels of light into the picture without taking any out,`
    + ` no relay address on it, ${sections.length} settings sections, four screens inside`
    + ` the window, ${rows.length} rebindable controls in ${groups.length} groups with two`
    + ` keys each — rebound, cleared, stolen and reset, and the new key drove the game —`
    + ` and a frame-rate readout that stays off until asked: "${stats.text}"`);
}
