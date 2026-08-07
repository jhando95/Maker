/**
 * Does a long session grow?
 *
 * Every scenario in this repository so far asks whether something *works*.
 * This one asks whether doing it two hundred times costs more than doing it
 * twice, which is a different question and the one no unit test can reach: a
 * leak is invisible in the code that causes it and invisible in a thirty-second
 * playtest, and it arrives as "the game gets worse the longer you play" three
 * weeks after the commit.
 *
 * This project has a lot of places for one to hide. `PartRenderer` and
 * `PropBatch` throw away buckets and rebuild them whenever anybody builds;
 * `TagDecals` rebuilds a mesh per shape whenever the paint changes;
 * `NightLights` builds an instanced mesh; every mode change replaces a roster
 * of characters. Each of those disposes something, and "disposes something" is
 * exactly the kind of claim that is true of the code somebody wrote and false
 * of the code after the next change.
 *
 * ## Why the first cycle does not count
 *
 * A first round legitimately allocates: the first tag mesh, the first program
 * for a material nobody had drawn, the buckets for a size of plank that had not
 * been used. That is a cache filling, not a leak. So the baseline is taken
 * *after* a warm-up cycle and the claim is about cycles two onward — the shape
 * of every honest leak test, and the reason a naive one is all false positives.
 *
 *   node tools/shoot.mjs --scenario scenarios/soak.mjs --out shots/soak.png
 */

const assert = (cond, message) => {
  if (!cond) throw new Error(`soak scenario: ${message}`);
};

const frames = (page, n) => page.evaluate((k) => new Promise((r) => {
  let seen = 0;
  const step = () => { if (++seen >= k) r(); else requestAnimationFrame(step); };
  requestAnimationFrame(step);
}), n);

const MODES = ['captureTheFlag', 'waterWar', 'fortDefense', 'tag', 'lava'];

/**
 * One cycle of everything that churns the renderer.
 *
 * Deliberately the real entry points rather than the systems underneath: a
 * soak that called `PropBatch.rebuild` directly would pass with the whole
 * build path leaking, and the build path is where a player spends the round.
 */
async function cycle(page, n) {
  await page.evaluate(async (i) => {
    const m = window.__maker;
    const modes = ['captureTheFlag', 'waterWar', 'fortDefense', 'tag', 'lava'];
    m.startRound(modes[i % modes.length]);

    // Build a path, paint it, take it down. Each of those rebuilds a batch.
    const path = m.layPlankPath(-6 + (i % 3), 4 + (i % 3), 6);
    m.spray.take(true);
    for (let k = 0; k < 6; k++) {
      m.spray.style(k, k);
      m.spray.at(path.top.x, path.top.y, path.top.z);
    }
    m.removeAtPoint(path.top.x, path.top.y, path.top.z);

    // The lamps come up and go down, which builds and empties a glow mesh.
    m.setTimeOfDay('dusk');
    m.setTimeOfDay('afternoon');
    m.stopRound();
  }, n);
  // Let the frames that actually rebuild and draw run, or the whole cycle is
  // queued work that never happened.
  await frames(page, 12);
}

const read = (page) => page.evaluate(() => window.__maker.renderMemory());

const show = (label, m) =>
  `${label}: ${m.geometries} geometries, ${m.textures} textures,`
  + ` ${m.programs} programs, ${m.nodes} nodes`;

export default async function (page) {
  await page.evaluate(() => window.__maker.hideOverlay());
  await frames(page, 30);

  console.log(`[soak] ${show('cold', await read(page))}`);

  // The warm-up. Two cycles rather than one, because a cache with a capacity of
  // one entry fills on the first and evicts on the second, and calling the
  // second one a leak is how a soak test earns a reputation for crying wolf.
  await cycle(page, 0);
  await cycle(page, 1);
  const base = await read(page);
  console.log(`[soak] ${show('warm', base)}`);

  // Two halves rather than one long run, because a threshold on total growth
  // cannot tell the two failures apart: a cache that fills over the first
  // dozen cycles and then stops is fine, and a leak of the same size over the
  // same dozen is not, and both look like "grew by five". A cache flattens.
  // A leak keeps the same slope, so the second half is the whole assertion and
  // the first half is only there to give the caches somewhere to go.
  const HALF = 12;
  for (let i = 2; i < 2 + HALF; i++) await cycle(page, i);
  const mid = await read(page);
  console.log(`[soak] ${show(`after ${HALF}`, mid)}`);

  for (let i = 2 + HALF; i < 2 + HALF * 2; i++) await cycle(page, i);
  const after = await read(page);
  console.log(`[soak] ${show(`after ${HALF * 2}`, after)}`);

  for (const key of ['geometries', 'textures', 'programs', 'nodes']) {
    const first = mid[key] - base[key];
    const second = after[key] - mid[key];
    assert(
      second === 0,
      `${key} was still growing after ${HALF} warm cycles: ${base[key]} -> ${mid[key]}`
      + ` -> ${after[key]} (+${first} then +${second} over ${HALF} identical cycles each).`
      + ` A cache flattens; this has a slope, and a session long enough to matter`
      + ` is a session that runs out of memory`,
    );
  }

  // And the game is still a game afterwards, which a soak that only counted
  // objects would never notice: a batch can stop leaking by never drawing.
  await page.evaluate(() => window.__maker.startRound('tag'));
  await frames(page, 20);
  const stats = await page.evaluate(() => window.__maker.stats());
  assert(stats.drawCalls > 20, `the world stopped drawing after the soak: ${stats.drawCalls} draws`);
  assert(stats.triangles > 1000, `nothing left to rasterise: ${stats.triangles} triangles`);

  console.log(`[soak] verified: ${HALF * 2} identical rounds of building, painting,`
    + ` demolishing, nightfall and a mode change, and the last ${HALF} of them cost`
    + ` nothing that lasts — geometries ${base.geometries} -> ${mid.geometries}`
    + ` -> ${after.geometries}, programs ${base.programs} -> ${mid.programs}`
    + ` -> ${after.programs}, scene nodes ${base.nodes} -> ${after.nodes}, and it`
    + ` still draws ${stats.drawCalls} calls afterwards`);
}
