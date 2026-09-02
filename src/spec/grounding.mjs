/**
 * How much of this drawing can be traced back to the material it was built from?
 *
 * Researching a subject and *using* what came back are different things. A model
 * handed a dossier can still fill the sheet with round numbers of its own, and
 * `meta.researched` — one boolean for the whole drawing — cannot tell you that
 * happened. So this counts.
 *
 * Every figure the sheet asserts (a plate thickness, a power rating, an overall
 * length) is extracted, and matched against the numbers actually present in the
 * evidence: the dossier, the brief, the text on the CAD drawing. The ratio is
 * written to `meta.grounding` and reported.
 *
 * ── What this measures, precisely ──────────────────────────────────────────
 * It measures whether a figure is TRACEABLE, not whether it is CORRECT, and
 * certainly not whether it is attached to the right part. A model that reads
 * "1500 hp" off the dossier and writes it onto the gearbox instead of the
 * engine scores a hit here. What it catches is the failure that matters most
 * and is otherwise invisible: a sheet full of confident figures that came from
 * nowhere at all. Reported wording says "traceable" for that reason — calling
 * it "verified" would be the exact overclaim this file exists to prevent.
 *
 * Deliberately has no dependency on the ingest layer: this is a property of a
 * spec plus its evidence, and is testable with neither a model nor a network.
 */

/* ------------------------------------------------------------------- units */

/** Everything convertible collapses to one canonical unit per family. */
const LENGTH_TO_MM = {
  mm: 1, cm: 10, m: 1000, km: 1e6, in: 25.4, inch: 25.4, inches: 25.4, ft: 304.8,
  毫米: 1, 厘米: 10, 米: 1000, 公里: 1e6, 英寸: 25.4,
};
const MASS_TO_KG = {
  kg: 1, g: 0.001, t: 1000, tonne: 1000, tonnes: 1000, lb: 0.45359,
  公斤: 1, 千克: 1, 克: 0.001, 吨: 1000,
};
/** Units with no family — compared against themselves. */
const PLAIN = new Set([
  'rpm', 'hp', 'kw', 'w', 'mpa', 'kpa', 'bar', 'psi', 'v', 'a', 'kv', 'nm', 'hz',
  'l', 'ml', 'km/h', 'kph', 'mph', 'm/s', '°', 'deg', '马力', '千瓦', '升', '伏', '安', '转',
]);

const UNIT_ALTERNATION =
  'mm|cm|km/h|km|kph|mph|m/s|m|inches|inch|in|ft|tonnes|tonne|kg|lb|t|g|' +
  'rpm|mpa|kpa|bar|psi|kw|hp|nm|kv|ml|hz|deg|w|v|a|l|°|' +
  '毫米|厘米|公里|英寸|米|公斤|千克|吨|克|马力|千瓦|升|伏|安|转';

/** Longest alternatives first, or "mm" is eaten by "m". */
const CLAIM = new RegExp(
  `(\\d+(?:[  ,]\\d{3})*(?:\\.\\d+)?)\\s*(${UNIT_ALTERNATION})(?![a-z])`, 'gi');

/** "1 500 mm" and "1,500 mm" are one thousand five hundred, not one. */
const toNumber = (s) => Number(String(s).replace(/[  ,]/g, ''));

/**
 * @returns {{value: number, family: string}|null}
 */
function canonical(value, unitRaw) {
  const unit = String(unitRaw).toLowerCase();
  if (LENGTH_TO_MM[unit] !== undefined) return { value: value * LENGTH_TO_MM[unit], family: 'length' };
  if (MASS_TO_KG[unit] !== undefined) return { value: value * MASS_TO_KG[unit], family: 'mass' };
  if (PLAIN.has(unit)) return { value, family: unit };
  return null;
}

function* claimsIn(text) {
  if (!text) return;
  for (const m of String(text).matchAll(CLAIM)) {
    const c = canonical(toNumber(m[1]), m[2]);
    if (c) yield { ...c, text: m[0] };
  }
}

/* ---------------------------------------------------------------- evidence */

