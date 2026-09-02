/**
 * Fill defaults and derive the values the builder and runtime expect to be present.
 *
 * Runs *after* validate + richness, so the gates judge what was actually
 * authored rather than what normalize kindly invented.
 *
 * Everything it adds lands under keys the schema knows about, plus a single
 * `_derived` block for computed scene values.
 */

import { explodeDriverFor } from './explode.mjs';

// az is measured from +Z toward +X. X is the length axis, so az=0 looks at the
// flank (side elevation) and az=90 looks at the nose (front elevation).
const DEFAULT_VIEWS = [
  { id: 'iso',   label: 'ISO',   az: 38,  el: 22, projection: 'perspective' },
  { id: 'q34f',  label: '3/4 F', az: 62,  el: 18, projection: 'perspective' },
  { id: 'q34r',  label: '3/4 R', az: -55, el: 20, projection: 'perspective' },
  { id: 'side',  label: 'SIDE',  az: 0,   el: 0,  projection: 'orthographic',
    caption: 'SIDE ELEVATION', sub: 'datum condition' },
  { id: 'front', label: 'FRONT', az: 90,  el: 0,  projection: 'orthographic',
    caption: 'FRONT ELEVATION', sub: 'viewed on arrow F' },
  { id: 'plan',  label: 'PLAN',  az: 0,   el: 89.9, projection: 'orthographic',
    caption: 'PLAN VIEW', sub: 'looking down on datum' },
];

const UNIT_TO_M = { nm: 1e-9, A: 1e-10, um: 1e-6, mm: 1e-3, cm: 1e-2, m: 1, in: 0.0254, ft: 0.3048 };

const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

function vec3(v, d = [0, 0, 0]) {
  if (!Array.isArray(v)) return [...d];
  return [v[0] ?? d[0], v[1] ?? d[1], v[2] ?? d[2]];
}

/** Rough local-space centre of a shape, used for auto explode vectors and callout anchors. */
function shapeCentroid(shape) {
  if (!shape) return [0, 0, 0];
  switch (shape.type) {
    case 'lathe': {
      const ys = shape.points.map((p) => p[1]);
      return [0, (Math.min(...ys) + Math.max(...ys)) / 2, 0];
    }
    case 'extrude': {
      const xs = shape.profile.map((p) => p[0]);
      const ys = shape.profile.map((p) => p[1]);
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
      const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
      return [cx, cy, 0];
    }
    case 'sweep': {
      const pts = shape.path;
      const acc = pts.reduce((a, p) => [a[0] + p[0], a[1] + p[1], a[2] + p[2]], [0, 0, 0]);
      return acc.map((v) => v / pts.length);
    }
    case 'loft': {
      const pts = shape.sections.map((s) => s.at);
      const acc = pts.reduce((a, p) => [a[0] + p[0], a[1] + p[1], a[2] + p[2]], [0, 0, 0]);
      return acc.map((v) => v / pts.length);
    }
    case 'hull':
    case 'polyhedron': {
      const pts = shape.points ?? shape.vertices;
      const acc = pts.reduce((a, p) => [a[0] + p[0], a[1] + p[1], a[2] + p[2]], [0, 0, 0]);
      return acc.map((v) => v / pts.length);
    }
    case 'csg':
      return shapeCentroid(shape.operands[0]?.shape);
    default:
      return [0, 0, 0];
  }
}

/**
 * Roughly how far a shape extends from its own origin. Used to push a derived
 * callout anchor out onto the surface rather than leaving it at the centroid.
 */
