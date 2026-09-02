/**
 * How good is the material we were given?
 *
 * A pipeline that turns a description into a fine-grained drawing has to be
 * able to tell the difference between "a main battle tank" and a paragraph that
 * actually pins down a machine. The old test for that was word count, which is
 * barely a test at all: it cannot say WHAT is missing, it ignores drawings
 * entirely, and it treats a bracket and a pressure vessel as if they needed the
 * same things known about them.
 *
 * So sufficiency is scored on seven axes instead, each 0..1, and weighted by
 * what the subject's archetype actually demands. The result is not a verdict
 * but a gap list — which is what makes the follow-up research targeted rather
 * than a blanket re-ask.
 *
 * Everything here is deterministic, offline and cheap. No model is consulted to
 * decide whether to consult a model.
 */

import { ARCHETYPES, AXES } from './archetypes.mjs';

/** Below this, the material cannot support a fine-grained drawing. */
export const COVERAGE_THRESHOLD = 0.65;

/** An axis at or above this counts as covered and is not researched. */
const AXIS_OK = 0.5;

/**
 * Only an axis the archetype leans on this hard is worth a research round —
 * below it, a thin score is a preference rather than a hole. This is what makes
 * "no word about the interior" a gap for a pressure vessel and a shrug for a
 * steel frame.
 */
const GAP_DEMAND = 0.6;

/**
 * Axes research cannot fill. No amount of reading supplies a CAD file, so
 * `geometry` counts towards coverage — it is real evidence, and its absence is
 * real uncertainty — but never becomes something we go and ask about.
 */
const UNRESEARCHABLE = new Set(['geometry']);

/* ------------------------------------------------------------------ patterns */

// Longest alternatives first, or "mm" is eaten by "m". The trailing lookahead
// stops "5 mb" or "12 minutes" being read as a length.
const LENGTH = /(\d+(?:[.,]\d+)?)\s*(mm|cm|km|m|inches|inch|in|ft|米|毫米|厘米|公里|英寸)(?![a-z])/gi;
const MASS = /(\d+(?:[.,]\d+)?)\s*(tonnes|tonne|kg|lb|t|g|公斤|千克|吨|克)(?![a-z])/gi;
const RATE = /(\d+(?:[.,]\d+)?)\s*(rpm|km\/h|kph|mph|m\/s|deg\/s|°\/s|hz|转|节)(?![a-z])/gi;
const RATING = /(\d+(?:[.,]\d+)?)\s*(mpa|kpa|bar|psi|kw|hp|nm|kv|ml|w|v|a|l|马力|千瓦|升|伏|安|吨力)(?![a-z])/gi;

/** Model designations: M1A2, Bf 109, RB211, R-1340 … */
const DESIGNATION = /\b[A-Z]{1,4}[-\s]?\d{1,4}[A-Z]?\b/;
/**
 * The unambiguous form: a name in front of the number, or a separator inside
 * it. Distinguishes a machine ("Leopard 2A7", "R-1340", "MB 873") from a
 * material grade that happens to share the shape ("316L").
 */
const NAMED_DESIGNATION = /\b(?:[A-Z][a-z]{2,}\s+[A-Z]{0,4}[-\s]?\d|[A-Z]{2,4}[-\s]\d)/;
/** Two or more consecutive capitalised words — a named thing rather than a category. */
const PROPER_NOUN = /\b[A-Z][a-z]{2,}\s+[A-Z][a-z]{2,}\b/;

const MATERIALS = [
  'steel', 'stainless', 'alloy', 'aluminium', 'aluminum', 'titanium', 'composite',
  'concrete', 'masonry', 'timber', 'glass', 'rubber', 'plastic', 'abs', 'brass',
  'bronze', 'cast iron', 'ceramic', 'carbon fibre', 'carbon fiber', 'nylon', 'rha',
  '钢', '不锈钢', '铝', '钛', '复合', '混凝土', '砖', '木', '玻璃', '橡胶', '塑料', '铸铁', '陶瓷', '碳纤维',
];

