/**
 * Count how many pixels differ between two PNGs.
 *
 * A blunt instrument on purpose: when the question is "does this pass render at
 * all", a count of changed pixels answers it and a screenshot does not — a
 * one-pixel ink line is invisible to me at a glance and unmistakable here.
 */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

/**
 * A PNG, as `{ w, h, ch, px }` with `px` a flat RGB(A) byte buffer.
 *
 * Exported because more than one scenario now needs to ask a question about
 * pixels, and every one that rolls its own decoder is a second place for the
 * Paeth filter to be wrong.
 */
export function decode(path) {
  const data = readFileSync(path);
  let pos = 8, w = 0, h = 0, ct = 0;
  const idat = [];
  while (pos < data.length) {
    const len = data.readUInt32BE(pos);
    const type = data.toString('ascii', pos + 4, pos + 8);
    if (type === 'IHDR') {
      w = data.readUInt32BE(pos + 8);
      h = data.readUInt32BE(pos + 12);
      ct = data[pos + 17];
    } else if (type === 'IDAT') {
      idat.push(data.subarray(pos + 8, pos + 8 + len));
    }
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  const stride = w * ch;
  const out = Buffer.alloc(w * h * ch);
  let prev = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[p++];
    const line = Buffer.from(raw.subarray(p, p + stride));
    p += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? line[i - ch] : 0;
      const b = prev[i];
      const c = i >= ch ? prev[i - ch] : 0;
      if (f === 1) line[i] = (line[i] + a) & 255;
      else if (f === 2) line[i] = (line[i] + b) & 255;
      else if (f === 3) line[i] = (line[i] + ((a + b) >> 1)) & 255;
      else if (f === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        line[i] = (line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    }
    line.copy(out, y * stride);
    prev = line;
  }
  return { w, h, ch, px: out };
}

/** How many pixels differ between two PNGs, and out of how many. */
export function diffPixels(a, b, tolerance = 8) {
  const A = decode(a), B = decode(b);
  if (A.w !== B.w || A.h !== B.h) throw new Error('imgdiff: different sizes');
  let diff = 0;
  for (let i = 0; i < A.px.length; i += A.ch) {
    if (Math.abs(A.px[i] - B.px[i]) > tolerance
      || Math.abs(A.px[i + 1] - B.px[i + 1]) > tolerance
      || Math.abs(A.px[i + 2] - B.px[i + 2]) > tolerance) diff++;
  }
  return { diff, total: A.w * A.h };
}

/**
 * How many pixels got brighter between two PNGs, and how many got darker.
 *
 * `diffPixels` answers "did the picture change", which is the right question
 * for "does this pass render at all" and the wrong one for anything additive.
 * A glow is light *added* to a frame: it can only ever push pixels up, so the
 * count that went down is the assertion that the blend mode is what it claims
 * to be. A glow drawn with normal blending, or with a sign error, changes just
 * as many pixels — and half of them the wrong way.
 */
export function brighter(a, b, tolerance = 8) {
  const A = decode(a), B = decode(b);
  if (A.w !== B.w || A.h !== B.h) throw new Error('imgdiff: different sizes');
  const luma = (px, i) => 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
  let up = 0, down = 0;
  for (let i = 0; i < A.px.length; i += A.ch) {
    const d = luma(A.px, i) - luma(B.px, i);
    if (d > tolerance) up++;
    else if (d < -tolerance) down++;
  }
  return { up, down, total: A.w * A.h };
}

// Also usable from the shell, which is how it started.
if (process.argv[1]?.endsWith('imgdiff.mjs')) {
  const [a, b] = process.argv.slice(2);
  const { diff, total } = diffPixels(a, b);
  console.log(`${diff} of ${total} pixels differ (${(100 * diff / total).toFixed(3)}%)`);
}
