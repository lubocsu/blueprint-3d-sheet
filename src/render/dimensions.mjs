/**
 * Dimensions and datum lines, built as real world-space geometry.
 *
 * The reference draws its dimensions *in the scene*, not as a flat overlay:
 * the "2 360" height dimension leans with the perspective and its arrowheads
 * foreshorten. Projecting endpoints and drawing a straight SVG line between
 * them — which is what this used to do — reads as a sticker on the glass.
 *
 * The one thing that stays in screen space is the label. The reference keeps
 * dimension text horizontal no matter how steeply the line runs, which is
 * standard practice and much easier to read than rotated text.
 */

import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { PALETTE } from './materials.mjs';

const SVG_NS = 'http://www.w3.org/2000/svg';

const V = (a) => new THREE.Vector3(a[0], a[1], a[2]);

function makeLine(positions, { color, width, dashed = false, dashSize = 0, gapSize = 0 }) {
  const geo = new LineSegmentsGeometry();
  geo.setPositions(positions);
  const mat = new LineMaterial({
    color: new THREE.Color(color).getHex(),
    linewidth: width,
    worldUnits: false,
    dashed,
    dashSize,
    gapSize,
    transparent: true,
    // Dimensions and datums belong on top of the drawing. Without this they
    // flicker in and out as the model rotates past them.
    depthTest: false,
    alphaToCoverage: true,
  });
  const hasWin = typeof window !== 'undefined';
  mat.resolution.set(hasWin ? window.innerWidth : 1920, hasWin ? window.innerHeight : 1080);
  const line = new LineSegments2(geo, mat);
  line.computeLineDistances();
  line.raycast = () => {};
  line.renderOrder = 20;
  return line;
}

/**
 * Build one dimension: two witness lines, the dimension line itself, and a
 * 3D arrowhead at each end. All of it goes into a single geometry.
 */
function dimensionSegments(from, to, offset, scale) {
  const a = V(from), b = V(to), off = V(offset);
  const fa = a.clone().add(off);
  const fb = b.clone().add(off);

  const dir = fb.clone().sub(fa);
  const len = dir.length() || 1;
  dir.divideScalar(len);

  // Arrow barbs sit in the plane spanned by the dimension line and the offset,
  // which is the plane a draughtsman would draw them in.
  let up = off.clone();
  if (up.lengthSq() < 1e-9) up.set(0, 1, 0);
  up.addScaledVector(dir, -up.dot(dir));
  if (up.lengthSq() < 1e-9) {
    up.copy(Math.abs(dir.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0));
    up.addScaledVector(dir, -up.dot(dir));
  }
  up.normalize();

  // Barbs are sized off the assembly, not off the dimension's own length, so
  // every dimension on the sheet gets the same arrowhead. Capped against short
  // dimensions so the barbs never swallow the line.
  const AH = Math.min(len * 0.14, scale * 0.020);
  const AW = AH * 0.38;

  const seg = [];
  const push = (p, q) => seg.push(p.x, p.y, p.z, q.x, q.y, q.z);

  // witness lines run from the measured feature slightly past the dimension line
  const overshoot = off.clone().normalize().multiplyScalar(scale * 0.018);
  if (off.lengthSq() > 1e-9) {
    push(a, fa.clone().add(overshoot));
    push(b, fb.clone().add(overshoot));
  }

  push(fa, fb);

  for (const [tip, sign] of [[fa, 1], [fb, -1]]) {
    const base = tip.clone().addScaledVector(dir, AH * sign);
    push(tip, base.clone().addScaledVector(up, AW));
    push(tip, base.clone().addScaledVector(up, -AW));
  }

  return { seg, mid: fa.clone().add(fb).multiplyScalar(0.5) };
}

/**
 * @param {object} opts
 * @param {THREE.Object3D} opts.parent - the inner assembly node (spec coordinates)
 * @param {SVGElement} opts.svg
 * @param {object} opts.spec  - normalized
 * @param {THREE.Camera} opts.camera
 * @param {object} opts.viewCtl
 */
