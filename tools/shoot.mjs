#!/usr/bin/env node
/**
 * Headless verification harness.
 *
 * Boots the Vite dev server, loads the game in Chromium, waits for the engine
 * to signal readiness, optionally runs a scenario against the in-page debug API,
 * and writes a screenshot. Also fails loudly on console errors or uncaught
 * exceptions, so this doubles as a smoke test.
 *
 *   node tools/shoot.mjs                          # boot, settle, screenshot
 *   node tools/shoot.mjs --out shots/build.png    # choose output path
 *   node tools/shoot.mjs --scenario scenarios/stairs.mjs
 *   node tools/shoot.mjs --settle 3000 --size 1600x900
 *   node tools/shoot.mjs --scenario scenarios/crash.mjs --allow-errors
 *
 * A scenario file default-exports `async (page) => {}` and drives the game via
 * `window.__maker` (the debug API exposed by src/debug/debugApi.ts).
 */
import { spawn } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

/**
 * Find the Chromium that is actually on this machine. The container ships a
 * pinned build under PLAYWRIGHT_BROWSERS_PATH whose revision rarely matches the
 * one our playwright package wants, so resolve by scanning rather than trusting
 * playwright's computed path.
 */
function findChromium() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !existsSync(root)) return undefined;
  const dirs = readdirSync(root).filter((d) => d.startsWith('chromium-'));
  for (const d of dirs) {
    const bin = join(root, d, 'chrome-linux', 'chrome');
    if (existsSync(bin)) return bin;
  }
  return undefined;
}

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

const outPath = resolve(flag('out', 'shots/latest.png'));
const scenarioPath = flag('scenario', null);
const settleMs = Number(flag('settle', 2000));
const [width, height] = flag('size', '1280x720').split('x').map(Number);
const keepOpen = args.includes('--keep-open');
/**
 * Some scenarios provoke an error on purpose — the crash handler, for one, is
 * only worth anything if it can be shown handling a real throw. Those runs let
 * the scenario do its own asserting instead of the blanket console gate.
 */
const allowErrors = args.includes('--allow-errors');
/**
 * Adaptive quality is switched off for captures.
 *
 * This container has no GPU, so the software rasterizer misses the frame budget
 * permanently and the governor — correctly — drops to its floor. Every
 * screenshot would then be at half resolution, and would change depending on
 * how slow the machine felt that second. Scenarios that want to test the
 * governor turn it back on themselves.
 */
const autoQuality = args.includes('--auto-quality');

const log = (...m) => console.log('[shoot]', ...m);

/**
 * Grab a port the OS says is free. Using a fixed port meant a leaked dev server
 * from an earlier run would silently serve stale code to the next one — the
 * screenshot looked fine and told you nothing.
 */
async function freePort() {
  const { createServer } = await import('node:net');
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.on('error', rej);
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });
}

const port = Number(flag('port', 0)) || (await freePort());

/** Wait for the dev server to answer, rather than sleeping a fixed amount. */
async function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`dev server never came up at ${url}`);
}

const server = spawn('npx', ['vite', '--port', String(port), '--strictPort'], {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => process.stdout.write(`[vite] ${d}`));
server.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`));

const shutdown = () => {
  if (!server.killed) server.kill('SIGTERM');
};
process.on('exit', shutdown);
process.on('SIGINT', () => {
  shutdown();
  process.exit(130);
});

let exitCode = 0;
let browser;

try {
  const url = `http://localhost:${port}/`;
  await waitForServer(url);
  log('dev server up');

  const executablePath = findChromium();
  log('chromium:', executablePath ?? '(playwright default)');
  browser = await chromium.launch({
    executablePath,
    // SwiftShader software GL — there is no GPU in this container.
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--disable-gpu-sandbox',
      '--no-sandbox',
      // A synthetic microphone, and permission granted without a prompt.
      //
      // Chromium's fake device is a real audio track carrying a tone, which is
      // what makes voice testable at all here: a container has no microphone,
      // and a mocked getUserMedia would exercise the mock rather than WebRTC.
      // With this, two pages negotiate a genuine peer connection and genuine
      // Opus packets cross it — the only version of the check worth running.
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
    ],
  });
  const page = await browser.newPage({
    viewport: { width, height },
    permissions: ['microphone'],
  });

  const consoleErrors = [];
  const pageErrors = [];
  // A missing favicon is a 404 the browser reports as an error; it says nothing
  // about the game, so keep it out of the pass/fail signal.
  // A missing favicon surfaces as a console error whose text mentions only the
  // status code, so match on the request URL from the message location instead.
  const isNoise = (msg) => /favicon/.test(msg.location()?.url ?? '') || /favicon/.test(msg.text());
  page.on('console', (msg) => {
    const text = msg.text();
    if (msg.type() === 'error' && !isNoise(msg)) consoleErrors.push(text);
    log(`console.${msg.type()}:`, text);
  });
  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
    log('pageerror:', err.message, err.stack);
  });

  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // The engine sets window.__maker once the first frame has rendered.
  await page
    .waitForFunction(() => Boolean(window.__maker?.ready), null, { timeout: 60_000 })
    .catch(() => log('WARNING: window.__maker.ready never became true'));

  if (!autoQuality) {
    await page.evaluate(() => window.__maker?.setAutoQuality?.(false));
    log('adaptive quality off for a fixed-resolution capture (--auto-quality to keep it)');
  }

  await page.waitForTimeout(settleMs);

  if (scenarioPath) {
    log('running scenario', scenarioPath);
    const mod = await import(pathToFileURL(resolve(scenarioPath)).href);
    await mod.default(page);
  }

  await mkdir(dirname(outPath), { recursive: true });
  await page.screenshot({ path: outPath });
  log('screenshot ->', outPath);

  // Pull whatever diagnostics the engine chose to publish.
  const stats = await page.evaluate(() => window.__maker?.stats?.() ?? null);
  if (stats) log('stats:', JSON.stringify(stats));

  if (allowErrors) {
    log(`errors ignored by request: ${pageErrors.length} page, ${consoleErrors.length} console`);
    log('PASS: scenario completed without assertion failures');
  } else {
    if (pageErrors.length) {
      log(`FAIL: ${pageErrors.length} uncaught page error(s)`);
      exitCode = 1;
    }
    if (consoleErrors.length) {
      log(`FAIL: ${consoleErrors.length} console error(s)`);
      exitCode = 1;
    }
    if (!exitCode) log('PASS: no console or page errors');
  }

  if (keepOpen) {
    log('--keep-open set; press ctrl-c to exit');
    await new Promise(() => {});
  }
} catch (err) {
  log('harness error:', err);
  exitCode = 1;
} finally {
  await browser?.close();
  shutdown();
}

process.exit(exitCode);
