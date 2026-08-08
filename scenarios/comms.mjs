/**
 * Talking, pinging and waving, in the real game.
 *
 * The rules about who may hear what are unit-tested against a loopback pair and
 * that is where they belong. What only a browser can answer is whether any of
 * it reaches a player: a chat box that takes the keyboard without walking the
 * character into a fence, a ping that becomes a mark on the compass, a bubble
 * that appears over the right head.
 *
 * Driven through the same calls the keys make rather than by writing into the
 * log, so a scenario cannot pass with the session layer disconnected — which is
 * the half most likely to break.
 */
const assert = (c, m) => { if (!c) throw new Error(`comms scenario: ${m}`); };

const frames = (page, n) => page.evaluate((count) => new Promise((resolve) => {
  let seen = 0;
  const step = () => { if (++seen >= count) resolve(); else requestAnimationFrame(step); };
  requestAnimationFrame(step);
}), n);

export default async function (page) {
  await page.evaluate(() => {
    window.__maker.setAutoQuality(false);
    window.__maker.hideOverlay();
    window.__maker.teleport(0, 0.6, 14);
    window.__maker.lookAt(Math.PI, -0.05);
  });

  // ── Saying something ────────────────────────────────────────────────────────

  // Playing alone still shows your own chat. The alternative is a feature that
  // silently does nothing until somebody else turns up, which is how a player
  // concludes it is broken rather than empty.
  const said = await page.evaluate(() => {
    window.__maker.comms.say('near', 'anybody out here?');
    return window.__maker.comms.state();
  });
  assert(said.chat.length === 1, `a line said alone should still show, saw ${said.chat.length}`);
  assert(said.chat[0].text === 'anybody out here?', `got "${said.chat[0].text}"`);
  assert(said.chat[0].channel === 'near', `on the channel it was said on, got ${said.chat[0].channel}`);

  await frames(page, 3);
  const onScreen = await page.evaluate(() => {
    const el = document.querySelector('.maker-chat');
    return { html: el?.innerHTML ?? '', text: el?.textContent ?? '' };
  });
  assert(/anybody out here/.test(onScreen.text), `and reach the screen, saw "${onScreen.text}"`);
  assert(/class="line near"/.test(onScreen.html), 'tagged with its channel, which is a colour and a word');

  // Names and messages come from other people, so they are never markup.
  //
  // The wait is load-bearing and was missing: the log is written during `draw`,
  // so reading `innerHTML` in the same turn as the `say` reads the frame
  // before it. Asserting on state it had not established is the root cause of
  // every scenario failure on this project so far, including this one.
  await page.evaluate(() => window.__maker.comms.say('near', '<img src=x onerror=alert(1)>'));
  await frames(page, 3);
  const escaped = await page.evaluate(
    () => document.querySelector('.maker-chat')?.innerHTML ?? '',
  );
  assert(!/<img/i.test(escaped), 'a message must never become markup');
  assert(/&lt;img/.test(escaped), 'it should be shown as the text it is');

  // ── The box you type in ─────────────────────────────────────────────────────

  const typing = await page.evaluate(() => {
    window.__maker.comms.openSay('team');
    return window.__maker.comms.state();
  });
  assert(typing.typing, 'opening the box should show it');
  assert(typing.channel === 'team', `on the channel asked for, got ${typing.channel}`);

  // And it must take the keyboard: a player writing "wasd" is writing, not
  // walking. This is the one thing here that no unit test can reach, because
  // the whole question is which layer got the key.
  const held = await page.evaluate(async () => {
    const before = { x: window.__maker.player.x, z: window.__maker.player.z };
    for (let i = 0; i < 90; i++) {
      window.__maker.driveIntentTyping?.();
    }
    return before;
  });
  await page.keyboard.type('wwwwaaaassss');
  await frames(page, 20);
  const after = await page.evaluate(() => ({
    x: window.__maker.player.x, z: window.__maker.player.z,
    text: window.__maker.comms.state(),
  }));
  assert(
    Math.hypot(after.x - held.x, after.z - held.z) < 0.6,
    `typing must not walk the player; they moved ${Math.hypot(after.x - held.x, after.z - held.z).toFixed(2)}m`,
  );
  assert(after.text.typing, 'and the box should still be open');

  await page.evaluate(() => window.__maker.comms.openSay(null));
  const shut = await page.evaluate(() => window.__maker.comms.state());
  assert(!shut.typing, 'closing it should shut it');

  // ── Marking a spot ──────────────────────────────────────────────────────────

  // Cast from the crosshair rather than dropped at the player's feet, because a
  // ping means *that* and not *here*.
  const pinged = await page.evaluate(async () => {
    window.__maker.comms.ping();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return {
      pings: window.__maker.comms.state().pings,
      drawn: window.__maker.roundInfo().markersDrawn,
    };
  });
  assert(pinged.pings === 1, `a ping should go in the world, saw ${pinged.pings}`);
  assert(pinged.drawn >= 1, `and be drawn, renderer sees ${pinged.drawn}`);

  // ── Waving ──────────────────────────────────────────────────────────────────

  const waved = await page.evaluate(async () => {
    window.__maker.setCameraMode('third');
    window.__maker.comms.emote();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const bubbles = [...document.querySelectorAll('.maker-emote')]
      .filter((e) => !e.classList.contains('maker-hidden'))
      .map((e) => e.textContent);
    return bubbles;
  });
  assert(waved.length >= 1, 'an emote should put a bubble over somebody');
  assert(waved[0].length > 0, `with something in it, got "${waved[0]}"`);

  // ── And picking one, rather than tapping through six ────────────────────────
  //
  // Emotes used to cycle: a key that sent the next one in a list, with a
  // comment saying a radial picker already existed for parts and weapons and
  // this ought to use it. It does now — the third content set on one wheel,
  // because a `WheelEntry` is a label, a detail and a colour and never knew
  // what a part was.
  //
  // A real key held down rather than a hook, and the mouse injected rather than
  // moved, exactly as `wheel.mjs` does it: the game ignores the mouse unless
  // the pointer is locked and a headless page has no gesture to grant lock
  // from. Holding exercises the whole gesture — the key opens it, the mouse
  // aims it, the release sends — where a check that only opened it would pass
  // with the release path deleted.
  await page.keyboard.down('b');
  await page
    .waitForFunction(() => window.__maker.comms.wheel().open, null, { timeout: 15_000 })
    .catch(() => { throw new Error('comms scenario: holding the emote key never opened the wheel'); });

  const opened = await page.evaluate(() => window.__maker.comms.wheel());
  assert(opened.shows === 'emotes', `the wheel should show emotes, not ${opened.shows}`);
  assert(opened.selection === null, 'nothing should be picked before the mouse moves');

  // Straight down, which is the wedge opposite the top one. Far enough out to
  // clear the dead zone, which is what stops a twitch choosing something.
  await page.evaluate(() => window.__maker.look(0, 200));
  await page
    .waitForFunction(() => window.__maker.comms.wheel().selection !== null, null, { timeout: 15_000 })
    .catch(() => { throw new Error('comms scenario: aiming the emote wheel never picked a wedge'); });

  const aimed = await page.evaluate(() => window.__maker.comms.wheel());
  await page.keyboard.up('b');
  await page
    .waitForFunction(() => !window.__maker.comms.wheel().open, null, { timeout: 15_000 })
    .catch(() => { throw new Error('comms scenario: releasing the emote key never closed the wheel'); });

  const sent = await page.evaluate(() => window.__maker.comms.wheel());
  assert(
    sent.last === aimed.selection,
    `releasing should send what was pointed at: aimed at ${aimed.selection},`
    + ` sent ${sent.last}`,
  );
  assert(
    sent.shows === null,
    `and the wheel should forget what it was showing, not stay on ${sent.shows}`,
  );

  // ── Muting ──────────────────────────────────────────────────────────────────

  // A muted player's message must not announce itself, or the mute is a mute of
  // the words and not of the person.
  const muted = await page.evaluate(() => {
    window.__maker.comms.mute(0);
    const before = window.__maker.comms.state().chat.length;
    window.__maker.comms.say('near', 'you should not see this');
    const after = window.__maker.comms.state();
    return { before, after: after.chat.length, texts: after.chat.map((l) => l.text) };
  });
  assert(
    !muted.texts.some((t) => /should not see/.test(t)),
    `a muted player's line got through: ${muted.texts.join(' | ')}`,
  );

  await page.evaluate(() => {
    window.__maker.setCameraMode('first');
    window.__maker.teleport(-2, 0.6, 14);
    window.__maker.lookAt(Math.PI, -0.06);
  });
  await frames(page, 4);
  await page.screenshot({ path: `${process.env.RUNNER_TEMP ?? '/tmp'}/comms.png` });

  console.log('[comms] verified: a line said alone reaches the screen tagged with its'
    + ' channel and escaped, the box takes the keyboard without walking the player,'
    + ' a ping becomes a drawn marker, an emote becomes a bubble, a held key opens'
    + ' a wheel of six and releasing it sends the one being pointed at rather than'
    + ' the next in a cycle, and a mute is silent');
}
