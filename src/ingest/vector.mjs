/**
 * Vector CAD entry (DXF / SVG).
 *
 * This is the accurate path. A raster drawing forces the model to estimate every
 * dimension; a vector file already contains true coordinates, so closed outlines
 * are handed over verbatim for use as extrude profiles. The model is then only
 * asked what it is actually good at — deciding what each outline *is* and how
 * the parts assemble.
 */

import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

const MAX_OUTLINES = 40;
const MAX_POINTS = 64;

/** Douglas–Peucker, so a 900-vertex spline arrives as something a model can read. */
function simplify(points, tolerance) {
  if (points.length <= 3) return points;
  let maxDist = 0, index = 0;
  const [ax, ay] = points[0];
  const [bx, by] = points[points.length - 1];
  const dx = bx - ax, dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i];
    const d = Math.abs((px - ax) * dy - (py - ay) * dx) / len;
    if (d > maxDist) { maxDist = d; index = i; }
  }
  if (maxDist <= tolerance) return [points[0], points[points.length - 1]];
  return [
    ...simplify(points.slice(0, index + 1), tolerance).slice(0, -1),
    ...simplify(points.slice(index), tolerance),
  ];
}

function resampleTo(points, max) {
  if (points.length <= max) return points;
  const out = [];
  for (let i = 0; i < max; i++) out.push(points[Math.round((i * (points.length - 1)) / (max - 1))]);
  return out;
}

function bbox(points) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return {
    minX: Math.min(...xs), maxX: Math.max(...xs),
    minY: Math.min(...ys), maxY: Math.max(...ys),
  };
}

/* ------------------------------------------------------------------ DXF */

async function outlinesFromDxf(path) {
  const { default: DxfParser } = await import('dxf-parser');
  const text = await readFile(path, 'utf8');
  const dxf = new DxfParser().parseSync(text);

  const outlines = [];
  const texts = [];

  for (const e of dxf.entities ?? []) {
    const layer = e.layer ?? '0';
    if (e.type === 'LWPOLYLINE' || e.type === 'POLYLINE') {
      const pts = (e.vertices ?? []).map((v) => [v.x, v.y]);
      if (pts.length >= 3) outlines.push({ layer, closed: !!e.shape, points: pts });
    } else if (e.type === 'CIRCLE') {
      const n = 24;
      const pts = Array.from({ length: n }, (_, i) => {
        const a = (i / n) * Math.PI * 2;
        return [e.center.x + Math.cos(a) * e.radius, e.center.y + Math.sin(a) * e.radius];
      });
      outlines.push({ layer, closed: true, points: pts, circle: { r: e.radius, c: [e.center.x, e.center.y] } });
    } else if (e.type === 'TEXT' || e.type === 'MTEXT') {
      const t = (e.text ?? '').trim();
      if (t) texts.push({ layer, text: t, at: [e.startPoint?.x ?? 0, e.startPoint?.y ?? 0] });
    }
  }
  return { outlines, texts, units: dxf.header?.$INSUNITS ?? null };
}

/* ------------------------------------------------------------------ SVG */

