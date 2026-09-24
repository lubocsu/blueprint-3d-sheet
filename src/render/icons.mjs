/**
 * The toolbar's glyphs.
 *
 * A console button names a view or a motion the spec invented. Their ids and
 * labels are authored text — `secBB`, `q34r`, `SKIRTS` — so an icon table keyed
 * on them would be a table of one subject's vocabulary, which is exactly what
 * the rest of `src/` refuses to carry. The glyphs here are therefore DERIVED
 * from what the spec already states geometrically:
 *
 *   a view    is an azimuth, an elevation, a projection and maybe a cut plane,
 *             so its glyph is the subject's own bounding box drawn from that
 *             viewpoint. A long hull seen from the side gives a wide rectangle
 *             and seen from the front a narrow one, because that is what it is.
 *
 *   a motion  pushes named drivers, and parts bind animation channels to those
 *             drivers, so the motion's glyph is the channel type it actually
 *             drives — `explode` separates, `spin` rotates, `emit` throws
 *             particles. The word on the button plays no part in the choice.
 *
 * An author who wants a different glyph writes `icon` on the view or motion and
 * it wins; the derivation is a default, not a lock.
 *
 * Everything is inline SVG markup. The emitted page makes no network requests,
 * so an icon font or a sprite sheet is not an option — and at these sizes a
 * hand-drawn path in the sheet's own stroke weight beats either.
 *
 * Nothing here interpolates a string that came from a spec: every glyph is
 * built out of numbers this module computed, so the markup cannot carry
 * authored text into `innerHTML`.
 */

/** Glyph canvas. Every path below is drawn in this box. */
const BOX = 24;

const svg = (body, cls = 'ic') =>
  `<svg class="${cls}" viewBox="0 0 ${BOX} ${BOX}" fill="none" aria-hidden="true" `
  + `xmlns="http://www.w3.org/2000/svg">${body}</svg>`;

const n = (v) => (Math.abs(v) < 1e-4 ? 0 : Math.round(v * 100) / 100);

/* ------------------------------------------------------------------ vectors */

const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

const DEG = Math.PI / 180;
const WORLD_UP = [0, 1, 0];

/**
 * The camera basis for an azimuth/elevation pair.
 *
 * Deliberately the same construction as `fitDistance` in `runtime/views.mjs`:
 * az measured from +Z toward +X, elevation above the horizon, world up +Y. If
 * these two ever disagree the glyph stops describing the view it sits on, so
 * they are written the same way on purpose.
 */
function basis(az, el) {
  const a = az * DEG;
  const e = el * DEG;
  const fwd = norm([Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)]);
  let right = cross(WORLD_UP, fwd);
  if (dot(right, right) < 1e-8) right = [1, 0, 0];
  right = norm(right);
  const up = norm(cross(fwd, right));
  return { fwd, right, up };
}

/* -------------------------------------------------------------- the ViewCube */

/** The six faces of a box, as outward normal axis/sign plus its corner quad. */
const FACES = [
  { axis: 0, s: 1, quad: [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]] },
  { axis: 0, s: -1, quad: [[-1, -1, 1], [-1, 1, 1], [-1, 1, -1], [-1, -1, -1]] },
  { axis: 1, s: 1, quad: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]] },
  { axis: 1, s: -1, quad: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] },
  { axis: 2, s: 1, quad: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
  { axis: 2, s: -1, quad: [[-1, 1, -1], [1, 1, -1], [1, -1, -1], [-1, -1, -1]] },
];

/**
 * Face shading, by which axis the face faces.
 *
 * Light from above, which is the convention every axonometric block on a
 * drawing already uses: the top plane reads lightest, the end darkest. Tinted
 * with `currentColor` so the glyph is the same ink as the button around it and
 * inverts with it when the button lights up.
 */
const SHADE = [0.15, 0.05, 0.27];

/**
 * A view's glyph: the subject's own bounding box, drawn from that viewpoint.
 *
 * @param {object} view - a normalized `spec.views[]` entry
 * @param {object} bounds - `spec.bounds` ({ length, width, height })
 * @returns {string} SVG markup
 */
