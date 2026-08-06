/**
 * Proves the world can hold more than one person.
 *
 * The roster, teams and commands are unit-tested; what only exists in a browser
 * is the chain from "a second actor joined" through the renderer's instance
 * buffers to a body standing on the lawn that the local player can walk into.
 * This drives that path with no network attached, so when a transport arrives it
 * has something already known to work underneath it — and if it does not work,
 * the failure is here rather than tangled up with sockets.
 *
 *   node tools/shoot.mjs --scenario scenarios/actors.mjs --out shots/actors.png
 */

const assert = (cond, message) => {
  if (!cond) throw new Error(`actors scenario: ${message}`);
};

/** Frames, not milliseconds — the sim and the renderer both advance on them. */
const frames = (page, count) =>
  page.evaluate(
    (n) => new Promise((resolve) => {
      let seen = 0;
      const step = () => { if (++seen >= n) resolve(); else requestAnimationFrame(step); };
      requestAnimationFrame(step);
    }),
    count,
  );

const roster = (page) =>
  page.evaluate(() => ({
    ids: window.__maker.actors.all.map((a) => a.id),
    kinds: window.__maker.actors.all.map((a) => a.kind),
    teams: window.__maker.actors.all.map((a) => a.team),
  }));

const REMOTE_ID = 500;

export default async function (page) {
  await page.evaluate(() => {
    window.__maker.setAutoQuality(false);
    window.__maker.hideOverlay();
  });
  await frames(page, 2);

  // ── The player is an actor like any other ──────────────────────────────────
  const alone = await roster(page);
  assert(alone.ids.length === 1, `sandbox should hold just you, saw ${alone.ids.length}`);
  assert(alone.ids[0] === 0, `the local player is actor 0, saw ${alone.ids[0]}`);
  assert(alone.kinds[0] === 'local', `and is local, saw ${alone.kinds[0]}`);

  // ── A mode's bots join the roster, and leave it again ──────────────────────
  await page.evaluate(() => {
    window.__maker.startRound('captureTheFlag');
    window.__maker.fastForward(75);
  });
  await page.waitForFunction(() => window.__maker.actors.all.length > 1, null, { timeout: 30_000 })
    .catch(() => { throw new Error('actors scenario: the mode never put anyone in the roster'); });

  const playing = await roster(page);
  assert(playing.ids.length > 1, 'a capture phase should populate the roster');
  assert(
    playing.teams.includes('left') && playing.teams.includes('right'),
    `both sides should be represented, saw ${playing.teams.join(',')}`,
  );
  // Allies exist and are not the player.
  const allies = playing.teams.filter((t, i) => t === 'left' && playing.ids[i] !== 0).length;
  assert(allies > 0, 'you should not be the only one on your side');

  // ── A remote player, with no network to bring them ─────────────────────────
  const before = playing.ids.length;
  await page.evaluate((id) => {
    window.__maker.teleport(-10, 0.6, 6);
    window.__maker.addRemoteActor(id, 'left', -10, 0.6, 2);
  }, REMOTE_ID);
  await frames(page, 3);

  const joined = await roster(page);
  assert(joined.ids.includes(REMOTE_ID), 'a remote player should appear in the roster');
  assert(joined.ids.length === before + 1, `one more actor, saw ${joined.ids.length} from ${before}`);
  assert(
    joined.kinds[joined.ids.indexOf(REMOTE_ID)] === 'remote',
    'and should be marked remote rather than passing as a bot',
  );

  // ── They survive the mode churning its own bots ────────────────────────────
  // The roster is rebuilt from the mode's bots every tick. A remote player is
  // not the mode's to own, so a rebuild must not take them with it.
  await page.evaluate(() => window.__maker.fastForward(8));
  await frames(page, 3);
  const survived = await roster(page);
  assert(
    survived.ids.includes(REMOTE_ID),
    'a remote player must survive the roster being rebuilt from the mode',
  );

  // ── They move on their own commands ────────────────────────────────────────
  const start = await page.evaluate((id) => {
    const a = window.__maker.actors.get(id);
    return { x: a.controller.x, z: a.controller.z };
  }, REMOTE_ID);
  const playerStart = await page.evaluate(() => window.__maker.stats().player);

  let last = null;
  for (let i = 0; i < 90; i++) {
    last = await page.evaluate((id) => window.__maker.stepRemoteActor(id, 1, 0), REMOTE_ID);
  }
  assert(last !== null, 'stepping a remote actor should report where it got to');
  const moved = Math.hypot(last.x - start.x, last.z - start.z);
  assert(moved > 0.5, `a remote actor should move on its commands; went ${moved.toFixed(2)}m`);

  const playerNow = await page.evaluate(() => window.__maker.stats().player);
  const playerDrift = Math.hypot(playerNow.x - playerStart.x, playerNow.z - playerStart.z);
  assert(
    playerDrift < 0.2,
    `and must not drag the local player along; you moved ${playerDrift.toFixed(2)}m`,
  );

  // ── They wear their side's shirt ───────────────────────────────────────────
  // Read off the instance buffer rather than judged from the screenshot, which
  // cannot tell a violet ally from a washed-out stunned one. The draw index is
  // *not* the roster index: the renderer skips anyone who is down, so a soaked
  // bot shifts everyone after it — computing it the same way the renderer does
  // is the difference between this checking a colour and checking a coincidence.
  const shirt = await page.evaluate((id) => {
    // Straight from the order the rig actually drew in, rather than re-derived
    // from the roster: re-deriving it is re-implementing the renderer's own rule,
    // which is how a test ends up checking a coincidence instead of a colour.
    const drawIndex = window.__maker.drawnActorIds().indexOf(id);
    if (drawIndex < 0) return 'not-drawn';
    const mesh = window.__maker.scene.getObjectByName('characters')
      .getObjectByName('torso');
    const buf = mesh.instanceColor.array;
    const toSrgb = (v) =>
      Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055));
    return [0, 1, 2]
      .map((k) => toSrgb(buf[drawIndex * 3 + k]).toString(16).padStart(2, '0'))
      .join('');
  }, REMOTE_ID);
  // The left team's violet. Not the orange the right team wears, and not the
  // white an instance carries when nothing ever coloured it.
  assert(shirt === '7a3fc8', `a remote on your side should wear your colours, got #${shirt}`);

  // Frame them both so the screenshot shows two people on one lawn.
  await page.evaluate((id) => {
    const a = window.__maker.actors.get(id);
    window.__maker.lookAtPoint(a.controller.x, a.controller.y + 1, a.controller.z);
  }, REMOTE_ID);
  await frames(page, 3);
  await page.screenshot({ path: process.env.ACTORS_SHOT ?? 'shots/actors.png' });

  // ── And they can leave ─────────────────────────────────────────────────────
  await page.evaluate((id) => window.__maker.removeRemoteActor(id), REMOTE_ID);
  await frames(page, 3);
  const left = await roster(page);
  assert(!left.ids.includes(REMOTE_ID), 'a remote player who left should be gone from the roster');
  assert(left.ids.includes(0), 'and taking them out must not take you with them');

  console.log(
    '[actors] verified: the player is actor 0, both sides populate the roster,',
    'a remote joins, survives a rebuild, moves on its own commands, and leaves',
  );
}
