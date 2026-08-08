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

/**
 * Wait for the game to be in a state, never for a number of frames.
 *
 * Switching between first and third person is *eased* — `showsPlayer` is
 * `modeBlend > 0.2` and the blend takes a while to cross it, a while whose
 * length is a function of the frame time. So "three frames after asking for
 * first person" is not "in first person", it is a bet on how fast the machine
 * is, and the bet came due on a CI runner: the local player was still in the
 * roster, four kids were drawn, and an assertion that three mouths should be
 * on screen failed saying `4 of 3`.
 *
 * Same root cause as every scenario failure on this project — asserting on
 * state that had not been established — and the same fix as the last three.
 */
const until = (page, fn, what, timeout = 20000) =>
  page.waitForFunction(fn, undefined, { timeout, polling: 'raf' })
    .catch(() => { throw new Error(`kids scenario: ${what}`); });

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
  await page.evaluate(() => { window.__maker.setCameraMode('third'); });
  await until(
    page,
    () => window.__maker.drawnActorIds().includes(0),
    'the local player never joined the roster in third person',
  );
  // One more frame, so `charactersPosed` is a count of the frame that drew them
  // rather than of the one before it.
  await frames(page, 1);
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
  await until(
    page,
    () => !window.__maker.drawnActorIds().includes(0),
    'the local player never left the roster in first person',
  );
  await frames(page, 1);

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
      // The scale comes off the first basis column, because heads vary in size
      // by a fifth and every claim below is a *fraction* of the head's radius.
      // An absolute bound in metres cannot tell a well-placed eye on a big head
      // from a badly placed one on a small head — which is exactly the mistake
      // the placement itself made.
      return {
        x: m[o + 12], y: m[o + 13], z: m[o + 14], count: mesh.count,
        scale: Math.hypot(m[o], m[o + 1], m[o + 2]),
      };
    };
    return {
      head: read('head', 0),
      eyeL: read('eyes', 0),
      eyeR: read('eyes', 1),
      mouth: read('mouth', 0),
      neck: read('neck', 0),
    };
  });
  const eyeGap = Math.hypot(face.eyeL.x - face.eyeR.x, face.eyeL.z - face.eyeR.z);
  assert(eyeGap > 0.08, `two eyes should be apart, they were ${eyeGap.toFixed(3)}m`);
  // The head is 0.235m before its own scale, and both ends of this have been
  // wrong. At 0.86 of the radius the eyes sat *inside* the skull and every face
  // was blank. Then they were placed at an offset whose length nobody had
  // checked — `(0.35, -0.12, -1)` is 1.07 long, not 1 — which put them past the
  // surface with a quarter-radius of eyeball still to come: invisible face on,
  // a black bead stuck to the temple from the side.
  const HEAD_RADIUS = 0.235 * face.head.scale;
  const from = (p) => Math.hypot(
    p.x - face.head.x, p.y - face.head.y, p.z - face.head.z,
  ) / HEAD_RADIUS;
  for (const [name, eye] of [['left', face.eyeL], ['right', face.eyeR]]) {
    const out = from(eye);
    assert(
      out > 0.9 && out < 1.02,
      `the ${name} eye should sit on the head, not in it or off it`
        + ` — ${out.toFixed(3)} of a head radius from the centre`,
    );
    assert(eye.y < face.head.y, 'and below the crown, where eyes are');
  }

  // A mouth, which for a long time there was not one of. Two dots on a blank
  // face is a doll; the third mark is what makes it a kid.
  assert(
    face.mouth.count === 3,
    `every kid should have a mouth drawn, ${face.mouth.count} of 3 were`,
  );
  assert(face.neck.count === 3, `and a neck, ${face.neck.count} of 3`);
  const mouthOut = from(face.mouth);
  assert(
    mouthOut > 0.9 && mouthOut < 1.02,
    `the mouth should sit on the face — ${mouthOut.toFixed(3)} of a head radius out`,
  );
  assert(
    face.mouth.y < face.eyeL.y,
    'and below the eyes, which is where a mouth goes',
  );

  // ── They are alive when they are doing nothing ─────────────────────────────
  //
  // Three of them standing on a lawn were three statues in identical poses.
  // Checked here rather than only in the unit suite because the breath runs on
  // the real frame's dt through the real loop, and a rig that animates when a
  // test hands it a fixed timestep and not when the game hands it a real one is
  // a thing this project has shipped before.
  const torsoAt = () => page.evaluate(() => {
    const m = window.__maker.scene.getObjectByName('characters')
      .getObjectByName('torso').instanceMatrix.array;
    return { y: m[13] };
  });
  const shoeAt = () => page.evaluate(() => {
    const m = window.__maker.scene.getObjectByName('characters')
      .getObjectByName('shoe0').instanceMatrix.array;
    return { x: m[12], y: m[13], z: m[14] };
  });
  // Let the stride settle out first, so what is left moving is the breath.
  await frames(page, 45);
  const chestFrom = await torsoAt();
  const footFrom = await shoeAt();
  let chestMoved = 0;
  let footMoved = 0;
  for (let i = 0; i < 30; i++) {
    await frames(page, 2);
    const chest = await torsoAt();
    const foot = await shoeAt();
    chestMoved = Math.max(chestMoved, Math.abs(chest.y - chestFrom.y));
    footMoved = Math.max(footMoved, Math.hypot(
      foot.x - footFrom.x, foot.y - footFrom.y, foot.z - footFrom.z,
    ));
  }
  assert(
    chestMoved > 0.002,
    `a kid standing still should still be breathing, their chest moved ${chestMoved.toFixed(4)}m`,
  );
  assert(
    footMoved < 1e-6,
    `but their feet should be on the ground, and moved ${footMoved.toFixed(4)}m`,
  );

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
    `eyes and a mouth sit on the face rather than in the skull or off the front of it,`,
    `kids differ from each other, a standing one breathes (${chestMoved.toFixed(4)}m)`,
    `without moving their feet, the walk cycle advances, and the ink moves ${diff} pixels`,
  );
}
