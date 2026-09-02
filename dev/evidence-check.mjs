/**
 * Offline verification for the sufficiency judgement.
 *
 * Everything here runs without credentials and without network: axis scoring,
 * archetype-specific demand, targeted questioning, the research-request path,
 * dossier import, grounding measurement, and the escalate-once loop.
 *
 * What it does NOT cover is a live search. That needs credentials, and asserting
 * it works without running it would be exactly the kind of unchecked claim this
 * whole feature exists to prevent. See the note printed at the end.
 *
 *   node dev/evidence-check.mjs
 */

import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ARCHETYPES, AXES, archetypeGuidance } from '../src/ingest/archetypes.mjs';
import { scoreEvidence, formatEvidence } from '../src/ingest/evidence.mjs';
import {
  needsResearch, researchSubject, researchSlug, buildResearchPrompt,
  writeResearchRequest, normaliseDossier, CACHE_DIR,
} from '../src/ingest/research.mjs';
import { buildUserPrompt } from '../src/ingest/prompt.mjs';
import { generateSpec, knowledgeAxes } from '../src/ingest/client.mjs';
import { measureGrounding } from '../src/spec/grounding.mjs';
import { checkRichness } from '../src/spec/richness.mjs';
import { validateSpec } from '../src/spec/validate.mjs';

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (cond) console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`);
  else { failures++; console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`); }
};

const RICH_TANK =
  'Leopard 2A7 main battle tank, hull length 7700 mm, width 3760 mm, height 3030 mm ' +
  'to turret roof, combat mass 67.5 t, 120 mm L/55 smoothbore gun, MTU MB 873 diesel ' +
  'delivering 1500 hp at 2600 rpm, torsion bar suspension with seven road wheels per ' +
  'side, composite armour over an RHA hull, turret traverse 360 deg in 9 s.';

/* --------------------------------------------------------- 1. axis scoring */

console.log('\naxis scoring');
{
  const thin = scoreEvidence({ kind: 'brief', brief: '一辆主战坦克', archetype: 'vehicle' });
  ok(thin.coverage < 0.1, 'a four-character brief scores near zero', `coverage ${thin.coverage.toFixed(2)}`);
  ok(thin.axes.identity.score === 0, 'a category is not an identity');

  const rich = scoreEvidence({ kind: 'brief', brief: RICH_TANK, archetype: 'vehicle' });
  ok(rich.axes.identity.score === 1, 'a designation scores full identity');
  ok(rich.axes.scale.score === 1, 'four dimensions and a mass score full scale');
  ok(rich.axes.materials.score >= 0.6, 'materials and ratings register', rich.axes.materials.why);
  ok(rich.axes.internals.score === 0, 'and yet it says nothing about the interior');
  ok(rich.gaps.includes('internals'), 'so internals is the gap');

  // A drawing was opt-in before, which is backwards: a raster with no notes is
  // the case with the least to go on, not the most.
  const raster = scoreEvidence({ kind: 'raster', brief: null, archetype: 'vehicle' });
  ok(raster.axes.geometry.score === 0.5, 'a raster contributes proportion but no coordinates');
  ok(!raster.enough, 'a raster with no notes is still under-evidenced');

  const labelled = scoreEvidence({
    kind: 'vector', archetype: 'mechanism',
    extracted: {
      overall: { minX: 0, maxX: 900, minY: 0, maxY: 400 },
      outlines: new Array(12).fill(0),
      texts: ['LINK ARM 240 mm', 'PIN 20 mm', 'BUSHING', 'FRAME', 'GRIPPER', 'CAM',
        'ACTUATOR', 'STROKE 180 mm', 'GUARD'].map((t) => ({ text: t })),
    },
  });
  const bare = scoreEvidence({
    kind: 'vector', archetype: 'mechanism',
    extracted: { overall: { minX: 0, maxX: 900, minY: 0, maxY: 400 }, outlines: new Array(12).fill(0), texts: [] },
  });
  ok(labelled.axes.geometry.score === 1 && bare.axes.geometry.score === 1,
    'both CAD files score full geometry — the coordinates are true either way');
  ok(labelled.coverage > bare.coverage + 0.25,
    'but a labelled drawing is far better evidence than a bare one',
    `${bare.coverage.toFixed(2)} → ${labelled.coverage.toFixed(2)}`);
}

