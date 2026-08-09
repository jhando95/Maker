/**
 * Run the browser scenarios, split across however many machines there are.
 *
 * CI ran twenty-seven of these one after another in a single job, as twenty-seven
 * near-identical steps in the workflow file. That is two problems in one shape.
 *
 * **It is slow in a way nothing about it needs to be.** Each scenario is an
 * independent process with its own dev server and its own browser; none of them
 * shares state with any other. Half an hour of strictly serial work that is
 * embarrassingly parallel is half an hour spent waiting on a scheduler.
 *
 * **And the list was written down twice.** A new scenario meant a new file *and*
 * a new step in the workflow, and forgetting the second one is silent — the
 * scenario simply never runs, and nothing anywhere says so. That is the shape of
 * bug this project has lost to four times, so the list is read off the directory
 * now and the workflow says only how many shards to cut it into.
 *
 * ## Balancing
 *
 * Round-robin would be the obvious split and a poor one: `voice.mjs` is five
 * minutes on its own and the soak is nearly two, so a shard that draws both is
 * the whole job's wall clock while another finishes in ninety seconds. Longest
 * processing time first — sort by cost, give each next-longest to whichever
 * shard is currently lightest — is the standard answer, is four lines, and is
 * within a third of optimal for any input.
 *
 * The costs are measured, approximate, and only have to be right about the
 * *order*: getting them wrong makes a shard slightly uneven, not wrong.
 *
 *   node tools/scenarios.mjs            # all of them, in one process
 *   node tools/scenarios.mjs 2 5        # shard 2 of 5
 */

import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

/**
 * Roughly how long each one takes on a CI runner, in seconds.
 *
 * Anything not listed gets the default, which is deliberately on the high side:
 * a new scenario nobody has timed should be treated as expensive, so it lands on
 * a light shard rather than on top of the heaviest one.
 */
const SECONDS = {
  voice: 300,
  soak: 105,
  profile: 100,
  multiplayer: 45,
  lobby: 45,
  'lobby-friends': 45,
  party: 40,
  locker: 40,
  frontend: 40,
  gamepad: 40,
  blueprint: 35,
  collapse: 30,
  kids: 30,
  tag: 25,
  lava: 25,
  hud: 25,
};
const DEFAULT_SECONDS = 30;

/** Extra arguments a particular scenario needs. */
const FLAGS = {
  // The crash scenario throws on purpose; the harness would otherwise fail it
  // for the very error it exists to produce.
  crash: ['--allow-errors'],
};

/** Scenarios that want adaptive quality left on, because they measure it. */
const AUTO_QUALITY = new Set([
  'water', 'actors', 'hud', 'lumber', 'kids', 'lawn', 'party', 'multiplayer',
  'lobby', 'mantle', 'items', 'tag', 'lava', 'collapse', 'spray', 'profile',
  'soak', 'bounds', 'frontend', 'comms', 'voice', 'blueprint', 'locker',
  'lobby-friends', 'quality',
]);

export function allScenarios(dir = join(root, 'scenarios')) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.mjs') && !f.startsWith('_'))
    .map((f) => f.slice(0, -4))
    .sort();
}

export function costOf(name) {
  return SECONDS[name] ?? DEFAULT_SECONDS;
}

/**
 * Split names across `total` shards, heaviest first onto the lightest shard.
 *
 * Returns every shard rather than just the one asked for, because the property
 * worth testing is that the shards *together* are the whole list exactly once —
 * and a function that returns one slice cannot be asked that.
 */
export function shards(names, total, cost = costOf) {
  const buckets = Array.from({ length: Math.max(1, total) }, () => ({ load: 0, names: [] }));
  // Ties broken by name so the split is the same on every machine, which is what
  // makes a failure on shard 3 reproducible by running shard 3.
  const order = [...names].sort((a, b) => (cost(b) - cost(a)) || a.localeCompare(b));
  for (const name of order) {
    let lightest = buckets[0];
    for (const bucket of buckets) if (bucket.load < lightest.load) lightest = bucket;
    lightest.names.push(name);
    lightest.load += cost(name);
  }
  return buckets.map((b) => b.names.sort());
}

function argsFor(name) {
  const out = ['tools/shoot.mjs', '--scenario', `scenarios/${name}.mjs`];
  if (AUTO_QUALITY.has(name)) out.push('--auto-quality');
  out.push(...(FLAGS[name] ?? []));
  out.push('--out', `${process.env.RUNNER_TEMP ?? '/tmp'}/ci-${name}.png`);
  return out;
}

function main() {
  const [rawIndex, rawTotal] = process.argv.slice(2);
  const total = Number(rawTotal ?? 1);
  const index = Number(rawIndex ?? 1);
  const names = allScenarios();
  const mine = Number.isFinite(total) && total > 1
    ? shards(names, total)[index - 1] ?? []
    : names;

  console.log(`[scenarios] shard ${index}/${total}: ${mine.length} of ${names.length}`
    + ` — ${mine.join(', ')}`);

  for (const name of mine) {
    console.log(`[scenarios] --- ${name}`);
    const run = spawnSync('node', argsFor(name), { cwd: root, stdio: 'inherit' });
    if (run.status !== 0) {
      console.error(`[scenarios] ${name} failed with status ${run.status}`);
      process.exit(run.status ?? 1);
    }
  }
  console.log(`[scenarios] shard ${index}/${total} passed all ${mine.length}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
