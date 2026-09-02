/**
 * Shape vocabulary -> BufferGeometry.
 *
 * One pure function per `shape.type` in the spec schema. Everything is built in
 * the spec's own units (mm, m, whatever) and centred on its local origin; the
 * assembly applies a single scene scale at the root.
 *
 * Axis convention, matching `bounds`:
 *   X = length (fore/aft)   Y = height (up)   Z = width (lateral)
 */

import * as THREE from 'three';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { Brush, Evaluator, ADDITION, SUBTRACTION, INTERSECTION } from 'three-bvh-csg';

const DEG = Math.PI / 180;

/* ------------------------------------------------------------------ helpers */

function shapeFromProfile(profile, holes = []) {
  const s = new THREE.Shape();
  profile.forEach(([x, y], i) => (i === 0 ? s.moveTo(x, y) : s.lineTo(x, y)));
  s.closePath();
  for (const h of holes) {
    const path = new THREE.Path();
    h.forEach(([x, y], i) => (i === 0 ? path.moveTo(x, y) : path.lineTo(x, y)));
    path.closePath();
    s.holes.push(path);
  }
  return s;
}

/** Resample a closed polygon to exactly `n` points, evenly spaced by arc length. */
function resampleClosed(points, n) {
  const pts = points.map((p) => new THREE.Vector2(p[0], p[1]));
  const segLen = [];
  let total = 0;
  for (let i = 0; i < pts.length; i++) {
    const d = pts[i].distanceTo(pts[(i + 1) % pts.length]);
    segLen.push(d);
    total += d;
  }
  if (total === 0) return Array.from({ length: n }, () => [points[0][0], points[0][1]]);

  const out = [];
  let seg = 0;
  let acc = 0;
  for (let k = 0; k < n; k++) {
    const target = (k / n) * total;
    while (acc + segLen[seg] < target && seg < segLen.length - 1) { acc += segLen[seg]; seg++; }
    const t = segLen[seg] > 0 ? (target - acc) / segLen[seg] : 0;
    const a = pts[seg], b = pts[(seg + 1) % pts.length];
    out.push([a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t]);
  }
  return out;
}

/** Signed area; used to force a consistent winding so lofted skins face outward. */
function signedArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

function circleProfile(r, segments = 16) {
  return Array.from({ length: segments }, (_, i) => {
    const a = (i / segments) * Math.PI * 2;
    return [Math.cos(a) * r, Math.sin(a) * r];
  });
}

/* ------------------------------------------------------------------ builders */

