/**
 * Proves the water fight works end to end, in a real browser, on the real map.
 *
 * The unit tests drive the mode against a bare CollisionWorld and can say the
 * arithmetic is right. What they cannot say is whether the loop the player
 * actually performs — get sent to a raid, run dry, find a tap, fill up, hose
 * a kid — holds together once the mode is wired to the shell, the HUD and the
 * neighbourhood's own geometry. Every step below has broken at that seam at
 * least once while the rest of the suite stayed green.
 *
 *   node tools/shoot.mjs --scenario scenarios/water.mjs --out shots/water.png
 */

const assert = (cond, message) => {
  if (!cond) throw new Error(`water scenario: ${message}`);
};

/** Everything the scenario judges by, read out of the live mode in one hop. */
const state = (page) =>
  page.evaluate(() => {
    const m = window.__maker.getMode();
    const hud = m.hud();
    return {
      id: m.id,
      phase: hud.phase,
      timer: hud.timer,
      building: m.buildingAllowed,
      tank: m.tankLevel ?? null,
      wetness: m.playerWetness ?? null,
      out: m.playerIsOut ?? false,
      stream: m.stream === null || m.stream === undefined ? null : { ...m.stream },
      bots: m.bots.filter((b) => b.alive).length,
      water: m.sources === undefined ? null : m.sources.map((s) => Math.round(s.water)),
      weapons: m.loadout === undefined ? [] : m.loadout.entries.map((e) => ({
        id: e.id, ready: e.ready,
      })),
      selected: m.loadout === undefined ? null : m.loadout.selected,
      markers: m.markers().length,
      // What the player can actually see of all this.
      tankBar: document.querySelector('.maker-tank .track i')?.style.width ?? null,
      tankLabel: document.querySelector('.maker-tank .cap')?.textContent ?? null,
      soakBar: document.querySelector('.maker-soak .track i')?.style.width ?? null,
      soakLabel: document.querySelector('.maker-soak .cap')?.textContent ?? null,
      vignette: Number(document.querySelector('.maker-vignette')?.style.opacity ?? '0'),
      pips: document.querySelectorAll('.maker-ammo .pip').length,
      help: document.querySelector('.maker-help')?.textContent ?? '',
      statusShown: document.querySelector('.maker-status')?.offsetParent !== null,
    };
  });

/**
 * Wait until the HUD has repainted for a given phase.
 *
 * `fastForward` drives the simulation directly, but the HUD only redraws on an
 * animation frame, so reading the DOM straight after one is a race — and it is
 * the *fast* machine that loses it, since fewer simulated seconds pass per frame
 * and the repaint is more likely to still be pending. This passed on every local
 * run at 5fps under software GL and failed first time on a CI runner.
 *
 * The phase banner is the signal because `updateMode` writes it and the ammo,
 * help and status elements in one synchronous pass: if the banner has caught up,
 * everything else in that pass has too. Waiting on the banner rather than on the
 * thing being asserted keeps the assertions honest — a genuinely missing tank
 * gauge still fails as a missing tank gauge, not as a timeout.
 */
async function painted(page, phase) {
  await page
    .waitForFunction(
      (p) => (document.querySelector('.maker-mode .phase')?.textContent ?? '').includes(p),
      phase,
      { timeout: 30_000 },
    )
    .catch(() => {
      throw new Error(`water scenario: the HUD never repainted for phase ${phase}`);
    });
}

/**
 * Send every kid home for a moment.
 *
 * The mechanics measured below — a stream drawing, a tank emptying, a tap
 * refilling — are about water, not about winning a firefight. Left alone the
 * player stands motionless at a tap while four kids pelt them, and a knockout
 * mid-measurement stops the tank draining and teleports them off the tap: the
 * assertion then fails for a reason with nothing to do with what it checks.
 * That is exactly how this first went red on CI, at 0.55 wetness and climbing
 * on the machine where it passed.
 *
 * Soaking them buys a clean window, and is the same thing the unit tests do.
 */
const clearTheLawn = (page) =>
  page.evaluate(() => {
    for (const bot of window.__maker.getMode().bots) {
      for (let i = 0; i < 12 && bot.alive; i++) bot.soak();
    }
  });

