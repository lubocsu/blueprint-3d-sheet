#!/usr/bin/env node
/**
 * Judge whether the supplied material can support a fine-grained drawing.
 *
 * Scores the input on seven axes — identity, scale, decomposition, internals,
 * kinematics, materials, geometry — weighted by what the subject's class
 * actually demands, and names the gaps. Entirely offline and deterministic; no
 * model is consulted to decide whether more material is needed.
 *
 * The point is not the number. The point is the gap list: it tells you exactly
 * what to go and ask the user for, or look up, instead of quietly inventing it.
 *
 *   node scripts/evidence.mjs "一辆主战坦克"
 *   node scripts/evidence.mjs brief.txt --archetype vehicle
 *   node scripts/evidence.mjs drawing.dxf
 *   node scripts/evidence.mjs drawing.dwg --keep-dxf work/drawing.dxf
 *
 * A DWG is converted first (see src/ingest/dwg.mjs) so the score reflects the
 * geometry rather than the bytes. Anything binary that cannot be converted is
 * refused outright — scoring a file we cannot read is how you get a confident
 * "the material supports a detailed drawing" out of pure noise.
 */

import { readFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { scoreEvidence, formatEvidence, explainEvidence } from '../../../src/ingest/evidence.mjs';
import { guessArchetype } from '../../../src/ingest/archetypes.mjs';
import { extractVector } from '../../../src/ingest/vector.mjs';
import { classifyPath, assertReadableBrief } from '../../../src/ingest/source.mjs';
import { dwgToDxf } from '../../../src/ingest/dwg.mjs';

const argv = process.argv.slice(2);
const flag = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : null;
};

// The positional is the first argument that is neither a flag nor a flag's
// VALUE — otherwise `--keep-dxf out.dxf drawing.dwg` reads the output path as
// the subject and scores the wrong thing.
const input = argv.find((a, i) =>
  !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));

const keepDxf = flag('keep-dxf');

if (!input) {
  console.error('usage: node scripts/evidence.mjs <brief text | file> [--archetype x] [--keep-dxf out.dxf]');
  process.exit(1);
}

const isFile = existsSync(input);
let { kind } = classifyPath(input, isFile);

let brief = null;
let extracted = null;
let cleanupDwg = null;

// A DWG is a drawing, not a brief. Convert it up front so the evidence scorer
// judges real geometry instead of scoring the bytes of a binary file.
if (kind === 'convertible') {
  const converted = await dwgToDxf(input, { verbose: true });
  cleanupDwg = converted.cleanup;
  console.error(`# converted with ${converted.converter}\n`);
  // The temp DXF dies with this process, so keep a copy when asked — the
  // outlines are the whole reason to convert, and they are needed at authoring
  // time, not just here.
  if (keepDxf) {
    mkdirSync(dirname(resolve(keepDxf)), { recursive: true });
    copyFileSync(converted.dxfPath, resolve(keepDxf));
  }
  extracted = await extractVector(converted.dxfPath);
  kind = 'vector';
} else if (kind === 'raster') {
  // nothing to extract: a raster shows proportions and carries no coordinates
} else if (kind === 'vector') {
  extracted = await extractVector(input);
} else if (isFile) {
  // Check the bytes BEFORE decoding. Reading an unknown file straight to utf8
  // is what let a binary drawing be scored as a written brief.
  const bytes = readFileSync(input);
  assertReadableBrief(input, bytes);
  brief = bytes.toString('utf8');
} else {
  brief = input;
}

const archetype = flag('archetype') ?? guessArchetype(
  [brief, isFile ? input : '', ...(extracted?.texts ?? []).map((t) => t.text)].filter(Boolean).join(' '));

const report = scoreEvidence({ kind, brief, extracted, archetype });

console.log(`source: ${kind} · subject class: ${archetype}\n`);
console.log(formatEvidence(report));
console.log();
console.log(explainEvidence(report));

if (report.gaps.length) {
  console.log(`\nGaps worth closing before authoring, in order: ${report.gaps.join(', ')}`);
  console.log('Ask the user for these, or look them up. Do not fill them from impression —');
  console.log('an absent figure is recoverable, an invented one is not.');
} else {
  console.log('\nNo gaps this subject class cares about. Go ahead and author the spec.');
}

if (kind === 'vector') {
  console.log(`\nThe CAD file carries TRUE coordinates — ${extracted.outlines.length} outlines.`);
  console.log('Use them directly as extrude profiles rather than estimating. To see them:');
  const source = keepDxf ?? input;
  console.log(`  node -e "import(process.env.CLAUDE_PLUGIN_ROOT + '/src/ingest/vector.mjs').then(async m => console.log((await m.extractVector('${source.replace(/\\/g, '/')}')).digest))"`);
  if (cleanupDwg && !keepDxf) {
    console.log('\nThe converted DXF was temporary. Re-run with --keep-dxf <path> to keep it,');
    console.log('so the outlines above can be read back while you author the spec.');
  }
}

// The converted DXF lives in a temp directory; a 29 MB DWG can expand a long
// way, so it is removed rather than left for the OS to sweep up eventually.
if (cleanupDwg) await cleanupDwg();
