/**
 * Page entry point.
 *
 * Reads the spec that `emit` inlined into the page, then wires stage ->
 * assembly -> runtime -> chrome -> annotations. Nothing here knows what the
 * subject is.
 */

import * as THREE from 'three';
import { normalizeSpec } from '../spec/normalize.mjs';
import { buildAssembly } from '../build/assembly.mjs';
import { setLineResolution, lineMaterial, WEIGHTS } from '../build/edges.mjs';
import { createStage } from './scene.mjs';
import { makeHatchMaterial, makeSharedUniforms } from './hatch-material.mjs';
import { PALETTE } from './materials.mjs';
import { buildChrome } from './chrome.mjs';
import { createAnnotations } from './annotations.mjs';
import { createDimensions } from './dimensions.mjs';
import { createDrivers } from '../runtime/drivers.mjs';
import { bindChannels, applyChannels, setEmitterResolution } from '../runtime/channels.mjs';
import { createExplodeTrace } from './explode-trace.mjs';
import { createViewController } from '../runtime/views.mjs';
import { createInteraction } from '../runtime/interact.mjs';

const raw = window.__B2D_SPEC__;
if (!raw) throw new Error('no spec found on the page');

const spec = normalizeSpec(raw);

const sheet = document.getElementById('sheet');
const canvas = document.getElementById('stage');
const svg = document.getElementById('ann');

const shared = makeSharedUniforms({
  dpr: Math.min(window.devicePixelRatio || 1, 2),
  pitch: raw.style?.hatchPitch ?? 4.0,
  uniformHatch: (raw.style?.materialHatch ?? 'uniform') === 'uniform',
});

const stage = createStage(canvas, spec, shared);

/* ------------------------------------------------------------------ assembly */

const t0 = performance.now();
const { root, inner, records, pickables, stats, bbox } = buildAssembly(spec, (part) =>
  makeHatchMaterial(part, shared));
stage.scene.add(root);
stage.addShadow(root, raw.style?.shadow ?? 'projected');

const buildMs = performance.now() - t0;

const allMaterials = [...records.values()].map((r) => r.material);


/* ------------------------------------------------------------------- runtime */

const drivers = createDrivers(spec);
const bound = bindChannels(spec, records, stage.scene);

// Traces are drawn in world space, so they hang off the scene rather than the
// model root — otherwise they would inherit the framing transform twice. Built
// after bindChannels, which is what publishes each part's separation length.
const explodeTrace = spec._derived?.explodeTrace ? createExplodeTrace(records) : null;
if (explodeTrace) stage.scene.add(explodeTrace.object);
const viewCtl = createViewController(stage.camera, spec, { sceneDiag: stage.sceneDiag, bbox });

/**
 * How far the assembly has come apart, 0..1, read back from what the explode
 * channels actually applied. Used to widen the camera framing so a separating
 * model stays on the sheet — the fit box is built from the rest pose, so
 * without this an explode that genuinely opens up walks off the edge.
 */
const explodeRecs = [];
for (const rec of records.values()) {
  if (!(rec.spec.channels ?? []).some((c) => c.type === 'explode')) continue;
  const full = rec.explodeFull ?? 0;
  if (full > 0) explodeRecs.push({ rec, full });
}
function explodeExtent() {
  let m = 0;
  for (const { rec, full } of explodeRecs) {
    if (rec.explodeOffset) m = Math.max(m, rec.explodeOffset.length() / full);
  }
  return m;
}

/**
 * The extra envelope full separation adds, computed once. Separation is
 * deterministic — rest position plus the part's own explode vector — so the
 * exploded bounds are known up front and the camera can be framed for them
 * exactly. The alternative, re-measuring every part every frame, buys nothing
 * and costs a box transform per part per frame.
 */
const explodedSpan = (() => {
  if (!bbox || !explodeRecs.length) return null;
  stage.scene.updateMatrixWorld(true);
  const out = bbox.clone();
  const sceneScale = spec._derived?.sceneScale ?? 1;
  const shift = new THREE.Vector3();
  for (const { rec } of explodeRecs) {
    shift.set(...rec.spec.explode).multiplyScalar(sceneScale);
    for (const node of rec.nodes) {
      out.union(rec.localBox.clone().applyMatrix4(node.matrixWorld).translate(shift));
    }
  }
  return out;
})();