/* ------------------------------------------------- 2. the archetype decides */

console.log('\nthe archetype decides what counts as missing');
{
  const text = 'A 316L stainless pressure vessel, 2400 mm shell diameter, ' +
    '6000 mm tangent length, 6 bar design, saddle supported.';
  const vessel = scoreEvidence({ kind: 'brief', brief: text, archetype: 'vessel' });
  const structure = scoreEvidence({ kind: 'brief', brief: text, archetype: 'structure' });

  ok(vessel.axes.internals.score === 0 && structure.axes.internals.score === 0,
    'the same text says nothing about internals either way');
  ok(vessel.gaps.includes('internals'),
    'for a vessel that is a gap — its own guidance says the point is what is inside');
  ok(!structure.gaps.includes('internals'),
    'for a structure it is not — the demand weight settles it',
    `vessel ${ARCHETYPES.vessel.demand.internals} vs structure ${ARCHETYPES.structure.demand.internals}`);
}

/* ------------------------------------------------------- 3. lexicon hygiene */

console.log('\nlexicon stays in step with the prose');
{
  let worst = null;
  for (const [name, entry] of Object.entries(ARCHETYPES)) {
    // `generic` is exempt by design: its guidance deliberately names no domain
    // vocabulary ("the structural core, the enclosure, the moving elements"),
    // so there is nothing for its lexicon to agree with.
    if (name === 'generic') continue;
    const prose = archetypeGuidance(name).toLowerCase();
    const words = [...entry.part, ...entry.internal].filter((w) => /^[a-z]/.test(w));
    const seen = words.filter((w) => prose.includes(w.toLowerCase())).length;
    const share = words.length ? seen / words.length : 1;
    if (!worst || share < worst.share) worst = { name, share, seen, total: words.length };
  }
  // The lexicon is allowed to be richer than the prose, but if it drifts away
  // from it entirely then one of the two has been edited and the other forgotten.
  ok(worst.share >= 0.25,
    'every archetype grounds a quarter of its vocabulary in its own guidance',
    `weakest: ${worst.name} at ${(worst.share * 100).toFixed(0)}% (${worst.seen}/${worst.total})`);
}

/* --------------------------------------------------- 4. targeted questioning */

console.log('\nresearch asks only about the gaps');
{
  const targeted = buildResearchPrompt('一辆主战坦克', 'vehicle', ['internals']);
  ok(/INTERNAL assemblies/.test(targeted), 'asks about the interior');
  ok(!/Overall dimensions/.test(targeted), 'does not re-ask for dimensions it already has');
  ok(/already covers/.test(targeted), 'and says so explicitly, so the budget goes to the gap');

  const broad = buildResearchPrompt('一辆主战坦克', 'vehicle', []);
  ok(/Overall dimensions/.test(broad) && /INTERNAL assemblies/.test(broad),
    'with no gaps named it asks about everything');
}

/* --------------------------------------------------------- 5. request path */

console.log('\nno fetcher available: says what it needs');
{
  const saved = { k: process.env.ANTHROPIC_API_KEY, t: process.env.ANTHROPIC_AUTH_TOKEN, p: process.env.ANTHROPIC_PROFILE };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_PROFILE;

  const subject = `request-path fixture ${Date.now()}`;
  const r = await researchSubject({ subject, archetype: 'vehicle', gaps: ['internals', 'scale'] });
  ok(r.dossier === null, 'returns null rather than throwing');
  ok(Boolean(r.requestPath), 'writes a research request', r.requestPath ?? '');
  if (r.requestPath) {
    const body = await readFile(r.requestPath, 'utf8');
    ok(/gap axes.*internals/.test(body), 'the request names the gap axes');
    ok(/INTERNAL assemblies/.test(body), 'and carries the questions to answer');
    ok(/"covered"/.test(body) && /--dossier/.test(body), 'plus a skeleton and how to hand it back');
    await rm(r.requestPath, { force: true });
  }

  for (const [k, v] of [['ANTHROPIC_API_KEY', saved.k], ['ANTHROPIC_AUTH_TOKEN', saved.t], ['ANTHROPIC_PROFILE', saved.p]]) {
    if (v !== undefined) process.env[k] = v;
  }
}

