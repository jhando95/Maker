/**
 * Generate a prop with Meshy, at development time and never at run time.
 *
 * The key decides the architecture before taste gets a vote. This is a web
 * game: anything the client does, it does in front of the player, and an API
 * key in a browser bundle is public the moment somebody opens the network tab.
 * So generation happens here, on a developer's machine, with the key in an
 * environment variable — and what ships is a mesh file, reviewed like any
 * other asset. The public bundle never learns Meshy exists.
 *
 * ## Why preview mode is the whole pipeline
 *
 * Meshy's two-stage flow is preview (geometry, untextured, ~5 credits) then
 * refine (textures, ~10 more). This game deliberately has no texture pipeline —
 * every surface is a flat colour under a toon ramp with an ink outline, and
 * that constraint is most of the look. An untextured low-poly mesh painted
 * with the game's own materials keeps that rule exactly, at a third of the
 * credit cost. Refine exists behind a flag for the day a texture is worth the
 * argument, and defaults off.
 *
 *   MESHY_API_KEY=... node tools/meshy.mjs "a wooden dog house" --name doghouse
 *   MESHY_API_KEY=... node tools/meshy.mjs "..." --name x --refine   # textures
 *
 * Output lands in assets/meshy/, which is gitignored on purpose: a generation
 * is raw material, not an asset. Promotion — scaling, painting, committing into
 * public/props/ — is a review step a person does with eyes on the mesh.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const API = 'https://api.meshy.ai';
const OUT_DIR = 'assets/meshy';

const key = process.env.MESHY_API_KEY;
if (key === undefined || key === '') {
  console.error('[meshy] MESHY_API_KEY is not set. It lives in your shell, never in the repo.');
  process.exit(1);
}

const args = process.argv.slice(2);
const prompt = args.find((a) => !a.startsWith('--'));
const name = args[args.indexOf('--name') + 1];
const refine = args.includes('--refine');
if (prompt === undefined || args.indexOf('--name') === -1 || name === undefined) {
  console.error('usage: node tools/meshy.mjs "<prompt>" --name <slug> [--refine]');
  process.exit(1);
}

async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

/** Poll until a task settles. Meshy tasks run one to a few minutes. */
async function wait(id) {
  for (let tick = 0; tick < 240; tick++) {
    const task = await api(`/openapi/v2/text-to-3d/${id}`);
    if (task.status === 'SUCCEEDED') return task;
    if (task.status === 'FAILED' || task.status === 'CANCELED') {
      throw new Error(`task ${id} ${task.status}: ${task.task_error?.message ?? 'no reason given'}`);
    }
    process.stdout.write(`\r[meshy] ${task.status} ${task.progress ?? 0}%   `);
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`task ${id} still running after 20 minutes; giving up politely`);
}

async function download(url, file) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  writeFileSync(file, bytes);
  return bytes.length;
}

const balance = await api('/openapi/v1/balance');
console.log(`[meshy] balance: ${balance.balance} credits`);

console.log(`[meshy] preview: "${prompt}"`);
const preview = await api('/openapi/v2/text-to-3d', {
  method: 'POST',
  body: JSON.stringify({
    mode: 'preview',
    prompt,
    // Low-poly is the game's own register: flat faces take a toon ramp and an
    // outline the way smooth normals never do, and the polycount keeps a prop
    // cheaper than the house it stands beside.
    model_type: 'lowpoly',
    target_polycount: 3000,
    // Real-world metres with the origin at the base, which is what a thing
    // standing on a lawn wants to be.
    auto_size: true,
    origin_at: 'bottom',
    target_formats: ['glb'],
  }),
});

const previewTask = await wait(preview.result);
console.log(`\n[meshy] preview done, ${previewTask.consumed_credits ?? '?'} credits`);

mkdirSync(OUT_DIR, { recursive: true });
let task = previewTask;
let suffix = '.preview';

if (refine) {
  console.log('[meshy] refining (textures)…');
  const refined = await api('/openapi/v2/text-to-3d', {
    method: 'POST',
    body: JSON.stringify({
      mode: 'refine',
      preview_task_id: preview.result,
      texture_resolution: '2k',
      target_formats: ['glb'],
    }),
  });
  task = await wait(refined.result);
  console.log(`\n[meshy] refine done, ${task.consumed_credits ?? '?'} credits`);
  suffix = '';
}

const glb = task.model_urls?.glb;
if (glb === undefined) throw new Error('no GLB url on the finished task');
const file = join(OUT_DIR, `${name}${suffix}.glb`);
const size = await download(glb, file);
console.log(`[meshy] ${file}  ${(size / 1024).toFixed(0)}KB`);
if (task.thumbnail_url) {
  const thumb = join(OUT_DIR, `${name}.png`);
  await download(task.thumbnail_url, thumb);
  console.log(`[meshy] ${thumb}`);
}
const after = await api('/openapi/v1/balance');
console.log(`[meshy] balance now: ${after.balance} credits`);
