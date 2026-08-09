/**
 * Proves the ground reaches the screen as ground rather than as a flat colour.
 *
 * This whole pass started from a measurement taken off screenshots: one colour
 * covered between fifteen and forty-one per cent of every frame, because the
 * lawn was a single four-hundred-metre plane in a single green. The fix lives in
 * two places the unit suite cannot follow — a vertex `color` attribute that has
 * to survive the toon shader, and ten thousand instanced clumps that have to
 * survive `InstancedMesh` tinting.
 *
 * Both have already failed in ways nothing but a picture would have caught:
 *
 *   - Asking a toon material for `vertexColors` on the instanced clumps defines
 *     USE_COLOR with no geometry attribute behind it, and every clump renders
 *     black. At this size that reads as scattered litter, not as a shader bug.
 *   - Vertex colours reaching nothing at all leaves the lawn a uniform white
 *     multiplied by the light — which still looks like a lawn, in a screenshot,
 *     until you notice no path has been walked into it anywhere.
 *
 * Two claims that belong to this pass are deliberately not here, both because
 * the browser version of them was written, passed, and then failed to fail when
 * the fix was taken back out:
 *
 *   - Grass growing up through the street, which this scenario found on its
 *     first run. From straight above the blades are edge-on and cover almost no
 *     pixels, so removing the keep-out moved the count by half a per cent. That
 *     claim lives in `scene.test.ts`, checked against the street's footprint.
 *   - "The lawn is many colours rather than one." Ten thousand individually
 *     tinted clumps put hundreds of colours on screen whether or not the ground
 *     under them is flat. `ground.test.ts` measures the tone spread directly.
 *
 *   node tools/shoot.mjs --scenario scenarios/lawn.mjs --out shots/lawn.png
 */

import { decode } from '../tools/imgdiff.mjs';

const assert = (cond, message) => {
  if (!cond) throw new Error(`lawn scenario: ${message}`);
};

const TMP = process.env.RUNNER_TEMP ?? '/tmp';

/**
 * A patch of frame containing nothing but the ground under the player's feet.
 *
 * Off to one side of the placement ghost, which hangs in the middle of every
 * first-person frame and is a pale mint — near enough to grass to be counted as
 * some, and quite far enough from it to move an average.
 */
const GROUND_PATCH = { x: 830, y: 260, width: 250, height: 200 };

/** Wait for the renderer to actually paint, rather than for a wall clock. */
const frames = (page, count) =>
  page.evaluate(
    (n) => new Promise((resolve) => {
      let seen = 0;
      const step = () => { if (++seen >= n) resolve(); else requestAnimationFrame(step); };
      requestAnimationFrame(step);
    }),
    count,
  );

/** Wait until the player has landed and stopped, so the camera is where it will stay. */
const settle = (page) =>
  page.waitForFunction(() => {
    const at = () => {
      const p = window.__maker.stats().player;
      return `${p.onGround}:${p.x.toFixed(2)}:${p.y.toFixed(2)}:${p.z.toFixed(2)}`;
    };
    return new Promise((resolve) => {
      const first = at();
      requestAnimationFrame(() => requestAnimationFrame(() => {
        resolve(window.__maker.stats().player.onGround && at() === first);
      }));
    });
  }, { timeout: 8000 });

/**
 * Stand at (x, z) and look straight down at the ground.
 *
 * Straight down on purpose: a shallow angle puts the sky, the fence and half the
 * scenery in frame, and then everything measured from it is a measurement of
 * the props instead.
 *
 * Standing rather than hovering, and settled before aiming, because the obvious
 * version of this — teleport ten metres up and photograph on the next frame —
 * photographs the player mid-fall. The camera height then depends on how many
 * frames the runner managed in that time, so the framing, and therefore every
 * proportion taken from it, is a measurement of the machine.
 */
async function overhead(page, x, z) {
  await page.evaluate(({ px, pz }) => window.__maker.teleport(px, 1.2, pz), { px: x, pz: z });
  await settle(page);
  await page.evaluate(({ px, pz }) => window.__maker.lookAtPoint(px, -8, pz + 0.001), { px: x, pz: z });
  await frames(page, 3);
}