/** Interior words that are not domain-specific. */
const INTERIOR = [
  'internal', 'interior', 'inside', 'section', 'sectioned', 'cutaway', 'cross-section',
  '内部', '内腔', '剖', '剖视', '剖面', '总成', '内构',
];

/* ------------------------------------------------------------------- helpers */

const clamp01 = (v) => Math.min(Math.max(v, 0), 1);

function countMatches(text, re) {
  const seen = new Set();
  for (const m of text.matchAll(re)) seen.add(`${m[1]}${m[2]}`.toLowerCase());
  return seen.size;
}

/**
 * Vocabulary hits. Latin terms match on a word boundary; CJK terms cannot,
 * because \b is defined against [A-Za-z0-9_] and never fires between two Han
 * characters — the same reason the archetype router carries two patterns.
 */
function lexHits(text, words) {
  const lower = text.toLowerCase();
  const hits = [];
  for (const w of words) {
    const isLatin = /^[a-z0-9 -]+$/i.test(w);
    if (isLatin) {
      if (new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(lower)) hits.push(w);
    } else if (text.includes(w)) {
      hits.push(w);
    }
  }
  return hits;
}

/** Map a hit count onto 0..1 through a few named steps rather than a formula. */
function steps(n, thresholds) {
  let out = 0;
  for (const [need, value] of thresholds) if (n >= need) out = value;
  return out;
}

const archetypeOf = (name) => ARCHETYPES[name] ?? ARCHETYPES.generic;

/* --------------------------------------------------------------------- score */

/**
 * @param {object} o
 * @param {'brief'|'raster'|'vector'} o.kind
 * @param {string|null} o.brief
 * @param {string|null} o.notes
 * @param {object|null} o.extracted  the structured result from extractVector
 * @param {string} o.archetype
 * @returns {{axes: object, coverage: number, gaps: string[], enough: boolean, why: string}}
 */
