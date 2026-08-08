/**
 * A second player, in a real browser, over the real protocol.
 *
 * A second full game cannot run in the same page — `main.ts` is a module and
 * there is one world — so the scenario *is* the other person. It speaks the wire
 * format down a real transport into the real session, and everything on the
 * page's side of that pipe is exactly what a relay would drive: the same
 * handshake, the same commands, the same building requests, the same snapshots
 * coming back.
 *
 * What this covers that the unit tests cannot: whether a person who joined
 * reaches the renderer at all. The session can be perfectly correct and the
 * guest still invisible — the roster is rebuilt by a running mode, the character
 * rig is driven from a list assembled in the draw call, and neither of those is
 * exercised by a test that never renders. That exact bug was real: anyone who
 * joined a Free Build session existed, collided, and was never drawn.
 *
 *   node tools/shoot.mjs --scenario scenarios/multiplayer.mjs --out shots/multiplayer.png
 */

const assert = (cond, message) => {
  if (!cond) throw new Error(`multiplayer scenario: ${message}`);
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

const drain = (page) => page.evaluate(() => window.__maker.guestDrain());
const send = (page, message) =>
  page.evaluate((m) => window.__maker.guestSend(m), message);

/**
 * One monotonic tick counter for the whole scenario.
 *
 * The host keeps only the newest command it has seen and discards anything with
 * an older tick — which is right, because an old command is input for a tick
 * that has already happened. Hand-numbering each burst separately means the
 * second burst can be numbered *below* the first and be silently thrown away, so
 * the guest stands still and nothing says why.
 */
let nextTick = 0;
const walkCommand = (moveX, moveZ) => ({ t: 'cmd', c: [nextTick++, moveX, moveZ, 0, 0, 0, 0, 0] });

/** Standing still with the trigger down, holding the weapon in `slot`. */
const fireCommand = (slot = 0) => ({ t: 'cmd', c: [nextTick++, 0, 0, 0, 0, 0, BUTTON_FIRE, slot] });

/** `BUTTON.fire` from src/core/command.ts, restated because this file is not TypeScript. */
const BUTTON_FIRE = 1 << 3;

/**
 * Wait for a message of this kind, and return the *newest* one seen.
 *
 * Newest rather than first, because snapshots arrive twenty a second and the
 * queue is drained in batches: taking the first match reads a snapshot from
 * several seconds ago and compares it against the world as it is now, which
 * fails in a way that looks exactly like the host publishing stale positions.
 */
async function await_(page, kind, tries = 60) {
  const seen = [];
  for (let i = 0; i < tries; i++) {
    seen.push(...await drain(page));
    const matches = seen.filter((m) => m.t === kind);
    if (matches.length > 0) return { hit: matches[matches.length - 1], seen };
    await frames(page, 2);
  }
  throw new Error(`multiplayer scenario: never saw a "${kind}" (saw ${
    [...new Set(seen.map((m) => m.t))].join(', ') || 'nothing'})`);
}

export default async function (page) {
  await page.evaluate(() => {
    window.__maker.setAutoQuality(false);
    window.__maker.hideOverlay();
    window.__maker.teleport(-20, 0.5, 4);
    window.__maker.lookAt(0, -0.1);
    window.__maker.hostWithFakeGuest();
  });

  // ── The handshake ──────────────────────────────────────────────────────────
  // The version is read out of the page rather than typed in here. Written as a
  // literal it silently goes stale the next time the protocol changes, and the
  // failure — "expected a welcome, saw refused" — points at the handshake rather
  // than at the number.
  const version = await page.evaluate(() => window.__maker.protocolVersion);
  await send(page, { t: 'hello', version, name: 'the other kid' });
  const { hit: welcome } = await await_(page, 'welcome');

  assert(typeof welcome.id === 'number' && welcome.id > 0,
    `a guest needs an id that is not the host's, got ${welcome.id}`);
  assert(welcome.team === 'right',
    `a joiner should land on the other side, got "${welcome.team}"`);
  assert(Array.isArray(welcome.parts),
    'a guest has to be handed the world as it stands, or they play a different map');
  assert(welcome.parts.length > 0,
    'the starter structures exist, so the world sent cannot be empty');
  assert(
    Array.isArray(welcome.parts[0]) && welcome.parts[0].length === 2,
    'parts travel with the host ids attached, or a removal names the wrong plank',
  );

  const status = await page.evaluate(() => window.__maker.netStatus());
  assert(status !== null && status.role === 'host', 'the page should be hosting');
  assert(status.peers === 1, `one guest should have joined, host says ${status.peers}`);

  // ── The guest becomes a person on the lawn ─────────────────────────────────
  const drawn = await page.evaluate(() => ({
    ids: window.__maker.drawnActorIds(),
    posed: window.__maker.charactersPosed(),
  }));
  assert(
    drawn.ids.includes(welcome.id),
    `the guest should be somebody you can see; drawn ids were ${drawn.ids.join(',')}`,
  );
  assert(drawn.posed >= 1, 'and the rig should have posed them');

  // ── Their commands move them, on this machine ──────────────────────────────
  const startedAt = await page.evaluate((id) => {
    const a = window.__maker.actors.get(id);
    return a === undefined ? null : { x: a.controller.x, z: a.controller.z };
  }, welcome.id);
  assert(startedAt !== null, 'the guest should be in the roster');

  // Walk them until they have actually got somewhere, then stop.
  //
  // moveZ is world space and already rotated, which is exactly what a real
  // client sends. The host repeats the last command it has on every tick — which
  // is what stops a player with a late packet from freezing — so how far they
  // travel depends on how many *simulation* ticks elapse between two sends, and
  // that depends on the frame rate. Sending a fixed number of commands and then
  // measuring the distance is therefore measuring the runner's frame rate: it
  // walked seven metres here and 0.44m on CI, and the assertion was the same.
  //
  // So this waits for the distance rather than assuming a frame count produces
  // it, and stops the moment it has enough. The cap is a timeout, not a target.
  const WALK_TARGET = 2.0;
  let travelled = 0;
  for (let i = 0; i < 400 && travelled < WALK_TARGET; i++) {
    travelled = await page.evaluate(({ id, from, t }) => {
      window.__maker.guestSend({ t: 'cmd', c: [t, 0, -1, 0, 0, 0, 0, 0] });
      const a = window.__maker.actors.get(id);
      return a === undefined ? 0 : Math.hypot(a.controller.x - from.x, a.controller.z - from.z);
    }, { id: welcome.id, from: startedAt, t: nextTick++ });
    await frames(page, 1);
  }
  await send(page, walkCommand(0, 0));
  await frames(page, 6);

  const movedTo = await page.evaluate((id) => {
    const a = window.__maker.actors.get(id);
    return a === undefined ? null : { x: a.controller.x, z: a.controller.z };
  }, welcome.id);
  assert(movedTo !== null, 'the guest should still be in the roster after walking');
  const walked = Math.hypot(movedTo.x - startedAt.x, movedTo.z - startedAt.z);
  assert(
    walked >= WALK_TARGET,
    `their commands should move them; they went ${walked.toFixed(2)}m`,
  );

  // ── Snapshots come back, and say where everybody is ────────────────────────
  await drain(page);
  await frames(page, 6);
  const { hit: snap } = await await_(page, 'snap');
  assert(Array.isArray(snap.actors) && snap.actors.length >= 2,
    `a snapshot should carry everybody, saw ${snap.actors?.length}`);
  const mine = snap.actors.find((a) => a[0] === welcome.id);
  assert(mine !== undefined, 'including the guest themselves, or they cannot predict');
  assert(
    Math.abs(mine[4] - movedTo.z) < 0.5,
    `and it should say where they actually are — ${mine[4]} vs ${movedTo.z}`,
  );
  assert(snap.ack >= 0, 'and acknowledge a command, or prediction never converges');

  // ── They can build, and the host decides ───────────────────────────────────

  // Beside the guest, read off the roster rather than written down.
  //
  // It used to be a fixed spot at (-18, 2), which is forty metres from where a
  // guest actually spawns — a placement the client's own snapper would never
  // have produced, and one the host now refuses because a guest cannot build
  // across the map. Worth fixing rather than exempting: a scenario about a
  // guest building has to ask for something a guest could build.
  const spot = await page.evaluate((id) => {
    const a = window.__maker.actors.get(id);
    return a === undefined ? null : { x: +(a.controller.x + 2).toFixed(3), z: +a.controller.z.toFixed(3) };
  }, welcome.id);
  assert(spot !== null, 'the guest should be in the roster before they build');

  const before = await page.evaluate(() => window.__maker.stats().parts);
  await send(page, {
    t: 'build',
    r: { kind: 0, colorway: 0, x: spot.x, y: 0.5, z: spot.z, qx: 0, qy: 0, qz: 0, qw: 1 },
  });
  const { hit: built } = await await_(page, 'built');
  const after = await page.evaluate(() => window.__maker.stats().parts);
  assert(after === before + 1, `a guest's plank should appear in the host's world`);
  assert(typeof built.id === 'number', 'and be announced with an id a removal can name');

  // The same request again must be refused, because the space is taken. This is
  // the whole reason there is an authority.
  await send(page, {
    t: 'build',
    r: { kind: 0, colorway: 0, x: spot.x, y: 0.5, z: spot.z, qx: 0, qy: 0, qz: 0, qw: 1 },
  });
  await frames(page, 10);
  await drain(page);
  const stillAfter = await page.evaluate(() => window.__maker.stats().parts);
  assert(stillAfter === after, 'and a second plank in the same space must be refused');

  // ── And taking it down reaches everybody ───────────────────────────────────
  await send(page, { t: 'unbuild', p: built.id });
  await await_(page, 'unbuilt');
  const removed = await page.evaluate(() => window.__maker.stats().parts);
  assert(removed === before, `taking it down should leave ${before}, left ${removed}`);

  // ── And they can fight, which is the thing the wire was built for ─────────
  //
  // Everything above is a guest being *present*: a body that walks, a plank
  // that lands. This is the guest doing the one thing the round is about, and
  // it is the only check here that fails if the host reads a command's position
  // and throws away its trigger — which is exactly what the host used to do.
  //
  // Driven through a real command down a real transport rather than by calling
  // the mode, because the seam under test is the one between them.
  await page.evaluate(() => {
    window.__maker.startRound('waterWar');
    // Past the building phase: there is nothing to fire at during it, and the
    // mode refuses to fire at all. Fast-forwarded with the trigger up so the
    // only shot fired in this test is the guest's.
    window.__maker.fastForward(90, 'RAID 1');
  });
  const phase = await page.evaluate(() => window.__maker.roundInfo().phase);
  assert(
    (phase ?? '').startsWith('RAID'),
    `the raid should have started before the guest fires, phase is "${phase}"`,
  );

  await drain(page);
  // Hold the trigger for a while. A tank is metered per second of stream, so
  // this needs real ticks rather than a single command.
  let tank = null;
  let full = null;
  for (let i = 0; i < 120; i++) {
    await send(page, fireCommand(0));
    await frames(page, 1);
    const seen = (await drain(page)).filter((m) => m.t === 'snap' && m.you !== null);
    for (const snap of seen) {
      if (snap.you.ammo === null) continue;
      if (full === null) full = snap.you.ammo[1];
      tank = snap.you.ammo[0];
    }
    if (tank !== null && full !== null && tank < full * 0.95) break;
  }
  assert(full !== null, 'the host should tell a guest what is in their own tank');
  assert(
    tank < full,
    `holding the trigger should spend the guest's own water; ${tank} of ${full}`,
  );

  // And the host's own tank is untouched, because it is a different tank.
  const hostTank = await page.evaluate(() => window.__maker.getMode()?.tankLevel ?? null);
  assert(
    hostTank !== null && hostTank > tank,
    `the host was not firing and should still be fuller than the guest;`
    + ` host ${hostTank}, guest ${tank}`,
  );
  await page.evaluate(() => window.__maker.stopRound());
  await frames(page, 4);

  // ── Leaving empties the lawn ───────────────────────────────────────────────
  // Out of the corner they spawned in, so the shot is two people on open lawn
  // rather than one person and a bush.
  for (let tick = 0; tick < 10; tick++) {
    await send(page, walkCommand(-1, -0.35));
    await frames(page, 1);
  }
  await send(page, walkCommand(0, 0));
  await frames(page, 4);

  const framed = await page.evaluate(() => {
    // Frame the guest before they go, so the screenshot has two people in it.
    const a = window.__maker.actors.all.find((x) => x.kind === 'remote');
    if (a === undefined) return null;
    // First person, looking at them from a few metres away.
    //
    // Third person put the camera behind the local player's shoulders, which
    // means aiming at somebody frames your own back — three attempts at it
    // produced a bush, a tree trunk and an empty lawn. The shot that is actually
    // worth having is the one the joining player is in, seen the way you would
    // see them.
    window.__maker.setCameraMode('first');
    window.__maker.teleport(a.controller.x, 0.5, a.controller.z + 2.6);
    window.__maker.lookAtPoint(a.controller.x, a.controller.y + 1.0, a.controller.z);
    return { x: +a.controller.x.toFixed(2), y: +a.controller.y.toFixed(2), z: +a.controller.z.toFixed(2) };
  });
  await frames(page, 6);
  assert(framed !== null, 'the guest should still be here to photograph');
  const shot = await page.evaluate(() => {
    // Where the rig actually put their torso, so "they are on screen" is a
    // measurement rather than a look at a screenshot — the picture is a record,
    // not the test.
    const torso = window.__maker.scene.getObjectByName('characters').getObjectByName('torso');
    const m = torso.instanceMatrix.array;
    return {
      ids: window.__maker.drawnActorIds(),
      posed: window.__maker.charactersPosed(),
      torso: [m[12], m[13], m[14]],
      people: window.__maker.actors.all.map((a) => ({
        id: a.id, kind: a.kind, team: a.team,
        p: [a.controller.x, a.controller.y, a.controller.z],
      })),
    };
  });
  // One person on screen, because this is first person and the other is holding
  // the camera. Both are still in the world, which is the claim that matters.
  assert(shot.ids.length === 1 && shot.ids[0] !== 0,
    `the guest should be the one drawn, drew ${shot.ids.join(',')}`);
  assert(shot.posed === 1, `and the rig should have posed them, posed ${shot.posed}`);
  assert(shot.people.length === 2, `two people should be in the world, saw ${shot.people.length}`);
  const joiner = shot.people.find((p) => p.kind === 'remote');
  assert(joiner !== undefined && joiner.team === 'right',
    'and the joiner should be on the other side, wearing the other shirt');
  // The body drawn is the joiner's, standing where the session says they are —
  // not a stale instance left over from a frame before they moved.
  const off = Math.hypot(shot.torso[0] - joiner.p[0], shot.torso[2] - joiner.p[2]);
  assert(off < 0.05, `the drawn body should be where they are, ${off.toFixed(2)}m out`);
  await page.screenshot({ path: process.env.MP_SHOT ?? 'shots/multiplayer.png' });

  await page.evaluate(() => window.__maker.leaveSession());
  await frames(page, 3);
  const alone = await page.evaluate(() => ({
    ids: window.__maker.drawnActorIds(),
    status: window.__maker.netStatus(),
  }));
  assert(alone.status === null, 'leaving should end the session');
  assert(
    !alone.ids.includes(welcome.id),
    'and take the guest with it — otherwise they stand on the lawn forever',
  );

  console.log(
    '[multiplayer] verified: a guest joins over the real protocol, is handed the world with',
    'ids attached, becomes a character on the lawn, walks on their own commands,',
    'appears in snapshots, builds through the host, is refused an illegal placement,',
    'and is gone when they leave',
  );
}
