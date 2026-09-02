/**
 * Ingest dispatcher.
 *
 * Three ways in — a written brief, a raster drawing, a vector CAD file — and one
 * way out: a validated AssemblySpec. Everything downstream of here is
 * deterministic, so this is the only stage that needs a model at all.
 */

import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { generateSpec } from './client.mjs';
import { buildUserPrompt, formatDossier } from './prompt.mjs';
import { guessArchetype } from './archetypes.mjs';
import { extractVector } from './vector.mjs';
import { needsResearch, researchSubject } from './research.mjs';
import { initBundle, loadBundleForIngest } from './bundle.mjs';
import { hasCredentials, CREDENTIAL_HINT } from './anthropic.mjs';
import { scoreEvidence, formatEvidence, explainEvidence } from './evidence.mjs';
import { measureGrounding, describeGrounding } from '../spec/grounding.mjs';

const run = promisify(execFile);

const RASTER = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff']);
const VECTOR = new Set(['.dxf', '.svg']);
const MEDIA_TYPE = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

/** Longest edge the vision path sends. Bigger costs tokens without adding detail. */
const MAX_EDGE = 1568;
const REFERENCE_IMAGE_LIMIT = 3;

/**
 * Downscale with the ffmpeg that's already a prerequisite, rather than pulling
 * in a native image library for one resize.
 */
async function prepareImage(path) {
  const ext = extname(path).toLowerCase();
  const dir = await mkdtemp(join(tmpdir(), 'b2d-'));
  const out = join(dir, 'drawing.png');
  try {
    await run('ffmpeg', [
      '-v', 'error', '-i', path,
      '-vf', `scale='min(${MAX_EDGE},iw)':'min(${MAX_EDGE},ih)':force_original_aspect_ratio=decrease`,
      '-frames:v', '1', out, '-y',
    ]);
    const data = await readFile(out);
    return { data: data.toString('base64'), mediaType: 'image/png', dir };
  } catch (err) {
    // ffmpeg missing or refused the file — fall back to sending it untouched
    await rm(dir, { recursive: true, force: true });
    const data = await readFile(path);
    const mediaType = MEDIA_TYPE[ext];
    if (!mediaType) throw new Error(`cannot read ${basename(path)}: ${err.message}`);
    return { data: data.toString('base64'), mediaType, dir: null };
  }
}

/** Rasterise a vector drawing so the model can see it as well as read it. */
async function renderVector(path) {
  try {
    const { Resvg } = await import('@resvg/resvg-js');
    const svg = extname(path).toLowerCase() === '.svg'
      ? await readFile(path, 'utf8')
      : null;
    if (!svg) return null;
    const png = new Resvg(svg, { fitTo: { mode: 'width', value: MAX_EDGE } }).render().asPng();
    return { data: Buffer.from(png).toString('base64'), mediaType: 'image/png' };
  } catch {
    // resvg is optional; without it the vector path is text-only, which still works
    return null;
  }
}

async function prepareReference(path) {
  const ext = extname(path).toLowerCase();
  if (RASTER.has(ext)) {
    const prepared = await prepareImage(path);
    return {
      image: { data: prepared.data, mediaType: prepared.mediaType },
      cleanupDir: prepared.dir,
    };
  }
  if (ext === '.svg') {
    const image = await renderVector(path);
    if (image) return { image, cleanupDir: null };
  }
  return { image: null, cleanupDir: null };
}

/**
 * @param {string} input - a file path, or literal text when it isn't one
 * @param {object} opts
 * @returns {Promise<object>} a validated AssemblySpec
 */
