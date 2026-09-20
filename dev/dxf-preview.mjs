/**
 * Render a DXF to PNG, for drawings that are pictures rather than models.
 *
 * Some DXFs carry no CAD semantics at all: one layer, no TEXT, no DIMENSION, no
 * LINE or ARC — just polylines and hatches, at paper scale. Whatever produced
 * them, the vector path has nothing to work with, because `extractVector`'s
 * whole premise is that the coordinates mean something in the world.
 *
 * Such a file is still a perfectly good DRAWING, though: the linework is there
 * and the lettering survives as glyph outlines, legible to a reader and to a
 * vision pass. So render it and use the raster path, which is the honest route
 * for a file whose information is pictorial.
 *
 * Streaming, because these files run to hundreds of megabytes — `dxf-parser`
 * reads the whole thing into one string, which is exactly what you cannot do at
 * 500 MB. Only the entity types that carry linework are collected; HATCH is
 * skipped by default (there can be over a million of them, and on a drawing
 * like this they are mostly the filled interiors of letters, which the outlines
 * already describe).
 *
 * A drawing SET is often tiled across model space — a dozen sheets in a row —
 * so the whole extent renders as an unreadable strip. `--region` crops to one
 * sheet, which is what makes the lettering legible enough to read back.
 *
 *   node dev/dxf-preview.mjs <in.dxf> <out.png> [--width 4000] [--hatch]
 *   node dev/dxf-preview.mjs in.dxf sheet2.png --region 780,0,1650,600 --width 5000
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && !/^--(hatch)$/.test(args[i - 1])));
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const has = (n) => args.includes(`--${n}`);

const input = positional[0];
const output = positional[1];
if (!input || !output) {
  console.error('usage: node dev/dxf-preview.mjs <in.dxf> <out.png> [--width 4000] [--hatch]');
  process.exit(1);
}

const WIDTH = Number(flag('width', 4000));
const WITH_HATCH = has('hatch');
const MAX_ENTITIES = Number(flag('max-entities', 2_000_000));

/* ------------------------------------------------------------------- parse */

/**
 * Collect polylines as flat [x0,y0,x1,y1,...] runs.
 *
 * A DXF is a flat stream of (code, value) pairs; an entity ends when the next
 * `0` arrives. Vertices are codes 10/20, which repeat — so they accumulate per
 * entity rather than overwrite, and that is the whole parser this needs.
 */
async function collect(path) {
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });

  const polys = [];
  const circles = [];
  let section = null, pendingSection = false;
  let code = null, isCode = true;
  let type = null;
  let xs = [], ys = [];
  let cx = 0, cy = 0, r = 0;
  let closed = false;
  let count = 0;
  let skipped = 0;

  const flush = () => {
    if (type === 'LWPOLYLINE' || type === 'POLYLINE') {
      if (xs.length >= 2) {
        const flat = new Float32Array(xs.length * 2);
        for (let i = 0; i < xs.length; i++) { flat[i * 2] = xs[i]; flat[i * 2 + 1] = ys[i]; }
        polys.push({ pts: flat, closed });
      }
    } else if (type === 'CIRCLE' && r > 0) {
      circles.push({ cx, cy, r });
    } else if (type === 'HATCH' && WITH_HATCH && xs.length >= 2) {
      const flat = new Float32Array(xs.length * 2);
      for (let i = 0; i < xs.length; i++) { flat[i * 2] = xs[i]; flat[i * 2 + 1] = ys[i]; }
      polys.push({ pts: flat, closed: true });
    }
    xs = []; ys = []; closed = false; r = 0;
  };

  for await (const raw of rl) {
    const line = raw.replace(/\r$/, '');
    if (isCode) { code = line.trim(); isCode = false; continue; }
    const value = line; isCode = true;

    if (code === '0') {
      flush();
      if (value === 'SECTION') { pendingSection = true; type = null; continue; }
      if (value === 'ENDSEC') { section = null; type = null; continue; }
      type = section === 'ENTITIES' ? value.trim() : null;
      if (type) {
        if (++count > MAX_ENTITIES) { skipped++; type = null; }
      }
      continue;
    }
    if (pendingSection && code === '2') { section = value.trim(); pendingSection = false; continue; }
    if (!type) continue;

    if (code === '10') { if (type === 'CIRCLE') cx = Number(value); else xs.push(Number(value)); }
    else if (code === '20') { if (type === 'CIRCLE') cy = Number(value); else ys.push(Number(value)); }
    else if (code === '40' && type === 'CIRCLE') r = Number(value);
    else if (code === '70' && (type === 'LWPOLYLINE' || type === 'POLYLINE')) {
      closed = (Number(value) & 1) === 1;
    }
  }
  flush();
  return { polys, circles, skipped };
}

console.error(`reading ${input} …`);
const t0 = Date.now();
const { polys, circles, skipped } = await collect(resolve(input));
console.error(`  ${polys.length} polyline(s), ${circles.length} circle(s) in ${((Date.now() - t0) / 1000).toFixed(1)}s` +
              (skipped ? `, ${skipped} entity(ies) past --max-entities` : ''));

if (!polys.length && !circles.length) {
  console.error('nothing drawable found');
  process.exit(1);
}

/* -------------------------------------------------------------------- bbox */