const partById = new Map(spec.parts.map((p) => [p.id, p]));
const calloutByPart = new Map();
for (const c of spec.annotations?.callouts ?? []) {
  if (!calloutByPart.has(c.anchor)) calloutByPart.set(c.anchor, c.n);
}

/* -------------------------------------------------------------------- chrome */

/** Everything a view switch implies, in one place. */
function applyView(v) {
  if (!v) return;
  const ortho = v.projection === 'orthographic';
  chrome.setActiveView(v.id);
  chrome.setCaption(v);
  chrome.setPlateMode(ortho);
  stage.setSection(v.section ?? null, allMaterials);
  // A view may imply a state — a section view that wants the internals shown,
  // a plate that wants the covers off. Motions still override it.
  drivers.setViewState(v.set ?? null);
  // Datum centrelines and the cast shadow are mutually exclusive: an elevation
  // plate gets centrelines, a perspective view gets the shadow.
  dimensions.setDatumsVisible(ortho);
  annotations.bump();
  // A plate is a flat drawing: no cast shadow, no perspective ground grid.
  if (stage.shadow) stage.shadow.visible = !ortho;
  if (stage.grid) stage.grid.visible = !ortho;
}

const chrome = buildChrome(sheet, spec, {
  onView: (id) => applyView(viewCtl.setView(id)),
  onMotion: (id) => {
    const m = spec.motions.find((x) => x.id === id);
    if (!m) return;
    drivers.toggle(m);
    chrome.setActiveMotions(drivers.activeIds());
    annotations.bump();
  },
});

const annotations = createAnnotations(svg, spec, {
  records, inner, camera: stage.camera, canvas, pickables, viewCtl, bbox,
});

const dimensions = createDimensions({
  parent: inner, svg, spec, camera: stage.camera, viewCtl,
});

// Re-fit the camera against model + dimensions together, and precompute the
// same box at full separation so EXPLODE can be framed by interpolating
// between the two rather than letting the assembly walk off the sheet.
const restFit = bbox.clone();
{
  const dimBox = dimensions.bounds();
  if (dimBox) restFit.union(dimBox);
  viewCtl.setFitBounds(restFit);
}
const explodedFit = explodedSpan ? explodedSpan.clone().union(restFit) : null;

// Rebuilding the fit corners allocates, so only redo it when the framing would
// visibly change; 0.005 of the separation is well under a pixel.
let framedAt = -1;
const _fitBox = new THREE.Box3();
function frameForExplode(extent) {
  if (!explodedFit) return;
  if (Math.abs(extent - framedAt) < 0.005) return;
  framedAt = extent;
  _fitBox.min.lerpVectors(restFit.min, explodedFit.min, extent);
  _fitBox.max.lerpVectors(restFit.max, explodedFit.max, extent);
  viewCtl.setFitBounds(_fitBox);
}

/* --------------------------------------------------------------- interaction */

let hoveredPart = null;

/**
 * Highlight is carried by the OUTLINE, not the fill. The reference reddens a
 * component's edges and leaves its hatching intact, which keeps the part
 * readable while it is being pointed at.
 */
function setPartHot(id, hot) {
  const r = records.get(id);
  if (!r) return;
  if (r.material?.uniforms?.uHighlight) r.material.uniforms.uHighlight.value = hot ? 1 : 0;
  for (const line of r.lines ?? []) {
    line.material = hot
      ? lineMaterial((r.weight ?? WEIGHTS.normal) + 0.7, { color: PALETTE.accent })
      : lineMaterial(r.weight ?? WEIGHTS.normal);
  }
}

const interaction = createInteraction(canvas, stage.camera, viewCtl, pickables, {
  onActivity: () => annotations.bump(),
  onHover: (id, prev) => {
    if (prev) setPartHot(prev, false);
    hoveredPart = id;
    if (id) setPartHot(id, true);
    chrome.setHotCallout(id ? (calloutByPart.get(id) ?? null) : null);
    annotations.setHot(id);
  },
});

/* --------------------------------------------------------------------- start */

const first = spec.views[0];
if (first) {
  viewCtl.setView(first.id, { instant: true });
  applyView(first);
}
chrome.setActiveMotions(drivers.activeIds());

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  stage.resize(w, h);
  setLineResolution(w, h);
  dimensions.setResolution(w, h);
  setEmitterResolution(w, h);
  explodeTrace?.setResolution(w, h);
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  annotations.refreshAvoid();
  annotations.bump();
}
window.addEventListener('resize', resize);
resize();