export function viewGlyph(view, bounds) {
  const L = Number(bounds?.length) || 1;
  const H = Number(bounds?.height) || 1;
  const W = Number(bounds?.width) || 1;
  // x is length, y is height, z is width — the axis convention the whole
  // pipeline uses, and what makes az=0 a profile and az=90 a front elevation.
  //
  // The proportions are COMPRESSED, by a square root, before being drawn. At
  // true ratio a 9980 x 2360 hull gives a side elevation 4.2:1, which inside a
  // 24px square is a 5px sliver — accurate, and unreadable, and indistinguishable
  // from the other sliver next to it. The root pulls that to about 2:1 while
  // leaving the three elevations plainly different from each other and from the
  // axonometric views, which is the whole job a glyph has. It is a symbol of the
  // subject, not a scale drawing of it; the sheet behind it is the scale drawing.
  const m = Math.max(L, H, W) || 1;
  const squash = (d) => Math.sqrt(d / m) / 2;
  const half = [squash(L), squash(H), squash(W)];

  const { fwd, right, up } = basis(view.az ?? 38, view.el ?? 22);

  // Parallel projection onto the camera basis. A view glyph has no business
  // having perspective in it: it is a statement about direction, not distance.
  const flat = (c) => {
    const p = [c[0] * half[0], c[1] * half[1], c[2] * half[2]];
    return [dot(p, right), -dot(p, up)];
  };

  const facing = (f) => {
    const nrm = [0, 0, 0];
    nrm[f.axis] = f.s;
    return dot(nrm, fwd);
  };
  // Edge-on to every face — a true elevation — leaves nothing strictly facing
  // us, so the plate falls back to the single most nearly-facing one and still
  // draws its rectangle.
  const visible = FACES.filter((f) => facing(f) > 1e-6);
  const faces = visible.length
    ? visible
    : [[...FACES].sort((a, b) => facing(b) - facing(a))[0]];

  const pts = faces.map((f) => f.quad.map(flat));
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pts.flat()) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const pad = 3.5;
  const span = Math.max(maxX - minX, maxY - minY, 1e-6);
  const k = (BOX - pad * 2) / span;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const at = ([x, y]) => `${n((x - cx) * k + BOX / 2)},${n((y - cy) * k + BOX / 2)}`;

  let body = '';
  faces.forEach((f, i) => {
    body += `<polygon points="${pts[i].map(at).join(' ')}" fill="currentColor"`
      + ` fill-opacity="${SHADE[f.axis]}" stroke="currentColor" stroke-width="1.3"`
      + ' stroke-linejoin="round"/>';
  });

  // An orthographic view is a PLATE, and a plate carries datum centrelines —
  // the same dash-dot the sheet draws on the real elevations. That, rather than
  // the outline, is what separates the plate buttons from the perspective ones
  // at a glance, whatever the subject's proportions happen to be.
  if (view.projection === 'orthographic') {
    const x0 = n((minX - cx) * k + BOX / 2 - 1.6);
    const x1 = n((maxX - cx) * k + BOX / 2 + 1.6);
    const y0 = n((minY - cy) * k + BOX / 2 - 1.6);
    const y1 = n((maxY - cy) * k + BOX / 2 + 1.6);
    const d = 'stroke="currentColor" stroke-width=".9" stroke-dasharray="4 1.6 1 1.6" opacity=".62"';
    body += `<line x1="${x0}" y1="${BOX / 2}" x2="${x1}" y2="${BOX / 2}" ${d}/>`;
    body += `<line x1="${BOX / 2}" y1="${y0}" x2="${BOX / 2}" y2="${y1}" ${d}/>`;
  }

  // A cut view says so the way a drawing says it: a heavy cutting-plane trace
  // straight across the glyph, hatched on the side that was taken away.
  if (view.section) {
    body += '<path d="M2.5 17.6 21.5 6.4" stroke="currentColor" stroke-width="2.1"'
      + ' stroke-linecap="round"/>'
      + '<path d="M4.4 21.4 9.1 18.6 M8.2 22.8 12.9 20" stroke="currentColor"'
      + ' stroke-width="1" stroke-linecap="round" opacity=".75"/>';
  }

  return svg(body);
}

/* ------------------------------------------------------------ motion glyphs */

/**
 * One glyph per animation primitive. These are the ten `channel.type` values
 * the runtime knows how to apply, so between them they describe every motion a
 * spec is able to declare.
 */
