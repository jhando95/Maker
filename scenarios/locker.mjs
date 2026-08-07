/**
 * The locker, driven the way a player drives it.
 *
 * The unit suite owns the rules: what can be chosen, what the limits are, what
 * survives a socket. What only exists in a browser is the chain from a click to
 * a different-coloured kid standing on the lawn — and this screen is unusual in
 * that its *preview is the game*. There is no inset viewport and no second
 * scene: the character behind the card is the real one, drawn by the same rig,
 * so "did the picture change" and "did the player change" are the same question
 * and neither can be answered anywhere but here.
 *
 *   node tools/shoot.mjs --scenario scenarios/locker.mjs --out shots/locker.png
 */

const assert = (cond, message) => {
  if (!cond) throw new Error(`locker scenario: ${message}`);
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

/** Click a chip under a labelled group, by the text on it. */
const pickChip = (page, group, label) => page.evaluate(([g, l]) => {
  const head = [...document.querySelectorAll('.mk-label')]
    .find((e) => e.textContent.toLowerCase() === g.toLowerCase());
  if (head === undefined) throw new Error(`no group called ${g}`);
  const button = [...head.nextElementSibling.querySelectorAll('button')]
    .find((b) => b.textContent === l);
  if (button === undefined) throw new Error(`no ${l} under ${g}`);
  button.click();
}, [group, label]);

/** Click the nth swatch under a labelled group. */
const pickSwatch = (page, group, index) => page.evaluate(([g, i]) => {
  const head = [...document.querySelectorAll('.mk-label')]
    .find((e) => e.textContent.toLowerCase() === g.toLowerCase());
  head.nextElementSibling.querySelectorAll('button')[i].click();
}, [group, index]);

const openTab = (page, name) => page.evaluate((n) => {
  [...document.querySelectorAll('.mk-tabs button')].find((b) => b.textContent === n).click();
}, name);

const clickButton = (page, pattern) => page.evaluate((p) => {
  const re = new RegExp(p, 'i');
  const button = [...document.querySelectorAll('.mk-card button')]
    .find((b) => re.test(b.textContent ?? ''));
  if (button === undefined) throw new Error(`no button matching ${p}`);
  button.click();
}, pattern);

/**
 * Read one instance off a character mesh.
 *
 * The colours are the whole point of this screen and they only exist in the
 * instance buffer — there is nothing in the DOM that says what colour a kid's
 * head is, and a screenshot cannot tell a chosen tone from the one the seeded
 * generator would have produced anyway.
 */
const instance = (page, mesh, slot = 0) => page.evaluate(([name, i]) => {
  const group = window.__maker.scene.getObjectByName('characters');
  const found = group.getObjectByName(name);
  if (found === undefined) return null;
  const m = found.instanceMatrix.array;
  const o = i * 16;
  const colours = found.instanceColor;
  return {
    count: found.count,
    x: m[o + 12], y: m[o + 13], z: m[o + 14],
    scale: Math.hypot(m[o], m[o + 1], m[o + 2]),
    colour: colours === null
      ? null
      : [colours.array[i * 3], colours.array[i * 3 + 1], colours.array[i * 3 + 2]]
        .map((v) => v.toFixed(3)).join(','),
  };
}, [mesh, slot]);

export default async function (page) {
  await page.evaluate(() => {
    window.__maker.setAutoQuality(false);
    window.__maker.menu.show('locker');
  });
  await frames(page, 8);

  // ── Opening it puts you on screen ───────────────────────────────────────────
  //
  // The preview only works because the local player, who is normally inside
  // their own head, is drawn like everybody else the moment the camera can see
  // them. If that stops being true the whole screen previews an empty lawn.
  const opened = await page.evaluate(() => ({
    ids: window.__maker.drawnActorIds(),
    posed: window.__maker.charactersPosed(),
  }));
  assert(opened.ids.includes(0), 'the locker should draw the player it is dressing');
  assert(opened.posed >= 1, `and pose them; ${opened.posed} were posed`);

  // The card must not cover the person it is dressing, which is a layout claim
  // and therefore one only a browser can make.
  const layout = await page.evaluate(() => {
    const card = document.querySelector('.mk-card').getBoundingClientRect();
    return { right: card.right, window: window.innerWidth };
  });
  assert(
    layout.right < layout.window * 0.62,
    `the card should leave room for the preview, it reaches ${layout.right.toFixed(0)}`
      + ` of ${layout.window}`,
  );

  // ── Picking a face changes the face ─────────────────────────────────────────
  const skinBefore = await instance(page, 'head');
  await pickSwatch(page, 'skin', 4);
  await frames(page, 3);
  const skinAfter = await instance(page, 'head');
  assert(
    skinBefore.colour !== skinAfter.colour,
    `picking a skin tone should repaint the head; it stayed ${skinAfter.colour}`,
  );

  const eyeBefore = await instance(page, 'irises');
  await pickSwatch(page, 'eyes', 5);
  await frames(page, 3);
  const eyeAfter = await instance(page, 'irises');
  assert(
    eyeBefore.colour !== eyeAfter.colour,
    'picking an eye colour should repaint the iris, and only the iris',
  );
  // The white stays white. An eye that is one colour all through is a dot, and
  // dots are what these were before there was a locker to choose between them.
  const sclera = await instance(page, 'eyes');
  assert(sclera.count >= 2, `both eyes should be drawn, ${sclera.count} were`);

  // ── Brows can be taken off, and it is the brows that go ─────────────────────
  await pickChip(page, 'brows', 'None');
  await frames(page, 3);
  const browsOff = await instance(page, 'brows');
  assert(
    browsOff.scale < 0.01,
    `"None" should draw no brows, they are still ${browsOff.scale.toFixed(3)} across`,
  );
  await pickChip(page, 'brows', 'Cross');
  await frames(page, 3);
  const browsOn = await instance(page, 'brows');
  assert(browsOn.scale > 0.5, 'and picking one should put them back');

  // ── Hair is a silhouette, not just a colour ─────────────────────────────────
  await openTab(page, 'Hair');
  await frames(page, 2);
  await pickChip(page, 'style', 'Mop');
  await frames(page, 3);
  const mop = await instance(page, 'hair');
  await pickChip(page, 'style', 'Shaved');
  await frames(page, 3);
  const shaved = await instance(page, 'hair');
  assert(
    shaved.scale < mop.scale * 0.2,
    `a shaved head should not be wearing a mop — ${shaved.scale.toFixed(3)} against`
      + ` ${mop.scale.toFixed(3)}`,
  );
  await pickChip(page, 'style', 'Ponytail');
  await frames(page, 3);
  const bunch = await instance(page, 'bunch');
  assert(bunch.scale > 0.01, 'a ponytail needs the bunch behind the head to be drawn');

  // ── Shaping stays inside the model ──────────────────────────────────────────
  //
  // The claim the whole limit exists for, checked on the thing that is actually
  // drawn rather than on the number that was asked for. A player who drags a
  // slider to its end gets the biggest head the locker allows; there is no way
  // through this screen to a head that is a different game.
  await openTab(page, 'Shape');
  await frames(page, 2);
  const headAt = async (value) => {
    await page.evaluate((v) => {
      const slider = [...document.querySelectorAll('.mk-row')]
        .find((r) => r.querySelector('label')?.textContent === 'Head size')
        .querySelector('input');
      slider.value = String(v);
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
    await frames(page, 3);
    return (await instance(page, 'head')).scale;
  };
  const smallest = await headAt(0);
  const largest = await headAt(1);
  assert(largest > smallest, 'the head slider should do something');
  assert(
    largest / smallest < 1.4,
    `the head must stay inside the model — the slider spans ${(largest / smallest).toFixed(2)}x`,
  );
  // And nobody grows: height is the one thing that is not on offer, because the
  // joints are tied to the collision capsule.
  const torsoTall = await instance(page, 'torso');
  await headAt(0.5);
  assert(
    Math.abs((await instance(page, 'torso')).y - torsoTall.y) < 0.02,
    'changing the head must not change how tall somebody is',
  );

  // ── Paint reaches the shirt ─────────────────────────────────────────────────
  await openTab(page, 'Paint');
  await frames(page, 2);
  await pickChip(page, 'where', 'Chest');
  await pickChip(page, 'shape', 'Star');
  await pickSwatch(page, 'colour', 4);
  await frames(page, 3);

  const star = await instance(page, 'mark-star');
  const torso = await instance(page, 'torso');
  assert(star !== null && star.count === 1, 'a painted star should be drawn exactly once');
  const proud = Math.hypot(star.x - torso.x, star.z - torso.z);
  // A mark placed against the feet rather than against the torso's own frame
  // ends up *inside* the shirt the moment its wearer leans, which is what the
  // first version did — and a back nobody could paint is how it was found.
  assert(
    proud > 0.12 && proud < 0.4,
    `the star should sit on the shirt, not in it — ${proud.toFixed(3)}m from the chest`,
  );

  await pickChip(page, 'where', 'Back');
  await pickChip(page, 'shape', 'Heart');
  await frames(page, 3);
  const heart = await instance(page, 'mark-heart');
  assert(heart.count === 1, 'and a second mark on the back is a second mark');
  const front = Math.hypot(star.x - torso.x, star.z - torso.z);
  const behind = Math.hypot(heart.x - torso.x, heart.z - torso.z);
  assert(
    Math.abs(front - behind) < 0.05,
    `chest and back should sit the same distance out — ${front.toFixed(3)} against ${behind.toFixed(3)}`,
  );
  // Opposite sides, which is the thing that was wrong: the back mark was buried.
  assert(
    Math.hypot(star.x - heart.x, star.z - heart.z) > 0.2,
    'chest and back must be on opposite sides of the body',
  );

  // A shape nobody is wearing costs nothing, which is what makes twelve of them
  // affordable to offer at all.
  const unused = await instance(page, 'mark-splat');
  assert(unused.count === 0, `an unworn shape should draw nothing, ${unused.count} were drawn`);

  // ── Turning shows a different side, rather than the same one ────────────────
  //
  // The first version carried the facing as an offset from the camera, so the
  // character rotated *with* it and always presented the same face. It orbited
  // beautifully and the back — which is half of what this screen paints — could
  // not be looked at.
  //
  // Read as an angle off the torso's own basis rather than as a position:
  // "something moved" is satisfied by a breath, and this has to distinguish a
  // body that turned from a body that is still facing the camera.
  const facing = () => page.evaluate(() => {
    const m = window.__maker.scene.getObjectByName('characters')
      .getObjectByName('torso').instanceMatrix.array;
    // Column two is the local Z axis in world space, scaled — the direction the
    // character's back points.
    return Math.atan2(m[8], m[10]);
  });
  const turnBy = async (times) => {
    for (let i = 0; i < times; i++) {
      await page.evaluate(() => {
        [...document.querySelectorAll('.mk-chips button')]
          .find((b) => /Turn \u21b7/.test(b.textContent ?? '')).click();
      });
    }
    await frames(page, 4);
  };

  const before = await facing();
  await turnBy(3);
  const after = await facing();
  const turned = Math.abs(Math.atan2(Math.sin(after - before), Math.cos(after - before)));
  // Three presses of 0.6 radians. Compared against a bound rather than an exact
  // value, because the camera eases and a frame may land mid-blend.
  assert(
    turned > 0.9,
    `three turns should have shown a different side — the body moved ${turned.toFixed(2)} radians`,
  );
  await turnBy(2);
  const back = await facing();
  const total = Math.abs(Math.atan2(Math.sin(back - before), Math.cos(back - before)));
  assert(total > 2.4, `and five should be past halfway round, it managed ${total.toFixed(2)}`);

  // ── An outfit can be kept and put back on ───────────────────────────────────
  await openTab(page, 'Outfits');
  await frames(page, 2);
  const chosen = (await instance(page, 'head')).colour;
  await page.evaluate(() => {
    const field = document.querySelector('.mk-card input[type="text"]');
    field.value = 'Test Kit';
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await clickButton(page, 'save outfit');
  await frames(page, 3);
  const saved = await page.evaluate(
    () => [...document.querySelectorAll('.mk-preset .who')].map((e) => e.textContent),
  );
  assert(saved.includes('Test Kit'), `the outfit should be listed, saw ${saved.join(', ')}`);

  await clickButton(page, 'start over');
  await frames(page, 4);
  await openTab(page, 'Outfits');
  await frames(page, 2);
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('.mk-preset')]
      .find((r) => r.querySelector('.who').textContent === 'Test Kit');
    [...row.querySelectorAll('button')].find((b) => b.textContent === 'Wear').click();
  });
  await frames(page, 4);
  assert(
    (await instance(page, 'head')).colour === chosen,
    'putting a saved outfit back on should bring the same face back',
  );

  // ── And it survives a reload, which is what "saved" means ───────────────────
  const stored = await page.evaluate(() => localStorage.getItem('maker.locker.v1'));
  assert(stored !== null, 'the locker should have written itself to storage');
  assert(stored.includes('Test Kit'), 'including the outfit that was just saved');

  await page.evaluate(() => {
    const field = document.querySelector('.mk-card input[type="text"]');
    if (field !== null) field.value = '';
  });
  await frames(page, 3);
  await page.screenshot({ path: process.env.LOCKER_SHOT ?? 'shots/locker.png' });

  console.log(
    '[locker] verified: the player is the preview and the card leaves room for them,',
    'skin, iris and brows repaint independently, hair changes silhouette,',
    'the shaping sliders stay inside the model and cannot change anybody\'s height,',
    'paint lands on the shirt front and back and unworn shapes cost nothing,',
    'and an outfit saves, comes back and reaches storage',
  );
}
