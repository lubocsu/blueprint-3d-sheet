/**
 * Web research for thin subjects.
 *
 * The density gate can force a note onto every part; it cannot tell whether the
 * note is true. Given "a main battle tank" and nothing else, a model fills the
 * sheet from impression — plausible dimensions, plausible-sounding part names,
 * no way to check any of it. This stage closes that gap: it looks the subject up
 * first, and hands the spec author a dossier of facts with URLs attached.
 *
 * It is strictly an enhancement. Every failure path — no credentials, no
 * network, a search error, a model that declines to call the tool — degrades to
 * null and lets ingest carry on. Research must never be the reason a build
 * fails; it is the reason a build is trustworthy.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeClient, hasCredentials, isAuthError, CREDENTIAL_HINT } from './anthropic.mjs';
import { archetypeGuidance, AXES } from './archetypes.mjs';
import { scoreEvidence } from './evidence.mjs';

const MODEL = process.env.B2D_RESEARCH_MODEL ?? process.env.B2D_MODEL ?? 'claude-opus-5';

/**
 * A server-side tool turn can stop with `pause_turn` when the search loop hits
 * its iteration cap. Resuming is a plain resend with the assistant turn
 * appended — no "continue" message, which would read as a new instruction.
 */
const MAX_CONTINUATIONS = 5;
const MAX_SEARCHES = 8;

const CACHE_DIR = fileURLToPath(new URL('../../.cache/research/', import.meta.url));

/** Every axis except the ones no amount of reading can supply. */
export const RESEARCHABLE_AXES = AXES.filter((a) => a !== 'geometry');

/* ------------------------------------------------------------------ triggers */

/**
 * Decide whether to research, and what about.
 *
 * The judgement itself lives in evidence.mjs — this is only the policy layer
 * that turns a coverage report plus the user's flags into a yes/no. Keeping the
 * two apart means the scoring can be exercised offline without any notion of
 * credentials or caches.
 *
 * @param {object} o
 * @param {'brief'|'raster'|'vector'} o.kind
 * @param {string|null} o.brief
 * @param {string|null} o.notes
 * @param {object|null} o.extracted  structured result from extractVector
 * @param {string} o.archetype
 * @param {boolean|null} o.force     true = --research, false = --no-research
 * @param {string[]|null} o.axes     explicit --research-axes override
 * @returns {{research: boolean, why: string, gaps: string[], report: object}}
 */
export function needsResearch({
  kind = 'brief', brief = null, notes = null, extracted = null,
  archetype = 'generic', force = null, axes = null,
}) {
  const report = scoreEvidence({ kind, brief, notes, extracted, archetype });

  if (force === false) {
    return { research: false, why: 'disabled with --no-research', gaps: [], report };
  }
  if (axes?.length) {
    return { research: true, why: `axes named on the command line: ${axes.join(', ')}`, gaps: axes, report };
  }
  if (force === true) {
    // Forced, but still targeted: asking about everything when only the
    // interior is missing wastes the search budget on facts we already hold.
    const gaps = report.gaps.length ? report.gaps : [...RESEARCHABLE_AXES];
    return { research: true, why: `requested with --research (${gaps.join(', ')})`, gaps, report };
  }
  return { research: !report.enough, why: report.why, gaps: report.gaps, report };
}

/* --------------------------------------------------------------------- cache */