const CHANNEL_GLYPH = {
  // a body turning about its own axis
  spin: '<path d="M12 4.6a7.4 7.4 0 1 1-6.6 4" stroke="currentColor" stroke-width="1.7"'
    + ' stroke-linecap="round"/><path d="M4.2 3.4v5.6h5.6" stroke="currentColor"'
    + ' stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',

  // a body swinging through an arc and back
  oscillate: '<path d="M4.4 15.4a8.6 8.6 0 0 1 15.2 0" stroke="currentColor"'
    + ' stroke-width="1.7" stroke-linecap="round"/><path d="M6.8 11.8 4 15.8l4.7.9'
    + ' M17.2 11.8 20 15.8l-4.7.9" stroke="currentColor" stroke-width="1.5"'
    + ' stroke-linecap="round" stroke-linejoin="round"/>'
    + '<circle cx="12" cy="19.4" r="1.5" fill="currentColor"/>',

  // a piston: straight, both ways
  reciprocate: '<path d="M3.6 12h16.8" stroke="currentColor" stroke-width="1.7"'
    + ' stroke-linecap="round"/><path d="M7 8.2 3.2 12 7 15.8 M17 8.2 20.8 12 17 15.8"'
    + ' stroke="currentColor" stroke-width="1.6" stroke-linecap="round"'
    + ' stroke-linejoin="round"/><rect x="10.2" y="7.4" width="3.6" height="9.2"'
    + ' fill="currentColor" fill-opacity=".2" stroke="currentColor" stroke-width="1.3"/>',

  // a linkage folding about a pin
  articulate: '<path d="M4.8 19.6 11 9.4l8.4 3.6" stroke="currentColor" stroke-width="1.8"'
    + ' stroke-linecap="round" stroke-linejoin="round"/>'
    + '<circle cx="11" cy="9.4" r="2.4" stroke="currentColor" stroke-width="1.4"/>'
    + '<circle cx="4.8" cy="19.6" r="1.6" fill="currentColor"/>'
    + '<circle cx="19.4" cy="13" r="1.6" fill="currentColor"/>',

  // something running along a route
  pathFollow: '<path d="M3.4 17.6c4.4 0 3.6-9.6 8.2-9.6 4 0 3.2 6.4 6.6 6.4"'
    + ' stroke="currentColor" stroke-width="1.6" stroke-linecap="round"'
    + ' stroke-dasharray="3 2.4"/><path d="M17 11.2 21 14.4 17 17.6" stroke="currentColor"'
    + ' stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',

  // a single discharge
  impulse: '<path d="M12 2.8v4.6 M12 16.6v4.6 M2.8 12h4.6 M16.6 12h4.6 M5.6 5.6 8.8 8.8'
    + ' M15.2 15.2 18.4 18.4 M18.4 5.6 15.2 8.8 M8.8 15.2 5.6 18.4" stroke="currentColor"'
    + ' stroke-width="1.6" stroke-linecap="round"/>'
    + '<circle cx="12" cy="12" r="2.6" fill="currentColor"/>',

  // covers on, covers off
  visibility: '<path d="M2.6 12S6.2 5.8 12 5.8 21.4 12 21.4 12 17.8 18.2 12 18.2 2.6 12 2.6 12Z"'
    + ' stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>'
    + '<circle cx="12" cy="12" r="2.9" fill="currentColor" fill-opacity=".22"'
    + ' stroke="currentColor" stroke-width="1.4"/>',

  // the assembly coming apart
  explode: '<rect x="9.4" y="9.4" width="5.2" height="5.2" fill="currentColor"'
    + ' fill-opacity=".2" stroke="currentColor" stroke-width="1.4"/>'
    + '<path d="M12 7.4V3.4 M12 16.6v4 M7.4 12H3.4 M16.6 12h4" stroke="currentColor"'
    + ' stroke-width="1.6" stroke-linecap="round"/>'
    + '<path d="M10.1 5.3 12 2.9l1.9 2.4 M10.1 18.7 12 21.1l1.9-2.4 M5.3 10.1 2.9 12l2.4 1.9'
    + ' M18.7 10.1 21.1 12l-2.4 1.9" stroke="currentColor" stroke-width="1.5"'
    + ' stroke-linecap="round" stroke-linejoin="round"/>',

  // a nozzle throwing particles
  emit: '<path d="M3.2 12h5.2" stroke="currentColor" stroke-width="1.8"'
    + ' stroke-linecap="round"/><path d="M8.4 8.4 12.6 12l-4.2 3.6Z" fill="currentColor"'
    + ' fill-opacity=".25" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>'
    + '<circle cx="16" cy="8.6" r="1.5" fill="currentColor"/>'
    + '<circle cx="19.4" cy="12" r="1.9" fill="currentColor" fill-opacity=".6"/>'
    + '<circle cx="16.4" cy="15.8" r="1.2" fill="currentColor" fill-opacity=".8"/>',

  // fluid on the move
  flow: '<path d="M3 8.2c3.4-2.6 5.4 2.6 9 0s5.4 2.6 9 0 M3 15.8c3.4-2.6 5.4 2.6 9 0s5.4 2.6 9 0"'
    + ' stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
};