/* --------------------------------------------------------- 6. dossier import */

const FIXTURE = {
  designation: 'Leopard 2A7',
  summary: 'A German main battle tank; the 2A7 is the urban-operations variant.',
  dimensions: { units: 'mm', length: 7700, width: 3760, height: 3030, mass: 67.5, massUnits: 't' },
  subsystems: ['hull', 'turret', 'powerpack', 'running gear'],
  components: [
    { name: 'FUME EXTRACTOR', note: 'Mid-barrel, scavenges propellant gas after firing' },
    { name: 'TORSION BAR', note: 'Transverse bar, seven stations per side' },
    { name: 'MTU MB 873 Ka-501', note: 'V12 twin-turbo diesel, 1500 hp at 2600 rpm', internal: true },
    { name: 'READY RACK', note: '15 rounds in the turret bustle behind blow-off panels', internal: true },
  ],
  motions: ['Turret traverse, 360 deg in 9 s'],
  specs: ['CALIBRE: 120 mm L/55', 'COMBAT MASS: 67.5 t'],
  sources: [{ title: 'Example reference page', url: 'https://example.invalid/leopard-2a7' }],
};

console.log('\ndossier import');
{
  const path = join(CACHE_DIR, 'evidence-check-fixture.json');
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(path, JSON.stringify(FIXTURE, null, 2), 'utf8');

  const r = await researchSubject({
    subject: 'import fixture', archetype: 'vehicle',
    gaps: ['internals'], dossierPath: path,
  });
  ok(r.source === 'file', 'a supplied dossier is read straight in', `source=${r.source}`);
  ok(r.dossier?.covered?.includes('internals'), 'and records which gaps it was asked to close');

  const text = buildUserPrompt({ kind: 'brief', brief: '一辆主战坦克', dossier: r.dossier });
  ok(/RESEARCHED FACTS/.test(text), 'the facts reach the spec author');
  ok(/INTERNAL COMPONENTS/.test(text), 'with the internals called out separately');

  const bad = await researchSubject({ subject: 'x', archetype: 'vehicle', dossierPath: join(CACHE_DIR, 'nope.json') });
  ok(bad.dossier === null && /could not read/.test(bad.why), 'a missing dossier degrades with a reason');

  await rm(path, { force: true });
  await rm(join(CACHE_DIR, `${researchSlug('import fixture')}.json`), { force: true });
}

/* ------------------------------------------------------------ 7. grounding */

console.log('\ngrounding measures traceability');
{
  const base = { meta: { units: 'mm' }, bounds: { length: 7700, width: 3760, height: 3030 } };
  const traced = {
    ...base,
    parts: [
      { id: 'a', name: 'FUME EXTRACTOR', note: 'Mid-barrel, 120 mm bore' },
      { id: 'b', name: 'ENGINE', note: '1500 hp at 2600 rpm' },
    ],
    annotations: { callouts: [{ n: 1, text: 'Combat mass 67.5 t' }] },
  };
  const invented = {
    ...base,
    bounds: { length: 9100, width: 3200, height: 2450 },
    parts: [
      { id: 'a', name: 'FUME EXTRACTOR', note: 'Mid-barrel, 125 mm bore' },
      { id: 'b', name: 'ENGINE', note: '1200 hp at 3200 rpm' },
    ],
    annotations: { callouts: [{ n: 1, text: 'Combat mass 55 t' }] },
  };

  const g1 = measureGrounding(traced, { dossier: FIXTURE });
  const g2 = measureGrounding(invented, { dossier: FIXTURE });
  ok(g1.ratio > 0.9, 'figures lifted from the dossier trace back', `${g1.grounded}/${g1.claims}`);
  ok(g2.ratio === 0, 'figures that were made up do not', `${g2.grounded}/${g2.claims}`);

  const noEvidence = measureGrounding(traced, {});
  ok(noEvidence.ratio === 0 && noEvidence.evidence === 0,
    'with nothing supplied, nothing is traceable — which is the honest answer');

  // Units are normalised, so the same quantity written differently still matches.
  // Isolated from `base` on purpose — its bounds would ground themselves and
  // hide whether the restatement was the thing that matched.
  const restated = { meta: { units: 'mm' }, parts: [{ id: 'a', name: 'HULL', note: 'Overall length 7.7 m' }] };
  const gr = measureGrounding(restated, { dossier: FIXTURE });
  ok(gr.claims === 1 && gr.grounded === 1,
    '7.7 m matches a dossier figure of 7700 mm', `${gr.grounded}/${gr.claims}`);
}

