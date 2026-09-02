/**
 * Named views and the camera that serves them.
 *
 * There is one perspective camera. "Orthographic" views are reached by tweening
 * the FOV down to a couple of degrees while pulling the camera back to keep the
 * framing constant — a dolly zoom that converges on a parallel projection.
 *
 * The alternative, swapping in a real OrthographicCamera, pops on the frame it
 * switches. The reference film clearly eases straight through the transition
 * (frames caught mid-move still read as perspective), so it can't be doing that.
 */

import * as THREE from 'three';

const DEG = Math.PI / 180;

const FOV_PERSP = 30;
const FOV_ORTHO = 2.2;
const TWEEN_MS = 900;

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const shortestAngle = (from, to) => from + (((to - from) % 360) + 540) % 360 - 180;

export function createViewController(camera, spec, { sceneDiag = 10, bbox = null } = {}) {
  const views = spec.views ?? [];
  const scale = spec._derived?.sceneScale ?? 1;

  // Leaves room for the balloon gutters and the dimension run. Filling more of
  // the sheet than this pushes the annotation hard against the frame.
  const DEFAULT_FIT = 0.78;

  // The eight corners of the fit bounding box. Projecting these onto the
  // camera's basis gives the exact on-screen extent for any view direction,
  // which is what lets a plan view of a long vehicle fill the sheet instead of
  // being framed for its diagonal.
  let corners = [];
  let boxCentre = new THREE.Vector3();

  function setFitBounds(box) {
    corners = [];
    if (!box) return;
    for (const x of [box.min.x, box.max.x]) {
      for (const y of [box.min.y, box.max.y]) {
        for (const z of [box.min.z, box.max.z]) corners.push(new THREE.Vector3(x, y, z));
      }
    }
    boxCentre.addVectors(box.min, box.max).multiplyScalar(0.5);
  }
  setFitBounds(bbox);
  if (!bbox) boxCentre.set(0, (spec._derived?.modelHeightScene ?? sceneDiag * 0.35) * 0.45, 0);

  const _fwd = new THREE.Vector3();
  const _right = new THREE.Vector3();
  const _up = new THREE.Vector3();
  const _rel = new THREE.Vector3();
  const WORLD_UP = new THREE.Vector3(0, 1, 0);

  /** Distance at which the projected silhouette fills `fit` of the viewport. */
  function fitDistance(az, el, fov, target, fit) {
    const fallback = sceneDiag * 0.62 / Math.tan((fov / 2) * DEG);
    if (!corners.length) return fallback;

    const e = el * DEG, a = az * DEG;
    _fwd.set(Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)).normalize();
    _right.crossVectors(WORLD_UP, _fwd);
    if (_right.lengthSq() < 1e-8) _right.set(1, 0, 0);
    _right.normalize();
    _up.crossVectors(_fwd, _right).normalize();

    let halfW = 0, halfH = 0;
    for (const c of corners) {
      _rel.copy(c).sub(target);
      halfW = Math.max(halfW, Math.abs(_rel.dot(_right)));
      halfH = Math.max(halfH, Math.abs(_rel.dot(_up)));
    }

    const tanY = Math.tan((fov / 2) * DEG);
    const aspect = camera.aspect || 1.6;
    const need = Math.max(halfH / (tanY * fit), halfW / (tanY * aspect * fit));
    return Math.max(need, sceneDiag * 0.02);
  }

  const state = {
    az: views[0]?.az ?? 38,
    el: views[0]?.el ?? 22,
    fov: FOV_PERSP,
    zoom: 1,
    fit: DEFAULT_FIT,
    target: new THREE.Vector3(0, 0, 0),
    distMul: 1,
  };

  let tween = null;
  let currentId = views[0]?.id ?? null;

  // Framing is symmetric about the fit box centre — anything else wastes
  // viewport on one side.
  const targetFor = (v) => {
    if (!v.target) return boxCentre.clone();
    return new THREE.Vector3(0, (v.target[1] ?? 0) * scale, 0);
  };

  function applyImmediate(v) {
    state.az = v.az;
    state.el = v.el;
    state.fov = v.projection === 'orthographic' ? FOV_ORTHO : FOV_PERSP;
    state.distMul = v.dist ?? 1;
    state.fit = v.fit ?? DEFAULT_FIT;
    state.target.copy(targetFor(v));
    currentId = v.id;
  }

  if (views[0]) applyImmediate(views[0]);

  function setView(id, { instant = false } = {}) {
    const v = views.find((x) => x.id === id);
    if (!v) return null;
    if (instant) { applyImmediate(v); tween = null; return v; }
    tween = {
      t0: performance.now(),
      from: {
        az: state.az, el: state.el, fov: state.fov,
        distMul: state.distMul, fit: state.fit, target: state.target.clone(),
      },
      to: {
        az: shortestAngle(state.az, v.az),
        el: v.el,
        fov: v.projection === 'orthographic' ? FOV_ORTHO : FOV_PERSP,
        distMul: v.dist ?? 1,
        fit: v.fit ?? DEFAULT_FIT,
        target: targetFor(v),
      },
      view: v,
    };
    currentId = v.id;
    return v;
  }

  function update() {
    if (tween) {
      const k = Math.min((performance.now() - tween.t0) / TWEEN_MS, 1);
      const e = easeInOut(k);
      const f = tween.from, t = tween.to;
      state.az = f.az + (t.az - f.az) * e;
      state.el = f.el + (t.el - f.el) * e;
      state.fov = f.fov + (t.fov - f.fov) * e;
      state.distMul = f.distMul + (t.distMul - f.distMul) * e;
      state.fit = f.fit + (t.fit - f.fit) * e;
      state.target.lerpVectors(f.target, t.target, e);
      if (k >= 1) tween = null;
    }

    // Re-fit every frame: it is eight dot products, and doing it continuously
    // means the framing stays correct through a tween, an orbit and a resize
    // without any invalidation bookkeeping.
    const fit = state.fit * state.zoom;
    const dist = fitDistance(state.az, state.el, state.fov, state.target, fit) * state.distMul;

    const el = Math.max(-89.5, Math.min(89.5, state.el)) * DEG;
    const az = state.az * DEG;
    const r = Math.cos(el) * dist;
    camera.position.set(
      state.target.x + Math.sin(az) * r,
      state.target.y + Math.sin(el) * dist,
      state.target.z + Math.cos(az) * r,
    );
    camera.lookAt(state.target);

    camera.fov = state.fov;
    // Hug the subject so depth precision survives the very long distances the
    // near-orthographic FOV demands.
    const span = sceneDiag * 1.2;
    camera.near = Math.max(dist - span, dist * 0.002);
    camera.far = dist + span;
    camera.updateProjectionMatrix();
  }

  return {
    state,
    views,
    setView,
    update,
    setFitBounds,
    get currentId() { return currentId; },
    get current() { return views.find((v) => v.id === currentId) ?? null; },
    get isOrtho() { return state.fov < (FOV_PERSP + FOV_ORTHO) / 2; },
    get tweening() { return tween !== null; },
    /** user orbit cancels any running tween */
    nudge(dAz, dEl) {
      tween = null;
      state.az -= dAz;
      state.el = Math.max(-89, Math.min(89, state.el + dEl));
    },
    zoomBy(f) {
      tween = null;
      state.zoom = Math.min(Math.max(state.zoom * f, 0.25), 6);
    },
  };
}

export { FOV_PERSP, FOV_ORTHO, TWEEN_MS };