/** When nothing can be derived: a motion is still something you start. */
const MOTION_FALLBACK = '<path d="M8.4 5.6 19 12 8.4 18.4Z" fill="currentColor"'
  + ' fill-opacity=".2" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>';

/**
 * Which channel wins when a motion drives several.
 *
 * Ordered by how much of the picture the primitive changes: separating the
 * whole assembly is what a reader sees first, a part blinking out of existence
 * is what they see last. A motion that both spins a shaft and throws exhaust
 * is, to someone glancing at a toolbar, the exhaust one.
 */
const CHANNEL_RANK = [
  'explode', 'emit', 'flow', 'pathFollow', 'articulate',
  'reciprocate', 'oscillate', 'spin', 'impulse', 'visibility',
];

/**
 * Work out what a motion actually does, by following its drivers into the
 * geometry rather than by reading its label.
 *
 * `motion.set` names drivers; a part's `channel.bind` is an expression over
 * drivers. So the channels a motion moves are the ones whose binding mentions
 * one of its drivers — which `compileExpr(...).vars` already reports, and which
 * `validate` has already proved resolves.
 *
 * @param {object} spec - normalized spec
 * @param {object} motion - a `spec.motions[]` entry
 * @param {(src: string) => { vars: Set<string> }} compile - expression compiler
 * @returns {string|null} a `channel.type`, or null if nothing binds these drivers
 */
export function motionChannelKind(spec, motion, compile) {
  const drivers = new Set(Object.keys(motion?.set ?? {}));
  if (!drivers.size) return null;

  const tally = new Map();
  for (const part of spec?.parts ?? []) {
    for (const ch of part.channels ?? []) {
      if (!ch?.type) continue;
      let vars;
      try { vars = compile(String(ch.bind ?? '')).vars; } catch { continue; }
      let touched = false;
      for (const v of vars) if (drivers.has(v)) { touched = true; break; }
      if (!touched) continue;
      tally.set(ch.type, (tally.get(ch.type) ?? 0) + 1);
    }
  }
  if (!tally.size) return null;

  let best = null;
  let bestCount = -1;
  for (const [type, count] of tally) {
    const beats = count > bestCount
      || (count === bestCount && CHANNEL_RANK.indexOf(type) < CHANNEL_RANK.indexOf(best));
    if (beats) { best = type; bestCount = count; }
  }
  return best;
}

/** The glyph for a motion, given the channel type it was found to drive. */
export function motionGlyph(kind) {
  return svg(CHANNEL_GLYPH[kind] ?? MOTION_FALLBACK);
}

/**
 * A motion's glyph, all three sources in order: what the author asked for, what
 * the geometry says, and what the motion's own shape says.
 *
 * The last of those is the case where a driver is pushed that no channel reads.
 * `momentary` is still a fact about the motion — it fires once and releases —
 * so a one-shot with nothing bound gets the discharge glyph rather than the
 * generic one. It is read off the spec, not off the button's word.
 */
export function resolveMotionGlyph(spec, motion, compile) {
  const asked = motion?.icon ? namedGlyph(motion.icon) : null;
  if (asked) return asked;
  const kind = motionChannelKind(spec, motion, compile);
  if (kind) return motionGlyph(kind);
  return motionGlyph(motion?.momentary ? 'impulse' : null);
}

/** A view's glyph, with the author's `icon` taking precedence over the geometry. */
export function resolveViewGlyph(view, bounds) {
  const asked = view?.icon ? namedGlyph(view.icon) : null;
  return asked ?? viewGlyph(view, bounds);
}

/* ---------------------------------------------------------------- furniture */

/**
 * The sheet's own controls. Unlike the two above these are not derived from
 * anything — a legend is a legend on every sheet — so they are simply drawn.
 */
