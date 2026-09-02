/**
 * Density gate.
 *
 * The reference film sets the bar: ~150 parts, 10 legend entries, live
 * instrumentation, an engineering note on every component. Nothing in the
 * renderer enforces that — a spec with four boxes renders "fine" and looks
 * like nothing. So the bar lives here, as a check the pipeline runs on every
 * spec regardless of subject.
 *
 * Two tiers:
 *   FLOOR  - errors. Below this the page is not worth shipping.
 *   TARGET - warnings (errors under --strict). Reference-film parity.
 *
 * Thresholds scale by archetype so a wristwatch isn't held to a tank's part
 * count, but nothing gets a pass on *annotation* density — notes, callouts and
 * instruments are cheap for any subject and are most of what makes the page
 * feel like a real drawing.
 */

import { explodeParticipation } from './explode.mjs';
import { GROUNDING_FLOOR } from './grounding.mjs';

/** Part-count expectations per archetype: [floor, target]. */
const PART_BUDGET = {
  vehicle:            [48, 110],
  aircraft:           [48, 110],
  'rotating-machine': [36,  85],
  mechanism:          [32,  80],
  vessel:             [30,  70],
  structure:          [28,  70],
  appliance:          [24,  60],
  instrument:         [24,  60],
  generic:            [24,  60],
};

const ANNOTATION_FLOOR = {
  callouts: 6, dimensions: 2, views: 4, motions: 2, instruments: 4, details: 4, materials: 1,
};
const ANNOTATION_TARGET = {
  callouts: 10, dimensions: 3, views: 6, motions: 4, instruments: 6, details: 12, materials: 2,
};

/** Count instanced repeats too — 7 road wheels from one spec entry is 7 parts on screen. */
function effectivePartCount(parts) {
  let n = 0;
  for (const p of parts) {
    const inst = p.instances;
    let k = 1;
    if (inst) {
      if (inst.pattern === 'grid' && inst.counts) k = inst.counts.reduce((a, b) => a * b, 1);
      else k = inst.count ?? 1;
      if (inst.mirror && inst.mirror !== 'none') k *= 2;
    }
    n += k;
  }
  return n;
}

function countDetails(parts) {
  return parts.reduce((n, p) => n + (p.details?.length ?? 0), 0);
}

