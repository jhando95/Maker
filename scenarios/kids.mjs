/**
 * Proves the character rig reaches the screen.
 *
 * The unit suite can check that a matrix moved and a shell exists. What it
 * cannot check is whether any of that becomes pixels — and this rig is almost
 * entirely a claim about pixels. Two of the three things it is for went wrong in
 * ways no test would have caught and only a screenshot did: the eyes were placed
 * at 0.86 of the head radius, which is *inside* the skull, so every face was
 * blank; and the hair box was anchored at its centre, so the tall variants grew
 * downwards over the face instead of upwards.
 *
 * The ink is checked by taking the same picture twice, with the character
 * outlines on and off, and counting how many pixels changed. A one-pixel line
 * round a distant kid is invisible to the eye in a screenshot and unmistakable
 * in that number — which is the difference between verifying the pass and hoping.
 *
 *   node tools/shoot.mjs --scenario scenarios/kids.mjs --out shots/kids.png
 */

import { diffPixels } from '../tools/imgdiff.mjs';

const assert = (cond, message) => {
  if (!cond) throw new Error(`kids scenario: ${message}`);
};

const frames = (page, count) =>
  page.evaluate(
    (n) => new Promise((resolve) => {
      let seen = 0;
      const step = () => { if (++seen >= n) resolve(); else requestAnimationFrame(step); };
      requestAnimationFrame(step);
    }),
    count,
  );

const TMP = process.env.RUNNER_TEMP ?? '/tmp';

