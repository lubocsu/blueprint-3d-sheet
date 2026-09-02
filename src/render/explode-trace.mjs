/**
 * Explode traces.
 *
 * On a printed exploded assembly, every part is joined to the hole it came out
 * of by a thin broken line. Without them an exploded view is just a cloud of
 * components: you can see the pieces but not where any of them belongs. With
 * them the drawing reads as a disassembly instruction.
 *
 * One `LineSegments2` for the whole assembly, two vertices per part instance,
 * rewritten in place each frame. The line is drawn in world space and lives on
 * the scene root, so it does not inherit the model's framing transform twice.
 *
 * NOTE: this deliberately does not use the shared `lineMaterial()` cache. That
 * cache is keyed by weight/colour/opacity and hands the same object to every
 * caller — fine for static ink, wrong for anything whose opacity is animated,
 * because the fade would be applied to every other line sharing the key.
 */

import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { INK } from '../build/edges.mjs';

/** Below this the parts have barely moved and the traces are just clutter. */
const SHOW_AT = 0.12;
const FULL_AT = 0.45;

const _origin = new THREE.Vector3();
const _tip = new THREE.Vector3();
const _local = new THREE.Vector3();

/**
 * @param {Map} records  from buildAssembly
 * @returns {{object: THREE.Object3D, update(amount: number): void, material: LineMaterial}|null}
 */
export function createExplodeTrace(records) {
  // A part earns a trace only if it actually separates.
  const legs = [];
  for (const rec of records.values()) {
    const explodes = (rec.spec.channels ?? []).some((c) => c.type === 'explode');
    if (!explodes) continue;
    // Separation relative to the parent, which is what the channel applies —
    // see the inheritance note in channels.mjs.
    const full = rec.explodeFull ?? 0;
    if (full === 0) continue;
    for (const node of rec.nodes) legs.push({ rec, node, full });
  }
  if (!legs.length) return null;

  const flat = new Float32Array(legs.length * 6);
  const geometry = new LineSegmentsGeometry();
  geometry.setPositions(flat);

  const material = new LineMaterial({
    color: INK,
    linewidth: 0.9,
    worldUnits: false,
    dashed: true,
    dashSize: 5,
    gapSize: 4,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    alphaToCoverage: true,
  });
  const hasWin = typeof window !== 'undefined';
  material.resolution.set(hasWin ? window.innerWidth : 1920, hasWin ? window.innerHeight : 1080);

  const line = new LineSegments2(geometry, material);
  line.computeLineDistances();   // allocates the distance buffers once
  line.raycast = () => {};
  line.frustumCulled = false;
  line.renderOrder = 3;
  line.visible = false;
  line.name = 'explodeTrace';

  const startAttr = geometry.attributes.instanceStart;
  const endAttr = geometry.attributes.instanceEnd;
  const posData = startAttr.data;
  const posArr = posData.array;
  const distData = geometry.attributes.instanceDistanceStart.data;
  const distArr = distData.array;

  /** True while every ancestor is visible — a hidden part should not trail a line. */
  const shown = (o) => {
    for (let n = o; n; n = n.parent) if (!n.visible) return false;
    return true;
  };

  return {
    object: line,
    material,

    /**
     * Call after applyChannels and after the scene graph's world matrices are
     * up to date. Extension is read back from what the explode channel actually
     * applied (`rec.explodeOffset`) rather than recomputed from the driver, so
     * a bind like "apart * 0.5" traces the distance the part really travelled.
     */
    update() {
      // How far along the assembly is, taken from the part that moved most.
      let extent = 0;
      for (const { rec, full } of legs) {
        const off = rec.explodeOffset;
        if (off) extent = Math.max(extent, off.length() / full);
      }
      if (extent < SHOW_AT) { line.visible = false; return; }
      line.visible = true;
      material.opacity = 0.42 * Math.min((extent - SHOW_AT) / (FULL_AT - SHOW_AT), 1);

      for (let i = 0; i < legs.length; i++) {
        const { rec, node } = legs[i];
        const frame = node.parent ?? node;
        const j = i * 6;

        // Collapse to a zero-length segment rather than branching the draw:
        // nothing is rasterised and the buffer layout stays fixed.
        if (!shown(node) || !rec.explodeOffset) {
          for (let k = 0; k < 6; k++) posArr[j + k] = 0;
          continue;
        }

        // The rest position is the origin of the part's own frame; the tip is
        // that frame's origin plus the separation vector, both taken through the
        // parent's world matrix so a slewed turret's parts trail correctly.
        _origin.set(0, 0, 0).applyMatrix4(frame.matrixWorld);
        _tip.copy(_local.copy(rec.explodeOffset)).applyMatrix4(frame.matrixWorld);

        posArr[j] = _origin.x; posArr[j + 1] = _origin.y; posArr[j + 2] = _origin.z;
        posArr[j + 3] = _tip.x; posArr[j + 4] = _tip.y; posArr[j + 5] = _tip.z;
      }
      posData.needsUpdate = true;

      // Dash phase accumulates across segments, matching LineSegmentsGeometry's
      // own computeLineDistances — recomputed in place so nothing allocates.
      let run = 0;
      for (let i = 0, j = 0; i < legs.length; i++, j += 2) {
        _origin.fromBufferAttribute(startAttr, i);
        _tip.fromBufferAttribute(endAttr, i);
        distArr[j] = run;
        run += _origin.distanceTo(_tip);
        distArr[j + 1] = run;
      }
      distData.needsUpdate = true;
    },

    setResolution(w, h) { material.resolution.set(w, h); },
  };
}