const UI_GLYPH = {
  // key to items: numbered rows
  key: '<circle cx="5.2" cy="6.4" r="2.5" stroke="currentColor" stroke-width="1.3"/>'
    + '<circle cx="5.2" cy="14.8" r="2.5" stroke="currentColor" stroke-width="1.3"/>'
    + '<path d="M10.6 6.4h10.2 M10.6 14.8h10.2 M3.2 21.4h17.6" stroke="currentColor"'
    + ' stroke-width="1.5" stroke-linecap="round"/>',

  // instrumentation: a dial with a needle
  instruments: '<path d="M3.6 17.6a9 9 0 1 1 16.8 0" stroke="currentColor"'
    + ' stroke-width="1.6" stroke-linecap="round"/><path d="M12 17 15.8 9.6"'
    + ' stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'
    + '<circle cx="12" cy="17.6" r="1.8" fill="currentColor"/>'
    + '<path d="M4.9 11.1 6.3 12 M19.1 11.1 17.7 12" stroke="currentColor"'
    + ' stroke-width="1.3" stroke-linecap="round"/>',

  // title block: the ruled corner of a drawing
  titleBlock: '<rect x="3" y="4.6" width="18" height="14.8" stroke="currentColor"'
    + ' stroke-width="1.5"/><path d="M3 12.4h18 M12 12.4v7 M3 16h9" stroke="currentColor"'
    + ' stroke-width="1.3"/><path d="M5.8 8.2h8" stroke="currentColor" stroke-width="1.6"'
    + ' stroke-linecap="round"/>',

  // item numbering: a balloon on a leader
  callouts: '<circle cx="16.6" cy="7.4" r="4.4" stroke="currentColor" stroke-width="1.5"/>'
    + '<path d="M12.6 9.6 4.4 18.2" stroke="currentColor" stroke-width="1.4"/>'
    + '<circle cx="4" cy="18.6" r="1.7" fill="currentColor"/>'
    + '<path d="M15.1 6.1h1.8v4.1 M15.4 10.2h3" stroke="currentColor" stroke-width="1.3"'
    + ' stroke-linecap="round" stroke-linejoin="round"/>',

  // dimensions: an extension-line pair with arrowheads
  dimensions: '<path d="M4.6 4.4v15.2 M19.4 4.4v15.2" stroke="currentColor"'
    + ' stroke-width="1.3" stroke-linecap="round" opacity=".72"/>'
    + '<path d="M4.6 12h14.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'
    + '<path d="M8 9.2 4.4 12 8 14.8 M16 9.2 19.6 12 16 14.8" stroke="currentColor"'
    + ' stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',

  // focus: pull the sheet furniture back to the edges
  focus: '<rect x="8.4" y="8.4" width="7.2" height="7.2" stroke="currentColor"'
    + ' stroke-width="1.5"/><path d="M3 3.4v3.4h3.4 M21 3.4v3.4h-3.4 M3 20.6v-3.4h3.4'
    + ' M21 20.6v-3.4h-3.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"'
    + ' stroke-linejoin="round"/>',

  close: '<path d="M6 6 18 18 M18 6 6 18" stroke="currentColor" stroke-width="1.9"'
    + ' stroke-linecap="round"/>',

  // Points the way along a rail that has more on it than fits.
  chevron: '<path d="M9.5 4.8 16.7 12 9.5 19.2" stroke="currentColor" stroke-width="2.2"'
    + ' stroke-linecap="round" stroke-linejoin="round"/>',

  // what the pointer does here
  help: '<circle cx="12" cy="12" r="8.8" stroke="currentColor" stroke-width="1.5"/>'
    + '<path d="M9.4 9.6a2.7 2.7 0 1 1 3.4 2.6v1.6" stroke="currentColor" stroke-width="1.6"'
    + ' stroke-linecap="round" stroke-linejoin="round"/>'
    + '<circle cx="12.4" cy="17" r="1.25" fill="currentColor"/>',
};

/** A named piece of sheet furniture. An unknown name draws nothing rather than throwing. */
export function uiGlyph(name) {
  return svg(UI_GLYPH[name] ?? '');
}

/** Every glyph name an author may write in `view.icon` / `motion.icon`. */
export const ICON_NAMES = [...Object.keys(CHANNEL_GLYPH), ...Object.keys(UI_GLYPH)];

/** A glyph by name, for the `icon` override. Returns null when unknown. */
export function namedGlyph(name) {
  if (CHANNEL_GLYPH[name]) return svg(CHANNEL_GLYPH[name]);
  if (UI_GLYPH[name]) return svg(UI_GLYPH[name]);
  return null;
}

export { BOX as GLYPH_BOX };
