/**
 * Proves that building costs something, and that the screen says so.
 *
 * The budget is the first rule that can make a legal placement fail, and the
 * unit tests can only show that the number moves. What they cannot show is
 * whether the player is ever told: a ghost that stays green over an empty stack,
 * or a counter that never reaches the banner, is a budget the player discovers
 * by clicking and getting nothing.
 *
 * It also pins the thing most likely to break quietly — that Free Build stayed
 * free. A sandbox that silently acquired a budget would pass every test above.
 *
 *   node tools/shoot.mjs --scenario scenarios/lumber.mjs --out shots/lumber.png
 */

const assert = (cond, message) => {
  if (!cond) throw new Error(`lumber scenario: ${message}`);
};

/**
 * Wait for the HUD to have actually repainted.
 *
 * The banner is written on animation frames, so reading the DOM straight after
 * changing game state reads the frame before the change.
 */
const frames = (page, count) =>
  page.evaluate(
    (n) => new Promise((resolve) => {
      let seen = 0;
      const step = () => { if (++seen >= n) resolve(); else requestAnimationFrame(step); };
      requestAnimationFrame(step);
    }),
    count,
  );

/**
 * Wait until the player has stopped moving.
 *
 * A teleport drops you above the ground and the solver pushes you out of
 * whatever you landed in, so for the first few frames the eye is still moving.
 * Everything here aims a ray from that eye and then aims the same ray again to
 * remove what it placed, which only works if the eye did not shift in between —
 * and how far it shifts depends on how many frames elapsed, which is exactly
 * the thing that differs between this machine and a CI runner.
 */
const settle = async (page) => {
  await page.waitForFunction(
    () => {
      const at = () => {
        const p = window.__maker.stats().player;
        return `${p.onGround}:${p.x.toFixed(2)}:${p.y.toFixed(2)}:${p.z.toFixed(2)}`;
      };
      return new Promise((resolve) => {
        const first = at();
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const p = window.__maker.stats().player;
          resolve(p.onGround && at() === first);
        }));
      });
    },
    null, { timeout: 15_000 },
  ).catch(() => { throw new Error('lumber scenario: the player never stopped moving'); });
};

const banner = (page) =>
  page.evaluate(() => {
    // Through the panel's own visibility, not just the DOM: leaving a round
    // hides the banner rather than emptying it, and a scenario that read the
    // stale cells would call a hidden counter "shown".
    const panel = document.querySelector('.maker-mode');
    const visible = panel !== null && !panel.classList.contains('maker-hidden');
    const cell = visible
      ? [...panel.querySelectorAll('.cell')]
        .find((c) => c.querySelector('.cap')?.textContent === 'wood')
      : undefined;
    const val = cell?.querySelector('.val') ?? null;
    return {
      present: cell !== undefined,
      value: val?.textContent ?? null,
      short: val?.classList.contains('short') ?? false,
      chipCost: document.querySelector('.mk-chip .cost')?.textContent ?? null,
    };
  });