/* ------------------------------------------- 8. the gate treats it as a warning */

console.log('\nthe density gate flags it without blocking');
{
  const specPath = fileURLToPath(new URL('../examples/mbt-mk6/spec.json', import.meta.url));
  const base = JSON.parse(readFileSync(specPath, 'utf8'));

  const low = structuredClone(base);
  low.meta.grounding = { claims: 48, grounded: 3, ratio: 0.063 };
  const a = checkRichness(low);
  ok(validateSpec(low).ok, 'meta.grounding validates against the schema');
  ok(a.warnings.some((w) => /trace back/.test(w)), 'a sheet of untraceable figures warns');
  ok(a.errors.length === 0, 'and still builds — offline work stays legitimate');
  ok(a.gaps.lowGrounding === true, 'and the structured gap is set for the escalation loop');
  ok(checkRichness(low, { strict: true }).errors.some((e) => /trace back/.test(e)),
    'under --strict it is an error');

  const high = structuredClone(base);
  high.meta.grounding = { claims: 48, grounded: 44, ratio: 0.917 };
  ok(!checkRichness(high).warnings.some((w) => /trace back/.test(w)), 'a well-grounded sheet is quiet');

  ok(!checkRichness(base).warnings.some((w) => /trace back/.test(w)),
    'a hand-authored spec with no grounding field is left alone');
}

/* --------------------------------------------------------- 9. escalate once */

console.log('\nescalation: find out rather than re-ask');
{
  ok(knowledgeAxes({ noInternals: true }).includes('internals'),
    'a section with nothing inside reads as missing knowledge about internals');
  ok(knowledgeAxes({ fewCallouts: true }).length === 0,
    'too few callouts does not — that is the model being lazy, not uninformed');

  // A stub client that returns a deliberately thin spec every time, so the loop
  // has to decide what to do about it. No network, no credentials.
  const thinSpec = {
    meta: { title: 'STUB', units: 'mm', archetype: 'vehicle' },
    bounds: { length: 1000, width: 500, height: 500 },
    parts: [{ id: 'a', name: 'BODY', note: 'A body of some kind', shape: { type: 'box', size: [100, 100, 100] } }],
  };
  let calls = 0;
  const client = {
    messages: {
      create: async () => {
        calls++;
        return {
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: `t${calls}`, name: 'emit_assembly_spec', input: thinSpec }],
        };
      },
    },
  };

  let escalations = 0;
  await generateSpec({
    archetype: 'vehicle',
    userContent: [{ type: 'text', text: 'a tank' }],
    client,
    onKnowledgeGap: async () => { escalations++; return { dossier: FIXTURE, userContent: [{ type: 'text', text: 'a tank, with facts' }] }; },
  }).catch(() => {});

  ok(escalations === 1, 'a thin spec triggers exactly one research escalation', `${escalations} escalation(s)`);
  ok(calls === 3, 'and the attempt budget is otherwise untouched', `${calls} model call(s)`);
}

/* ------------------------------------------------------------------ verdict */

console.log(
  '\n\x1b[2mnot covered: the live search. That needs credentials —\n' +
  '  b2d research "Leopard 2A7" --out tank.json     then     b2d ingest ... --dossier tank.json\x1b[0m');

if (failures) {
  console.log(`\n\x1b[31m${failures} check(s) failed\x1b[0m`);
  process.exit(1);
}
console.log('\n\x1b[32mall offline evidence checks passed\x1b[0m');