export function researchSlug(subject) {
  const norm = String(subject).trim().toLowerCase().replace(/\s+/g, ' ');
  const hash = createHash('sha1').update(norm).digest('hex').slice(0, 8);
  const stem = norm
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${stem || 'subject'}-${hash}`;
}

async function readCache(slug) {
  try {
    return JSON.parse(await readFile(join(CACHE_DIR, `${slug}.json`), 'utf8'));
  } catch {
    return null;
  }
}

async function writeCache(slug, dossier) {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(join(CACHE_DIR, `${slug}.json`), JSON.stringify(dossier, null, 2), 'utf8');
  } catch {
    // A cache we cannot write is a cache we do without.
  }
}

/* ---------------------------------------------------------------------- tool */

const DOSSIER_TOOL = {
  name: 'emit_subject_dossier',
  description:
    'Record the researched facts about the subject. Call exactly once, after ' +
    'searching. Every figure must come from a source you actually read.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['designation', 'summary', 'dimensions', 'subsystems', 'components', 'sources'],
    properties: {
      designation: {
        type: 'string',
        description: 'The real or representative model designation, e.g. "Leopard 2A7" or "Bristol Hercules XVII".',
      },
      summary: { type: 'string', description: 'Two sentences on what this object is and what it is for.' },
      dimensions: {
        type: 'object',
        additionalProperties: false,
        required: ['units', 'length', 'width', 'height'],
        properties: {
          units: { enum: ['mm', 'cm', 'm', 'in', 'ft', 'um', 'nm'] },
          length: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' },
          mass: { type: 'number', description: 'Numeric mass in massUnits.' },
          massUnits: { type: 'string', description: 'e.g. "kg", "t", "lb".' },
        },
      },
      subsystems: {
        type: 'array',
        items: { type: 'string' },
        description: 'Major subsystems by their trade names.',
      },
      components: {
        type: 'array',
        description:
          'Individual components, INCLUDING internal ones that are hidden in the ' +
          'external view. This list is what the drawing is built from, so use the ' +
          'professional name for each and put a checkable fact in the note.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'note'],
          properties: {
            name: { type: 'string' },
            note: { type: 'string', description: 'A material, size, rating or count.' },
            internal: { type: 'boolean', description: 'True if not visible from outside.' },
          },
        },
      },
      motions: {
        type: 'array',
        items: { type: 'string' },
        description: 'Typical movements or the working cycle, with real rates or travels.',
      },
      specs: {
        type: 'array',
        items: { type: 'string' },
        description: 'Headline specifications as "LABEL: value unit" strings.',
      },
      sources: {
        type: 'array',
        description: 'Every page the figures above came from.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'url'],
          properties: { title: { type: 'string' }, url: { type: 'string' } },
        },
      },
      referenceImages: {
        type: 'array',
        description:
          'Photographs or general-arrangement drawings worth looking at, recorded ' +
          'for a human to check. They are NOT downloaded or fed to the drawing ' +
          'stage: a picture of the wrong variant is worse evidence than none.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['url', 'caption'],
          properties: { url: { type: 'string' }, caption: { type: 'string' } },
        },
      },
    },
  },
};

/**
 * `web_search_20260209` is GA — no beta header, regular messages endpoint.
 * Its dynamic filtering runs code execution under the hood, so declaring
 * code_execution alongside it would hand the model two execution environments.
 */
const WEB_SEARCH_TOOL = { type: 'web_search_20260209', name: 'web_search', max_uses: MAX_SEARCHES };

/* ------------------------------------------------------------------- prompts */

/**
 * What to go and find out, one entry per evidence axis.
 *
 * Only the gap axes are asked about. Re-confirming figures the brief already
 * supplies spends the search budget on facts we hold and starves the ones we
 * do not — which in practice is almost always the interior.
 */
const ASK = {
  identity:
    'The real model designation, or the most representative production model if\n' +
    '     the subject was given only as a category.',
  scale:
    'Overall dimensions (length, width, height) and mass, in consistent units.',
  decomposition:
    'The professional name of every major component. This matters more than\n' +
    '     anything else here: "torsion-bar swing arm" and "fume extractor" are what\n' +
    '     make the sheet read as a drawing; "side thing" and "tube" do not.',
  internals:
    'INTERNAL assemblies — what is inside the enclosure and how it is arranged.\n' +
    '     An exploded or sectioned view has nothing to show without this, so be as\n' +
    '     specific here as you are about the exterior. Mark these components\n' +
    '     "internal": true.',
  kinematics:
    'How it moves or cycles in normal operation, with real rates and travels.',
  materials:
    'Materials, ratings and counts — what things are made of, what they are\n' +
    '     rated for, and how many of each there are.',
};

function buildResearchPrompt(subject, archetype, gaps = []) {
  const wanted = gaps.length ? gaps.filter((g) => ASK[g]) : Object.keys(ASK);
  const held = Object.keys(ASK).filter((a) => !wanted.includes(a));

  const asks = wanted.map((a, i) => `  ${i + 1}. ${ASK[a]}`).join('\n');

  const alreadyHave = held.length
    ? `\nThe brief above already covers ${held.join(', ')}. Do not spend searches\n` +
      'reconfirming those — carry the figures it gives straight into the dossier and\n' +
      'put the search budget on the points listed above.\n'
    : '';

  return `Research this subject so an engineering drawing of it can be built from
fact rather than impression:

  ${subject}

Search the web first. Do not answer from memory — every figure you record must
come from a page you actually opened during this turn.

Find:
${asks}
${alreadyHave}
For orientation, subjects of this class are normally decomposed like this:
${archetypeGuidance(archetype)}

Where sources disagree, take the most commonly cited figure and say so in the
relevant note. Where you genuinely cannot find a figure, omit it rather than
estimating — an absent number is recoverable, an invented one is not.

Then call emit_subject_dossier exactly once with what you found.`;
}

/* ------------------------------------------------------------------- helpers */

/**
 * Search results arrive as `web_search_tool_result` blocks whose `content` is a
 * LIST on success and an OBJECT carrying `error_code` on failure — both under
 * HTTP 200. Indexing before checking would silently yield undefined.
 */
function summariseSearches(content, acc) {
  for (const block of content) {
    if (block.type === 'server_tool_use' && block.name === 'web_search') acc.queries++;
    if (block.type !== 'web_search_tool_result') continue;
    const c = block.content;
    if (Array.isArray(c)) acc.results += c.length;
    else if (c && typeof c === 'object' && c.error_code) acc.errors.push(c.error_code);
  }
  return acc;
}

function findDossier(content) {
  const block = content.find((b) => b.type === 'tool_use' && b.name === 'emit_subject_dossier');
  return block ? block.input : null;
}

/** Trust nothing about shape — the tool is not strict, and a null field is fine. */
export function normaliseDossier(raw, { covered = null } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const arr = (v) => (Array.isArray(v) ? v : []);
  const dossier = {
    designation: typeof raw.designation === 'string' ? raw.designation : '',
    summary: typeof raw.summary === 'string' ? raw.summary : '',
    dimensions: raw.dimensions && typeof raw.dimensions === 'object' ? raw.dimensions : null,
    subsystems: arr(raw.subsystems).filter((s) => typeof s === 'string'),
    components: arr(raw.components).filter((c) => c && typeof c.name === 'string'),
    motions: arr(raw.motions).filter((s) => typeof s === 'string'),
    specs: arr(raw.specs).filter((s) => typeof s === 'string'),
    sources: arr(raw.sources)
      .filter((s) => s && typeof s.url === 'string')
      .map((s) => ({ title: String(s.title ?? s.url), url: s.url })),
    // Reference imagery is RECORDED, never fetched: a photo of the wrong
    // variant is worse evidence than none, and the licensing is not ours to
    // assume. Feed one in deliberately with `--reference <file>`.
    referenceImages: arr(raw.referenceImages)
      .filter((r) => r && typeof r.url === 'string')
      .map((r) => ({ url: r.url, caption: String(r.caption ?? '') })),
  };
  // Which axes this dossier was actually asked to close, so a later escalation
  // knows what has already been looked for and does not ask twice.
  dossier.covered = arr(raw.covered).filter((s) => typeof s === 'string');
  if (covered) dossier.covered = [...new Set([...dossier.covered, ...covered])];

  // A dossier with no components and no dimensions taught us nothing.
  if (!dossier.components.length && !dossier.dimensions) return null;
  return dossier;
}

/* --------------------------------------------------------------- request file */

/**
 * When nothing can fetch, say exactly what is missing and how to supply it.
 *
 * This is the difference between "research unavailable" and a dead end. The
 * request names the gap axes, asks the same questions the model would have
 * asked, and ships a skeleton to fill — so a person, or an agent that does have
 * web access, can close the loop and hand the file back with `--dossier`.
 */
export async function writeResearchRequest({ subject, archetype, gaps, slug, why }) {
  const wanted = (gaps.length ? gaps : Object.keys(ASK)).filter((g) => ASK[g]);
  const path = join(CACHE_DIR, `${slug}.request.md`);

  const skeleton = {
    designation: '',
    summary: '',
    dimensions: { units: 'mm', length: 0, width: 0, height: 0, mass: 0, massUnits: 'kg' },
    subsystems: [],
    components: [{ name: '', note: '', internal: false }],
    motions: [],
    specs: [],
    sources: [{ title: '', url: '' }],
    referenceImages: [],
    covered: wanted,
  };

  const body = `# Research request — ${subject}

The pipeline judged the supplied material too thin to draw finely, and could not
look it up itself (${why}).

- **subject**: ${subject}
- **archetype**: ${archetype}
- **gap axes**: ${wanted.join(', ')}

## What to find out

${wanted.map((a, i) => `${i + 1}. ${ASK[a].replace(/\n\s+/g, ' ')}`).join('\n\n')}

Every figure must come from a page actually read, and each source goes in
\`sources\`. Omit anything you cannot find rather than estimating it — an absent
number is recoverable, an invented one is not.

## Fill this in and hand it back

Save the completed JSON and run:

\`\`\`bash
b2d ingest <the same input> --dossier <your-file>.json
\`\`\`

Or drop it at \`.cache/research/${slug}.json\` and it will be picked up
automatically on the next run.

\`\`\`json
${JSON.stringify(skeleton, null, 2)}
\`\`\`
`;

  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(path, body, 'utf8');
    return path;
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------------- main */

/**
 * Resolve a dossier, trying each source in turn.
 *
 *   file       an explicit --dossier, or a cache hit
 *   anthropic  the server-side web_search tool, when credentials resolve
 *   request    neither worked: write out what needs answering, and say so
 *
 * The last one matters. Without it the capability is simply unavailable on any
 * machine without an API key, and the build quietly proceeds on invention.
 *
 * @returns {Promise<{dossier: object|null, source: string|null, why: string, requestPath?: string}>}
 */
export async function researchSubject({
  subject, archetype, gaps = [], refresh = false, verbose = false,
  dossierPath = null, emitRequest = true,
}) {
  const slug = researchSlug(subject);

  // --- provider: explicit file ------------------------------------------------
  if (dossierPath) {
    try {
      const raw = JSON.parse(await readFile(dossierPath, 'utf8'));
      const dossier = normaliseDossier(raw, { covered: gaps });
      if (!dossier) return { dossier: null, source: null, why: `${dossierPath} has neither components nor dimensions` };
      await writeCache(slug, dossier);
      if (verbose) process.stderr.write(`  research: loaded ${dossierPath}\n`);
      return { dossier, source: 'file', why: `supplied via --dossier` };
    } catch (err) {
      return { dossier: null, source: null, why: `could not read ${dossierPath}: ${err.message}` };
    }
  }

  // --- provider: cache --------------------------------------------------------
  if (!refresh) {
    const cached = await readCache(slug);
    if (cached) {
      const dossier = normaliseDossier(cached);
      if (dossier) {
        // A cache entry that never covered the axes we are short of is not a hit.
        const missing = gaps.filter((g) => !dossier.covered?.includes(g));
        if (!missing.length || !hasCredentials()) {
          if (verbose) process.stderr.write(`  research: cache hit (${slug})\n`);
          return { dossier, source: 'cache', why: 'from cache' };
        }
        if (verbose) process.stderr.write(`  research: cache hit but short on ${missing.join(', ')} — refreshing\n`);
      }
    }
  }

  // --- provider: anthropic ----------------------------------------------------
  if (hasCredentials()) {
    const live = await researchLive({ subject, archetype, gaps, slug, verbose });
    if (live.dossier) return live;
    if (!emitRequest) return live;
    const requestPath = await writeResearchRequest({ subject, archetype, gaps, slug, why: live.why });
    return { ...live, requestPath };
  }

  // --- provider: request ------------------------------------------------------
  const why = CREDENTIAL_HINT;
  if (!emitRequest) return { dossier: null, source: null, why };
  const requestPath = await writeResearchRequest({ subject, archetype, gaps, slug, why });
  return { dossier: null, source: null, why, requestPath };
}

/** The live search. Split out so the provider chain above stays readable. */
async function researchLive({ subject, archetype, gaps, slug, verbose }) {
  const client = makeClient();
  const messages = [{ role: 'user', content: buildResearchPrompt(subject, archetype, gaps) }];
  const tally = { queries: 0, results: 0, errors: [] };

  try {
    for (let turn = 0; turn <= MAX_CONTINUATIONS; turn++) {
      const forcing = turn === MAX_CONTINUATIONS;
      const message = await client.messages.create({
        model: MODEL,
        max_tokens: 16000,
        tools: [WEB_SEARCH_TOOL, DOSSIER_TOOL],
        tool_choice: forcing
          ? { type: 'tool', name: 'emit_subject_dossier' }
          : { type: 'auto' },
        messages,
      });

      summariseSearches(message.content, tally);

      const dossier = normaliseDossier(findDossier(message.content), { covered: gaps });
      if (dossier) {
        await writeCache(slug, dossier);
        if (verbose) {
          process.stderr.write(
            `  research: ${tally.queries} search(es), ${dossier.components.length} components, ` +
            `${dossier.sources.length} source(s)\n`);
        }
        return { dossier, source: 'live', why: `${tally.queries} search(es)` };
      }

      if (message.stop_reason === 'refusal') {
        return { dossier: null, source: null, why: 'the model declined the research request' };
      }

      // pause_turn: the server-side search loop hit its cap mid-turn. Resume by
      // resending with the assistant turn appended and nothing else.
      messages.push({ role: 'assistant', content: message.content });
      if (message.stop_reason !== 'pause_turn' && !forcing) {
        messages.push({ role: 'user', content: 'Now call emit_subject_dossier with what you found.' });
      }
    }

    const why = tally.errors.length
      ? `search failed (${[...new Set(tally.errors)].join(', ')})`
      : 'the model never called emit_subject_dossier';
    return { dossier: null, source: null, why };
  } catch (err) {
    if (isAuthError(err)) return { dossier: null, source: null, why: CREDENTIAL_HINT };
    return { dossier: null, source: null, why: `research failed: ${err.message}` };
  }
}

export { CACHE_DIR, DOSSIER_TOOL, WEB_SEARCH_TOOL, MODEL as RESEARCH_MODEL, buildResearchPrompt, ASK };
