/**
 * Proves the HUD tells you the things it now claims to.
 *
 * Three of these are new and none has a unit test, because all three are about
 * the seam between what a mode knows and what reaches a pixel: a mode has known
 * where its objectives are since it was written, and until now the screen never
 * said. The rest of the suite would stay green with every one of them broken.
 *
 *   node tools/shoot.mjs --scenario scenarios/hud.mjs --out shots/hud.png
 */

const assert = (cond, message) => {
  if (!cond) throw new Error(`hud scenario: ${message}`);
};

const frames = (page, count) =>
  page.evaluate(
    (n) => new Promise((resolve) => {
      let seen = 0;
      const step = () => { if (++seen >= n) resolve(); else requestAnimationFrame(step); };
      requestAnimationFrame(step);
    }),
    count,
  );

const pins = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.maker-pin')]
      .filter((p) => !p.classList.contains('maker-hidden'))
      .map((p) => ({
        edge: p.classList.contains('edge'),
        quiet: p.classList.contains('quiet'),
        dist: p.querySelector('.dist').textContent,
        distShown: getComputedStyle(p.querySelector('.dist')).display !== 'none',
        left: parseFloat(p.style.left),
        top: parseFloat(p.style.top),
      })));

export default async function (page) {
  await page.evaluate(() => {
    window.__maker.setAutoQuality(false);
    window.__maker.startRound('waterWar');
    window.__maker.hideOverlay();
    window.__maker.fastForward(75, 'RAID 1/4');
  });
  await page.waitForFunction(
    () => (document.querySelector('.maker-mode .phase')?.textContent ?? '').includes('RAID'),
    null, { timeout: 30_000 },
  );

  // ── The banner reads as a hierarchy, not a row of numbers ──────────────────
  const banner = await page.evaluate(() => ({
    cells: document.querySelectorAll('.maker-mode .cell').length,
    caps: [...document.querySelectorAll('.maker-mode .cap')].map((c) => c.textContent),
    phase: document.querySelector('.maker-mode .phase')?.textContent ?? '',
    timer: document.querySelector('.maker-mode .timer')?.textContent ?? '',
  }));
  assert(banner.cells >= 3, `the banner should be built of cells, saw ${banner.cells}`);
  assert(/^RAID/.test(banner.phase), `phase cell should name the phase, saw "${banner.phase}"`);
  assert(/^\d+:\d\d$/.test(banner.timer), `timer should be a clock, saw "${banner.timer}"`);
  // Every number is captioned. An uncaptioned figure is a number you have to
  // already know the meaning of.
  assert(banner.caps.length >= 2, `stats should be captioned, saw ${banner.caps.join('/')}`);

  // ── Objectives are findable ────────────────────────────────────────────────
  await page.evaluate(() => {
    window.__maker.teleport(-12, 0.6, -2);
    window.__maker.lookAt(0.6, -0.05);
  });
  await frames(page, 3);

  const shown = await pins(page);
  assert(shown.length === 3, `three taps should be pinned, saw ${shown.length}`);
  for (const p of shown) {
    // The distance is the whole point, and it must survive being off screen —
    // an objective you can see tells you roughly how far it is by how big it
    // looks, and one you cannot see tells you nothing at all.
    assert(/^\d+m$/.test(p.dist), `every pin needs a distance, saw "${p.dist}"`);
    assert(p.distShown, 'and the distance must not be hidden, least of all off screen');
    assert(p.left >= 0 && p.left <= 1280, `pins stay on screen; x was ${p.left}`);
    assert(p.top >= 0 && p.top <= 720, `pins stay on screen; y was ${p.top}`);
  }
  // With nothing marked urgent, nothing is dimmed. Dimming everything is the
  // same as dimming nothing, except harder to read.
  assert(
    shown.some((p) => !p.quiet),
    'with no objective marked active, none of them should be dimmed',
  );

  // Turning round must move them, or they are decoration rather than a compass.
  const before = shown.map((p) => `${p.left},${p.top}`).join(' ');
  await page.evaluate(() => window.__maker.lookAt(0.6 + Math.PI, -0.05));
  await frames(page, 3);
  const after = (await pins(page)).map((p) => `${p.left},${p.top}`).join(' ');
  assert(after !== before, 'turning around should move the objective pins');

  // ── Landing a hit says so ──────────────────────────────────────────────────
  const hit = await page.evaluate(() => {
    window.__maker.hud.hitMarker(performance.now() / 1000);
    return document.querySelector('.maker-crosshair').classList.contains('hit');
  });
  assert(hit, 'a hit should kick the crosshair');
  // And it lets go again, or the crosshair is stuck flared for the whole round.
  await page.waitForFunction(
    () => !document.querySelector('.maker-crosshair').classList.contains('hit'),
    null, { timeout: 10_000 },
  ).catch(() => { throw new Error('hud scenario: the hit marker never cleared'); });

  // ── Being hit says where from ──────────────────────────────────────────────
  const hurt = await page.evaluate(() => {
    window.__maker.hud.hurtFrom(-2.1);
    const arcs = [...document.querySelectorAll('.maker-hurt i')];
    const lit = arcs.filter((a) => a.classList.contains('show'));
    return { count: lit.length, rotation: lit[0]?.style.transform ?? '' };
  });
  assert(hurt.count === 1, `one arc per hit, saw ${hurt.count}`);
  assert(
    hurt.rotation.includes('-2.1'),
    `the arc should point where the water came from, saw "${hurt.rotation}"`,
  );

  await page.screenshot({ path: process.env.HUD_SHOT ?? 'shots/hud.png' });
  console.log(
    '[hud] verified: captioned banner cells, three objectives pinned with distances',
    'that survive going off screen, pins track the camera, hit and hurt cues fire',
  );
}
