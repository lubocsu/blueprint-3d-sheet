/**
 * Constant-width ink lines.
 *
 * The reference draws every crease at the same pixel width regardless of depth,
 * with a slightly heavier outer contour. `LineSegments2` gives exactly that —
 * screen-space width, retina-correct, no post-process pass and no depth-buffer
 * precision games.
 */

import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';

export const INK = 0x1b2745;

/** Line weights, in CSS pixels, keyed by the part's `outline` setting. */
export const WEIGHTS = { heavy: 2.2, normal: 1.5, light: 1.0, none: 0 };

const materialCache = new Map();

/**
 * LineMaterials are shared per weight so a resize only has to touch a handful
 * of `resolution` uniforms instead of one per part.
 */
export function lineMaterial(weight, { color = INK, opacity = 1, dashed = false } = {}) {
  const key = `${weight}|${color}|${opacity}|${dashed}`;
  if (materialCache.has(key)) return materialCache.get(key);
  const m = new LineMaterial({
    color,
    linewidth: weight,
    worldUnits: false,
    dashed,
    dashSize: 6,
    gapSize: 4,
    transparent: opacity < 1,
    opacity,
    alphaToCoverage: true,
  });
  const hasWin = typeof window !== 'undefined';
  m.resolution.set(hasWin ? window.innerWidth : 1920, hasWin ? window.innerHeight : 1080);
  materialCache.set(key, m);
  return m;
}

export function allLineMaterials() {
  return [...materialCache.values()];
}

export function setLineResolution(w, h) {
  for (const m of materialCache.values()) m.resolution.set(w, h);
}

/**
 * Extract creases from a geometry and return a drawable line object.
 * @param {THREE.BufferGeometry} geometry
 * @param {number} thresholdAngle - degrees; edges sharper than this are drawn
 */
export function edgesFor(geometry, thresholdAngle = 25, weight = WEIGHTS.normal, opts = {}) {
  if (weight <= 0) return null;
  const eg = new THREE.EdgesGeometry(geometry, thresholdAngle);
  const pos = eg.attributes.position;
  if (!pos || pos.count === 0) { eg.dispose(); return null; }

  const lg = new LineSegmentsGeometry();
  lg.setPositions(Array.from(pos.array));
  eg.dispose();

  const line = new LineSegments2(lg, lineMaterial(weight, opts));
  line.computeLineDistances();
  line.raycast = () => {};      // lines never participate in hover picking
  line.renderOrder = 2;
  return line;
}

/** Build a line object from explicit segment pairs (engraved detail lines). */
export function linesFromSegments(segments, weight = WEIGHTS.light, opts = {}) {
  if (!segments?.length || weight <= 0) return null;
  const flat = [];
  for (const [a, b] of segments) flat.push(a[0], a[1], a[2], b[0], b[1], b[2]);
  const lg = new LineSegmentsGeometry();
  lg.setPositions(flat);
  const line = new LineSegments2(lg, lineMaterial(weight, opts));
  line.computeLineDistances();
  line.raycast = () => {};
  line.renderOrder = 2;
  return line;
}