function outlinesFromSvg(text) {
  const outlines = [];
  const texts = [];

  // Polygons and polylines carry explicit points — the reliable case.
  for (const m of text.matchAll(/<(polygon|polyline)\b[^>]*\bpoints\s*=\s*"([^"]+)"[^>]*>/gi)) {
    const pts = m[2].trim().split(/[\s,]+/).map(Number);
    const points = [];
    for (let i = 0; i + 1 < pts.length; i += 2) points.push([pts[i], -pts[i + 1]]);
    if (points.length >= 3) outlines.push({ layer: m[1], closed: m[1] === 'polygon', points });
  }
  for (const m of text.matchAll(/<rect\b[^>]*>/gi)) {
    const at = (n) => Number((m[0].match(new RegExp(`\\b${n}\\s*=\\s*"([^"]+)"`)) ?? [])[1] ?? NaN);
    const x = at('x') || 0, y = at('y') || 0, w = at('width'), h = at('height');
    if (Number.isFinite(w) && Number.isFinite(h)) {
      outlines.push({ layer: 'rect', closed: true,
        points: [[x, -y], [x + w, -y], [x + w, -(y + h)], [x, -(y + h)]] });
    }
  }
  for (const m of text.matchAll(/<circle\b[^>]*>/gi)) {
    const at = (n) => Number((m[0].match(new RegExp(`\\b${n}\\s*=\\s*"([^"]+)"`)) ?? [])[1] ?? NaN);
    const cx = at('cx') || 0, cy = at('cy') || 0, r = at('r');
    if (Number.isFinite(r)) {
      const n = 24;
      outlines.push({ layer: 'circle', closed: true, circle: { r, c: [cx, -cy] },
        points: Array.from({ length: n }, (_, i) => {
          const a = (i / n) * Math.PI * 2;
          return [cx + Math.cos(a) * r, -(cy + Math.sin(a) * r)];
        }) });
    }
  }
  // Straight-segment paths only; curves are left to the raster view.
  for (const m of text.matchAll(/<path\b[^>]*\bd\s*=\s*"([^"]+)"[^>]*>/gi)) {
    const d = m[1];
    if (/[csqtaCSQTA]/.test(d)) continue;
    const nums = d.match(/-?\d*\.?\d+(?:e-?\d+)?/gi)?.map(Number) ?? [];
    const points = [];
    for (let i = 0; i + 1 < nums.length; i += 2) points.push([nums[i], -nums[i + 1]]);
    if (points.length >= 3) outlines.push({ layer: 'path', closed: /[zZ]/.test(d), points });
  }
  for (const m of text.matchAll(/<text\b[^>]*>([^<]+)<\/text>/gi)) {
    const t = m[1].trim();
    if (t) texts.push({ layer: 'text', text: t, at: [0, 0] });
  }
  return { outlines, texts, units: null };
}

/**
 * Extract outlines and annotation text, and render a human-readable digest for
 * the prompt.
 */
export async function extractVector(path) {
  const ext = extname(path).toLowerCase();
  let result;
  if (ext === '.dxf') result = await outlinesFromDxf(path);
  else result = outlinesFromSvg(await readFile(path, 'utf8'));

  // Biggest outlines first — those are the ones that describe real parts.
  const scored = result.outlines
    .map((o) => {
      const b = bbox(o.points);
      return { ...o, area: (b.maxX - b.minX) * (b.maxY - b.minY), bbox: b };
    })
    .filter((o) => o.area > 0)
    .sort((a, b) => b.area - a.area)
    .slice(0, MAX_OUTLINES);

  const overall = scored.length ? bbox(scored.flatMap((o) => o.points)) : null;
  const tol = overall ? Math.max((overall.maxX - overall.minX), (overall.maxY - overall.minY)) * 0.002 : 0;

  const lines = [];
  if (overall) {
    lines.push(`drawing extent: x ${overall.minX.toFixed(1)}..${overall.maxX.toFixed(1)}, ` +
               `y ${overall.minY.toFixed(1)}..${overall.maxY.toFixed(1)} (file units)`);
  }
  if (result.texts.length) {
    lines.push(`\ntext found on the drawing (dimensions, labels, title block):`);
    for (const t of result.texts.slice(0, 60)) lines.push(`  "${t.text}"`);
  }
  lines.push(`\n${scored.length} closed outlines, largest first. Coordinates are TRUE — ` +
             `use them directly as extrude profiles:`);
  for (const [i, o] of scored.entries()) {
    if (o.circle) {
      lines.push(`  [${i}] layer "${o.layer}" CIRCLE r=${o.circle.r.toFixed(1)} at ` +
                 `[${o.circle.c[0].toFixed(1)}, ${o.circle.c[1].toFixed(1)}]`);
      continue;
    }
    const pts = resampleTo(simplify(o.points, tol), MAX_POINTS);
    const b = o.bbox;
    lines.push(`  [${i}] layer "${o.layer}" ${o.closed ? 'closed' : 'open'} ` +
               `bbox ${(b.maxX - b.minX).toFixed(1)} x ${(b.maxY - b.minY).toFixed(1)} ` +
               `at [${b.minX.toFixed(1)}, ${b.minY.toFixed(1)}]`);
    lines.push(`       ${JSON.stringify(pts.map((p) => [+p[0].toFixed(1), +p[1].toFixed(1)]))}`);
  }

  return { digest: lines.join('\n'), outlines: scored, texts: result.texts, overall };
}