/** Every number the supplied material actually contains, canonicalised. */
function evidenceValues({ dossier, brief, notes, extracted }) {
  const pool = [brief, notes];

  if (dossier) {
    pool.push(dossier.summary, dossier.designation);
    pool.push(...(dossier.specs ?? []));
    pool.push(...(dossier.subsystems ?? []));
    pool.push(...(dossier.motions ?? []));
    for (const c of dossier.components ?? []) pool.push(c.note, c.name);

    // Dimensions are structured rather than prose, so they are converted
    // directly instead of being regex-scraped out of a sentence.
    const d = dossier.dimensions;
    if (d) {
      const u = d.units ?? 'mm';
      for (const k of ['length', 'width', 'height']) {
        if (typeof d[k] === 'number') pool.push(`${d[k]} ${u}`);
      }
      if (typeof d.mass === 'number') pool.push(`${d.mass} ${d.massUnits ?? 'kg'}`);
    }
  }

  for (const t of extracted?.texts ?? []) pool.push(t.text);

  const out = [];
  for (const text of pool) for (const c of claimsIn(text)) out.push(c);
  return out;
}

function bundleEvidenceValues({ dossier }) {
  const pool = [];
  if (dossier) {
    pool.push(...(dossier.snippets ?? []).map((s) => typeof s === 'string' ? s : s?.text));
  }
  const out = [];
  for (const text of pool) for (const c of claimsIn(text)) out.push(c);
  return out;
}

/* ------------------------------------------------------------------ claims */

/** Every figure the sheet asserts. */
function specClaims(spec) {
  const out = [];
  const add = (where, text) => {
    for (const c of claimsIn(text)) out.push({ ...c, where });
  };

  for (const p of spec.parts ?? []) {
    add(p.id, p.note);
    add(p.id, p.name);
  }
  for (const c of spec.annotations?.callouts ?? []) add(`callout ${c.n}`, c.text);
  add('meta', spec.meta?.subtitle);
  add('meta', spec.meta?.tolerance);

  // Overall bounds are asserted as bare numbers; the units live in meta.
  const b = spec.bounds;
  if (b) {
    const u = spec.meta?.units ?? 'mm';
    for (const k of ['length', 'width', 'height']) {
      if (typeof b[k] === 'number') {
        const c = canonical(b[k], u);
        if (c) out.push({ ...c, where: 'bounds', text: `${b[k]} ${u}` });
      }
    }
  }
  return out;
}

/* ----------------------------------------------------------------- measure */

/** A figure counts as traceable when the same quantity appears in the evidence. */
const TOLERANCE = 0.02;

function matches(claim, evidence) {
  for (const e of evidence) {
    if (e.family !== claim.family) continue;
    const scale = Math.max(Math.abs(e.value), Math.abs(claim.value), 1e-9);
    if (Math.abs(e.value - claim.value) / scale <= TOLERANCE) return true;
  }
  return false;
}

/**
 * @param {object} spec
 * @param {object} sources  { dossier, brief, notes, extracted }
 * @returns {{claims, grounded, ratio, unsupported, evidence}}
 */
export function measureGrounding(spec, sources = {}) {
  const evidence = evidenceValues(sources);
  const bundleEvidence = bundleEvidenceValues(sources);
  const claims = specClaims(spec);

  const unsupported = [];
  let grounded = 0;
  let bundleGrounded = 0;
  for (const c of claims) {
    if (matches(c, evidence)) grounded++;
    else unsupported.push(c);
    if (matches(c, bundleEvidence)) bundleGrounded++;
  }

  return {
    claims: claims.length,
    grounded,
    ratio: claims.length ? +(grounded / claims.length).toFixed(3) : 0,
    unsupported,
    evidence: evidence.length,
    bundleGrounded,
    bundleRatio: claims.length ? +(bundleGrounded / claims.length).toFixed(3) : 0,
    bundleEvidence: bundleEvidence.length,
  };
}

/** Below this, most of the sheet's figures came from nowhere we can point to. */
export const GROUNDING_FLOOR = 0.25;

export function describeGrounding(g) {
  if (!g.claims) return 'grounding  no numeric claims on the sheet';
  if (!g.evidence) {
    const raw = g.bundleEvidence
      ? `; bundle evidence would trace ${g.bundleGrounded}/${g.claims} raw figure(s)`
      : '';
    return `grounding  0/${g.claims} figures traceable to trusted dossier/brief material${raw}`;
  }
  const raw = g.bundleEvidence
    ? `; bundle raw ${g.bundleGrounded}/${g.claims}`
    : '';
  return `grounding  ${g.ratio.toFixed(2)} — ${g.grounded}/${g.claims} figures traceable ` +
         `to trusted dossier/brief material${raw} (traceable, not verified)`;
}