export async function ingest(input, {
  archetype = null,
  notes = null,
  verbose = false,
  research = null,
  researchAxes = null,
  refreshResearch = false,
  dossier: dossierPath = null,
  reference = null,
  bundle = null,
} = {}) {
  const isFile = typeof input === 'string' && existsSync(input) && input.length < 4096;
  const ext = isFile ? extname(input).toLowerCase() : '';

  let kind = 'brief';
  if (isFile && RASTER.has(ext)) kind = 'raster';
  else if (isFile && VECTOR.has(ext)) kind = 'vector';

  let brief = null;
  let extracted = null;
  let vector = null;
  let image = null;
  let cleanupDir = null;

  if (kind === 'brief') {
    brief = isFile ? await readFile(input, 'utf8') : String(input);
    if (!brief.trim()) throw new Error('the brief is empty');
  } else if (kind === 'raster') {
    const prepared = await prepareImage(input);
    image = { data: prepared.data, mediaType: prepared.mediaType };
    cleanupDir = prepared.dir;
    brief = notes ?? null;
  } else {
    // The whole extraction is kept, not just the digest: the evidence scorer
    // reads the label text and the true extent, and those are exactly what tell
    // it a CAD file is well documented rather than merely accurate.
    vector = await extractVector(input);
    extracted = vector.digest;
    image = await renderVector(input);
    brief = notes ?? null;
    if (verbose) {
      process.stderr.write(`  extracted ${vector.outlines.length} outlines, ` +
        `${vector.texts.length} text items${image ? ', rasterised for the vision pass' : ''}\n`);
    }
  }

  const hint = [brief, extracted, isFile ? basename(input) : ''].filter(Boolean).join(' ');
  const chosen = archetype && typeof archetype === 'string' ? archetype : guessArchetype(hint);
  if (verbose) process.stderr.write(`  source: ${kind} · archetype: ${chosen}\n`);

  // Reference images supplied by hand or selected from a local bundle join the
  // vision pass alongside any drawing. The emitted page still stays offline.
  const referenceImages = [];
  const referenceDirs = [];
  if (reference) {
    const prepared = await prepareReference(reference);
    if (!prepared.image) throw new Error(`reference is not a supported image/vector file: ${reference}`);
    referenceImages.push(prepared.image);
    if (prepared.cleanupDir) referenceDirs.push(prepared.cleanupDir);
    if (verbose) process.stderr.write(`  reference image: ${basename(reference)}\n`);
  }

  let bundleDossier = null;
  if (bundle) {
    const loaded = await loadBundleForIngest(bundle);
    bundleDossier = loaded.dossier;
    if (verbose) {
      process.stderr.write(
        `  bundle: ${loaded.bundleDir} · ${loaded.manifest.sources.length} url(s), ` +
        `${loaded.referenceFiles.length} selected reference image(s)\n`);
    }
    for (const file of loaded.referenceFiles) {
      const prepared = await prepareReference(file);
      if (prepared.image) {
        referenceImages.push(prepared.image);
        if (prepared.cleanupDir) referenceDirs.push(prepared.cleanupDir);
      }
    }
  }

  /* ---- sufficiency ---------------------------------------------------------- */

  const subject = [brief, notes].filter(Boolean).join(' ').trim() || (isFile ? basename(input) : String(input));
  const bundleEvidence = bundleDossier ? formatDossier(bundleDossier) : null;
  const decision = needsResearch({
    kind, brief, notes: [notes, bundleEvidence].filter(Boolean).join(String.fromCharCode(10)),
    extracted: vector, archetype: chosen,
    force: research, axes: researchAxes,
  });
  process.stderr.write(formatEvidence(decision.report) + '\n');
  if (verbose) process.stderr.write(explainEvidence(decision.report) + '\n');

  /* ---- research ------------------------------------------------------------- */

  // Findings arrive as part of the brief rather than as a correction afterwards.
  let dossier = bundleDossier;
  let researchWhy = decision.why;
  const researched = new Set();

  const runResearch = async (gaps, label) => {
    const r = await researchSubject({
      subject, archetype: chosen, gaps,
      refresh: refreshResearch, verbose, dossierPath,
    });
    researchWhy = r.why;
    for (const g of gaps) researched.add(g);
    if (r.dossier) {
      process.stderr.write(`  research  ${label}: ${r.source} — ` +
        `${r.dossier.components.length} components, ${r.dossier.sources.length} source(s)\n`);
      // Re-score with the findings folded in. Fetching material is not the same
      // as fetching ENOUGH material, and this is the only thing that says which
      // happened — including when a search comes back and closes nothing.
      const after = scoreEvidence({
        kind, brief, notes: [notes, formatDossier(r.dossier)].filter(Boolean).join(String.fromCharCode(10)),
        extracted: vector, archetype: chosen,
      });
      const closed = decision.gaps.filter((g) => !after.gaps.includes(g));
      process.stderr.write(
        `            coverage ${decision.report.coverage.toFixed(2)} -> ${after.coverage.toFixed(2)}`
        + (closed.length ? `, closed ${closed.join(', ')}` : ', closed nothing')
        + (after.gaps.length ? `; still thin on ${after.gaps.join(', ')}` : '')
        + String.fromCharCode(10));
    } else {
      process.stderr.write(`  research  ${label}: ${r.why}\n`);
      if (r.requestPath) {
        process.stderr.write(`            wrote ${r.requestPath}\n` +
          `            fill it in and re-run with --dossier <file>\n`);
      }
    }
    return r.dossier;
  };

  if (dossierPath || research === true) {
    const fresh = await runResearch(decision.gaps, dossierPath ? 'supplied' : decision.gaps.join('+') || 'all');
    if (fresh) dossier = fresh;
  } else if (dossier) {
    process.stderr.write(`  research  bundle — ${dossier.sources?.length ?? 0} source(s), ` +
      `${dossier.localReferences?.length ?? 0} local reference file(s)\n`);
  } else if (decision.research) {
    const created = await initBundle(subject, { archetype: chosen });
    researchWhy = `reference bundle needed: ${created.bundleDir}`;
    process.stderr.write(`  research  bundle needed — ${decision.why}\n` +
      `            created ${created.bundleDir}\n` +
      `            add URLs, run bundle fetch/score/select, then use a model-backed ingest or author spec.json manually\n`);
  } else {
    process.stderr.write(`  research  not needed — ${decision.why}\n`);
  }

  /* ---- generate ------------------------------------------------------------- */

  if (!hasCredentials()) {
    throw new Error(
      `${CREDENTIAL_HINT}. \`b2d ingest\` still needs model credentials to generate spec.json. ` +
      'For the zero-key path, run bundle select, read dossier.json plus downloads/*.txt, ' +
      'author spec.json manually as the agent, then run validate/build/selftest.');
  }

  const buildContent = (d) => {
    const text = buildUserPrompt({ kind, brief, notes, extracted, dossier: d });
    const content = [];
    if (image) content.push({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } });
    for (const refImage of referenceImages.slice(0, REFERENCE_IMAGE_LIMIT)) {
      content.push({ type: 'image', source: { type: 'base64', media_type: refImage.mediaType, data: refImage.data } });
    }
    content.push({ type: 'text', text });
    return content;
  };

  try {
    const spec = await generateSpec({
      archetype: chosen,
      userContent: buildContent(dossier),
      verbose,
      evidence: decision.report,
      dossier,
      /**
       * Escalation. When the density gate fails on things that read as MISSING
       * KNOWLEDGE rather than a malformed spec, asking the model to try harder
       * only invites it to invent more. Go and find out instead — once.
       */
      onKnowledgeGap: async (gaps) => {
        const fresh = gaps.filter((g) => !researched.has(g));
        if (!fresh.length) return null;
        if (research !== true && !dossierPath) {
          const created = await initBundle(subject, { archetype: chosen });
          process.stderr.write(`  escalate  ${fresh.join(', ')} needs source material — ` +
            `created ${created.bundleDir}; add URLs, select the bundle, then use a model-backed ingest or manual spec authoring\n`);
          return null;
        }
        process.stderr.write(`  escalate  the returned spec is thin on ${fresh.join(', ')} — researching rather than re-asking\n`);
        const d = await runResearch(fresh, `escalation (${fresh.join('+')})`);
        if (!d) return null;
        dossier = d;
        return { dossier: d, userContent: buildContent(d) };
      },
    });

    spec.meta ??= {};
    spec.meta.archetype ??= chosen;
    // Provenance is the whole point: a reader must be able to tell a checked
    // figure from an unchecked one without re-running the pipeline.
    spec.meta.researched = Boolean(dossier);
    if (dossier?.sources?.length) spec.meta.references = dossier.sources;
    else delete spec.meta.references;

    const grounding = measureGrounding(spec, { dossier, brief, notes, extracted: vector });
    spec.meta.grounding = { claims: grounding.claims, grounded: grounding.grounded, ratio: grounding.ratio };
    process.stderr.write('  ' + describeGrounding(grounding) + '\n');
    if (!dossier) process.stderr.write(`  note      meta.researched = false (${researchWhy})\n`);

    return spec;
  } finally {
    if (cleanupDir) await rm(cleanupDir, { recursive: true, force: true }).catch(() => {});
    for (const dir of referenceDirs) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export { guessArchetype, scoreEvidence };
