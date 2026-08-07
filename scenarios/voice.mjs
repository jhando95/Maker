/**
 * Two browsers talking to each other, for real.
 *
 * Every rule proximity voice applies is unit-tested in `voiceRules.test.ts` and
 * every rule about carrying a handshake is tested against a loopback pair in
 * `session.test.ts`. Neither can answer the only question that matters, which is
 * whether a person in one browser can hear a person in another — and that
 * question has exactly one honest form: **are audio packets arriving**.
 *
 * Everything short of that can be green while the feature is silent. A peer
 * connection reports `connected` while carrying nothing. A gain can be computed
 * perfectly and connected to no graph. A track can be added to a connection
 * whose offer was never sent. Each of those is a real way this breaks and none
 * of them throws, so the check counts `inbound-rtp` packets and then reads the
 * gain off the `AudioParam` the browser is actually using.
 *
 * Chromium's fake device makes it possible: `--use-fake-device-for-media-stream`
 * is a genuine audio track carrying a tone, so what crosses the connection is
 * genuine Opus. A mocked `getUserMedia` would have exercised the mock.
 *
 *   node tools/shoot.mjs --scenario scenarios/voice.mjs --out shots/voice.png
 */

import { spawn } from 'node:child_process';

const assert = (cond, message) => {
  if (!cond) throw new Error(`voice scenario: ${message}`);
};

const until = (page, fn, what, arg = undefined, timeout = 20000) =>
  page.waitForFunction(fn, arg, { timeout, polling: 'raf' })
    .catch(() => { throw new Error(`voice scenario: timed out waiting for ${what}`); });

const frames = (page, n) => page.evaluate((count) => new Promise((resolve) => {
  let seen = 0;
  const step = () => { if (++seen >= count) resolve(); else requestAnimationFrame(step); };
  requestAnimationFrame(step);
}), n);

/**
 * Start the audio context, which no amount of scripting can do on its own.
 *
 * A browser will not run an `AudioContext` outside a real user gesture, and
 * every node in the voice graph hangs off that context. Playwright's `click`
 * is a real gesture; `dispatchEvent` is not, and using it here would leave the
 * whole graph suspended while every other assertion still passed.
 */
const wake = async (page) => {
  // A real click first. `page.mouse.click` dispatches a trusted event, which
  // gives the page sticky user activation for the rest of its life —
  // `dispatchEvent` does not, and `resume()` without it leaves the context
  // suspended while every other assertion here still passes.
  await page.mouse.click(400, 300);
  await page.evaluate(() => window.__maker.wakeAudio());
  await until(page, () => window.__maker.audioRunning() === true, 'the audio context to start');
};