export default async function (page) {
  await page.evaluate(() => {
    window.__maker.setAutoQuality(false);
    window.__maker.startRound('waterWar');
    window.__maker.hideOverlay();
  });

  // ── The build phase ────────────────────────────────────────────────────────
  await painted(page, 'BUILD');
  const built = await state(page);
  assert(built.id === 'waterWar', `expected the water mode, got ${built.id}`);
  assert(built.building, 'you should be able to build before the first raid');
  assert(built.markers === 3, `three taps to defend, saw ${built.markers}`);
  assert(built.water.every((w) => w > 0), `every tap should start full, saw ${built.water}`);
  assert(built.pips === 0, 'no ammo pips during the build phase');
  assert(/parts/.test(built.help), `build hints while building, saw "${built.help}"`);
  assert(built.statusShown, 'the snap readout belongs on screen while building');

  // ── Into a raid ────────────────────────────────────────────────────────────
  await page.evaluate(() => window.__maker.fastForward(75, 'RAID 1/4'));
  await painted(page, 'RAID');
  const raid = await state(page);
  assert(raid.phase.startsWith('RAID'), `should be raiding, phase is ${raid.phase}`);
  assert(!raid.building, 'building is off once the kids are on the lawn');
  assert(raid.bots > 0, 'a raid needs kids in it');
  assert(raid.timer !== null && raid.timer > 0, 'a raid must show how long is left to hold');
  assert(raid.weapons.length === 3, `three things to fight with, saw ${raid.weapons.length}`);

  // The tank is a gauge, not a hundred pips. This regressed the moment the mode
  // reused the ammo field, and a hundred pips is a thousand pixels of them.
  assert(raid.pips === 0, `the tank must not render as pips, saw ${raid.pips}`);
  assert(raid.tankBar !== null, 'the tank should be drawn as a bar');
  assert(/L$/.test(raid.tankLabel ?? ''), `the tank should read in litres, saw ${raid.tankLabel}`);

  // Hints that name keys which do nothing right now read as broken controls.
  assert(/soak/.test(raid.help), `combat hints during a raid, saw "${raid.help}"`);
  assert(!/tilt/.test(raid.help), `build hints should be gone, saw "${raid.help}"`);
  assert(!raid.statusShown, 'the snap readout should go with the build controls');

  // The hose is tethered, so away from a tap it must be offered but not usable.
  const hose = raid.weapons.find((w) => w.id === 'hose');
  assert(hose !== undefined, 'the hose should be in the loadout');

  // ── The stream is drawn ────────────────────────────────────────────────────
  // First, on a full tank and an unsoaked player, and with the lawn cleared:
  // every one of those is a precondition for a stream existing at all, so
  // measuring this at the end of a firefight was testing the wrong thing.
  await clearTheLawn(page);
  await page.evaluate(() => window.__maker.lookAt(0, 0));
  await page.evaluate(() => window.__maker.fastForward(1.5, undefined, true));
  const streaming = await state(page);
  assert(!streaming.out, 'the player should still be in the fight for this check');
  assert(streaming.tank > 0, `and should have water; tank is ${streaming.tank}`);
  assert(streaming.stream !== null, 'holding fire with water in the tank should draw a stream');

  // ── Firing empties the tank ────────────────────────────────────────────────
  const fullTank = streaming.tank;
  await page.evaluate(() => window.__maker.fastForward(3, undefined, true));
  const fired = await state(page);
  assert(fired.tank < fullTank, `firing should cost water; ${fullTank} -> ${fired.tank}`);

  // Run it dry and check the stream stops rather than firing for free.
  await page.evaluate(() => window.__maker.fastForward(20, undefined, true));
  const dry = await state(page);
  assert(dry.tank < 1, `the tank should run dry, sitting at ${dry.tank}`);
  assert(dry.stream === null, 'an empty tank must not still be drawing a stream');

  // ── Refilling at a tap ─────────────────────────────────────────────────────
  // Stand in the paddling pool. The refill is proximity-based, so this is the
  // whole interaction: the mode has to notice, and it has to cost the tap.
  // Lawn cleared again — being knocked off the tap mid-fill would fail this for
  // reasons that have nothing to do with refilling.
  await clearTheLawn(page);
  const poolWater = dry.water[0];
  await page.evaluate(() => {
    const m = window.__maker.getMode();
    const pool = m.sources[0];
    window.__maker.teleport(pool.x, 0.6, pool.z);
  });
  await page.evaluate(() => window.__maker.fastForward(4));
  const filled = await state(page);
  assert(!filled.out, 'the player should not have been knocked off the tap');
  assert(filled.tank > dry.tank + 10, `standing in the pool should refill; still ${filled.tank}`);
  assert(
    filled.water[0] < poolWater,
    `a refill has to come out of the tap; it stayed at ${filled.water[0]}`,
  );

  // ── Being soaked is visible before it is fatal ─────────────────────────────
  // Drive the player's own meter up and check the screen says so. A meter
  // nobody can see is the same as no meter.
  //
  // Kept topped up while we wait rather than soaked once and read: the HUD only
  // redraws on an animation frame, software GL renders a handful a second, and
  // wetness dries in about three. Reading straight after the fast-forward races
  // the repaint and would fail on a fast machine and pass on a slow one.
  await page
    .waitForFunction(() => {
      const m = window.__maker.getMode();
      if (m.playerWetness < 0.7) {
        window.__maker.projectiles.spawn(
          window.__maker.player.x, window.__maker.player.y + 4, window.__maker.player.z,
          0, -1, 0, 14, 99,
        );
        window.__maker.fastForward(0.3);
      }
      return document.querySelector('.maker-soak .track i') !== null
        && Number(document.querySelector('.maker-vignette')?.style.opacity ?? '0') > 0;
    }, null, { timeout: 30_000 })
    .catch(() => {
      throw new Error('water scenario: being soaked never showed up on screen');
    });
  const soaked = await state(page);
  assert(soaked.wetness > 0.25, `the player should be visibly wet, at ${soaked.wetness}`);
  assert(soaked.soakBar !== null, 'a wetness meter should be on screen');
  assert(
    soaked.soakLabel === 'WET' || soaked.soakLabel === 'SOAKED',
    `the wetness meter needs a label, saw "${soaked.soakLabel}"`,
  );
  assert(soaked.vignette > 0, `the screen edge should bead up, opacity ${soaked.vignette}`);

  await page.screenshot({ path: process.env.WATER_SHOT ?? 'shots/water.png' });

  console.log(
    '[water] verified: build phase, raid starts, tank empties and refills from a tap,',
    'stream draws, wetness shows on the HUD and at the screen edge',
  );
}