let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
for (const p of polys) {
  for (let i = 0; i < p.pts.length; i += 2) {
    const x = p.pts[i], y = p.pts[i + 1];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
}
for (const c of circles) {
  minX = Math.min(minX, c.cx - c.r); maxX = Math.max(maxX, c.cx + c.r);
  minY = Math.min(minY, c.cy - c.r); maxY = Math.max(maxY, c.cy + c.r);
}
console.error(`  bbox  x ${minX.toFixed(1)} .. ${maxX.toFixed(1)}   y ${minY.toFixed(1)} .. ${maxY.toFixed(1)}`);

// Crop to one sheet of a tiled set. Given in drawing units, which is what the
// bbox above reports, so a region can be read straight off a full-extent pass.
const region = flag('region', null);
if (region) {
  const [rx0, ry0, rx1, ry1] = String(region).split(',').map(Number);
  if ([rx0, ry0, rx1, ry1].some((n) => !Number.isFinite(n))) {
    console.error('--region takes x0,y0,x1,y1 in drawing units');
    process.exit(1);
  }
  minX = Math.min(rx0, rx1); maxX = Math.max(rx0, rx1);
  minY = Math.min(ry0, ry1); maxY = Math.max(ry0, ry1);
  console.error(`  cropped to x ${minX} .. ${maxX}   y ${minY} .. ${maxY}`);
}

const w = maxX - minX, h = maxY - minY;
console.error(`  extent ${w.toFixed(1)} x ${h.toFixed(1)} (drawing units)`);

const width = WIDTH;
const height = Math.max(1, Math.round((h / w) * width));

/* ------------------------------------------------------------------ render */

// Geometry goes to the page as a binary payload rather than as JSON: a million
// coordinates through JSON.stringify is both slow and enormous.
const chunks = [];
for (const p of polys) {
  chunks.push(new Uint32Array([p.pts.length / 2]).buffer, p.pts.buffer);
}
const flatLen = chunks.reduce((n, b) => n + b.byteLength, 0);
const payload = Buffer.alloc(flatLen);
{
  let o = 0;
  for (const b of chunks) { Buffer.from(b).copy(payload, o); o += b.byteLength; }
}

const work = await mkdtemp(join(tmpdir(), 'b2d-dxfprev-'));
const binFile = join(work, 'geom.bin');
const htmlFile = join(work, 'render.html');
await writeFile(binFile, payload);
await writeFile(join(work, 'circles.json'), JSON.stringify(circles));

await writeFile(htmlFile, `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;background:#fff}canvas{display:block}</style>
<canvas id="c" width="${width}" height="${height}"></canvas>
<script>
window.__done = false;
(async () => {
  const buf = await (await fetch('geom.bin')).arrayBuffer();
  const circles = await (await fetch('circles.json')).json();
  const dv = new DataView(buf);
  const ctx = document.getElementById('c').getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, ${width}, ${height});
  ctx.strokeStyle = '#111';
  ctx.lineWidth = ${Math.max(0.6, width / 4000).toFixed(2)};
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';

  const minX = ${minX}, minY = ${minY}, w = ${w}, h = ${h};
  const sx = ${width} / w, sy = ${height} / h;
  const X = (x) => (x - minX) * sx;
  const Y = (y) => ${height} - (y - minY) * sy;   // DXF Y is up, canvas Y is down

  let o = 0;
  ctx.beginPath();
  let drawn = 0;
  while (o + 4 <= buf.byteLength) {
    const n = dv.getUint32(o, true); o += 4;
    if (!n || o + n * 8 > buf.byteLength) break;
    ctx.moveTo(X(dv.getFloat32(o, true)), Y(dv.getFloat32(o + 4, true)));
    for (let i = 1; i < n; i++) {
      ctx.lineTo(X(dv.getFloat32(o + i * 8, true)), Y(dv.getFloat32(o + i * 8 + 4, true)));
    }
    o += n * 8;
    // Flush periodically: one path with a million sub-paths never rasterises.
    if (++drawn % 20000 === 0) { ctx.stroke(); ctx.beginPath(); }
  }
  ctx.stroke();

  ctx.beginPath();
  for (const c of circles) {
    ctx.moveTo(X(c.cx + c.r), Y(c.cy));
    ctx.arc(X(c.cx), Y(c.cy), Math.abs(c.r * sx), 0, Math.PI * 2);
  }
  ctx.stroke();
  window.__polys = drawn;
  window.__done = true;
})();
</script>`);

const puppeteer = (await import('puppeteer')).default;
const { CHROME_FLAGS } = await import('./shot.mjs');
const browser = await puppeteer.launch({ headless: true, args: CHROME_FLAGS, protocolTimeout: 900000 });
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('  page error:', e.message));
  await page.setViewport({ width: Math.min(width, 2000), height: Math.min(height, 2000) });
  await page.goto(pathToFileURL(htmlFile).href, { waitUntil: 'load' });
  await page.waitForFunction('window.__done === true', { timeout: 600000 });
  const drawn = await page.evaluate(() => window.__polys);
  await mkdir(dirname(resolve(output)), { recursive: true });
  const el = await page.$('#c');
  await el.screenshot({ path: resolve(output) });
  console.error(`  drew ${drawn} polyline(s)`);
} finally {
  await browser.close();
  await rm(work, { recursive: true, force: true });
}

console.error(`\nwrote ${output}  (${width} x ${height})`);