export function scoreEvidence({ kind = 'brief', brief = null, notes = null, extracted = null, archetype = 'generic' }) {
  const arch = archetypeOf(archetype);
  const labels = (extracted?.texts ?? []).map((t) => t.text);
  const text = [brief, notes, ...labels].filter(Boolean).join('\n');

  const lengths = countMatches(text, LENGTH);
  const masses = countMatches(text, MASS);
  const rates = countMatches(text, RATE);
  const ratings = countMatches(text, RATING);

  const partHits = lexHits(text, arch.part);
  const internalHits = [...lexHits(text, arch.internal), ...lexHits(text, INTERIOR)];
  const motionHits = lexHits(text, arch.motion);
  const materialHits = lexHits(text, MATERIALS);

  const outlines = extracted?.outlines?.length ?? 0;

  const axes = {};
  const set = (axis, score, why) => { axes[axis] = { score: clamp01(score), why }; };

  // --- identity ---------------------------------------------------------------
  // A category is not an identity. "A main battle tank" scores zero here, and
  // that single fact is most of why the old word-count test worked at all.
  //
  // A bare token like "316L" matches the designation shape but names a material
  // grade, not a machine, so it only earns the middle tier. Full marks need
  // either a name in front of the number or a separator inside it — "Leopard
  // 2A7", "R-1340", "MB 873".
  {
    const named = NAMED_DESIGNATION.test(text);
    const bare = DESIGNATION.test(text);
    if (named) set('identity', 1, 'a model designation is given');
    else if (bare || PROPER_NOUN.test(text)) set('identity', 0.6, 'a name or grade is given, but no clear designation');
    else set('identity', 0, 'the subject is named only by category');
  }

  // --- scale ------------------------------------------------------------------
  {
    let s = steps(lengths, [[1, 0.35], [2, 0.5], [3, 0.7]]);
    if (masses > 0) s += 0.3;
    // A vector file carries a true extent even when nothing is written down.
    if (extracted?.overall) s += 0.4;
    set('scale', s, `${lengths} length figure(s), ${masses} mass figure(s)` +
      (extracted?.overall ? ', plus a true drawing extent' : ''));
  }

  // --- decomposition ----------------------------------------------------------
  {
    let s = steps(partHits.length, [[1, 0.25], [3, 0.55], [6, 0.8], [10, 1]]);
    if (labels.length >= 8) s += 0.2;
    if (outlines >= 8) s += 0.1;
    set('decomposition', s,
      `${partHits.length} of this class's part names present` +
      (labels.length ? `, ${labels.length} drawing label(s)` : ''));
  }

  // --- internals --------------------------------------------------------------
  set('internals', steps(internalHits.length, [[1, 0.4], [3, 0.7], [5, 1]]),
    `${internalHits.length} interior term(s) present`);

  // --- kinematics -------------------------------------------------------------
  set('kinematics', steps(rates + motionHits.length, [[1, 0.3], [2, 0.55], [4, 0.8], [6, 1]]),
    `${rates} rate figure(s), ${motionHits.length} motion term(s)`);

  // --- materials --------------------------------------------------------------
  set('materials', steps(materialHits.length + ratings, [[1, 0.35], [2, 0.6], [4, 0.85], [6, 1]]),
    `${materialHits.length} material name(s), ${ratings} rating figure(s)`);

  // --- geometry ---------------------------------------------------------------
  if (kind === 'vector') {
    set('geometry', outlines >= 3 ? 1 : 0.6,
      `${outlines} true outline(s) from the CAD file`);
  } else if (kind === 'raster') {
    set('geometry', 0.5, 'a raster drawing shows proportions but carries no coordinates');
  } else {
    set('geometry', 0, 'no drawing supplied');
  }

  // --- weighted coverage ------------------------------------------------------
  let num = 0;
  let den = 0;
  for (const axis of AXES) {
    const w = arch.demand[axis] ?? 0;
    num += w * axes[axis].score;
    den += w;
  }
  const coverage = den ? num / den : 0;

  // Gaps are ordered by how much they cost: a badly-covered axis this archetype
  // cares about outranks a slightly-thin one it does not.
  const gaps = AXES
    .filter((a) => !UNRESEARCHABLE.has(a))
    .filter((a) => axes[a].score < AXIS_OK && (arch.demand[a] ?? 0) >= GAP_DEMAND)
    .sort((a, b) =>
      (arch.demand[b] * (1 - axes[b].score)) - (arch.demand[a] * (1 - axes[a].score)));

  // Research is worth running only when it can actually close something. A
  // text-only brief that is otherwise complete scores below 1.0 forever, and
  // pestering the web about it would never help.
  const enough = coverage >= COVERAGE_THRESHOLD || gaps.length === 0;
  const why = coverage >= COVERAGE_THRESHOLD
    ? `coverage ${coverage.toFixed(2)} — the material supports a detailed drawing`
    : gaps.length === 0
      ? `coverage ${coverage.toFixed(2)}, but every gap is one research cannot fill`
      : `coverage ${coverage.toFixed(2)} < ${COVERAGE_THRESHOLD} — thin on ${gaps.join(', ')}`;

  return { axes, coverage, gaps, enough, why, archetype };
}

/* -------------------------------------------------------------------- report */

const BAR = (score) => {
  const n = Math.round(clamp01(score) * 5);
  return '▓'.repeat(n) + '░'.repeat(5 - n);
};

/** The coverage table printed by the CLI. This is the judgement made visible. */
export function formatEvidence(report, { indent = '  ' } = {}) {
  const rows = AXES.map((a) => `${a} ${BAR(report.axes[a].score)}`);
  const lines = [];
  for (let i = 0; i < rows.length; i += 4) {
    lines.push(indent + (i === 0 ? 'evidence  ' : '          ') + rows.slice(i, i + 4).join('  '));
  }
  lines.push(`${indent}          ${report.why}`);
  return lines.join('\n');
}

/** Per-axis detail, for when someone wants to know why an axis scored what it did. */
export function explainEvidence(report, { indent = '  ' } = {}) {
  return AXES
    .map((a) => `${indent}  ${a.padEnd(14)} ${report.axes[a].score.toFixed(2)}  ${report.axes[a].why}`)
    .join('\n');
}