/* ------------------------------------------------------------------ mainloop */

let last = performance.now();
let elapsed = 0;
let frames = 0;
let fpsAccum = 0;
let fps = 60;

function tick(now) {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  elapsed += dt;

  fpsAccum += dt; frames++;
  if (fpsAccum >= 0.5) { fps = frames / fpsAccum; frames = 0; fpsAccum = 0; }

  const scope = drivers.update(dt, elapsed);
  scope.fps = fps;
  applyChannels(bound, scope, dt);

  frameForExplode(explodeExtent());
  viewCtl.update();
  interaction.update();

  stage.scene.updateMatrixWorld(true);
  stage.shadowUpdate?.();
  explodeTrace?.update();
  stage.renderer.render(stage.scene, stage.camera);

  annotations.update(window.innerWidth, window.innerHeight, dt);
  dimensions.update(window.innerWidth, window.innerHeight, annotations.opacity);
  chrome.updateInstruments(scope);
  chrome.showCard(hoveredPart ? partById.get(hoveredPart) : null,
                  interaction.pointer.x, interaction.pointer.y);

  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// Surfaced for the headless self-test, which drives views and motions directly.
window.__B2D__ = {
  spec, records, stage, drivers, viewCtl, chrome, stats, buildMs,
  // exposed for dev/anchor-check.mjs
  annotationCallouts: annotations.callouts,
  setView: (id) => {
    const v = viewCtl.setView(id, { instant: true });
    applyView(v);
    return v;
  },
  setMotion: (id, on = true) => {
    const m = spec.motions.find((x) => x.id === id);
    if (!m) return false;
    const isOn = drivers.isActive(id);
    if (isOn !== on) drivers.toggle(m);
    chrome.setActiveMotions(drivers.activeIds());
    return drivers.isActive(id);
  },
  clearMotions: () => { drivers.reset(); chrome.setActiveMotions([]); annotations.bump(); },
  /**
   * Test hooks for dev/explode-check.mjs. Reported per part in world space so
   * the checker can measure separation and reveal without knowing the node
   * layout.
   */
  partState: (id) => {
    const rec = records.get(id);
    if (!rec) return null;
    stage.scene.updateMatrixWorld(true);
    // One box PER INSTANCE. Unioning them would turn a ring of nine cylinders
    // into a box spanning the whole engine, which then trivially "encloses"
    // every part at the centre.
    const boxes = [];
    const all = new THREE.Box3();
    for (const node of rec.nodes) {
      let chainOk = true;
      for (let n = node; n; n = n.parent) if (!n.visible) { chainOk = false; break; }
      if (!chainOk) continue;
      // Transform this part's OWN geometry bounds. Child parts hang off
      // nodes[0], so expanding by the object tree would fold every descendant
      // into the parent's box and make the hull read as the whole tank.
      const b = rec.localBox.clone().applyMatrix4(node.matrixWorld);
      boxes.push([b.min.toArray(), b.max.toArray()]);
      all.union(b);
    }
    if (!boxes.length) return { visible: false, box: null, boxes: [] };
    return { visible: true, box: [all.min.toArray(), all.max.toArray()], boxes };
  },
  partIds: () => [...records.keys()],
  fitBoxes: () => ({
    rest: [restFit.min.toArray(), restFit.max.toArray()],
    exploded: explodedFit ? [explodedFit.min.toArray(), explodedFit.max.toArray()] : null,
    framedAt,
  }),
  explodeTraceVisible: () => Boolean(explodeTrace?.object.visible),
  /** Orbit exactly as a drag would, including the annotation activity bump. */
  orbit: (dAz, dEl = 0) => { viewCtl.nudge(dAz, dEl); annotations.bump(); },
  zoom: (f) => { viewCtl.zoomBy(f); annotations.bump(); },
  /** Fast-forward the simulation without waiting in real time. */
  advance: (seconds, step = 1 / 60) => {
    for (let s = 0; s < seconds; s += step) {
      elapsed += step;
      const sc = drivers.update(step, elapsed);
      sc.fps = 60;
      applyChannels(bound, sc, step);
    }
  },
  ready: true,
};

console.log(`[b2d] ${spec.meta.title}: ${stats.meshes} meshes, ${Math.round(stats.tris)} tris, ` +
            `${stats.merged} instances merged, built in ${buildMs.toFixed(0)} ms`);
