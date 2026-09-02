/**
 * Procedural greebles.
 *
 * Most of the density in a real general-arrangement drawing is fasteners,
 * louvres, grilles, panel joints and tread plate. Modelling those by hand is
 * not viable, so each becomes one spec line applied to a host face.
 *
 * A generator returns:
 *   solids : BufferGeometry[]  merged into the part's mesh (shaded + outlined)
 *   lines  : [ [ax,ay,az], [bx,by,bz] ][]  engraved lines, drawn but not shaded
 *
 * Everything is emitted in the host part's local space.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const DEG = Math.PI / 180;

/**
 * Local frame for a named face of the host's bounding box.
 * Returns basis vectors plus the usable extent, so generators lay out in 2D.
 */
export function faceFrame(bbox, face = 'top') {
  const c = new THREE.Vector3();
  bbox.getCenter(c);
  const s = new THREE.Vector3();
  bbox.getSize(s);
  const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);
  const F = {
    top:    { o: [c.x, bbox.max.y, c.z], u: X, v: Z,                     n: Y,                     w: s.x, h: s.z },
    bottom: { o: [c.x, bbox.min.y, c.z], u: X, v: Z.clone().negate(),    n: Y.clone().negate(),    w: s.x, h: s.z },
    front:  { o: [c.x, c.y, bbox.max.z], u: X, v: Y,                     n: Z,                     w: s.x, h: s.y },
    back:   { o: [c.x, c.y, bbox.min.z], u: X.clone().negate(), v: Y,    n: Z.clone().negate(),    w: s.x, h: s.y },
    right:  { o: [bbox.max.x, c.y, c.z], u: Z.clone().negate(), v: Y,    n: X,                     w: s.z, h: s.y },
    left:   { o: [bbox.min.x, c.y, c.z], u: Z, v: Y,                     n: X.clone().negate(),    w: s.z, h: s.y },
  }[face] ?? null;
  if (!F) throw new Error(`unknown face "${face}"`);
  return F;
}

/** Matrix that maps a child built in XY (Z = outward) onto the face at (u,v,out). */
function placeOnFace(F, u, v, out = 0, roll = 0) {
  const m = new THREE.Matrix4().makeBasis(F.u, F.v, F.n);
  const p = new THREE.Vector3(F.o[0], F.o[1], F.o[2])
    .addScaledVector(F.u, u)
    .addScaledVector(F.v, v)
    .addScaledVector(F.n, out);
  m.setPosition(p);
  if (roll) m.multiply(new THREE.Matrix4().makeRotationZ(roll));
  return m;
}

function pointOnFace(F, u, v, out = 0) {
  return new THREE.Vector3(F.o[0], F.o[1], F.o[2])
    .addScaledVector(F.u, u).addScaledVector(F.v, v).addScaledVector(F.n, out)
    .toArray();
}

/** Build a child geometry oriented so +Z is "outward from the face". */
function stud(r, h, sides = 6) {
  const g = new THREE.CylinderGeometry(r, r, h, sides);
  g.rotateX(Math.PI / 2);        // axis Y -> axis Z
  g.translate(0, 0, h / 2);      // sit on the face
  return g;
}

function plate(w, h, t) {
  const g = new THREE.BoxGeometry(w, h, t);
  g.translate(0, 0, t / 2);
  return g;
}

/* ----------------------------------------------------------------- generators */

