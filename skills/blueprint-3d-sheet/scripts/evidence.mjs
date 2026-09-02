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
 */

import { readFileSync, existsSync } from 'node:fs';
import { extname } from 'node:path';
import { scoreEvidence, formatEvidence, explainEvidence } from '../../../src/ingest/evidence.mjs';
import { guessArchetype } from '../../../src/ingest/archetypes.mjs';
import { extractVector } from '../../../src/ingest/vector.mjs';

const argv = process.argv.slice(2);
const input = argv.find((a) => !a.startsWith('--'));
const flag = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : null;
};

if (!input) {
  console.error('usage: node scripts/evidence.mjs <brief text | file> [--archetype x]');
  process.exit(1);
}

const isFile = existsSync(input);
const ext = isFile ? extname(input).toLowerCase() : '';
const RASTER = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff']);
const VECTOR = new Set(['.dxf', '.svg']);

let kind = 'brief';
let brief = null;
let extracted = null;

if (isFile && RASTER.has(ext)) {
  kind = 'raster';
} else if (isFile && VECTOR.has(ext)) {
  kind = 'vector';
  extracted = await extractVector(input);
} else {
  brief = isFile ? readFileSync(input, 'utf8') : input;
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
  console.log(`  node -e "import(process.env.CLAUDE_PLUGIN_ROOT + '/src/ingest/vector.mjs').then(async m => console.log((await m.extractVector('${input.replace(/\\/g, '/')}')).digest))"`);
}
