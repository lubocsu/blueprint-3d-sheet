/**
 * Offline verification for input classification and the binary guard.
 *
 * This exists because of a specific failure, found by handing the pipeline the
 * most ordinary real-world input there is — a 29 MB AutoCAD DWG of an anaerobic
 * digester. `.dwg` was in neither extension whitelist, so the dispatcher fell
 * through to "written brief" and read 29 MB of compressed binary as UTF-8. The
 * evidence scorer then did its job perfectly on the mojibake:
 *
 *     source: brief · subject class: vehicle
 *       identity   1.00  a model designation is given
 *       scale      1.00  132 length figure(s), 129 mass figure(s)
 *       materials  1.00  294 rating figure(s)
 *       geometry   0.00  no drawing supplied
 *       coverage 0.65 — the material supports a detailed drawing
 *
 * Every one of those numbers came from random bytes. The component whose entire
 * purpose is to stop a sheet being built on invented figures issued a green
 * light, and routed a pressure vessel to the `vehicle` archetype on the way.
 *
 * That is the worst possible failure mode for this pipeline, so it is guarded
 * here rather than left to be rediscovered.
 *
 *   node dev/source-check.mjs
 */

import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  classifyPath, looksBinary, assertReadableBrief,
  RASTER, VECTOR, CONVERTIBLE, supportedDrawingExtensions,
} from '../src/ingest/source.mjs';
import { scoreEvidence } from '../src/ingest/evidence.mjs';
import { findConverter, CONVERTER_HINT } from '../src/ingest/dwg.mjs';

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (cond) console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`);
  else { failures++; console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`); }
};

const threw = (fn) => {
  try { fn(); return null; }
  catch (err) { return err.message; }
};

/* ------------------------------------------------------------ classification */

console.log('\nclassification');
{
  ok(classifyPath('/x/drawing.dxf').kind === 'vector', 'a .dxf is a vector drawing');
  ok(classifyPath('/x/drawing.SVG').kind === 'vector', 'extension matching is case-insensitive');
  ok(classifyPath('/x/photo.jpg').kind === 'raster', 'a .jpg is a raster drawing');
  ok(classifyPath('/x/drawing.dwg').kind === 'convertible', 'a .dwg is convertible, not unsupported');
  ok(classifyPath('/x/brief.txt').kind === 'brief', 'a .txt is a brief');
  ok(classifyPath('a main battle tank', false).kind === 'brief', 'literal text is a brief');

  // The three sets must stay disjoint or the routing order silently decides.
  const overlap = [...CONVERTIBLE].filter((e) => VECTOR.has(e) || RASTER.has(e));
  ok(overlap.length === 0, 'the extension sets do not overlap', overlap.join(' ') || 'disjoint');
  ok(supportedDrawingExtensions().includes('.dwg'), 'DWG is advertised as a supported drawing');
}

/* --------------------------------------------------------------- binary sniff */

console.log('\nbinary detection');
{
  ok(looksBinary(Buffer.from('AC1018\0\0\0\0binary junk')), 'a NUL byte marks a buffer as binary');
  ok(!looksBinary(Buffer.from('Leopard 2A7, hull length 7700 mm, mass 67.5 t')), 'plain ASCII prose is text');
  ok(!looksBinary(Buffer.from('厌氧罐，直径 12 000 mm，高 21 000 mm，容积 2 200 m3', 'utf8')),
    'UTF-8 Chinese prose is text');

  // Compressed bytes that happen to dodge NUL still have to be caught, which is
  // what the replacement-character ratio is for.
  const garbage = Buffer.from(Array.from({ length: 4096 }, (_, i) => 0x80 + (i * 37) % 0x7f));
  ok(looksBinary(garbage), 'high-byte noise without NULs is still binary');

  ok(!looksBinary(Buffer.alloc(0)), 'an empty buffer is not called binary');
}

/* --------------------------------------------------------------- the refusal */