export function checkRichness(spec, { strict = false } = {}) {
  const errors = [];
  const warnings = [];

  const parts = spec.parts ?? [];
  const archetype = spec.meta?.archetype ?? 'generic';
  const [partFloor, partTarget] = PART_BUDGET[archetype] ?? PART_BUDGET.generic;

  const authored = parts.length;
  const effective = effectivePartCount(parts);

  const actual = {
    callouts:   spec.annotations?.callouts?.length ?? 0,
    dimensions: spec.annotations?.dimensions?.length ?? 0,
    views:      spec.views?.length ?? 0,
    motions:    spec.motions?.length ?? 0,
    instruments:spec.instruments?.length ?? 0,
    details:    countDetails(parts),
    materials:  new Set(parts.map((p) => p.material ?? 'metal')).size,
  };

  const push = (list, msg) => list.push(msg);
  const gate = (label, got, floor, target) => {
    if (got < floor) push(errors, `${label}: ${got}, need at least ${floor}`);
    else if (got < target) push(strict ? errors : warnings, `${label}: ${got}, reference parity is ${target}`);
  };

  gate('parts (effective, incl. instances)', effective, partFloor, partTarget);
  for (const k of Object.keys(ANNOTATION_FLOOR)) {
    gate(k, actual[k], ANNOTATION_FLOOR[k], ANNOTATION_TARGET[k]);
  }

  // Every part carries a name; most carry an engineering note. This is what the
  // hover card reads, and it's the difference between a model and a drawing.
  const unnamed = parts.filter((p) => !p.name || p.name.trim().length < 2);
  if (unnamed.length) {
    push(errors, `${unnamed.length} part(s) have no name: ${unnamed.slice(0, 5).map((p) => p.id).join(', ')}${unnamed.length > 5 ? ' …' : ''}`);
  }
  const noted = parts.filter((p) => p.note && p.note.trim().length > 8).length;
  const noteRatio = authored ? noted / authored : 0;
  if (noteRatio < 0.5) {
    push(errors, `only ${noted}/${authored} parts have an engineering note (need >= 50%)`);
  } else if (noteRatio < 0.8) {
    push(strict ? errors : warnings, `${noted}/${authored} parts have a note; reference parity is >= 80%`);
  }

  // A page with no section view loses half the drafting vocabulary, and it is
  // the one view that reads as "engineering" for non-vehicle subjects.
  const hasSection = (spec.views ?? []).some((v) => v.section);
  if (!hasSection) push(strict ? errors : warnings, 'no section view declared; add one view with a "section" plane');

  // An exploded view whose outer shell stays put shows nothing. This is the
  // machine-checkable form of "the explode isn't thorough enough": count what
  // will actually separate once normalize has attached the inferred channels.
  const ex = explodeParticipation(spec);
  if (ex.wired > 0 || ex.driver) {
    const share = authored ? ex.participating / authored : 0;
    if (share < 0.6) {
      push(errors,
        `only ${ex.participating}/${authored} parts separate on EXPLODE (need >= 60%); ` +
        'add a top-level "explode": { "driver": "<id>" } to include every part');
    }
  }

  // Cutting a shell that contains nothing yields a picture of the shell. The
  // check is deliberately about *revealable* parts rather than geometry: a part
  // is interior in the sense that matters here when it is hidden until a view
  // asks for it.
  if (hasSection) {
    const revealable = parts.filter(
      (p) => p.hidden || (p.channels ?? []).some((c) => c.type === 'visibility')).length;
    if (revealable === 0) {
      push(strict ? errors : warnings,
        'a section view is declared but no part is hidden or visibility-switched — ' +
        'there is nothing inside the shell for the cut to reveal');
    }
  }

  // Motion must actually move something.
  const animated = parts.filter((p) => (p.channels?.length ?? 0) > 0).length;
  if (animated === 0) push(errors, 'no part has any animation channel — the page would be static');
  else if (animated < Math.max(3, authored * 0.1)) {
    push(strict ? errors : warnings, `only ${animated} part(s) animate; the reference animates running gear, turret and suspension together`);
  }

  // Provenance. The gate above can force a note onto every part but cannot tell
  // whether the note is true, so a sheet the model filled in from recollection
  // is flagged rather than silently presented as fact. A warning, never an
  // error — offline work is legitimate; passing off recollection as checked
  // figures is not. An ABSENT flag means hand-authored and is left alone; only
  // an explicit false means "ingest ran and nothing was verified".
  if (spec.meta?.researched === false) {
    push(warnings, 'meta.researched is false — figures and part names are unverified; re-run ingest with --research to look them up');
  } else if (spec.meta?.researched && !(spec.meta.references?.length)) {
    push(warnings, 'meta.researched is true but meta.references is empty — a checked figure needs a source');
  }

  // How much of the sheet can be traced back to what it was built from. Written
  // by ingest; absent on a hand-authored spec, which is left alone for the same
  // reason `researched` is.
  const gr = spec.meta?.grounding;
  if (gr && gr.claims > 0 && gr.ratio < GROUNDING_FLOOR) {
    push(strict ? errors : warnings,
      `only ${gr.grounded}/${gr.claims} figures on the sheet trace back to the supplied ` +
      'material — most of the numbers came from nowhere checkable');
  }

  const orthoViews = (spec.views ?? []).filter((v) => v.projection === 'orthographic').length;
  if (orthoViews < 2) push(strict ? errors : warnings, `only ${orthoViews} orthographic view(s); a general-arrangement sheet wants at least front/side/plan`);

  // Structured shortfalls, derived from the same numbers as the messages above.
  // Callers that need to ACT on a failure — deciding whether to re-ask the model
  // or to go and find out — read these rather than parsing the prose, which
  // would break the moment a message is reworded.
  const gaps = {
    thinParts: effective < partFloor,
    thinNotes: noteRatio < 0.8,
    noInternals: hasSection && parts.every(
      (p) => !p.hidden && !(p.channels ?? []).some((c) => c.type === 'visibility')),
    fewCallouts: actual.callouts < ANNOTATION_TARGET.callouts,
    noMotion: animated === 0,
    lowGrounding: Boolean(gr && gr.claims > 0 && gr.ratio < GROUNDING_FLOOR),
  };

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    gaps,
    stats: { archetype, authoredParts: authored, effectiveParts: effective, ...actual, noteRatio: +noteRatio.toFixed(2) },
  };
}

export { PART_BUDGET, ANNOTATION_FLOOR, ANNOTATION_TARGET };