export function createDimensions({ parent, svg, spec, camera, viewCtl }) {
  const group = new THREE.Group();
  group.name = 'dimensions';
  parent.add(group);

  const gLabels = document.createElementNS(SVG_NS, 'g');
  svg.appendChild(gLabels);

  const scale = spec._derived?.diag ?? 1000;
  const entries = [];

  for (const d of spec.annotations?.dimensions ?? []) {
    const { seg, mid } = dimensionSegments(d.from, d.to, d.offset ?? [0, 0, 0], scale);
    if (!seg.length) continue;

    const line = makeLine(seg, { color: PALETTE.dim, width: 1.1 });
    group.add(line);

    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('class', 'dimlabel');
    text.textContent = d.label;
    gLabels.appendChild(text);

    entries.push({ spec: d, line, text, mid });
  }

  /* ------------------------------------------------------------- datums */

  const datumGroup = new THREE.Group();
  datumGroup.name = 'datums';
  parent.add(datumGroup);

  const b = spec.bounds;
  const reach = Math.max(b.length, b.width) * 0.72;
  const autoDatums = [
    // centreline along the length, and across the width, both on the ground datum
    [[-reach, 0, 0], [reach, 0, 0]],
    [[0, 0, -reach], [0, 0, reach]],
  ];
  for (const dd of spec.datums ?? []) {
    const at = dd.at ?? 0;
    if (dd.plane === 'xy') autoDatums.push([[-reach, at, 0], [reach, at, 0]]);
    else if (dd.plane === 'zx') autoDatums.push([[-reach, at, 0], [reach, at, 0]]);
    else autoDatums.push([[0, at, -reach], [0, at, reach]]);
  }

  const datumSeg = [];
  for (const [p, q] of autoDatums) datumSeg.push(...p, ...q);
  const datumLine = makeLine(datumSeg, {
    color: PALETTE.datum, width: 1.0,
    dashed: true, dashSize: scale * 0.045, gapSize: scale * 0.018,
  });
  datumLine.material.opacity = 0.85;
  datumGroup.add(datumLine);
  datumGroup.visible = false;

  const _v = new THREE.Vector3();

  return {
    group, datumGroup,

    /**
     * World bounds of the dimension geometry. The camera fit has to include
     * these or a dimension that stands well off the part runs off the sheet.
     * Datums are deliberately excluded — they are meant to run to the edges.
     */
    bounds() {
      group.updateMatrixWorld(true);
      return entries.length ? new THREE.Box3().setFromObject(group) : null;
    },

    /** Datum centrelines only appear on the orthographic plates. */
    setDatumsVisible(on) { datumGroup.visible = !!on; },

    setResolution(w, h) {
      for (const e of entries) e.line.material.resolution.set(w, h);
      datumLine.material.resolution.set(w, h);
    },

    /**
     * @param {number} opacity - shared with the callout layer so the whole
     *   annotation set fades out and back in as one thing when the view moves.
     */
    update(w, h, opacity = 1) {
      const viewId = viewCtl?.currentId;
      gLabels.style.opacity = opacity.toFixed(3);
      datumLine.material.opacity = 0.85 * opacity;

      for (const e of entries) {
        const shown = (!e.spec.views?.length || e.spec.views.includes(viewId)) && opacity > 0.01;
        e.line.material.opacity = opacity;
        e.line.visible = shown;
        if (!shown) { e.text.style.display = 'none'; continue; }

        e.line.updateMatrixWorld(true);
        _v.copy(e.mid).applyMatrix4(e.line.matrixWorld).project(camera);
        const onScreen = _v.z > -1 && _v.z < 1;
        e.text.style.display = onScreen ? '' : 'none';
        if (!onScreen) continue;

        // Label stays horizontal — the reference never rotates dimension text.
        e.text.setAttribute('x', ((_v.x * 0.5 + 0.5) * w).toFixed(1));
        e.text.setAttribute('y', ((-_v.y * 0.5 + 0.5) * h).toFixed(1));
      }
    },
  };
}
