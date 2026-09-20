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
 *   node dev/dxf-preview.mjs <in.dxf> <out.png> [--width 4000] [--hatch]
 *   node dev/dxf-preview.mjs in.dxf sheet.png --region 780,0,1650,600 --width 5000
 *   node dev/dxf-preview.mjs in.dxf sheets/s.png --tiles auto --width 5200
 *
 * A drawing SET is often tiled across model space — a dozen sheets in a row — so
 * the full extent renders as an unreadable strip. `--region` crops to one sheet;
 * `--tiles auto` finds the gutters between sheets and writes one PNG per sheet
 * from a SINGLE parse, which is most of the wall clock when the file is large.
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { writeFile, mkdir, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const FLAGS_WITH_VALUES = new Set(['width', 'region', 'tiles', 'tile-gap', 'max-entities']);
const positional = args.filter((a, i) =>
  !a.startsWith('--') &&
  !(i > 0 && args[i - 1].startsWith('--') && FLAGS_WITH_VALUES.has(args[i - 1].slice(2))));
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const has = (n) => args.includes(`--${n}`);

const input = positional[0];
const output = positional[1];
if (!input || !output) {
  console.error('usage: node dev/dxf-preview.mjs <in.dxf> <out.png> [--width N] [--region x0,y0,x1,y1] [--tiles auto] [--hatch]');
  process.exit(1);
}

const WIDTH = Number(flag('width', 4000));
const WITH_HATCH = has('hatch');
const MAX_ENTITIES = Number(flag('max-entities', 2_000_000));

/* ------------------------------------------------------------------- parse */

/**
 * Collect polylines as flat [x0,y0,x1,y1,…] runs.
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
  let count = 0, skipped = 0;

  const flush = () => {
    const wantPoly = type === 'LWPOLYLINE' || type === 'POLYLINE' || (type === 'HATCH' && WITH_HATCH);
    if (wantPoly && xs.length >= 2) {
      const flat = new Float32Array(xs.length * 2);
      for (let i = 0; i < xs.length; i++) { flat[i * 2] = xs[i]; flat[i * 2 + 1] = ys[i]; }
      polys.push(flat);
    } else if (type === 'CIRCLE' && r > 0) {
      circles.push({ cx, cy, r });
    }
    xs = []; ys = []; r = 0;
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
      if (type && ++count > MAX_ENTITIES) { skipped++; type = null; }
      continue;
    }
    if (pendingSection && code === '2') { section = value.trim(); pendingSection = false; continue; }
    if (!type) continue;

    if (code === '10') { if (type === 'CIRCLE') cx = Number(value); else xs.push(Number(value)); }
    else if (code === '20') { if (type === 'CIRCLE') cy = Number(value); else ys.push(Number(value)); }
    else if (code === '40' && type === 'CIRCLE') r = Number(value);
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

let fullMinX = Infinity, fullMinY = Infinity, fullMaxX = -Infinity, fullMaxY = -Infinity;
for (const pts of polys) {
  for (let i = 0; i < pts.length; i += 2) {
    const x = pts[i], y = pts[i + 1];
    if (x < fullMinX) fullMinX = x; if (x > fullMaxX) fullMaxX = x;
    if (y < fullMinY) fullMinY = y; if (y > fullMaxY) fullMaxY = y;
  }
}
for (const c of circles) {
  fullMinX = Math.min(fullMinX, c.cx - c.r); fullMaxX = Math.max(fullMaxX, c.cx + c.r);
  fullMinY = Math.min(fullMinY, c.cy - c.r); fullMaxY = Math.max(fullMaxY, c.cy + c.r);
}
console.error(`  bbox  x ${fullMinX.toFixed(1)} .. ${fullMaxX.toFixed(1)}   y ${fullMinY.toFixed(1)} .. ${fullMaxY.toFixed(1)}`);

/* -------------------------------------------------------------------- tiles */

/**
 * Split a tiled sheet set on its gutters.
 *
 * A set laid out in a row leaves a genuinely empty band between sheets. Binning
 * X coverage and cutting at empty runs wider than `--tile-gap` finds them
 * without being told the sheet size — which matters, because the pitch is
 * whatever the draughtsman used rather than a standard.
 */
function findTiles(gap) {
  const BIN = 2;
  const bins = new Uint8Array(Math.ceil((fullMaxX - fullMinX) / BIN) + 1);
  const mark = (x0, x1) => {
    const a = Math.max(0, Math.floor((x0 - fullMinX) / BIN));
    const b = Math.min(bins.length - 1, Math.ceil((x1 - fullMinX) / BIN));
    for (let i = a; i <= b; i++) bins[i] = 1;
  };
  for (const pts of polys) {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < pts.length; i += 2) {
      if (pts[i] < lo) lo = pts[i];
      if (pts[i] > hi) hi = pts[i];
    }
    mark(lo, hi);
  }
  for (const c of circles) mark(c.cx - c.r, c.cx + c.r);

  const runs = [];
  const gapBins = Math.max(1, Math.round(gap / BIN));
  let start = -1, empty = 0;
  for (let i = 0; i < bins.length; i++) {
    if (bins[i]) { if (start < 0) start = i; empty = 0; continue; }
    if (start < 0) continue;
    if (++empty >= gapBins) {
      runs.push([fullMinX + start * BIN, fullMinX + (i - empty) * BIN]);
      start = -1; empty = 0;
    }
  }
  if (start >= 0) runs.push([fullMinX + start * BIN, fullMaxX]);

  // Discard slivers: a stray leader outside the frames is not a sheet.
  const span = fullMaxX - fullMinX;
  return runs.filter(([a, b]) => (b - a) > span * 0.01);
}

