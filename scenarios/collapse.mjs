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

export default async function (page) {
  await page.evaluate(() => {
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

  console.log('[collapse] verified: a three-part tower stands and carries a player'
    + ` at ${up.y.toFixed(2)}m, its top comes off on its own, its leg takes all of it`
    + ` down, the player lands back on the lawn at ${after.y.toFixed(2)}m, and a beam`
    + ' with two legs under it survives losing one of them');
}