const builders = {

  box({ size, radius = 0 }) {
    const [x, y, z] = size;
    if (radius > 0) {
      const r = Math.min(radius, Math.min(x, y, z) / 2 - 1e-6);
      return new RoundedBoxGeometry(x, y, z, 2, r);
    }
    return new THREE.BoxGeometry(x, y, z);
  },

  cylinder({ r, r2, h, segments = 24, arc = 360, capped = true }) {
    const top = r2 == null ? r : r2;
    return new THREE.CylinderGeometry(top, r, h, segments, 1, !capped, 0, arc * DEG);
  },

  cone({ r, h, segments = 24 }) {
    return new THREE.ConeGeometry(r, h, segments);
  },

  sphere({ r, segments = 24, phi = 360, theta = 180 }) {
    return new THREE.SphereGeometry(r, segments, Math.max(3, Math.round(segments / 2)),
      0, phi * DEG, 0, theta * DEG);
  },

  torus({ r, tube, segments = 32, tubeSegments = 12, arc = 360 }) {
    return new THREE.TorusGeometry(r, tube, tubeSegments, segments, arc * DEG);
  },

  /** Symmetric trapezoidal prism: taper 1 = box, taper 0 = triangular ridge. */
  wedge({ size, taper = 0 }) {
    const [x, y, z] = size;
    const tx = (x * Math.min(Math.max(taper, 0), 1)) / 2;
    const profile = [
      [-x / 2, -y / 2], [x / 2, -y / 2], [tx, y / 2], [-tx, y / 2],
    ];
    const g = new THREE.ExtrudeGeometry(shapeFromProfile(profile), {
      depth: z, bevelEnabled: false, steps: 1,
    });
    g.translate(0, 0, -z / 2);
    return g;
  },

  prism({ sides, r, h }) {
    return new THREE.CylinderGeometry(r, r, h, sides);
  },

  polyhedron({ vertices, faces }) {
    const pos = [];
    for (const f of faces) {
      // fan-triangulate each face
      for (let i = 1; i < f.length - 1; i++) {
        for (const idx of [f[0], f[i], f[i + 1]]) {
          const v = vertices[idx];
          if (!v) throw new Error(`polyhedron face references vertex ${idx} which does not exist`);
          pos.push(v[0], v[1], v[2]);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    return g;
  },

  extrude({ profile, depth, bevel = 0, holes = [], centered = true }) {
    const g = new THREE.ExtrudeGeometry(shapeFromProfile(profile, holes), {
      depth,
      bevelEnabled: bevel > 0,
      bevelThickness: bevel,
      bevelSize: bevel,
      bevelSegments: 1,
      steps: 1,
    });
    if (centered) g.translate(0, 0, -depth / 2);
    return g;
  },

  lathe({ points, segments = 24, arc = 360 }) {
    const pts = points.map(([r, y]) => new THREE.Vector2(Math.max(r, 1e-6), y));
    return new THREE.LatheGeometry(pts, segments, 0, arc * DEG);
  },

  sweep({ path, profile, radius = 1, segments = 12, steps, closed = false }) {
    const curvePts = path.map(([x, y, z]) => new THREE.Vector3(x, y, z));
    const curve = new THREE.CatmullRomCurve3(curvePts, closed, 'catmullrom', 0.2);
    const prof = profile ?? circleProfile(radius, segments);
    return new THREE.ExtrudeGeometry(shapeFromProfile(prof), {
      steps: steps ?? Math.max(16, path.length * 6),
      bevelEnabled: false,
      extrudePath: curve,
    });
  },

  /** Skin between ordered cross-sections. Profiles are resampled to a common count. */
  loft({ sections, capped = true }) {
    const n = Math.max(...sections.map((s) => s.profile.length), 8);
    const rings = sections.map((s) => {
      let poly = s.profile;
      if (signedArea(poly) < 0) poly = [...poly].reverse();   // force CCW
      const rs = resampleClosed(poly, n);
      const roll = (s.rot ?? 0) * DEG;
      const sc = s.scale ?? 1;
      const cos = Math.cos(roll), sin = Math.sin(roll);
      return rs.map(([px, py]) => {
        const rx = (px * cos - py * sin) * sc;
        const ry = (px * sin + py * cos) * sc;
        // section profile lies in the XY plane, positioned at `at`, stacked along Z
        return [s.at[0] + rx, s.at[1] + ry, s.at[2]];
      });
    });

    const pos = [];
    const tri = (a, b, c) => pos.push(...a, ...b, ...c);
    for (let i = 0; i < rings.length - 1; i++) {
      const A = rings[i], B = rings[i + 1];
      for (let k = 0; k < n; k++) {
        const k2 = (k + 1) % n;
        tri(A[k], B[k], B[k2]);
        tri(A[k], B[k2], A[k2]);
      }
    }
    if (capped) {
      for (const [ring, flip] of [[rings[0], true], [rings[rings.length - 1], false]]) {
        const c = ring.reduce((a, p) => [a[0] + p[0], a[1] + p[1], a[2] + p[2]], [0, 0, 0]).map((v) => v / n);
        for (let k = 0; k < n; k++) {
          const k2 = (k + 1) % n;
          if (flip) tri(c, ring[k2], ring[k]);
          else tri(c, ring[k], ring[k2]);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    return g;
  },

  helix({ r, pitch, turns, tube, segments = 8, steps }) {
    const n = steps ?? Math.max(32, Math.round(turns * 24));
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * turns * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * r, (i / n) * turns * pitch, Math.sin(a) * r));
    }
    const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0);
    const g = new THREE.TubeGeometry(curve, n, tube, segments, false);
    g.translate(0, -(turns * pitch) / 2, 0);
    return g;
  },

  hull({ points }) {
    return new ConvexGeometry(points.map(([x, y, z]) => new THREE.Vector3(x, y, z)));
  },

  csg(shape) {
    const OPS = { union: ADDITION, subtract: SUBTRACTION, intersect: INTERSECTION };
    const op = OPS[shape.op];
    const evaluator = new Evaluator();
    evaluator.attributes = ['position', 'normal'];

    const brushFor = (operand) => {
      const g = buildGeometry(operand.shape);
      const b = new Brush(g);
      const t = operand.transform ?? {};
      const [px, py, pz] = t.pos ?? [0, 0, 0];
      const [rx, ry, rz] = t.rot ?? [0, 0, 0];
      const [sx, sy, sz] = t.scale ?? [1, 1, 1];
      b.position.set(px, py, pz);
      b.rotation.set(rx * DEG, ry * DEG, rz * DEG);
      b.scale.set(sx, sy, sz);
      b.updateMatrixWorld(true);
      return b;
    };

    let acc = brushFor(shape.operands[0]);
    for (let i = 1; i < shape.operands.length; i++) {
      const next = brushFor(shape.operands[i]);
      const result = evaluator.evaluate(acc, next, op);
      // evaluate() returns a Brush; keep its geometry and reset the transform so
      // the next operand composes against an identity-placed accumulator
      acc = new Brush(result.geometry);
      acc.updateMatrixWorld(true);
    }
    const out = acc.geometry;
    out.computeVertexNormals();
    return out;
  },
};

/**
 * @param {object} shape - a `shape` node from the spec
 * @returns {THREE.BufferGeometry}
 */
export function buildGeometry(shape) {
  const fn = builders[shape?.type];
  if (!fn) throw new Error(`unknown shape type "${shape?.type}"`);
  const g = fn(shape);
  if (!g.attributes.normal) g.computeVertexNormals();
  return g;
}

export { shapeFromProfile, resampleClosed, circleProfile, builders };
