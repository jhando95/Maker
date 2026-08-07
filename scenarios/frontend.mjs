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
    + ` the window, and a frame-rate readout that stays off until asked: "${stats.text}"`);
}