const generators = {

  boltCircle(F, d, scale) {
    const r = d.r ?? Math.min(F.w, F.h) * 0.3;
    const count = d.count ?? 8;
    const br = d.boltR ?? Math.max(r * 0.09, scale * 0.6);
    const bh = d.boltH ?? br * 0.9;
    const cu = d.cu ?? 0, cv = d.cv ?? 0;
    const solids = [];
    const lines = [];
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + (d.phase ?? 0) * DEG;
      const u = cu + Math.cos(a) * r, v = cv + Math.sin(a) * r;
      const g = stud(br, bh, 6);
      g.applyMatrix4(placeOnFace(F, u, v, 0, a));
      solids.push(g);
    }
    // pitch-circle centre line, the way it's drawn on a real sheet
    const seg = 48;
    for (let i = 0; i < seg; i += 2) {
      const a1 = (i / seg) * Math.PI * 2, a2 = ((i + 1) / seg) * Math.PI * 2;
      lines.push([
        pointOnFace(F, cu + Math.cos(a1) * r, cv + Math.sin(a1) * r, 0.01),
        pointOnFace(F, cu + Math.cos(a2) * r, cv + Math.sin(a2) * r, 0.01),
      ]);
    }
    return { solids, lines };
  },

  rivetRow(F, d, scale) {
    const count = d.count ?? 8;
    const r = d.r ?? scale * 0.5;
    const from = d.from ?? [-F.w * 0.4, 0];
    const to = d.to ?? [F.w * 0.4, 0];
    const solids = [];
    for (let i = 0; i < count; i++) {
      const t = count === 1 ? 0.5 : i / (count - 1);
      const u = from[0] + (to[0] - from[0]) * t;
      const v = from[1] + (to[1] - from[1]) * t;
      const g = new THREE.SphereGeometry(r, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2);
      g.rotateX(Math.PI / 2);
      g.applyMatrix4(placeOnFace(F, u, v, 0));
      solids.push(g);
    }
    return { solids, lines: [] };
  },

  louvre(F, d) {
    const count = d.count ?? 6;
    const w = d.size?.[0] ?? F.w * 0.5;
    const h = d.size?.[1] ?? F.h * 0.5;
    const angle = (d.angle ?? 35) * DEG;
    const depth = d.depth ?? h / count * 0.5;
    const cu = d.cu ?? 0, cv = d.cv ?? 0;
    const pitch = h / count;
    const solids = [];
    for (let i = 0; i < count; i++) {
      const v = cv - h / 2 + pitch * (i + 0.5);
      const g = plate(w, pitch * 0.78, depth * 0.35);
      g.rotateX(-angle);
      g.applyMatrix4(placeOnFace(F, cu, v, 0));
      solids.push(g);
    }
    // recessed surround
    const frame = plate(w * 1.06, h * 1.06, depth * 0.12);
    frame.applyMatrix4(placeOnFace(F, cu, cv, -depth * 0.1));
    solids.push(frame);
    return { solids, lines: [] };
  },

  grille(F, d, scale) {
    const rows = d.rows ?? 6, cols = d.cols ?? 10;
    const w = d.size?.[0] ?? F.w * 0.6, h = d.size?.[1] ?? F.h * 0.6;
    const bar = d.bar ?? Math.max(scale * 0.4, Math.min(w / cols, h / rows) * 0.18);
    const cu = d.cu ?? 0, cv = d.cv ?? 0;
    const t = d.depth ?? bar;
    const solids = [];
    for (let i = 0; i <= cols; i++) {
      const u = cu - w / 2 + (w / cols) * i;
      const g = plate(bar, h, t);
      g.applyMatrix4(placeOnFace(F, u, cv, 0));
      solids.push(g);
    }
    for (let j = 0; j <= rows; j++) {
      const v = cv - h / 2 + (h / rows) * j;
      const g = plate(w, bar, t * 0.8);
      g.applyMatrix4(placeOnFace(F, cu, v, 0));
      solids.push(g);
    }
    return { solids, lines: [] };
  },

  mullion(F, d, scale) {
    return generators.grille(F, { rows: 4, cols: 3, ...d }, scale);
  },

  tread(F, d) {
    const count = d.count ?? 12;
    const w = d.size?.[0] ?? F.w * 0.9, h = d.size?.[1] ?? F.h * 0.9;
    const depth = d.depth ?? Math.min(w, h) * 0.03;
    const cu = d.cu ?? 0, cv = d.cv ?? 0;
    const along = d.along ?? 'u';
    const solids = [];
    const span = along === 'u' ? w : h;
    const pitch = span / count;
    for (let i = 0; i < count; i++) {
      const off = -span / 2 + pitch * (i + 0.5);
      const g = along === 'u' ? plate(pitch * 0.6, h, depth) : plate(w, pitch * 0.6, depth);
      g.applyMatrix4(placeOnFace(F, along === 'u' ? cu + off : cu, along === 'u' ? cv : cv + off, 0));
      solids.push(g);
    }
    return { solids, lines: [] };
  },

  corrugation(F, d) {
    const count = d.count ?? 10;
    const w = d.size?.[0] ?? F.w, h = d.size?.[1] ?? F.h;
    const amp = d.amp ?? Math.min(w, h) * 0.02;
    const axis = d.axis ?? 'v';           // ridges run along v
    const cu = d.cu ?? 0, cv = d.cv ?? 0;
    const solids = [];
    const span = axis === 'v' ? w : h;
    const pitch = span / count;
    for (let i = 0; i < count; i++) {
      const off = -span / 2 + pitch * (i + 0.5);
      const g = new THREE.CylinderGeometry(amp, amp, axis === 'v' ? h : w, 6, 1, false, 0, Math.PI);
      g.rotateX(Math.PI / 2);
      if (axis === 'v') g.rotateZ(Math.PI / 2);
      g.rotateZ(axis === 'v' ? 0 : 0);
      g.applyMatrix4(placeOnFace(F, axis === 'v' ? cu + off : cu, axis === 'v' ? cv : cv + off, 0));
      solids.push(g);
    }
    return { solids, lines: [] };
  },

  perforation(F, d, scale) {
    // Drawn as shallow recessed discs rather than real holes: a CSG hole array
    // costs far more than it reads in line art.
    const rows = d.rows ?? 5, cols = d.cols ?? 9;
    const w = d.size?.[0] ?? F.w * 0.6, h = d.size?.[1] ?? F.h * 0.6;
    const r = d.r ?? Math.min(w / cols, h / rows) * 0.3;
    const cu = d.cu ?? 0, cv = d.cv ?? 0;
    const solids = [];
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const u = cu - w / 2 + (w / (cols - 1 || 1)) * i;
        const v = cv - h / 2 + (h / (rows - 1 || 1)) * j;
        const g = new THREE.CylinderGeometry(r, r, r * 0.5, 8);
        g.rotateX(Math.PI / 2);
        g.translate(0, 0, -r * 0.25);
        g.applyMatrix4(placeOnFace(F, u, v, 0));
        solids.push(g);
      }
    }
    return { solids, lines: [] };
  },

  knurl(F, d, scale) {
    const count = d.count ?? 24;
    const r = d.r ?? Math.min(F.w, F.h) * 0.45;
    const h = d.h ?? F.h * 0.4;
    const ridge = d.ridge ?? Math.max(scale * 0.3, r * 0.05);
    const solids = [];
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      const g = plate(ridge, h, ridge);
      g.applyMatrix4(placeOnFace(F, Math.cos(a) * r, Math.sin(a) * r, 0, a));
      solids.push(g);
    }
    return { solids, lines: [] };
  },

  fastener(F, d, scale) {
    const r = d.r ?? scale * 0.8;
    const h = d.h ?? r * 0.7;
    const u = d.cu ?? 0, v = d.cv ?? 0;
    const sides = d.kind === 'socket' ? 12 : 6;
    const g = stud(r, h, sides);
    g.applyMatrix4(placeOnFace(F, u, v, 0));
    const lines = [];
    if (d.kind === 'slot') {
      lines.push([pointOnFace(F, u - r * 0.7, v, h + 0.01), pointOnFace(F, u + r * 0.7, v, h + 0.01)]);
    }
    return { solids: [g], lines };
  },

  panelLine(F, d) {
    // Pure engraving: no solid, just ink. Cheapest density there is.
    const lines = [];
    const out = d.out ?? 0.02;
    if (d.segments) {
      for (const [u1, v1, u2, v2] of d.segments) {
        lines.push([pointOnFace(F, u1, v1, out), pointOnFace(F, u2, v2, out)]);
      }
    } else {
      const count = d.count ?? 3;
      const along = d.along ?? 'u';
      const w = d.size?.[0] ?? F.w * 0.9, h = d.size?.[1] ?? F.h * 0.9;
      for (let i = 1; i <= count; i++) {
        const t = -0.5 + i / (count + 1);
        if (along === 'u') lines.push([pointOnFace(F, t * w, -h / 2, out), pointOnFace(F, t * w, h / 2, out)]);
        else lines.push([pointOnFace(F, -w / 2, t * h, out), pointOnFace(F, w / 2, t * h, out)]);
      }
    }
    return { solids: [], lines };
  },

  weldSeam(F, d, scale) {
    const r = d.r ?? scale * 0.5;
    const pts = (d.path ?? []).map(([x, y, z]) => new THREE.Vector3(x, y, z));
    if (pts.length < 2) return { solids: [], lines: [] };
    const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.1);
    const g = new THREE.TubeGeometry(curve, Math.max(12, pts.length * 4), r, 6, false);
    return { solids: [g], lines: [] };
  },
};