/* ------------------------------------------------------------------ render */

const puppeteer = (await import('puppeteer')).default;
const { CHROME_FLAGS } = await import('./shot.mjs');

/** One canvas page per region. The geometry payload is rebuilt per region so a
 *  cropped sheet only ships the polylines it actually needs. */
async function renderRegion(browser, work, [minX, minY, maxX, maxY], outPath) {
  const keep = [];
  for (const pts of polys) {
    let lo = Infinity, hi = -Infinity, ylo = Infinity, yhi = -Infinity;
    for (let i = 0; i < pts.length; i += 2) {
      if (pts[i] < lo) lo = pts[i]; if (pts[i] > hi) hi = pts[i];
      if (pts[i + 1] < ylo) ylo = pts[i + 1]; if (pts[i + 1] > yhi) yhi = pts[i + 1];
    }
    if (hi < minX || lo > maxX || yhi < minY || ylo > maxY) continue;
    keep.push(pts);
  }
  const keptCircles = circles.filter((c) =>
    c.cx + c.r >= minX && c.cx - c.r <= maxX && c.cy + c.r >= minY && c.cy - c.r <= maxY);

  const w = maxX - minX, h = maxY - minY;
  const width = WIDTH;
  const height = Math.max(1, Math.round((h / w) * width));

  // Binary payload rather than JSON: a million coordinates through
  // JSON.stringify is both slow and enormous.
  let bytes = 0;
  for (const pts of keep) bytes += 4 + pts.byteLength;
  const payload = Buffer.alloc(bytes);
  let o = 0;
  for (const pts of keep) {
    payload.writeUInt32LE(pts.length / 2, o); o += 4;
    Buffer.from(pts.buffer, pts.byteOffset, pts.byteLength).copy(payload, o);
    o += pts.byteLength;
  }

  await writeFile(join(work, 'geom.bin'), payload);
  await writeFile(join(work, 'circles.json'), JSON.stringify(keptCircles));
  const htmlFile = join(work, 'render.html');
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
  let o = 0, drawn = 0;
  ctx.beginPath();
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

  const page = await browser.newPage();
  try {
    page.on('pageerror', (e) => console.error('  page error:', e.message));
    await page.setViewport({ width: Math.min(width, 2000), height: Math.min(height, 2000) });
    await page.goto(pathToFileURL(htmlFile).href, { waitUntil: 'load' });
    await page.waitForFunction('window.__done === true', { timeout: 600000 });
    await mkdir(dirname(resolve(outPath)), { recursive: true });
    await (await page.$('#c')).screenshot({ path: resolve(outPath) });
    console.error(`  ${basename(outPath)}  ${width} x ${height}  (${keep.length} polylines)`);
  } finally {
    await page.close();
  }
}

const work = await mkdtemp(join(tmpdir(), 'b2d-dxfprev-'));
const browser = await puppeteer.launch({ headless: true, args: CHROME_FLAGS, protocolTimeout: 900000 });
try {
  const tilesArg = flag('tiles', null);
  if (tilesArg) {
    const tiles = findTiles(Number(flag('tile-gap', 20)));
    console.error(`  ${tiles.length} tile(s) detected`);
    const base = resolve(output).replace(/\.png$/i, '');
    let n = 0;
    for (const [x0, x1] of tiles) {
      n++;
      const pad = String(n).padStart(2, '0');
      console.error(`  tile ${pad}: x ${x0.toFixed(0)} .. ${x1.toFixed(0)}`);
      await renderRegion(browser, work, [x0, fullMinY, x1, fullMaxY], `${base}-${pad}.png`);
    }
  } else {
    let box = [fullMinX, fullMinY, fullMaxX, fullMaxY];
    const region = flag('region', null);
    if (region) {
      const r = String(region).split(',').map(Number);
      if (r.length !== 4 || r.some((n) => !Number.isFinite(n))) {
        console.error('--region takes x0,y0,x1,y1 in drawing units');
        process.exit(1);
      }
      box = [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
      console.error(`  cropped to x ${box[0]} .. ${box[2]}   y ${box[1]} .. ${box[3]}`);
    }
    await renderRegion(browser, work, box, output);
  }
} finally {
  await browser.close();
  await rm(work, { recursive: true, force: true });
}