console.log('\nrefusing what cannot be read');
{
  const dwgBytes = Buffer.concat([Buffer.from('AC1018'), Buffer.alloc(64)]);

  const msg = threw(() => assertReadableBrief('/x/tank.dwg', dwgBytes));
  ok(msg !== null, 'a .dwg is refused as a brief');
  ok(/DXF/i.test(msg ?? ''), 'the refusal names the conversion target', msg?.slice(0, 72));

  const pdf = threw(() => assertReadableBrief('/x/sheet.pdf', Buffer.from('%PDF-1.7\n\0\0')));
  ok(pdf !== null && /DXF|PNG/.test(pdf), 'a .pdf is refused with actionable advice');

  // An unlisted extension still has to be caught, by content rather than name.
  const unknown = threw(() => assertReadableBrief('/x/thing.bin', Buffer.from([0, 1, 2, 3, 4, 5])));
  ok(unknown !== null, 'an unlisted binary is refused on its bytes');

  const good = threw(() => assertReadableBrief('/x/brief.txt',
    Buffer.from('A nine-cylinder radial aero engine, 1 344 in3 displacement.')));
  ok(good === null, 'a genuine text brief is accepted');
}

/* ------------------------------------------- the regression this file is for */

console.log('\nthe original failure');
{
  // The exact shape of the bug: binary bytes decoded as text and scored.
  // Not asserting a particular coverage number — asserting that this path is
  // now unreachable, because any number derived from noise is wrong.
  const dir = await mkdtemp(join(tmpdir(), 'b2d-source-'));
  try {
    const fake = join(dir, '3-1盘锦厌氧罐(20203025).dwg');
    // A DWG body is compressed, so it is high-entropy — which is precisely what
    // fools the scorer: at this entropy the designation and unit patterns occur
    // by chance, in quantity. xorshift32 rather than Math.random so the check is
    // deterministic, and full byte range rather than printable-ASCII because a
    // regular or narrowed distribution does NOT reproduce the failure.
    const bytes = Buffer.alloc(200000);
    let s = 0x9e3779b9;
    for (let i = 0; i < bytes.length; i++) {
      s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
      bytes[i] = s & 0xff;
    }
    bytes.write('AC1018', 0);
    await writeFile(fake, bytes);

    ok(classifyPath(fake).kind === 'convertible', 'the real filename routes to conversion, not to brief');

    const refusal = threw(() => assertReadableBrief(fake, readFileSync(fake)));
    ok(refusal !== null, 'even forced down the brief path, the bytes are refused');

    // Prove the scorer WOULD have been fooled, so the guard upstream is
    // load-bearing rather than defensive decoration. The scorer is not at fault
    // and is not being changed: it is a text-scoring function doing its job on
    // text it should never have been handed.
    const fooled = scoreEvidence({ kind: 'brief', brief: bytes.toString('utf8'), archetype: 'vessel' });
    ok(fooled.coverage > 0.3,
      'the scorer really is fooled by raw noise, so the guard earns its place',
      `coverage would have been ${fooled.coverage.toFixed(2)}, ` +
      `identity ${fooled.axes.identity.score.toFixed(2)}, scale ${fooled.axes.scale.score.toFixed(2)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------ dwg converter */

console.log('\ndwg converter discovery');
{
  const found = await findConverter();
  if (found) {
    ok(true, `a converter is installed`, `${found.kind} at ${found.path}`);
  } else {
    // Not a failure: CI has no CAD tooling, and the point of the hint is that
    // its absence is diagnosable rather than mysterious.
    ok(/opendesign\.com|dwg2dxf|B2D_DWG_CONVERTER/.test(CONVERTER_HINT),
      'no converter here, and the hint says how to get one');
  }
}

/* -------------------------------------------------------------------- report */

if (failures) {
  console.error(`\n\x1b[31m${failures} check(s) failed\x1b[0m`);
  process.exit(1);
}
console.log('\n\x1b[32minput classification and the binary guard hold\x1b[0m');
console.log('\nNote: this covers classification and refusal only. An actual DWG conversion');
console.log('needs a converter installed and a real drawing, so it is not asserted here.');
