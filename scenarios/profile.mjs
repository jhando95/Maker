/**
 * Where the frame goes, measured on frames that really rendered a yard.
 *
 * `tools/bench.ts` times systems in isolation on a synthetic world. That is the
 * other half of this and not this one: it cannot say what a live frame in Tag
 * spends, because it never runs one. This does, and it leaves the table in the
 * CI log — so a change that doubles the cost of posing characters is visible in
 * the run that introduced it rather than six weeks later as "the game feels
 * worse now".
 *
 * ## What it does *not* assert
 *
 * Any absolute millisecond budget. This harness renders through SwiftShader on
 * a shared runner, where the numbers below are dominated by software
 * rasterisation and mean nothing about a real machine. Asserting a budget here
 * would be asserting a property of GitHub's fleet. What is asserted is
 * *structural*: that the parts add up to the whole, that nothing is negative,
 * and that the attribution moves when the work moves.
 *
 *   node tools/shoot.mjs --scenario scenarios/profile.mjs --out shots/profile.png
 */

const assert = (cond, message) => {
  if (!cond) throw new Error(`profile scenario: ${message}`);
};

const frames = (page, n) => page.evaluate((k) => new Promise((r) => {
  let seen = 0;
  const step = () => { if (++seen >= k) r(); else requestAnimationFrame(step); };
  requestAnimationFrame(step);
}), n);

const measure = async (page, label) => {
  const p = await page.evaluate(() => window.__maker.frameProfile());
  const rows = p.sections
    .slice().sort((a, b) => b.ms - a.ms)
    .map((s) => `${s.name} ${s.ms.toFixed(2)}ms ${(s.share * 100).toFixed(0)}%`)
    .join('  ');
  console.log(`[profile] ${label}: ${p.depth} frames, heaviest ${p.heaviest} | ${rows}`);
  return p;
};

export default async function (page) {
  await page.evaluate(() => window.__maker.hideOverlay());
  await frames(page, 90);
  const idle = await measure(page, 'an empty yard');

  assert(idle.depth > 30, `not enough frames to average: ${idle.depth}`);
  assert(idle.heaviest !== null, 'the profiler should be able to name a heaviest section');

  // Every section, plus the leftover, adds up to the frame. This is the claim
  // the whole design turns on: a profiler that quietly loses a third of the
  // frame tells you the parts you instrumented are fine and never mentions the
  // part that is not.
  const share = idle.sections.reduce((sum, s) => sum + s.share, 0);
  assert(
    Math.abs(share - 1) < 0.02,
    `the sections should account for the whole frame, and they cover ${(share * 100).toFixed(1)}%`,
  );
  for (const s of idle.sections) {
    assert(s.ms >= 0, `${s.name} reported a negative ${s.ms}ms`);
    assert(Number.isFinite(s.ms), `${s.name} reported ${s.ms}`);
  }

  // ── The attribution moves when the work does ───────────────────────────────
  //
  // The only functional claim worth making here, and the one that says the
  // sections are attached to something real rather than to a plausible-looking
  // constant: starting a round with a crowd in it has to show up in `sim`.
  const simIdle = idle.sections.find((s) => s.name === 'sim').ms;

  await page.evaluate(() => window.__maker.startRound('tag'));
  await frames(page, 150);
  const busy = await measure(page, 'Tag, six kids on the street');
  const simBusy = busy.sections.find((s) => s.name === 'sim').ms;

  assert(
    simBusy > simIdle * 1.5,
    `a round full of kids should cost more simulation than an empty lawn:`
    + ` ${simIdle.toFixed(2)}ms -> ${simBusy.toFixed(2)}ms`,
  );

  await page.evaluate(() => window.__maker.startRound('fortDefense'));
  await frames(page, 150);
  await measure(page, 'Fort Defense');

  console.log('[profile] verified: the sections account for the whole frame with nothing'
    + ' negative and nothing lost, and simulation cost rises with a crowd —'
    + ` ${simIdle.toFixed(2)}ms empty against ${simBusy.toFixed(2)}ms in Tag`);
}
