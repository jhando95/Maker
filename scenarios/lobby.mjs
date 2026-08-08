/**
 * Two browsers, a friend code, a party, a queue, and a yard at the end of it.
 *
 * This is the one scenario that drives the whole feature end to end against a
 * real server: two pages, a real lobby process, real WebSockets. Everything
 * below the surface is already unit-tested in-process — the rules in
 * `lobbyCore.test.ts`, the client's state in `lobby.test.ts` — so what is left
 * for this to prove is the part neither can see:
 *
 * - that any of it reaches the screen at all, as pixels and DOM;
 * - that a code minted on one machine works when typed into another;
 * - that a match hands both pages into the *same* room and exactly one of them
 *   hosts;
 * - and that a round actually starts in there.
 *
 * The failure this exists to catch is the boring one: everything works and
 * nothing is wired up.
 *
 *   node tools/shoot.mjs --scenario scenarios/lobby.mjs --out shots/lobby.png
 */

import { spawn } from 'node:child_process';

const assert = (cond, message) => {
  if (!cond) throw new Error(`lobby scenario: ${message}`);
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

/** Wait for something on the page rather than for a number of milliseconds. */
const until = (page, fn, what, timeout = 15000) =>
  page.waitForFunction(fn, undefined, { timeout, polling: 'raf' })
    .catch(() => { throw new Error(`lobby scenario: timed out waiting for ${what}`); });

/** Open the lobby screen on a page, pointed at the test server. */
async function openLobby(page, url) {
  await page.evaluate((address) => {
    window.__maker.setAutoQuality(false);
    window.__maker.hideOverlay();
    window.__maker.menu.show('title');
    window.__maker.openLobby(address);
    window.__maker.menu.show('lobby');
  }, url);
  await until(page, () => window.__maker.lobbyState()?.connected === true, 'the lobby to connect');
}

const state = (page) => page.evaluate(() => window.__maker.lobbyState());

/** The friends list as a player reads it: off the DOM, not out of the client. */
const friendRows = (page) =>
  page.evaluate(() => [...document.querySelectorAll('.mk-row')].map((r) => ({
    who: r.querySelector('.who')?.textContent ?? '',
    state: r.querySelector('.state')?.textContent ?? '',
    dot: r.querySelector('.mk-dot')?.className ?? '',
  })));

export default async function (page) {
  // ── A lobby to talk to ─────────────────────────────────────────────────────
  //
  // Spawned here rather than assumed to be running, because a scenario that
  // needs a service somebody remembered to start is a scenario that gets
  // skipped in CI and then stops being true. Its own port, so it cannot
  // collide with a lobby a developer already has open.
  const port = 8790 + Math.floor(Math.random() * 200);
  const url = `ws://localhost:${port}`;
  const server = spawn('npx', ['vite-node', 'server/serve.ts', String(port)], {
    cwd: process.cwd(), stdio: 'ignore',
  });

  try {
    await waitForServer(port);

    // ── A second browser, because one page cannot befriend itself ────────────
    //
    // A second *context*, not just a second page: pages in one context share
    // localStorage, so they would share an identity — and the lobby treats a
    // second connection from one identity as a reopened tab, which is exactly
    // the opposite of two players.
    const other = await page.context().browser().newContext();
    const second = await other.newPage();
    await second.goto(page.url());
    await until(second, () => window.__maker !== undefined, 'the second page to boot');

    await openLobby(page, url);
    await openLobby(second, url);

    // ── Each page is given a code, and they are different ──────────────────────
    const mine = await state(page);
    const theirs = await state(second);
    assert(typeof mine.code === 'string' && mine.code.length === 6,
      `a page should be given a six-character code, saw ${JSON.stringify(mine.code)}`);
    assert(mine.code !== theirs.code, 'two players were given the same code');

    // And it is on screen, grouped for reading aloud rather than as six letters.
    const shown = await page.evaluate(
      () => document.querySelector('.mk-code b')?.textContent ?? '');
    assert(/^[0-9A-Z]{3}-[0-9A-Z]{3}$/.test(shown),
      `the code should be shown grouped, saw "${shown}"`);

    // ── Typing that code into the other browser makes them friends ─────────────
    await second.evaluate((code) => {
      const input = document.querySelector('.mk-input[aria-label="friend code"]');
      input.value = code;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    }, `${mine.code.slice(0, 3)}-${mine.code.slice(3)}`.toLowerCase());

    await until(second, () => (window.__maker.lobbyState()?.friends ?? []).length === 1,
      'the friend to appear on the page that added them');
    // Mutual, and the other page finds out without asking.
    await until(page, () => (window.__maker.lobbyState()?.friends ?? []).length === 1,
      'the friendship to reach the other page');

    const rows = await second.evaluate(
      () => [...document.querySelectorAll('.mk-row .who')].map((n) => n.textContent));
    assert(rows.length >= 1, `the friend should be drawn as a row, saw ${JSON.stringify(rows)}`);

    // Presence is a word as well as a colour, because a colour alone is
    // unreadable to anybody who cannot tell the two greens apart.
    const drawn = await friendRows(second);
    assert(drawn.some((r) => r.state.toLowerCase() === 'online'),
      `a friend who is here should read as online, saw ${JSON.stringify(drawn)}`);
    assert(drawn.some((r) => r.dot.includes('online')),
      'and carry the matching dot');

    await page.screenshot({ path: `${process.env.RUNNER_TEMP ?? '/tmp'}/lobby-friends.png` });

    // ── One invites the other into a party ─────────────────────────────────────
    await second.evaluate(() => {
      const invite = [...document.querySelectorAll('.mk-row .mk-mini')]
        .find((b) => b.textContent === 'invite');
      invite.click();
    });
    await until(page, () => (window.__maker.lobbyState()?.invitations ?? []).length === 1,
      'the invitation to arrive');

    // Accepted from the DOM, the way a player accepts one.
    await page.evaluate(() => {
      [...document.querySelectorAll('.mk-invite .mk-mini')]
        .find((b) => b.textContent === 'join them').click();
    });
    await until(page, () => (window.__maker.lobbyState()?.party?.members ?? []).length === 2,
      'the party to have two people in it');
    await until(second, () => (window.__maker.lobbyState()?.party?.members ?? []).length === 2,
      'the party to reach the leader');

    // ── The leader queues, and the party goes in together ──────────────────────
    const leaderIsSecond = (await state(second)).party.leaderCode === theirs.code;
    const leader = leaderIsSecond ? second : page;
    const follower = leaderIsSecond ? page : second;

    // The one who did not start the party is told why they have no buttons,
    // rather than shown buttons that refuse.
    const followerText = await follower.evaluate(() => document.body.textContent ?? '');
    assert(followerText.includes('started the party picks the game'),
      'a party member who is not the leader should be told who picks');

    await leader.evaluate(() => {
      const buttons = [...document.querySelectorAll('.mk-btn')];
      buttons.find((b) => b.textContent === 'Water War').click();
    });

    // ── Which lands both of them in one yard, with one host ────────────────────
    await until(page, () => window.__maker.lastMatch() !== null, 'a match on the first page', 25000);
    await until(second, () => window.__maker.lastMatch() !== null, 'a match on the second page', 25000);

    const a = await page.evaluate(() => window.__maker.lastMatch());
    const b = await second.evaluate(() => window.__maker.lastMatch());
    assert(a.room === b.room, `both should land in one room, saw "${a.room}" and "${b.room}"`);
    assert(a.host !== b.host, 'exactly one of the two should host');
    assert(a.mode === 'waterWar', `the mode queued for should be the mode matched, saw ${a.mode}`);

    // ── And a round is actually running in there ───────────────────────────────
    //
    // The point of the whole feature, and the assertion most likely to catch a
    // wiring mistake: everything above can pass with the match handed over and
    // nobody ever put into a game.
    await until(page, () => window.__maker.roundInfo().mode === 'waterWar',
      'the round to start on the first page', 25000);
    await until(second, () => window.__maker.roundInfo().mode !== 'none',
      'the round to reach the second page', 25000);

    const host = a.host ? page : second;
    const guest = a.host ? second : page;
    await until(host, () => window.__maker.netStatus()?.peers === 1,
      'the guest to reach the host', 25000);

    const banner = await guest.evaluate(
      () => document.querySelector('.maker-mode .phase')?.textContent ?? '');
    assert(banner.length > 0, 'the guest should see the round on the banner');

    await host.screenshot({ path: `${process.env.RUNNER_TEMP ?? '/tmp'}/lobby-match.png` });
    await other.close();

    console.log('[lobby] verified: two codes, a friendship both ways, a party, a queue,'
      + ` one room with one host, and a "${banner}" round running in it`);
  } finally {
    server.kill('SIGKILL');
  }
}

/** Wait for the lobby's status page to answer, or give up with a useful line. */
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
  throw new Error(`lobby scenario: the server never came up on ${port}`);
}
