/**
 * Somebody else's round, on this screen.
 *
 * The multiplayer scenario checks the host's half: that a person who joined
 * becomes a body the renderer draws. This is the other half, and it is a
 * different claim entirely — that a round nobody on this machine is running
 * arrives as *pixels*. A phase on the banner, a clock counting down, a score in
 * two shirt colours, a pin on the compass, and a result screen at the end.
 *
 * Every one of those is a chain from a packet, through a `RemoteMode` that
 * computes nothing, into the HUD. The unit tests can prove the packet is right
 * and the remote mode reads it correctly. Neither can notice that the shell only
 * updates the HUD when it is the one running the mode, which is the obvious way
 * to get this wrong and would leave a guest staring at an empty banner while the
 * game happens around them.
 *
 * So the page joins, and the scenario plays host down a real transport speaking
 * the real wire format — the mirror of what `multiplayer.mjs` does.
 *
 *   node tools/shoot.mjs --scenario scenarios/party.mjs --out shots/party.png
 */

const assert = (cond, message) => {
  if (!cond) throw new Error(`party scenario: ${message}`);
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

/** Say something as the host. */
const send = (page, message) =>
  page.evaluate((m) => window.__maker.hostSend(m), message);

/** Read the mode banner the way a player sees it: off the DOM. */
const banner = (page) =>
  page.evaluate(() => ({
    phase: document.querySelector('.maker-mode .phase')?.textContent ?? '',
    timer: document.querySelector('.maker-mode .timer')?.textContent ?? '',
    caps: [...document.querySelectorAll('.maker-mode .cap')].map((c) => c.textContent),
    vals: [...document.querySelectorAll('.maker-mode .val')].map((c) => c.textContent),
    pins: document.querySelectorAll('.maker-pin').length,
  }));

/**
 * A snapshot as the host would send it.
 *
 * Built here rather than by asking the page, because the point is to drive the
 * guest from outside — a scenario that got its message from the code under test
 * would agree with it no matter what either of them did.
 */
/**
 * The tick a hand-written snapshot carries, which is nobody's business but this
 * helper's.
 *
 * It used to be the first argument and the fixtures numbered them by hand: 1, 2,
 * 3, 6, 7, and then 4 and 5. That was harmless while nothing read the number,
 * and it stopped being harmless the day a guest started refusing snapshots older
 * than the newest it had applied — which is a correct rule, because a real host's
 * counter only ever goes up. The round-over snapshot was numbered 4, arrived
 * after 7, and was dropped; the result screen never came and the scenario waited
 * out its timeout.
 *
 * So the number is generated rather than typed. A fixture cannot hand-write a
 * stale tick if it cannot hand-write a tick.
 */
let snapshotTick = 0;

function snapshot(ack, round, actors, you = null, balloons = []) {
  return { t: 'snap', tick: ++snapshotTick, ack, actors, round, you, balloons };
}

/** How this guest's own fight is going, as the host would describe it. */
function self(extra = {}) {
  return {
    charge: null,
    wet: 0.62,
    ammo: [41, 100, 1],
    refill: null,
    stream: null,
    out: false,
    ...extra,
  };
}

/** The personal meters, read off the DOM the way a player reads them. */
const meters = (page) =>
  page.evaluate(() => ({
    ammo: document.querySelector('.maker-ammo')?.textContent ?? '',
    hidden: document.querySelector('.maker-ammo')?.classList.contains('maker-hidden') ?? true,
    tank: document.querySelector('.maker-tank .track i')?.getAttribute('style') ?? '',
    pips: document.querySelectorAll('.maker-ammo .pip').length,
    soak: document.querySelector('.maker-soak .track i')?.getAttribute('style') ?? '',
    soakCap: document.querySelector('.maker-soak .cap')?.textContent ?? '',
  }));

const flagMarker = (x, z, color) => [2, x, 1, z, color, 0];

function round(over = null, extra = {}) {
  return {
    id: 'captureTheFlag',
    name: 'Capture the Flag',
    phase: 'ROUND 2',
    timer: 95.5,
    msg: 'Get their flag back to your base.',
    pri: null,
    sec: null,
    score: [2, 1],
    build: true,
    wood: 64,
    markers: [flagMarker(-17.5, 1.5, 0x7a3fc8), flagMarker(17.5, 1.5, 0xe07a4f)],
    over,
    ...extra,
  };
}

export default async function (page) {
  await page.evaluate(() => {
    window.__maker.setAutoQuality(false);
    window.__maker.hideOverlay();
    // Out on the lawn looking across the lot, so the artifact shows the round
    // over a yard rather than the inside of a wall.
    window.__maker.teleport(-2, 0.5, 15);
    window.__maker.lookAt(0, -0.06);
    window.__maker.joinFakeHost();
  });

  // ── The handshake, from the other side ─────────────────────────────────────
  const version = await page.evaluate(() => window.__maker.protocolVersion);
  const hello = await page.evaluate(() => window.__maker.hostDrain());
  assert(
    hello.some((m) => m.t === 'hello' && m.version === version),
    `a joining client speaks first and names its version; saw ${JSON.stringify(hello)}`,
  );

  await send(page, {
    t: 'welcome', id: 3, team: 'right', tick: 0, parts: [],
  });
  await frames(page, 4);

  const status = await page.evaluate(() => window.__maker.netStatus());
  assert(status !== null && status.role === 'guest', 'the page should be a guest');
  assert(status.localId === 3, `the guest should take the id it was given, saw ${status.localId}`);

  // ── No round yet: the shell must not invent one ────────────────────────────
  await send(page, snapshot(0, null, [[3, 1, 0, 0.5, 6, 0, 0, 0, 0, 3, 0]]));
  await frames(page, 4);
  const quiet = await page.evaluate(() => window.__maker.roundInfo());
  assert(
    quiet.mode === 'none',
    `with the host playing nothing, a guest plays nothing; saw "${quiet.mode}"`,
  );

  // ── The host starts a round, and this screen joins it ──────────────────────
  await send(page, snapshot(0, round(), [[3, 1, 0, 0.5, 6, 0, 0, 0, 0, 3, 0]]));
  await frames(page, 6);

  const playing = await page.evaluate(() => window.__maker.roundInfo());
  assert(
    playing.mode === 'captureTheFlag',
    `a guest should be in the host's round without starting one; saw "${playing.mode}"`,
  );

  const live = await banner(page);
  assert(live.phase === 'ROUND 2', `the banner should name the host's phase, saw "${live.phase}"`);
  assert(
    /^\d+:\d\d$/.test(live.timer),
    `and run the host's clock as a clock, saw "${live.timer}"`,
  );
  // Two flags were published, and a compass that points at neither is a compass
  // that has quietly decided this machine is not playing.
  assert(live.pins >= 2, `the host's objectives should be pinned, saw ${live.pins}`);

  await page.screenshot({ path: `${process.env.RUNNER_TEMP ?? '/tmp'}/party-live.png` });

  // ── The clock is the host's, not this machine's ────────────────────────────
  //
  // The failure this catches is a guest running its own timer off its own dt,
  // which looks perfect for a few seconds and then drifts — and drifts fastest
  // on the machine having the worst time, which is the one you least want
  // guessing.
  await send(page, snapshot(0, round(null, { timer: 12 }), [[3, 1, 0, 0.5, 6, 0, 0, 0, 0, 3, 0]]));
  await frames(page, 6);
  const wound = await banner(page);
  assert(
    wound.timer === '0:12',
    `the clock should be whatever the host last said, saw "${wound.timer}"`,
  );

  // ── The wood is the yard's, and it is on screen ────────────────────────────
  assert(
    live.vals.some((v) => (v ?? '').includes('64')),
    `the shared pile should be on the banner, saw ${JSON.stringify(live.vals)}`,
  );

  // ── The meters on this screen describe the person reading them ─────────────
  //
  // Four fields on a guest's HUD used to be null on principle, and the
  // principle was right: a needle describing somebody else is not a meter. The
  // fix was to ask the host per peer, and this is where that arrives as pixels.
  // The unit tests can prove the packet carries the numbers and that
  // `RemoteMode` reads them; only this can notice that the HUD paints the
  // personal half of a round exclusively when it is the one running it.
  await send(page, snapshot(
    0,
    round(null, { build: false }),
    [[3, 1, 0, 0.5, 6, 0, 0, 0, 0, 3, 0.62]],
    self(),
  ));
  await frames(page, 6);

  const mine = await meters(page);
  assert(!mine.hidden, 'a guest with a tank should see it; the ammo block stayed hidden');
  assert(
    mine.ammo.includes('41'),
    `the tank should read what the host sent, saw "${mine.ammo}"`,
  );
  // A gauge rather than pips: 41 of 100 litres drawn as pips is a hundred pips.
  assert(
    mine.pips === 0 && /width:\s*41%/.test(mine.tank),
    `a litre tank draws as a bar, saw ${mine.pips} pips and style "${mine.tank}"`,
  );
  // And the soaking meter, which is the one that says how close this player is
  // to being out of the round. It is the field the guest most conspicuously did
  // not have.
  assert(
    /width:\s*62%/.test(mine.soak),
    `the guest's own wetness should be on screen, saw "${mine.soak}"`,
  );
  assert(
    mine.soakCap === 'WET',
    `and labelled by stage rather than by number, saw "${mine.soakCap}"`,
  );

  // ── And a balloon in the air is on screen before it lands ──────────────────
  //
  // A guest runs no projectile simulation, so without the host publishing them
  // the lawn is silent and the first sign of an incoming balloon is being wet.
  const before = await page.evaluate(() => window.__maker.balloonsDrawn());
  await send(page, snapshot(
    0,
    round(null, { build: false }),
    [[3, 1, 0, 0.5, 6, 0, 0, 0, 0, 3, 0.62]],
    self(),
    [[1, 2, 3], [-4, 1.5, 0]],
  ));
  await frames(page, 6);
  const after2 = await page.evaluate(() => window.__maker.balloonsDrawn());
  assert(
    before === 0 && after2 === 2,
    `the host's balloons should be in the air here, saw ${before} then ${after2}`,
  );

  await page.screenshot({ path: `${process.env.RUNNER_TEMP ?? '/tmp'}/party-meters.png` });

  // ── And the round ends for everybody ───────────────────────────────────────
  await send(page, snapshot(0, round({
    won: true,
    headline: 'Your side won!',
    lines: [['captures', '3']],
  }), [[3, 1, 0, 0.5, 6, 0, 0, 0, 0, 3, 0]]));
  // The shell waits four seconds before the result screen, so the last thing
  // that happened is visible before the game talks about it. Waited out rather
  // than skipped: that countdown lives in the tick loop, not in the mode, so
  // fast-forwarding the mode would step straight past the very thing being
  // checked — and on a guest the mode has nothing to fast-forward anyway.
  // `null` for the argument, because Playwright's second parameter is what gets
  // handed to the function and the third is the options. Written without it, the
  // fifteen-second timeout was passed as an unused argument and the wait quietly
  // ran on the thirty-second default — which is how a scenario that hung for
  // half a minute reported a timeout nobody had asked for.
  await page.waitForFunction(
    () => document.querySelector('.mk-result-big') !== null,
    null,
    { timeout: 20_000 },
  );

  const result = await page.evaluate(() => ({
    open: document.querySelector('.mk-result-big')?.textContent ?? null,
    stats: document.querySelector('.mk-stats')?.textContent ?? '',
  }));
  assert(
    result.open !== null,
    'a guest has to be told how the round ended; no result screen appeared',
  );
  assert(
    result.stats.includes('captures'),
    `the host's own summary should be the one shown, saw "${result.stats}"`,
  );

  await page.screenshot({ path: `${process.env.RUNNER_TEMP ?? '/tmp'}/party-result.png` });

  // ── And when the host packs up, so does everybody ──────────────────────────
  //
  // Checked here rather than before the round starts, which is where it was
  // first written and where it cannot fail: with no round yet adopted there is
  // nothing for "stop" to clear, so removing the code that clears it changes
  // nothing. The failure only exists once a guest is holding a round — and then
  // it holds it forever, a frozen clock over a game that has moved on.
  await send(page, snapshot(0, null, [[3, 1, 0, 0.5, 6, 0, 0, 0, 0, 3, 0]]));
  await frames(page, 6);
  const after = await page.evaluate(() => window.__maker.roundInfo());
  assert(
    after.mode === 'none',
    `a guest should let go of a round the host has ended; still in "${after.mode}"`,
  );
  console.log('[party] verified: joined a round nobody here started, banner, clock, pins,'
    + ' own meters, balloons in the air, result');
}