/** The average colour of a shot, and how bare it reads. */
function averageColor(path) {
  const { ch, px } = decode(path);
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < px.length; i += ch) {
    r += px[i];
    g += px[i + 1];
    b += px[i + 2];
    n++;
  }
  r /= n;
  g /= n;
  b /= n;
  // Grass is a green: its green channel sits well above its red. Bare earth is
  // a brown, which is a dark yellow, so the two converge and then cross. The
  // sign of this number is what the whole wear system comes down to.
  return { r, g, b, bareness: r - g };
}

/** Stand somewhere, look down, and report the ground. */
async function groundAt(page, name, x, z) {
  await overhead(page, x, z);
  await page.screenshot({ path: `${TMP}/lawn-${name}.png`, clip: GROUND_PATCH });
  return averageColor(`${TMP}/lawn-${name}.png`);
}

/** Every pixel of a full frame, sorted into what a lawn is allowed to be. */
function survey(path) {
  const { w, h, ch, px } = decode(path);
  const counts = { green: 0, dark: 0, other: 0 };
  const buckets = new Set();
  for (let i = 0; i < px.length; i += ch) {
    const r = px[i];
    const g = px[i + 1];
    const b = px[i + 2];
    buckets.add(`${r >> 3},${g >> 3},${b >> 3}`);
    if (r + g + b < 110) counts.dark++;
    // `r > b` is doing real work: grass is a yellow-green and has more red in
    // it than blue, and the placement ghost is a mint that does not.
    else if (g > r + 12 && g > b + 25 && r > b) counts.green++;
    else counts.other++;
  }
  const total = w * h;
  return { buckets: buckets.size, green: counts.green / total, dark: counts.dark / total };
}

export default async function (page) {
  await page.evaluate(() => {
    window.__maker.setAutoQuality(false);
    window.__maker.hideOverlay();
    window.__maker.setHudVisible(false);
    window.__maker.setCameraMode('first');
  });

  // Open lawn out by the front fence: nothing built on it, no mode sending
  // anybody across it, and several metres of clear space in every direction so
  // the frame is ground and only ground.
  const clean = await groundAt(page, 'clean', -6, 18);
  await page.screenshot({ path: `${TMP}/lawn-clean-full.png` });
  const wide = survey(`${TMP}/lawn-clean-full.png`);

  assert(
    clean.g > clean.r + 35 && clean.g > clean.b + 80,
    `the ground on open lawn averages rgb(${clean.r.toFixed(0)}, ${clean.g.toFixed(0)}, ${clean.b.toFixed(0)}), which is not grass — something is standing between the camera and the lawn`,
  );
  assert(
    wide.green > 0.8,
    `looking straight down at open lawn is only ${(wide.green * 100).toFixed(1)}% green`,
  );
  assert(
    wide.dark < 0.005,
    `${(wide.dark * 100).toFixed(1)}% of an empty lawn is near-black; the grass clumps are rendering unlit, which is exactly what asking an InstancedMesh for vertexColors does`,
  );

  // The stash in the fort yard — somewhere every mode sends people, and the
  // most worn piece of ground on the map with room to stand on it. Same camera,
  // same height, same framing; the only difference is the traffic.
  //
  // This pair is the load-bearing assertion of the scenario, and not only for
  // the wear. The dirt exists nowhere but the vertex `color` attribute, so if
  // vertex colours ever stop reaching the toon shader the lawn goes back to one
  // uniform green and this difference collapses to nothing.
  const worn = await groundAt(page, 'worn', -12, -13);

  assert(
    worn.bareness > clean.bareness + 30,
    `the ground at the stash reads ${worn.bareness.toFixed(0)} against ${clean.bareness.toFixed(0)} out on open lawn — the wear is not reaching the screen`,
  );

  // Finally, the thing the whole pass is for, from somewhere a player actually
  // stands rather than from a camera chosen to make the point.
  await page.evaluate(() => {
    window.__maker.teleport(-6, 0.5, 14);
    window.__maker.lookAtPoint(4, 0.4, -6);
  });
  await settle(page);
  await frames(page, 3);
  await page.screenshot({ path: `${TMP}/lawn-eye.png` });
  const eye = survey(`${TMP}/lawn-eye.png`);
  console.log(
    '[lawn]',
    JSON.stringify({
      cleanBareness: +clean.bareness.toFixed(1),
      wornBareness: +worn.bareness.toFixed(1),
      cleanGreen: +wide.green.toFixed(3),
      cleanDark: +wide.dark.toFixed(4),
      eyeBuckets: eye.buckets,
    }),
  );
  assert(eye.buckets > 300, `an eye-level view of the yard is only ${eye.buckets} distinct colours`);
}
