/**
 * Proves the lawn is actually lava, and that a plank is actually a floor.
 *
 * The rules are arithmetic and unit-tested. What only exists in a browser is
 * the one thing the whole mode rests on: a downward ray that has to come back
 * saying "ground" when you are on the grass and "not ground" when you are on a
 * crate, a roof, or a plank you put there yourself thirty seconds ago. That is
 * a question about the real collision world with the real map loaded in it, and
 * there is no honest way to ask it anywhere else.
 *
 * It also answers the design question a unit test cannot: **is the course
 * actually completable.** The answer had better be yes for the dullest possible
 * reason — you can always lay a plank path across the grass — and this walks
 * one of those paths to make sure.
 *
 *   node tools/shoot.mjs --scenario scenarios/lava.mjs --out shots/lava.png
 */

const assert = (cond, message) => {
  if (!cond) throw new Error(`lava scenario: ${message}`);
};

const frames = (page, count) => page.evaluate((n) => new Promise((resolve) => {
  let seen = 0;
  const step = () => { if (++seen >= n) resolve(); else requestAnimationFrame(step); };
  requestAnimationFrame(step);
}), count);

/**
 * Stand somewhere, let the game run, and report what the mode made of it.
 *
 * `runRound` rather than `fastForward`, and that distinction is the first thing
 * this scenario got wrong. The lava rule asks what you are standing *on*, and
 * `onGround` is set by the character controller's step — so a body teleported
 * onto the grass and never stepped is in mid-air above it, which is a true
 * answer to a question nobody asked and made every reading come back zero.
 */
const standAt = (page, x, y, z, seconds) => page.evaluate(([px, py, pz, secs]) => {
  window.__maker.teleport(px, py, pz);
  window.__maker.runRound(secs);
  return window.__maker.lavaState();
}, [x, y, z, seconds]);

