/**
 * Offline verification for the research stage.
 *
 * Every path here runs without credentials and without network: trigger
 * detection, the cache round-trip, dossier rendering into the prompt, the
 * provenance warning, and the no-credentials degrade. What it deliberately does
 * NOT cover is the live search itself — that needs an API key, and pretending
 * otherwise would be the exact kind of unchecked claim this stage exists to
 * prevent. See the note printed at the end.
 *
 *   node dev/research-check.mjs
 */

import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import {
  needsResearch, researchSubject, researchSlug, CACHE_DIR,
} from '../src/ingest/research.mjs';
import { buildUserPrompt, formatDossier } from '../src/ingest/prompt.mjs';
import { checkRichness } from '../src/spec/richness.mjs';
import { validateSpec } from '../src/spec/validate.mjs';

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (cond) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`); }
};

/* ------------------------------------------------------- 1. trigger detection */

console.log('\ntrigger detection');
{
  const thin = needsResearch({ kind: 'brief', brief: '一辆主战坦克' });
  ok(thin.research, 'a four-character brief triggers research', thin.why);

  const alsoThin = needsResearch({ kind: 'brief', brief: 'a main battle tank' });
  ok(alsoThin.research, 'a four-word English brief triggers research', alsoThin.why);

  // Sufficiency is per-axis now, so a brief can be rich in figures and still be
  // short of something. This one never mentions the interior, and you cannot
  // draw a cutaway of a machine nobody described the inside of — so it triggers,
  // but only for the axis it is actually missing.
  const concrete = needsResearch({
    kind: 'brief', archetype: 'vehicle',
    brief: 'Leopard 2A7 main battle tank, hull length 7700 mm, width 3760 mm, ' +
      'height 3030 mm to turret roof, combat mass 67.5 t, 120 mm L/55 smoothbore ' +
      'gun, MTU MB 873 Ka-501 delivering 1500 hp at 2600 rpm, torsion bar suspension ' +
      'with seven road wheels per side and rotary shock absorbers on stations one two and seven.',
  });
  ok(concrete.gaps.includes('internals')
    && !concrete.gaps.includes('scale')
    && !concrete.gaps.includes('identity')
    && !concrete.gaps.includes('materials'),
    'it asks about what is missing and not about the figures it already has',
    `gaps [${concrete.gaps.join(', ')}]`);

  const complete = needsResearch({
    kind: 'brief', archetype: 'vehicle',
    brief: 'Leopard 2A7 main battle tank, hull length 7700 mm, width 3760 mm, ' +
      'height 3030 mm, combat mass 67.5 t, 120 mm L/55 smoothbore, MTU MB 873 diesel ' +
      '1500 hp at 2600 rpm, torsion bar suspension, seven road wheels per side, ' +
      'composite over RHA hull, turret traverse 360 deg in 9 s. Internally the ' +
      'powerpack is at the rear with the transmission ahead of it, ammunition in the ' +
      'bustle magazine behind blow-off panels, three crew stations.',
  });
  ok(!complete.research, 'a brief that also covers the interior does not trigger', complete.why);

  const longVague = needsResearch({
    archetype: 'vehicle',
    kind: 'brief',
    brief: 'I would like you to design something like a large armoured fighting ' +
      'vehicle that looks impressive and modern and has a big gun on top and moves ' +
      'around on tracks and generally gives the impression of being very heavy indeed ' +
      'without me having to tell you anything specific about how big any of it is.',
  });
  ok(longVague.research, 'a long brief with no figures still triggers', longVague.why);

  ok(!needsResearch({ kind: 'brief', brief: 'a tank', force: false }).research,
    '--no-research overrides a thin brief');
  ok(needsResearch({ kind: 'brief', brief: 'a tank', force: true }).research,
    '--research forces it regardless');
  // Drawings used to be opt-in, which had it backwards: an unlabelled raster is
  // the input with the LEAST to go on, not the most.
  ok(needsResearch({ kind: 'raster', brief: null, archetype: 'vehicle' }).research,
    'an unlabelled raster triggers — it shows proportions and nothing else');
  ok(!needsResearch({ kind: 'raster', brief: null, force: false }).research,
    '--no-research still overrides it');
}

/* ------------------------------------------------------- 2. no credentials */

console.log('\ndegrade without credentials');
{
  const saved = { key: process.env.ANTHROPIC_API_KEY, tok: process.env.ANTHROPIC_AUTH_TOKEN, prof: process.env.ANTHROPIC_PROFILE };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_PROFILE;

  const subject = `uncached subject ${Date.now()}`;
  const r = await researchSubject({ subject, archetype: 'vehicle' });
  ok(r.dossier === null, 'returns null rather than throwing');
  ok(/credential/i.test(r.why), 'says why', r.why);

  for (const [k, v] of [['ANTHROPIC_API_KEY', saved.key], ['ANTHROPIC_AUTH_TOKEN', saved.tok], ['ANTHROPIC_PROFILE', saved.prof]]) {
    if (v !== undefined) process.env[k] = v;
  }
}

/* -------------------------------------------------------- 3. cache round-trip */

console.log('\ncache round-trip');
const FIXTURE = {
  designation: 'Leopard 2A7',
  summary: 'A German main battle tank. The 2A7 is the current urban-operations variant.',
  dimensions: { units: 'mm', length: 7700, width: 3760, height: 3030, mass: 67.5, massUnits: 't' },
  subsystems: ['hull', 'turret', 'powerpack', 'running gear'],
  components: [
    { name: 'FUME EXTRACTOR', note: 'Mid-barrel, scavenges propellant gas after firing' },
    { name: 'TORSION BAR SWING ARM', note: 'Transverse bar, seven stations per side' },
    { name: 'MTU MB 873 Ka-501', note: 'V12 twin-turbo diesel, 1500 hp at 2600 rpm', internal: true },
    { name: 'READY RACK', note: '15 rounds in the turret bustle behind blow-off panels', internal: true },
  ],
  motions: ['Turret traverse, 360° in 9 s', 'Gun elevation −9° to +20°'],
  specs: ['CALIBRE: 120 mm L/55', 'COMBAT MASS: 67.5 t'],
  sources: [{ title: 'Example reference page', url: 'https://example.invalid/leopard-2a7' }],
};
{
  const subject = 'cache fixture subject for research-check';
  const slug = researchSlug(subject);
  await mkdir(CACHE_DIR, { recursive: true });
  const path = join(CACHE_DIR, `${slug}.json`);
  await writeFile(path, JSON.stringify(FIXTURE, null, 2), 'utf8');

  // No credentials in play — a cache hit must not need any.
  const r = await researchSubject({ subject, archetype: 'vehicle' });
  ok(r.source === 'cache', 'reads back from cache', `source=${r.source}`);
  ok(r.dossier?.designation === 'Leopard 2A7', 'round-trips the dossier intact');

  const fresh = await researchSubject({ subject, archetype: 'vehicle', refresh: true });
  ok(fresh.source === null, '--refresh-research bypasses the cache', `source=${fresh.source}`);

  ok(researchSlug(subject) === researchSlug(`  ${subject.toUpperCase()}  `),
    'slug is stable across case and surrounding space');

  await rm(path, { force: true });
}

/* ------------------------------------------------- 4. dossier into the prompt */

console.log('\ndossier reaches the spec author');
{
  const text = buildUserPrompt({ kind: 'brief', brief: '一辆主战坦克', notes: null, extracted: null, dossier: FIXTURE });
  ok(text.includes('RESEARCHED FACTS'), 'prompt carries the facts block');
  ok(/precedence over your own recollection/.test(text), 'states precedence over recollection');
  ok(text.includes('7700'), 'carries the researched dimensions');
  ok(text.includes('FUME EXTRACTOR'), 'carries external component names');
  ok(text.includes('MTU MB 873 Ka-501'), 'carries internal component names');
  ok(/INTERNAL COMPONENTS/.test(text), 'separates internals so they can be modelled hidden');
  ok(text.includes('https://example.invalid/leopard-2a7'), 'carries the source URL');

  const bare = buildUserPrompt({ kind: 'brief', brief: 'a tank', notes: null, extracted: null });
  ok(!bare.includes('RESEARCHED FACTS'), 'omits the block entirely when there is no dossier');
  ok(formatDossier(null) === null, 'formatDossier(null) is null');
}

/* ------------------------------------------------------ 5. provenance warning */

console.log('\nprovenance gate');
{
  const specPath = fileURLToPath(new URL('../examples/mbt-mk6/spec.json', import.meta.url));
  const base = JSON.parse(readFileSync(specPath, 'utf8'));

  const unresearched = structuredClone(base);
  unresearched.meta.researched = false;
  const a = checkRichness(unresearched);
  ok(validateSpec(unresearched).ok, 'meta.researched validates against the schema');
  ok(a.warnings.some((w) => /unverified/.test(w)), 'unresearched spec warns');
  ok(!a.errors.some((e) => /researched/.test(e)), 'and does not error — offline work stays legitimate');

  const claimed = structuredClone(base);
  claimed.meta.researched = true;
  const b = checkRichness(claimed);
  ok(b.warnings.some((w) => /references is empty/.test(w)), 'claiming research without sources warns');

  const cited = structuredClone(base);
  cited.meta.researched = true;
  cited.meta.references = FIXTURE.sources;
  const c = checkRichness(cited);
  ok(validateSpec(cited).ok, 'meta.references validates against the schema');
  ok(!c.warnings.some((w) => /unverified|references is empty/.test(w)), 'a cited spec is quiet');
}

/* --------------------------------------------------------------------- verdict */

console.log(
  '\n\x1b[2mnot covered: the live search itself. That needs credentials — ' +
  'set ANTHROPIC_API_KEY or run `ant auth login`, then\n' +
  '  b2d ingest "一辆主战坦克" --research --out /tmp/tank.json\x1b[0m');

if (failures) {
  console.log(`\n\x1b[31m${failures} check(s) failed\x1b[0m`);
  process.exit(1);
}
console.log('\n\x1b[32mall offline research checks passed\x1b[0m');