async function waitForServer(port) {
  for (let i = 0; i < 120; i++) {
    try {
      const response = await fetch(`http://localhost:${port}/`);
      if (response.ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`voice scenario: the relay never came up on ${port}`);
}

export default async function (page) {
  const port = 8990 + Math.floor(Math.random() * 200);
  const url = `ws://localhost:${port}`;
  const server = spawn('npx', ['vite-node', 'server/serve.ts', String(port)], {
    cwd: process.cwd(), stdio: 'ignore',
  });
  let other = null;

  try {
    await waitForServer(port);

    // A second context rather than a second page: pages in one context share
    // localStorage and therefore an identity, and two players are two people.
    // Microphone permission is granted on the context, because it is a context
    // permission and the browser flag alone only suppresses the prompt.
    other = await page.context().browser().newContext({ permissions: ['microphone'] });
    const second = await other.newPage();
    await second.goto(page.url());
    await until(second, () => window.__maker !== undefined, 'the second page to boot');

    for (const p of [page, second]) {
      await p.evaluate(() => {
        window.__maker.setAutoQuality(false);
        window.__maker.hideOverlay();
      });
      await wake(p);
    }

    // ── Microphones ──────────────────────────────────────────────────────────
    const opened = await Promise.all([
      page.evaluate(() => window.__maker.voice.turnOn(true)),
      second.evaluate(() => window.__maker.voice.turnOn(true)),
    ]);
    assert(opened[0] && opened[1], 'the fake microphone should open on both pages');

    const errors = await Promise.all(
      [page, second].map((p) => p.evaluate(() => window.__maker.voice.state().error)),
    );
    assert(errors.every((e) => e === null), `voice reported ${JSON.stringify(errors)}`);

    // ── One room ─────────────────────────────────────────────────────────────
    const room = `voice-${port}`;
    await page.evaluate(([u, r]) => window.__maker.voice.host(u, r), [url, room]);
    await second.evaluate(([u, r]) => window.__maker.voice.join(u, r, 'bo'), [url, room]);
    await until(page, () => window.__maker.netStatus().peers === 1, 'the guest to join');
    await until(second, () => window.__maker.netStatus().connected === true,
      'the guest to be welcomed');

    // ── A call, and audio actually crossing it ───────────────────────────────
    //
    // Both directions. One is not enough: the offering end and the answering
    // end run different code paths, and a mesh where audio only flows downhill
    // is a mesh half the players think is broken.
    for (const [p, who] of [[page, 'the host'], [second, 'the guest']]) {
      await until(
        p,
        () => window.__maker.voice.state().calls > 0,
        `${who} to open a peer connection`,
      );
    }

    const packetsOn = async (p) => p.evaluate(async () => {
      const stats = await window.__maker.voice.stats();
      return stats.reduce((n, s) => n + s.packets, 0);
    });

    /**
     * Poll from Node rather than through `waitForFunction`.
     *
     * `getStats()` is async, and a `waitForFunction` predicate that returns a
     * promise resolves against the **Promise object**, which is truthy — so the
     * wait passed instantly, at zero packets, and the assertion two lines later
     * read the zero. It looked exactly like a connection that carried audio and
     * then stopped. Polling here has no such ambiguity: every read is awaited.
     */
    const waitForPackets = async (p, who, timeout = 40000) => {
      const deadline = Date.now() + timeout;
      for (;;) {
        const n = await packetsOn(p);
        if (n > 0) return n;
        if (Date.now() > deadline) {
          throw new Error(`voice scenario: no audio ever reached ${who}`);
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    };

    const hostPackets = await waitForPackets(page, 'the host');
    const guestPackets = await waitForPackets(second, 'the guest');
    assert(hostPackets > 0, `the host should be receiving audio, saw ${hostPackets} packets`);
    assert(guestPackets > 0, `and the guest too, saw ${guestPackets} packets`);

    // ── Proximity ────────────────────────────────────────────────────────────
    //
    // Read off the `AudioParam` the browser is using rather than off a value
    // this code kept, because a remembered number agrees with itself whatever
    // the graph is doing — which makes it useless as a check that the graph is
    // connected to anything.
    const guestId = await second.evaluate(() => window.__maker.netStatus().localId);

    const guestSpot = await page.evaluate((id) => {
      const them = window.__maker.actors.get(id);
      return them === undefined ? null : { x: them.controller.x, z: them.controller.z };
    }, guestId);
    assert(guestSpot !== null, 'the guest should be in the host roster');

    /**
     * Stand `metres` from the guest, in a given direction, and read the graph.
     *
     * **The host moves, not the guest.** Teleporting the guest on its own page
     * looks like the obvious way to open a gap and does not work: a guest sends
     * *input*, not positions, so the host runs their body from their commands
     * and reconciliation drags them straight back. Moving the listener is
     * authoritative, changes the same distance, and goes through the same mix.
     *
     * The direction matters and was found by measuring rather than assumed. The
     * yard is not empty: standing 14m away on the +Z side of this spawn puts the
     * house between the two of them, which is *correct behaviour* and ruins a
     * falloff measurement — the reading is the distance curve multiplied by the
     * occlusion penalty. -Z is clear to 24m, so that is where the curve is
     * measured, and +Z is where occlusion is measured on purpose.
     */
    const mixAt = async (dx, dz, metres) => {
      await page.evaluate(([spot, d, ux, uz]) => {
        window.__maker.teleport(spot.x + ux * d, 0.6, spot.z + uz * d);
        // Face them. `getLookDirection` is `(-sin y, ., -cos y)`, so pointing
        // back down the offset means `sin y = ux`, `cos y = uz`.
        window.__maker.lookAt(Math.atan2(ux, uz), 0);
      }, [guestSpot, metres, dx, dz]);
      // Long enough for the ramp to arrive. `setTargetAtTime` is a smooth
      // approach rather than a jump, so reading on the next frame reads the
      // value from before the move.
      await frames(page, 40);
      return page.evaluate((id) => window.__maker.voice.mixFor(id), guestId);
    };

    const OPEN = 18000;

    const close = await mixAt(0, -1, 2);
    assert(close !== null, 'there should be a live mix for the guest');
    assert(close.gain > 0.9, `standing together should be full volume, gain was ${close.gain}`);
    assert(close.cutoff === OPEN, `and unmuffled at two metres, cutoff was ${close.cutoff}`);
    // Straight ahead is centred. This is the assertion that catches the stereo
    // basis being taken from the world rather than from the camera — a mistake
    // that is inaudible in mono and puts every voice in one ear otherwise.
    assert(Math.abs(close.pan) < 0.2, `somebody straight ahead should be centred, pan ${close.pan}`);

    // A band read off the curve rather than `across < close`, which was the
    // first version and could not fail: `setTargetAtTime` is an approach rather
    // than a jump, so two reads of a gain that never moved differ by float
    // noise and one of them is smaller. `1 - t²` at 20m of a 5..26m span is
    // 0.49, so this bites a falloff that is missing, inverted or the wrong
    // shape — all three were planted and all three now fail here.
    const across = await mixAt(0, -1, 20);
    assert(across.cutoff === OPEN, `the -Z line should be clear, cutoff was ${across.cutoff}`);
    assert(
      across.gain > 0.35 && across.gain < 0.65,
      `20m down a clear line should be about half volume, saw ${across.gain}`,
    );

    const gone = await mixAt(0, -1, 45);
    assert(gone.gain < 0.02, `out of range should be silent, gain was ${gone.gain}`);

    // ── The house between you ────────────────────────────────────────────────
    //
    // The same distance in the other direction, where the building is. This is
    // the whole occlusion feature in one comparison: nothing about the two
    // readings differs except what is in the way.
    const behindTheHouse = await mixAt(0, 1, 20);
    assert(
      behindTheHouse.cutoff < OPEN,
      `a voice through the house should be muffled, cutoff was ${behindTheHouse.cutoff}`,
    );
    assert(
      behindTheHouse.gain < across.gain,
      `and quieter than the same distance in the open: ${across.gain} clear,`
      + ` ${behindTheHouse.gain} through the house`,
    );
    assert(
      behindTheHouse.gain > 0,
      `but still audible — a wall is not a mute, gain was ${behindTheHouse.gain}`,
    );

    // Back within earshot, on the clear line, for the rest of the checks.
    await mixAt(0, -1, 4);

    // ── The screen says who is talking ───────────────────────────────────────
    // Polled until a mark appears rather than waited-for-then-read, and the
    // difference is load-bearing here: Chromium's fake microphone is a *pulsing*
    // beep, so the speaking gate genuinely goes on and off. Checking "is anybody
    // speaking" and then reading the DOM a few frames later reads a frame in one
    // of the gaps, which is the same mistake — asserting on state that was true
    // a moment ago — that every scenario failure on this project has been.
    const markCount = () => page.evaluate(
      () => [...document.querySelectorAll('.maker-voice')]
        .filter((e) => !e.classList.contains('maker-hidden')).length,
    );

    let marks = 0;
    const markDeadline = Date.now() + 40000;
    for (;;) {
      marks = await markCount();
      if (marks > 0) break;
      if (Date.now() > markDeadline) {
        const why = await page.evaluate(async (id) => ({
          state: window.__maker.voice.state(),
          levels: window.__maker.voice.levels(),
          mix: window.__maker.voice.mixFor(id),
          stats: await window.__maker.voice.stats(),
          me: { x: window.__maker.player.x, z: window.__maker.player.z },
          them: (() => {
            const a = window.__maker.actors.get(id);
            return a === undefined ? null : { x: a.controller.x, z: a.controller.z };
          })(),
        }), guestId);
        throw new Error(
          `voice scenario: a speaker never got a mark over their head; ${JSON.stringify(why)}`,
        );
      }
      await frames(page, 3);
    }
    assert(marks > 0, 'a speaker should get a mark over their head');

    // And they are somebody you can see. A voice with a mark floating over an
    // empty patch of lawn is worse than no mark: the renderer draws remote
    // actors from the roster, so this is the assertion that catches voice and
    // rendering disagreeing about who is present.
    const drawn = await page.evaluate(() => window.__maker.drawnActorIds());
    assert(
      drawn.includes(guestId),
      `the person you can hear should also be drawn; drawn ids ${JSON.stringify(drawn)}`,
    );

    const badge = await page.evaluate(() => {
      const el = document.querySelector('.maker-mic');
      return { hidden: el?.classList.contains('maker-hidden'), text: el?.textContent ?? '' };
    });
    assert(badge.hidden === false, 'your own microphone should be shown while voice is on');
    assert(badge.text.length > 0, `and say something, saw "${badge.text}"`);

    await page.screenshot({ path: `${process.env.RUNNER_TEMP ?? '/tmp'}/voice.png` });

    console.log('[voice] verified: two browsers open a peer connection through the host,'
      + ' Opus packets cross it in both directions, the gain applied on the graph falls'
      + ' with distance and reaches zero out of range, the house between two people'
      + ' muffles and quietens without silencing, and a speaker is marked on screen');
  } finally {
    await other?.close();
    server.kill();
  }
}