/**
 * Expand every `details` entry of a part.
 * @param {THREE.BufferGeometry} hostGeometry - already built, local space
 * @param {object[]} details
 * @param {number} scale - a characteristic size (used for default fastener radii)
 * @returns {{ geometry: THREE.BufferGeometry|null, lines: number[][][] }}
 */
export function buildDetails(hostGeometry, details = [], scale = 1) {
  if (!details.length) return { geometry: null, lines: [] };

  hostGeometry.computeBoundingBox();
  const bbox = hostGeometry.boundingBox;

  const solids = [];
  const lines = [];

  for (const d of details) {
    const gen = generators[d.kind];
    if (!gen) continue;
    const F = faceFrame(bbox, d.face ?? 'top');
    let res;
    try { res = gen(F, d, scale); }
    catch { continue; }
    for (let g of res.solids) {
      if (d.at || d.rot) {
        const m = new THREE.Matrix4();
        const [rx, ry, rz] = d.rot ?? [0, 0, 0];
        m.makeRotationFromEuler(new THREE.Euler(rx * DEG, ry * DEG, rz * DEG));
        m.setPosition(...(d.at ?? [0, 0, 0]));
        g = g.clone().applyMatrix4(m);
      }
      solids.push(g);
    }
    lines.push(...res.lines);
  }

  let geometry = null;
  if (solids.length) {
    const cleaned = solids.map((g) => {
      const n = g.index ? g.toNonIndexed() : g;
      // merge requires a uniform attribute set
      const out = new THREE.BufferGeometry();
      out.setAttribute('position', n.attributes.position.clone());
      if (!n.attributes.normal) n.computeVertexNormals();
      out.setAttribute('normal', n.attributes.normal.clone());
      return out;
    });
    geometry = mergeGeometries(cleaned, false);
  }

  return { geometry, lines };
}

export { generators };
