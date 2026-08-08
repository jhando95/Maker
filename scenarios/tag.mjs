/**
 * Freeze Tag, in the real game, on the real field.
 *
 * Two claims that only a browser can settle, and one of them is the reason the
 * mode exists at all.
 *
 * The first is the field. Tag is the only mode played outside the fence, and
 * "outside the fence" is not a setting anywhere — it is a routing grid wide
 * enough to reach the turning head and a set of bots willing to follow it out
 * of the gate. Both of those are simulation, and the unit tests do check them,
 * but they check them against a world a test built. This asks the game.
 *
 * The second is that a mode with no weapon, no ammo, no wetness and no lumber
 * reaches a HUD that was written for modes that have all four. Every previous
 * mode filled in every field; this one fills in almost none, and the ways that
 * goes wrong — a blank banner, a meter drawn for a null, an empty part wheel —
 * are all pixels.
 */
const assert = (c, m) => { if (!c) throw new Error(`tag scenario: ${m}`); };

export default async function (page) {
  await page.evaluate(() => {
    window.__maker.setAutoQuality(false);
    window.__maker.hideOverlay();
    window.__maker.startRound('tag');
  });

  // ── It, and the head start ──────────────────────────────────────────────────

  const opening = await page.evaluate(() => {
    const mode = window.__maker.getMode();
    return {
      id: mode.id,
      phase: mode.hud().phase,
      building: mode.buildingAllowed,
      kids: mode.bots.length,
      it: mode.isIt(0),
      player: { x: window.__maker.player.x, z: window.__maker.player.z },
      kidZ: mode.bots.map((b) => b.z),
    };
  });
  assert(opening.id === 'tag', `the round should be tag, got ${opening.id}`);
  assert(opening.phase === 'READY', `should open on the head start, got ${opening.phase}`);
  assert(opening.building === false, 'there is no building in tag');
  assert(opening.kids >= 4, `the neighbourhood should turn up, got ${opening.kids}`);
  assert(opening.it, 'the player is It');
  assert(opening.player.z > 8, `It starts down the back garden, at z=${opening.player.z}`);
  assert(
    opening.kidZ.every((z) => z < 0),
    `and the kids start at the front, at ${opening.kidZ.map((z) => z.toFixed(0)).join(', ')}`,
  );

  // The HUD has to say all that. A mode with nothing in its hands still has a
  // banner, a clock and a count, and those are the whole of what a player has
  // to go on here.
  const hud = await page.evaluate(() => {
    const h = window.__maker.getMode().hud();
    return {
      phase: h.phase, timer: h.timer, primary: h.primary,
      ammo: h.ammo, wetness: h.wetness, lumber: h.lumber ?? null,
    };
  });
  assert(hud.timer > 0, 'the head start is on the clock');
  assert(hud.primary !== null && hud.primary.label === 'Running',
    `the banner should count runners, got ${JSON.stringify(hud.primary)}`);
  assert(hud.ammo === null && hud.wetness === null,
    'and should offer no meters for things this mode does not have');
  assert(hud.lumber === null, 'and no plank count');

  // ── The kids leave the lot ──────────────────────────────────────────────────

  // The claim the whole mode rests on. The cul-de-sac has been scenery since
  // the day it was built; if the kids will not run out onto it then this is
  // still a mode played in a garden.
  const fled = await page.evaluate(() => {
    window.__maker.fastForward(8.5);
    window.__maker.fastForward(24);
    const mode = window.__maker.getMode();
    return {
      phase: mode.hud().phase,
      z: mode.bots.map((b) => b.z),
      x: mode.bots.map((b) => b.x),
    };
  });
  assert(fled.phase === 'TAG', `the chase should have started, phase is ${fled.phase}`);
  const outside = fled.z.filter((z) => z < -26).length;
  assert(
    outside >= 1,
    `somebody should be out on the street, kids are at z=${fled.z.map((z) => z.toFixed(0)).join(', ')}`,
  );

  // ── A tag, and a pin ────────────────────────────────────────────────────────

  const caught = await page.evaluate(() => {
    const mode = window.__maker.getMode();
    const victim = mode.bots[0];
    // Walk It into somebody. Teleported rather than driven, because what is
    // under test here is the rule, and the drive is what the mantle and item
    // scenarios are for.
    window.__maker.teleport(victim.x, victim.y + 0.1, victim.z);
    window.__maker.fastForward(0.2);
    const pins = mode.markers();
    return {
      frozen: mode.isFrozen(victim.id),
      washed: mode.wetnessOf(victim.id),
      running: mode.hud().primary.value,
      its: pins.filter((m) => m.kind === 'flag').length,
      waiting: pins.filter((m) => m.kind === 'bucket').length,
    };
  });
  assert(caught.frozen, 'walking into a kid should freeze them');
  assert(caught.washed === 1, 'and wash them out, so it reads at a glance');
  assert(caught.its === 1, `It should be pinned, got ${caught.its} pins`);
  assert(caught.waiting === 1, `and so should the frozen kid, got ${caught.waiting}`);

  // The pins reach the renderer, which is a different question from the mode
  // publishing them — every previous mode's markers stood still, and these
  // two follow people.
  const drawn = await page.evaluate(async () => {
    // One frame, so the renderer has been asked. `markersDrawn` counts the
    // pooled objects that are visible, which is the far end of the chain from
    // `markers()` — a mode can publish more objectives than there are stands
    // and lose the surplus without a word.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return window.__maker.roundInfo().markersDrawn;
  });
  assert(drawn === 2, `both pins should be drawn, renderer sees ${drawn}`);

  // ── The HUD drops what this mode does not have ──────────────────────────────

  // Every element here belongs to a mode that has a plank or a balloon, and Tag
  // has neither. Left alone they are a part chip for a part you cannot place, a
  // snap readout for a placement that cannot happen, and a row of key hints for
  // keys that do nothing — which reads as the controls being broken.
  const chrome = await page.evaluate(() => {
    const hidden = (sel) => {
      const el = document.querySelector(sel);
      return el === null || el.classList.contains('maker-hidden');
    };
    return {
      chip: hidden('.mk-chip'),
      status: hidden('.maker-status'),
      ammo: hidden('.maker-ammo'),
      banner: hidden('.maker-mode'),
      help: (document.querySelector('.maker-help')?.textContent ?? ''),
    };
  });
  assert(chrome.chip, 'the part chip has no business in a mode with no parts');
  assert(chrome.status, 'nor does the snap readout');
  assert(chrome.ammo, 'nor a tank, in a mode with nothing to fill');
  assert(!chrome.banner, 'but the banner is the whole HUD here and must be up');
  assert(
    !/snap|repeat|parts/i.test(chrome.help),
    `and the help should not offer building keys, it says "${chrome.help}"`,
  );
  assert(
    !/soak|fill up/i.test(chrome.help),
    `nor the water fight's, which is what it inherited, it says "${chrome.help}"`,
  );
  assert(/sprint/i.test(chrome.help), `it should offer the verbs this mode has: "${chrome.help}"`);

  // And nothing in your hands. `holdingWeapon` was "building is off", which was
  // the same thing until a mode arrived with neither a plank nor a soaker —
  // and put a water cannon in the hands of somebody playing a game about
  // running away.
  const hands = await page.evaluate(() => window.__maker.heldItem());
  assert(hands === null, `tag hands you nothing, the viewmodel shows ${hands}`);

  // ── A frame worth looking at ────────────────────────────────────────────────

  // Out on the street, looking back at the lot: the half of the map this mode
  // added, with the house it belongs to behind it.
  await page.evaluate(() => {
    window.__maker.teleport(0, 1.5, -33);
    window.__maker.lookAt(Math.PI, -0.02);
  });
  await page.screenshot({ path: `${process.env.RUNNER_TEMP ?? '/tmp'}/tag.png` });

  console.log(`[tag] verified: It and ${opening.kids} kids, no building and no meters,`
    + ` ${outside} of them out past the fence on the street, a tag freezes and washes out,`
    + ` and both moving pins reach the renderer`);
}