export default async function (page) {
  // ── A metered mode charges, and says the price ─────────────────────────────
  await page.evaluate(() => {
    window.__maker.setAutoQuality(false);
    window.__maker.startRound('fortDefense');
    window.__maker.hideOverlay();
    // Somewhere flat with room, looking at the ground a couple of metres off.
    window.__maker.teleport(6, 0.6, 10);
    window.__maker.lookAt(Math.PI, -0.5);
  });
  await settle(page);
  await frames(page, 3);

  const opening = await page.evaluate(() => window.__maker.lumber());
  assert(!opening.unlimited, 'a mode must not hand out an unlimited pile');
  assert(opening.available > 0, `a build phase should start with wood, saw ${opening.available}`);
  assert(opening.cost >= 1, `the held part must cost something, saw ${opening.cost}`);

  const first = await banner(page);
  assert(first.present, 'the banner should carry a wood cell while building is allowed');
  assert(
    first.value === String(opening.available),
    `the banner should read the stack; banner "${first.value}" vs ${opening.available}`,
  );
  assert(
    first.chipCost === `${opening.cost} wood`,
    `the part chip should price what you are holding, saw "${first.chipCost}"`,
  );

  // ── Placing spends, and removing gives it back ─────────────────────────────
  const placed = await page.evaluate(() => {
    const before = window.__maker.lumber().available;
    const cost = window.__maker.lumber().cost;
    const ok = window.__maker.placeAt(Math.PI, -0.5);
    return { ok, before, cost, after: window.__maker.lumber().available };
  });
  assert(placed.ok, 'the scenario needs a legal placement to measure against');
  assert(
    placed.after === placed.before - placed.cost,
    `placing should cost ${placed.cost}; went ${placed.before} -> ${placed.after}`,
  );

  await frames(page, 3);
  const spentBanner = await banner(page);
  assert(
    spentBanner.value === String(placed.after),
    `the banner should follow the stack down; saw "${spentBanner.value}"`,
  );

  const reclaimed = await page.evaluate(() => {
    // Aim at where the part actually landed rather than at the angle that put
    // it there: placement snaps to a surface, so the two rays differ.
    const at = window.__maker.lastPlacedAt();
    const ok = at !== null && window.__maker.removeAtPoint(at.x, at.y, at.z);
    return { ok, after: window.__maker.lumber().available };
  });
  assert(reclaimed.ok, 'the part just placed should be removable');
  assert(
    reclaimed.after === placed.before,
    `taking it down should refund in full; ${placed.before} -> ${reclaimed.after}`,
  );

  // ── An empty stack refuses, and the screen shows it before you try ─────────
  const denied = await page.evaluate(() => {
    window.__maker.setLumber(0);
    const parts = window.__maker.stats().parts;
    const ok = window.__maker.placeAt(Math.PI, -0.5);
    return { ok, parts, after: window.__maker.stats().parts, state: window.__maker.lumber() };
  });
  assert(!denied.ok, 'placing with an empty stack should fail');
  assert(denied.after === denied.parts, 'and a refused placement must not touch the world');
  assert(!denied.state.affordable, 'the build system should know it cannot afford the part');

  await frames(page, 3);
  const brokeBanner = await banner(page);
  assert(brokeBanner.value === '0', `an empty stack should read zero, saw "${brokeBanner.value}"`);
  assert(
    brokeBanner.short,
    'and it must be marked short — a counter the player has to do arithmetic on is not a warning',
  );

  // The ghost is the other half of that: red means this will not go in, and
  // running out is exactly that.
  //
  // Both readings are taken over the same legal placement, so the only thing
  // that differs between them is the stack. Comparing a red ghost over a wall
  // with a green one over open lawn would prove nothing.
  const tint = await page.evaluate(() => {
    const hex = (n) => `#${n.toString(16).padStart(6, '0')}`;
    const broke = hex(window.__maker.ghostTint());
    window.__maker.setLumber(500);
    const placed = window.__maker.placeAt(Math.PI, -0.5);
    const rich = hex(window.__maker.ghostTint());
    const at = window.__maker.lastPlacedAt();
    if (placed && at !== null) window.__maker.removeAtPoint(at.x, at.y, at.z);
    return { broke, rich, placed };
  });
  assert(tint.placed, 'the ghost comparison needs the same placement to be legal both times');
  assert(
    tint.broke !== tint.rich,
    `the ghost must change colour when you cannot afford the part; both were ${tint.broke}`,
  );

  // ── Free Build stayed free ─────────────────────────────────────────────────
  await page.evaluate(() => {
    window.__maker.stopRound();
    window.__maker.hideOverlay();
    window.__maker.teleport(6, 0.6, 10);
    window.__maker.lookAt(Math.PI, -0.5);
  });
  await settle(page);
  await frames(page, 3);

  const sandbox = await page.evaluate(() => window.__maker.lumber());
  assert(sandbox.unlimited, 'free build must not meter wood');
  assert(sandbox.affordable, 'and everything must be affordable in it');

  const sandboxBanner = await banner(page);
  assert(!sandboxBanner.present, 'free build has no banner to put a wood count on');
  assert(sandboxBanner.chipCost === null, 'and the chip should not price parts that are free');

  const freePlace = await page.evaluate(() => {
    const ok = window.__maker.placeAt(Math.PI, -0.5);
    return { ok, unlimited: window.__maker.lumber().unlimited };
  });
  assert(freePlace.ok, 'free build should still place');
  assert(freePlace.unlimited, 'and spend nothing doing it');

  // Back to a metered round for the screenshot, so the shot shows the counter.
  await page.evaluate(() => {
    window.__maker.startRound('fortDefense');
    window.__maker.hideOverlay();
    window.__maker.teleport(6, 0.6, 10);
    window.__maker.lookAt(Math.PI, -0.35);
  });
  await frames(page, 6);
  await page.screenshot({ path: process.env.LUMBER_SHOT ?? 'shots/lumber.png' });

  console.log(
    '[lumber] verified: opening stack charged per part and refunded in full,',
    'an empty stack refuses and says so on the banner and in the ghost,',
    'and free build is still free',
  );
}