function shapeReach(shape) {
  if (!shape) return 0;
  const s = shape;
  switch (s.type) {
    case 'box':        return Math.max(...s.size) * 0.42;
    case 'cylinder':   return Math.max(s.r, s.r2 ?? s.r, s.h / 2) * 0.85;
    case 'cone':       return Math.max(s.r, s.h / 2) * 0.85;
    case 'sphere':     return s.r * 0.9;
    case 'torus':      return (s.r + s.tube) * 0.9;
    case 'wedge':      return Math.max(...s.size) * 0.42;
    case 'prism':      return Math.max(s.r, s.h / 2) * 0.85;
    case 'helix':      return (s.r + s.tube) * 0.9;
    case 'extrude': {
      const xs = s.profile.map((p) => Math.abs(p[0]));
      const ys = s.profile.map((p) => Math.abs(p[1]));
      return Math.max(Math.max(...xs), Math.max(...ys), s.depth / 2) * 0.8;
    }
    case 'lathe':      return Math.max(...s.points.map(([r]) => r)) * 0.85;
    case 'hull':
    case 'polyhedron': {
      const pts = s.points ?? s.vertices;
      return Math.max(...pts.map((p) => Math.hypot(p[0], p[1], p[2]))) * 0.8;
    }
    case 'csg':        return shapeReach(s.operands[0]?.shape);
    default:           return 0;
  }
}

/** World position of a part, walking up the parent chain. */
const DEG = Math.PI / 180;
const IDENT = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/**
 * Euler XYZ to a row-major 3x3, matching THREE's default Euler order so the
 * positions derived here agree with the ones the builder produces.
 */
function eulerMat(rot) {
  const [x, y, z] = rot.map((d) => d * DEG);
  const a = Math.cos(x), b = Math.sin(x);
  const c = Math.cos(y), d = Math.sin(y);
  const e = Math.cos(z), f = Math.sin(z);
  const ae = a * e, af = a * f, be = b * e, bf = b * f;
  return [
    c * e,          -c * f,          d,
    af + be * d,     ae - bf * d,   -b * c,
    bf - ae * d,     be + af * d,    a * c,
  ];
}

const mulMV = (m, v) => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];