export default async function (page) {
  await page.evaluate(() => {
    window.__maker.setAutoQuality(false);
    window.__maker.hideOverlay();
    window.__maker.teleport(-20, 0.5, 2.5);
    // Three of them, so the seeded variety is on screen rather than asserted.
    for (let i = 0; i < 3; i++) {
      window.__maker.addRemoteActor(90 + i, i === 1 ? 'right' : 'left', -21.4 + i * 1.4, 0.5, -1.6);
    }
  });
  await frames(page, 3);

  // ── Everybody is drawn by the one rig ──────────────────────────────────────
  const drawn = await page.evaluate(() => ({
    ids: window.__maker.drawnActorIds(),
    posed: window.__maker.charactersPosed(),
    thirdPerson: false,
  }));
  assert(drawn.ids.length === 3, `three remotes should be drawn, saw ${drawn.ids.length}`);
  assert(!drawn.ids.includes(0), 'and not the local player, who is inside their own head');
  assert(
    drawn.posed === drawn.ids.length,
    `the rig should pose everyone it was handed; ${drawn.posed} of ${drawn.ids.length}`,
  );

  // The local player is one of the kids the moment the camera can see them.
  // This is the claim the whole rig exists for, and it used to be false: the
  // player was a blue capsule with a yellow ball on top, drawn by other code.
  const third = await page.evaluate(() => {
    window.__maker.setCameraMode('third');
    return null;
  });
  void third;
  await frames(page, 3);
  const withPlayer = await page.evaluate(() => ({
    ids: window.__maker.drawnActorIds(),
    posed: window.__maker.charactersPosed(),
  }));
  assert(
    withPlayer.ids.includes(0),
    'in third person the local player should be drawn like everyone else',
  );
  assert(
    withPlayer.posed === 4,
    `and by the same rig — expected 4 posed, saw ${withPlayer.posed}`,
  );

  await page.evaluate(() => window.__maker.setCameraMode('first'));
  await frames(page, 3);

  // ── They have faces, and the faces point somewhere ─────────────────────────
  //
  // Read off the instance buffer: an eye buried inside the head still has a
  // matrix, and the only thing that distinguishes "on the face" from "in the
  // skull" is where it is relative to the head.
  const face = await page.evaluate(() => {
    const group = window.__maker.scene.getObjectByName('characters');
    const read = (name, slot) => {
      const mesh = group.getObjectByName(name);
      const m = mesh.instanceMatrix.array;
      const o = slot * 16;
      return { x: m[o + 12], y: m[o + 13], z: m[o + 14] };
    };
    return { head: read('head', 0), eyeL: read('eyes', 0), eyeR: read('eyes', 1) };
  });
  const eyeGap = Math.hypot(face.eyeL.x - face.eyeR.x, face.eyeL.z - face.eyeR.z);
  assert(eyeGap > 0.08, `two eyes should be apart, they were ${eyeGap.toFixed(3)}m`);
  for (const [name, eye] of [['left', face.eyeL], ['right', face.eyeR]]) {
    const out = Math.hypot(eye.x - face.head.x, eye.z - face.head.z);
    // The head is 0.235m at scale 1. An eye inside that radius is not a face.
    assert(
      out > 0.16,
      `the ${name} eye should sit on the head, not in it — ${out.toFixed(3)}m from centre`,
    );
    assert(eye.y < face.head.y, 'and below the crown, where eyes are');
  }

  // ── They are different people ──────────────────────────────────────────────
  const looks = await page.evaluate(() => {
    const group = window.__maker.scene.getObjectByName('characters');
    const hair = group.getObjectByName('hair');
    const out = [];
    for (let i = 0; i < 3; i++) {
      const c = hair.instanceColor.array;
      out.push([c[i * 3], c[i * 3 + 1], c[i * 3 + 2]].map((v) => v.toFixed(3)).join(','));
    }
    return out;
  });
  assert(new Set(looks).size > 1, 'a lawn full of people should not be a lawn full of one person');

  // ── The walk cycle actually moves ──────────────────────────────────────────
  const legAt = () => page.evaluate(() => {
    const m = window.__maker.scene.getObjectByName('characters')
      .getObjectByName('leg0').instanceMatrix.array;
    return [...m.slice(0, 16)].join(',');
  });
  await page.evaluate(() => {
    for (const id of [90, 91, 92]) window.__maker.stepRemoteActor(id, 0, 0.9);
  });
  await frames(page, 2);
  const strideA = await legAt();
  for (let i = 0; i < 10; i++) {
    await page.evaluate(() => {
      for (const id of [90, 91, 92]) window.__maker.stepRemoteActor(id, 0, 0.9);
    });
  }
  await frames(page, 2);
  const strideB = await legAt();
  assert(strideA !== strideB, 'a walking kid should not hold one pose');

  // ── The ink reaches pixels ─────────────────────────────────────────────────
  await page.evaluate(() => {
    window.__maker.setHudVisible(false);
    window.__maker.teleport(-20, 0.5, 1.4);
    window.__maker.lookAtPoint(-20, 1.1, -1.6);
  });
  await frames(page, 4);
  await page.screenshot({ path: `${TMP}/kids-ink-on.png` });
  await page.evaluate(() => window.__maker.setCharacterOutlines(false));
  await frames(page, 4);
  await page.screenshot({ path: `${TMP}/kids-ink-off.png` });
  await page.evaluate(() => window.__maker.setCharacterOutlines(true));
  await page.evaluate(() => window.__maker.setHudVisible(true));

  const { diff, total } = diffPixels(`${TMP}/kids-ink-on.png`, `${TMP}/kids-ink-off.png`);
  // Three kids filling a fair slice of the frame. A line one pixel wide round
  // each of nine parts is thousands of pixels; a shell that never renders is
  // zero. The bar sits far below the former and far above the latter.
  assert(
    diff > 500,
    `the characters' ink should reach the screen — only ${diff} of ${total} pixels changed`,
  );

  await frames(page, 3);
  await page.screenshot({ path: process.env.KIDS_SHOT ?? 'shots/kids.png' });
  console.log(
    `[kids] verified: one rig draws everyone including the local player in third person,`,
    `eyes sit on the face and not in the skull, kids differ from each other,`,
    `the walk cycle advances, and the ink moves ${diff} pixels`,
  );
}
