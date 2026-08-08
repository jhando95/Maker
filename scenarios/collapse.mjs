/**
 * Proves that what you build has to hold itself up.
 *
 * The title screen has said *"Build it yourself. Then find out if it holds."*
 * since the first commit, and for most of this project's life nothing ever
 * found out: a placement was checked for overlap and for bounds and for nothing
 * else, so a tower stood whether or not it had legs. `support.ts` decides what
 * is standing and `support.test.ts` checks that decision against thirty-odd
 * shapes — but both of those are arguments about boxes.
 *
 * Two things can only be settled here, with the real collision world and a real
 * body in it:
 *
 * 1. **That the physics and the support rule agree about contact.** One works
 *    in oriented boxes in a spatial hash, the other in axis-aligned boxes and a
 *    tolerance, and a structure the player can climb but the rule thinks is
 *    disconnected would collapse under them for no visible reason.
 * 2. **That the player falls.** That is the entire feature. A list of ids is
 *    not a collapse; a kid three metres up who is suddenly on the grass is.
 *
 *   node tools/shoot.mjs --scenario scenarios/collapse.mjs --out shots/collapse.png
 */

const assert = (cond, message) => {
  if (!cond) throw new Error(`collapse scenario: ${message}`);
};

/** A quarter turn about Z, which stands a post on its end. */
const UPRIGHT = { qx: 0, qy: 0, qz: Math.SQRT1_2, qw: Math.SQRT1_2 };

/** Clear lawn, well away from the house, the pool and everything else. */
const AT = { x: 6.5, z: 13.5 };

/**
 * A post on a post with a panel on top: three parts, one on the ground.
 *
 * Deliberately a shape with exactly one path down, so the answer to "what does
 * taking the bottom out do" is not open to interpretation. Posts are 1.5m long
 * on their local +X, so an upright one spans y 0 to 1.5 about a centre at 0.75.
 */
const TOWER = [
  { kind: 4, colorway: 0, x: AT.x, y: 0.75, z: AT.z, ...UPRIGHT },
  { kind: 4, colorway: 0, x: AT.x, y: 2.25, z: AT.z, ...UPRIGHT },
  { kind: 5, colorway: 0, x: AT.x, y: 3.025, z: AT.z, qx: 0, qy: 0, qz: 0, qw: 1 },
];

const parts = (page) => page.evaluate(() => window.__maker.stats().parts);

/** Wait for real frames rather than for a clock. */
const frames = (page, count) => page.evaluate((n) => new Promise((resolve) => {
  let seen = 0;
  const step = () => { if (++seen >= n) resolve(); else requestAnimationFrame(step); };
  requestAnimationFrame(step);
}), count);