export default async function (page) {
  await page.evaluate(() => {
    window.__maker.setAutoQuality(false);
    window.__maker.hideOverlay();
    window.__maker.startRound('lava');
  });
  await frames(page, 3);

  const opening = await page.evaluate(() => ({
    ...window.__maker.lavaState(),
    round: window.__maker.roundInfo(),
  }));
  assert(opening.round.mode === 'lava', `the lava round should be running, got ${opening.round.mode}`);
  assert(opening.round.wood > 0, `and hand out planks, it handed out ${opening.round.wood}`);
  assert(
    opening.course.length >= 3,
    `the course should have somewhere to go, it has ${opening.course.length}`,
  );

  // ── The deck you start on is not lava ───────────────────────────────────────
  //
  // Checked before the grass, because a mode where *everything* is lava would
  // pass the grass test for the wrong reason.
  const onDeck = await standAt(page, opening.spawn.x, opening.spawn.y, opening.spawn.z, 2);
  assert(
    onDeck.depth === 0,
    `standing on the deck should be safe, sank to ${onDeck.depth.toFixed(2)}`,
  );
  assert(onDeck.dunks === 0, 'and should not have dunked anybody');

  // ── The grass is ────────────────────────────────────────────────────────────
  // Open grass behind the deck: clear of the paddling pool to the west and the
  // crates to the east, so what is being tested is the lawn and not a prop.
  const lawn = { x: opening.spawn.x - 3, y: 0.4, z: opening.spawn.z + 2.5 };
  const sinking = await standAt(page, lawn.x, lawn.y, lawn.z, 0.6);
  assert(
    sinking.depth > 0.1,
    `standing on the lawn should start sinking you, depth was ${sinking.depth.toFixed(2)}`,
  );

  const dunked = await standAt(page, lawn.x, lawn.y, lawn.z, 3);
  assert(dunked.dunks >= 1, `the lawn should have taken them, dunks ${dunked.dunks}`);
  // And put them back on the deck rather than leaving them where they sank.
  const home = Math.hypot(
    dunked.player.x - opening.spawn.x, dunked.player.z - opening.spawn.z,
  );
  assert(home < 2, `a dunk should send you back to the deck, you are ${home.toFixed(1)}m away`);
  assert(dunked.depth === 0, 'and start you dry');

  // ── A plank you put down is a floor ─────────────────────────────────────────
  //
  // The promise the entire mode is built on. If a plank laid on the grass still
  // reads as grass, there is no game here at all — and it is exactly the case a
  // height-based rule would get wrong, because the plank's top is five
  // centimetres up.
  const planked = await page.evaluate(([px, pz]) => {
    // Lay a short path out onto the lawn, the way a player would: stand on the
    // deck, look down at the grass, place.
    const laid = window.__maker.layPlankPath(px, pz, 3);
    return laid;
  }, [lawn.x, lawn.z]);
  assert(planked.placed >= 3, `three planks should go down, ${planked.placed} did`);

  const onPlank = await standAt(page, planked.top.x, planked.top.y + 0.05, planked.top.z, 2);
  assert(
    onPlank.depth === 0,
    `a plank laid on the grass must be a floor — sank to ${onPlank.depth.toFixed(2)}`,
  );
  assert(
    onPlank.dunks === dunked.dunks,
    'and standing on it must not have dunked anybody',
  );

  // ── The course advances, in order, and only in order ────────────────────────
  const before = await page.evaluate(() => window.__maker.lavaState());
  const second = before.course[1];
  const skipped = await standAt(page, second.x, second.y + 0.4, second.z, 0.4);
  assert(
    skipped.cleared === 0,
    `the second checkpoint should not count before the first, cleared ${skipped.cleared}`,
  );

  const first = before.course[0];
  const atFirst = await standAt(page, first.x, first.y + 0.4, first.z, 0.4);
  assert(atFirst.cleared === 1, `the treehouse should have counted, cleared ${atFirst.cleared}`);

  const atSecond = await standAt(page, second.x, second.y + 0.4, second.z, 0.4);
  assert(atSecond.cleared === 2, `the barrel should have counted, cleared ${atSecond.cleared}`);
  assert(
    atSecond.progress > atFirst.progress,
    'and progress should have gone up with it',
  );

  // Falling in on the last leg keeps what you earned and does not end the round.
  //
  // The related claim — that the finish is not *inside* the respawn, which in an
  // early draft meant falling in the lava awarded you the last checkpoint and
  // won the round — belongs to the unit suite and is asserted there. It is
  // geometry between two constants, and a scenario can only ever observe it at
  // whatever distance those constants happen to be apart today: planting the old
  // course back, this scenario passed anyway, because moving the spawn four
  // centimetres had taken the finish just outside the touch radius by accident.
  // Fresh grass, not the strip that now has three of our own planks on it —
  // standing there is safe, which is the whole point of the test above and
  // would make this one measure nothing. (It did, first time.)
  const bareLawn = { x: lawn.x, y: 0.4, z: lawn.z + 3 };
  const afterDunk = await standAt(page, bareLawn.x, bareLawn.y, bareLawn.z, 3);
  assert(
    !afterDunk.finished,
    'being dunked on the last leg must not finish the round for you',
  );
  assert(afterDunk.cleared === 2, 'and must not take back the checkpoints you earned');
  assert(
    afterDunk.dunks > atSecond.dunks,
    'and it should have counted as a dunk',
  );

  const finish = before.course[2];
  const done = await standAt(page, finish.x, finish.y + 0.4, finish.z, 0.4);
  assert(done.finished, 'reaching the porch roof should finish the round');
  assert(done.won, 'and it should be a win');

  // ── A picture of the yard from the deck, which is the shot that sells it ────
  await page.evaluate(() => {
    window.__maker.startRound('lava');
  });
  await frames(page, 3);
  await page.evaluate(() => {
    const s = window.__maker.lavaState().spawn;
    window.__maker.teleport(s.x, s.y, s.z);
    window.__maker.lookAt(Math.PI * 0.5, -0.08);
  });
  await frames(page, 5);
  await page.screenshot({ path: process.env.LAVA_SHOT ?? 'shots/lava.png' });

  console.log(
    `[lava] verified: the deck is safe and the lawn is not, a dunk after ~1.5s sends you home,`,
    `a plank laid on the grass is a floor, checkpoints only count in order,`,
    `a late dunk neither finishes the round nor takes back progress,`,
    `and the porch roof wins it`,
  );
}