function mulMM(a, b) {
  const o = new Array(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return o;
}

/**
 * Accumulated position AND orientation of a part in the assembly frame.
 *
 * Rotation has to compose: a gun barrel parented to a mantlet that is rolled
 * −90° lives along the hull's X axis, not its own Y. Summing raw positions puts
 * that barrel seven metres in the air, which then hands every derived value —
 * the auto explode direction, the default callout anchor — a position the part
 * does not occupy. Parent scale is not composed; non-unit scales on structural
 * parents are vanishingly rare and would only shift magnitude, not direction.
 */
function worldFrame(part, byId, seen = new Set()) {
  if (!part || seen.has(part.id)) return { p: [0, 0, 0], R: IDENT };
  seen.add(part.id);
  const parent = part.parent ? byId.get(part.parent) : null;
  const pf = parent ? worldFrame(parent, byId, seen) : { p: [0, 0, 0], R: IDENT };
  const local = mulMV(pf.R, vec3(part.transform?.pos));
  return {
    p: [pf.p[0] + local[0], pf.p[1] + local[1], pf.p[2] + local[2]],
    R: mulMM(pf.R, eulerMat(vec3(part.transform?.rot))),
  };
}

function worldPos(part, byId) {
  if (!part) return [0, 0, 0];
  const f = worldFrame(part, byId);
  const c = mulMV(f.R, shapeCentroid(part.shape));
  return [f.p[0] + c[0], f.p[1] + c[1], f.p[2] + c[2]];
}

export function normalizeSpec(input) {
  const spec = clone(input);

  // ---- meta -----------------------------------------------------------------
  const meta = (spec.meta ??= {});
  meta.id ??= String(meta.title ?? 'assembly')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'assembly';
  meta.units ??= 'mm';
  meta.projection ??= 'FIRST ANGLE';
  meta.archetype ??= 'generic';
  meta.tolerance ??= '±0.5';
  meta.org ??= '';
  meta.division ??= '';
  meta.subtitle ??= '';
  const tb = (meta.titleBlock ??= {});
  tb.drawingNo ??= '—';
  tb.sheet ??= '1 OF 1';
  tb.scale ??= '1 : 1';
  tb.rev ??= 'A';
  tb.drawn ??= '—';
  tb.checked ??= '—';
  tb.date ??= '—';
  tb.status ??= 'ISSUED';

  // ---- bounds / scene scale -------------------------------------------------
  const b = spec.bounds;
  const diag = Math.hypot(b.length, b.width, b.height);
  // Map the envelope diagonal onto a fixed scene size so camera framing, grid
  // spacing and line widths behave identically for a watch and a warehouse.
  const SCENE_DIAG = 10;
  const sceneScale = SCENE_DIAG / diag;

  // ---- drivers --------------------------------------------------------------
  spec.drivers ??= [];
  for (const d of spec.drivers) {
    d.min ??= 0;
    d.max ??= 1;
    d.init ??= Math.min(Math.max(0, d.min), d.max);
    d.ease ??= 2;
    d.wrap ??= false;
  }

  // ---- parts ----------------------------------------------------------------
  const byId = new Map(spec.parts.map((p) => [p.id, p]));
  for (const p of spec.parts) {
    p.material ??= 'metal';
    p.tone ??= 0.6;
    p.outline ??= 'normal';
    p.group ??= p.id.split('.')[0];
    p.hidden ??= false;
    p.details ??= [];
    p.channels ??= [];
    const t = (p.transform ??= {});
    t.pos = vec3(t.pos);
    t.rot = vec3(t.rot);
    t.scale = vec3(t.scale, [1, 1, 1]);
  }

  // ---- explode ---------------------------------------------------------------
  //
  // Auto explode vectors: push each part away from the assembly centre along its
  // dominant axis, so an exploded view separates instead of scattering.
  //
  // The magnitude is SHELL-ORDERED. A uniform reach moves every part the same
  // distance, which just inflates the assembly — the skin ends up as far from
  // the centre as it started relative to the core, and the interior stays
  // covered. Scaling reach by how far out a part already sits makes the outer
  // shell travel and the core barely move, so the assembly opens like a flower
  // and the inside is actually revealed. That is the whole point of the view.
  const centre = [0, b.height / 2, 0];
  const scale = spec.explode?.scale ?? 1;

  // Depth in the assembly tree is a usable proxy for enclosure: a part parented
  // to another is usually inside it. Radius alone cannot separate a nested
  // stack — a piston, its barrel and its head sit at almost the same radius and
  // so receive almost the same vector, and translate together still nested.
  // Adding a per-level term pulls the inner one further along that shared
  // direction, which is exactly the motion that frees it.
  const depthOf = (p, seen = new Set()) => {
    let d = 0;
    for (let q = p; q?.parent && !seen.has(q.id); q = byId.get(q.parent)) { seen.add(q.id); d++; }
    return d;
  };

  const radial = spec.parts.map((p) => {
    const w = worldPos(p, byId);
    const rel = [w[0] - centre[0], w[1] - centre[1], w[2] - centre[2]];
    return { p, rel, r: Math.hypot(...rel), depth: depthOf(p) };
  });
  const rMax = Math.max(...radial.map((e) => e.r), 1e-6);

  for (const { p, rel, r, depth } of radial) {
    if (p.explode) { p.explode = vec3(p.explode).map((v) => v * scale); continue; }
    const mag = Math.hypot(...rel) || 1;
    // Bias upward — drawings explode assemblies vertically far more often than radially.
    const dir = [rel[0] / mag, rel[1] / mag + 0.55, rel[2] / mag];
    const dm = Math.hypot(...dir) || 1;
    // The core barely moves, the skin travels about half the diagonal, and each
    // level of nesting adds a little more so enclosed parts come clear of what
    // encloses them. Each part's world displacement is exactly this vector —
    // the runtime cancels what a part would inherit from its sub-assembly — so
    // the depth term separates without compounding into a launch.
    const shell = Math.min(r / rMax, 1);
    const nest = Math.min(depth, 4) * 0.085;
    const reach = diag * (0.14 + 0.30 * shell + nest) * scale;
    p.explode = [ (dir[0] / dm) * reach, (dir[1] / dm) * reach, (dir[2] / dm) * reach ];
  }

  // Blanket participation — see explode.mjs for why this is inferred as well as
  // declared. Domain-neutral: nothing here knows what a turret is.
  //
  // Cost: a part with any channel is "animated" and so cannot have its static
  // instances merged into one draw call. Making every part participate
  // therefore trades merging away — 172 draws to 244 on the tank. Worth it for
  // an exploded view that actually comes apart; if a very large assembly needs
  // the merging back, omit `spec.explode` and wire the channels by hand.
  const { driver: explodeDriver } = explodeDriverFor(spec);
  if (explodeDriver) {
    for (const p of spec.parts) {
      if (p.channels.some((c) => c.type === 'explode')) continue;
      p.channels.push({ type: 'explode', bind: explodeDriver });
    }
  }

  // ---- annotations ----------------------------------------------------------
  const ann = (spec.annotations ??= {});
  ann.callouts ??= [];
  ann.dimensions ??= [];
  for (const c of ann.callouts) {
    c.side ??= 'auto';
    c.instance ??= 0;
    if (!c.point) {
      // Default to a point on the part's OUTWARD surface, not its centroid — a
      // leader that stops at the centroid appears to end inside the solid.
      const part = byId.get(c.anchor);
      if (!part) { c.point = [0, 0, 0]; continue; }
      const w = worldPos(part, byId);
      const out = [w[0] - centre[0], w[1] - centre[1], w[2] - centre[2]];
      const mag = Math.hypot(...out) || 1;
      const reach = shapeReach(part.shape);
      c.point = [
        w[0] + (out[0] / mag) * reach,
        w[1] + (out[1] / mag) * reach,
        w[2] + (out[2] / mag) * reach,
      ];
      c._pointDerived = true;
    }
  }
  // Which views a dimension belongs in. A general-arrangement sheet does not
  // repeat every dimension on every plate — length belongs on the side and plan
  // elevations, width on the front and plan, height on the side and front. If
  // the author didn't say, derive it from the axis the dimension measures.
  const viewIds = new Set((spec.views ?? []).map((v) => v.id));
  const pick = (...ids) => ids.filter((id) => viewIds.has(id));
  for (const d of ann.dimensions) {
    d.offset = vec3(d.offset);
    if (d.views?.length) continue;
    const span = [
      Math.abs(d.to[0] - d.from[0]),
      Math.abs(d.to[1] - d.from[1]),
      Math.abs(d.to[2] - d.from[2]),
    ];
    const axis = span.indexOf(Math.max(...span));
    const perspective = (spec.views ?? [])
      .filter((v) => v.projection !== 'orthographic')
      .map((v) => v.id);
    // Width is deliberately kept off the perspective views. Measured across the
    // subject, it projects straight over the drawing from an angled camera —
    // the reference's ISO carries only length and height for the same reason.
    if (axis === 0)      d.views = [...pick('side', 'plan'), ...perspective];   // length
    else if (axis === 1) d.views = [...pick('side', 'front'), ...perspective];  // height
    else                 d.views = pick('front', 'plan');                       // width
    d._viewsDerived = true;
  }

  // ---- views ----------------------------------------------------------------
  if (!spec.views?.length) spec.views = clone(DEFAULT_VIEWS);
  for (const v of spec.views) {
    v.projection ??= 'perspective';
    v.az ??= 38;
    v.el ??= 22;
    v.dist ??= 1;
    // No default target: the view controller frames against the model's real
    // built height, which `bounds` does not necessarily describe.
  }

  // ---- motions / instruments ------------------------------------------------
  spec.motions ??= [];
  for (const m of spec.motions) {
    m.momentary ??= false;
    m.group ??= null;
  }
  spec.instruments ??= [];
  for (const i of spec.instruments) {
    i.format ??= '%.1f';
  }

  spec._derived = {
    diag,
    sceneScale,
    unitToM: UNIT_TO_M[meta.units] ?? 1e-3,
    centre,
    partCount: spec.parts.length,
    // Which driver, if any, the explode traces should fade in with.
    explodeDriver,
    explodeTrace: explodeDriver ? (spec.explode?.trace ?? true) : false,
  };

  return spec;
}

export { DEFAULT_VIEWS, shapeCentroid, worldPos };