export default async function (page) {
  // Into the world rather than behind the title menu, because the menu pauses
  // the loop — and a paused loop never runs `build.update`, so there is no
  // preview to ask about and every question about one answers "nothing is
  // wrong". The stamping and demolishing below go through debug hooks and work
  // either way, which is exactly why this was easy to miss.
  await page.evaluate(() => {
    window.__maker.hideOverlay();
    window.__maker.setHudVisible(false);
    window.__maker.lookAt(Math.PI, -0.2);
  });

  // ── Building it ────────────────────────────────────────────────────────────
  //
  // Through `stampThese`, which places an exact list with no aiming in it — the
  // shape is the subject here and a crosshair would only be a way for it to
  // come out different.
  const before = await parts(page);
  const built = await page.evaluate((rs) => window.__maker.blueprints.stampThese(rs), TOWER);
  assert(built, 'a post, a post and a panel on clear lawn should go down');
  assert(
    (await parts(page)) === before + TOWER.length,
    `all three parts should be standing, ${await parts(page)} against ${before + TOWER.length}`,
  );

  // ── Standing on it ─────────────────────────────────────────────────────────
  //
  // The check that the two worlds agree. If the collision world does not think
  // the panel is there, or the support rule does not think it is joined to
  // anything, this is where it shows — and it shows as a player who fell before
  // anybody demolished anything.
  const up = await page.evaluate(([x, z]) => {
    window.__maker.teleport(x, 3.4, z);
    // Long enough to fall the 30cm onto the panel and settle, driven by the
    // game's own clock rather than by frames: a body that has just been
    // teleported is in mid-air, and `onGround` is set by the controller's step.
    return window.__maker.runRound(1.5);
  }, [AT.x, AT.z]);
  assert(
    up.onGround === true,
    'the player should end up standing on the panel, not falling past it',
  );
  assert(
    up.y > 2.8,
    `and standing on it three metres up, not on the lawn: y ${up.y.toFixed(2)}`,
  );

  // ── Taking the top off does not bring the rest down ────────────────────────
  //
  // The control. Without it, "the tower fell" is equally consistent with a rule
  // that simply removes everything it can reach.
  const top = await page.evaluate(([x, z]) => window.__maker.blueprints.demolishNear(x, 3.025, z),
    [AT.x, AT.z]);
  assert(
    top.length === 1,
    `taking the panel should take the panel and nothing else, ${top.length} came down`,
  );
  assert(
    (await parts(page)) === before + 2,
    'and should leave both posts standing',
  );

  // ── Taking the bottom out brings all of it down ────────────────────────────
  await page.evaluate((rs) => window.__maker.blueprints.stampThese([rs[2]]), TOWER);
  assert((await parts(page)) === before + 3, 'the panel should go back on');

  const standing = await parts(page);
  const down = await page.evaluate(([x, z]) => window.__maker.blueprints.demolishNear(x, 0.75, z),
    [AT.x, AT.z]);
  assert(
    down.length === 3,
    `the whole tower should come down with its leg, not ${down.length} of it`,
  );
  assert(
    (await parts(page)) === standing - 3,
    `and leave the world with three fewer parts, saw ${await parts(page)}`,
  );

  // ── And the player is on the grass ─────────────────────────────────────────
  //
  // The one that matters, and the only claim in this file that could not be
  // made anywhere but a browser. Everything above is bookkeeping about ids; a
  // collapse is a kid who was three metres up and is not any more.
  const after = await page.evaluate(() => window.__maker.runRound(2));
  assert(
    after.onGround === true && after.y < 0.5,
    `the player should be back on the lawn, not standing on a tower that is not`
    + ` there: y ${after.y.toFixed(2)}, onGround ${after.onGround}`,
  );

  // ── A structure with two ways down keeps standing ──────────────────────────
  //
  // The rule is *is there a path to the ground*, not *is there something
  // underneath*. Two legs under one beam: take a leg and the beam stays up,
  // which is the difference between this and a stacking rule.
  const legs = [
    { kind: 4, colorway: 0, x: AT.x - 0.9, y: 0.75, z: AT.z, ...UPRIGHT },
    { kind: 4, colorway: 0, x: AT.x + 0.9, y: 0.75, z: AT.z, ...UPRIGHT },
    { kind: 3, colorway: 0, x: AT.x, y: 1.55, z: AT.z, qx: 0, qy: 0, qz: 0, qw: 1 },
  ];
  const spanned = await page.evaluate((rs) => window.__maker.blueprints.stampThese(rs), legs);
  assert(spanned, 'two legs and a beam across them should go down');
  const bridged = await parts(page);
  const oneLeg = await page.evaluate(([x, z]) => window.__maker.blueprints.demolishNear(x, 0.75, z),
    [AT.x - 0.9, AT.z]);
  assert(
    oneLeg.length === 1,
    `a beam with a second leg under it should stay up, ${oneLeg.length} came down`,
  );
  assert((await parts(page)) === bridged - 1, 'and only the leg should be gone');

  const lastLeg = await page.evaluate(([x, z]) => window.__maker.blueprints.demolishNear(x, 0.75, z),
    [AT.x + 0.9, AT.z]);
  assert(
    lastLeg.length === 2,
    `and once the last leg goes the beam goes with it, ${lastLeg.length} came down`,
  );

  // ── And it says so before the wood is spent ────────────────────────────────
  //
  // The ghost's third state. Removal can no longer strand a part — whatever it
  // was holding comes down with it — but *placing* still can, and a plank hung
  // in open air stays there. Warned rather than refused, because "find out if
  // it holds" is the game and a rule that never lets you try is not that.
  //
  // The reachable case is not "aim at the sky": the snapper hides the ghost
  // when the ray meets nothing, so a single placement is always against
  // something. It is **a stamp**, which anchors on one surface and can leave
  // its far end in the air — and then anything nailed to that far end. So the
  // set-up here is the one a player actually reaches: a floating plank, and a
  // second one aimed at it.
  const HANG = { x: AT.x + 5, y: 3.2, z: AT.z };
  const hung = await page.evaluate((h) => window.__maker.blueprints.stampThese([
    { kind: 0, colorway: 0, x: h.x, y: h.y, z: h.z, qx: 0, qy: 0, qz: 0, qw: 1 },
  ]), HANG);
  assert(hung, 'a plank should be placeable in mid-air, because nothing refuses it');

  // Stand first, *then* aim. `lookAtPoint` works out a direction from where the
  // eye is at the moment it is called, and a body that has just been teleported
  // is still falling — aiming before it lands points the ray sixty centimetres
  // under the target, which at three metres is a clean miss of a plank five
  // centimetres thick.
  await page.evaluate((h) => window.__maker.teleport(h.x, 0.6, h.z + 0.6), HANG);
  await page.waitForFunction(() => window.__maker.stats().player.onGround === true,
    null, { timeout: 8000 });
  await page.evaluate((h) => window.__maker.lookAtPoint(h.x, h.y, h.z), HANG);
  await frames(page, 3);

  const onHung = await page.evaluate(() => window.__maker.buildPreview());
  // The precondition, stated. Without it "would this hold" reads as yes when
  // there is no ghost on screen at all, which is true and useless.
  assert(onHung.aiming, 'there should be a preview on the floating plank to ask about');
  // *Where* it landed, not just that it landed. Standing almost underneath and
  // aiming up leaves the lawn out of the ray entirely, and without this the
  // check below could be answered by a plank lying on the grass.
  assert(
    onHung.at !== null && Math.abs(onHung.at.y - HANG.y) < 0.3,
    `the preview should be against the floating plank, and it is at`
    + ` ${JSON.stringify(onHung.at)}`,
  );
  assert(
    onHung.stands === false,
    'and a plank nailed to a floating plank is not held up by anything',
  );

  // The pulse is the cue, so it has to actually move.
  const watch = () => page.evaluate(() => new Promise((resolve) => {
    const seen = [];
    const step = () => {
      seen.push(window.__maker.buildPreview().opacity);
      if (seen.length >= 14) resolve(seen);
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }));
  const moving = await watch();
  const spread = Math.max(...moving) - Math.min(...moving);
  assert(
    spread > 0.05,
    `an unsupported preview should pulse, and this one moved ${spread.toFixed(3)}`,
  );

  // And hold still when there is nothing to warn about, or it is not a cue,
  // it is a flicker.
  await page.evaluate((h) => {
    window.__maker.lookAtPoint(h.x, 0, h.z);
  }, HANG);
  await frames(page, 4);
  const onLawn = await page.evaluate(() => window.__maker.buildPreview());
  assert(onLawn.aiming, 'there should be a preview on the lawn to ask about');
  assert(onLawn.stands === true, 'a plank aimed at the lawn is held up by the lawn');

  const steady = await watch();
  const drift = Math.max(...steady) - Math.min(...steady);
  assert(
    drift < 0.01,
    `a supported preview should hold still, and this one moved ${drift.toFixed(3)}`,
  );

  // ── And the warning, for somebody who cannot hear it ───────────────────────
  //
  // The collapse sound carries forty-eight metres against a placement's
  // twenty-four, and `gameSounds.collapsed` says why: in a mode where two
  // people are dismantling each other's forts it is the only warning the other
  // one gets. A player who cannot hear it is missing the warning, not the
  // flavour. Two claims, and the second is the one that keeps this honest.
  await page.evaluate(() => window.__maker.captions.on(true));
  const far = await page.evaluate(() => {
    const m = window.__maker;
    m.teleport(0, 0, 16);
    return m.playHalf();
  });
  await frames(page, 6);

  // One close enough to hear. Within arm's reach rather than across the lawn,
  // because `removeAtPoint` is a build action and build actions have a reach —
  // the first version of this put the wood six metres away and the removal ray
  // never got there, so nothing happened and nothing was captioned.
  //
  // Which direction it reports is *not* asserted here, and that is deliberate
  // rather than a gap: the hook aims the camera at whatever it is removing, so
  // the answer can only ever be "ahead", and contorting the game to make a
  // scenario say "behind" would be testing the fixture. The bearing is pure
  // arithmetic with seven unit tests on it, including left/right and the
  // ninety-degree split. What only a browser can say is the rest of it — that a
  // caption reaches the screen at all, and that it obeys the range of the sound
  // it stands in for.
  await page.evaluate(() => {
    const m = window.__maker;
    const p = m.stats().player;
    const path = m.layPlankPath(p.x - 0.5, p.z - 2.5, 2);
    m.removeAtPoint(path.top.x, path.top.y, path.top.z);
  });
  await frames(page, 6);
  const heard = await page.evaluate(() => window.__maker.captions.lines());
  assert(
    heard.length > 0,
    'wood coming apart two metres away should say so when captions are on',
  );

  // And one past the range of the sound it stands in for. This is the rule the
  // whole feature is built around: a caption that outran its sound would make
  // an accessibility option an advantage, which in a game four friends play is
  // its own kind of exclusion.
  await page.evaluate((half) => {
    const m = window.__maker;
    m.captions.on(false);
    m.captions.on(true);
    const path = m.layPlankPath(-(half - 4), -(half - 4), 3);
    m.removeAtPoint(path.top.x, path.top.y, path.top.z);
  }, far);
  await frames(page, 6);
  const silent = await page.evaluate(() => window.__maker.captions.lines());
  assert(
    silent.length === 0,
    `something past the range of its own sound should say nothing at all: ${JSON.stringify(silent)}`,
  );
  await page.evaluate(() => window.__maker.captions.on(false));

  console.log('[collapse] verified: a three-part tower stands and carries a player'
    + ` at ${up.y.toFixed(2)}m, its top comes off on its own, its leg takes all of it`
    + ` down, the player lands back on the lawn at ${after.y.toFixed(2)}m, and a beam`
    + ' with two legs under it survives losing one of them, and the preview says'
    + ` which is which before the wood is spent — pulsing ${spread.toFixed(2)} over open`
    + ` air and holding to ${drift.toFixed(3)} on the lawn — and that a player who`
    + ` cannot hear the wood come apart is told about it (${heard.map((l) => l.text).join(', ')})`
    + ' but never about one further away than the sound itself would have carried');
}
