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

/** How long the drawing takes to slide clear of something covering it. */
const OFFSET_MS = 340;

const FOV_PERSP = 30;
const FOV_ORTHO = 2.2;
const TWEEN_MS = 900;

/** See the cap in `update`: headroom for the orthographic/perspective mismatch. */
const FIT_CEILING = 0.93;

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const shortestAngle = (from, to) => from + (((to - from) % 360) + 540) % 360 - 180;

export function createViewController(camera, spec, { sceneDiag = 10, bbox = null } = {}) {
  const views = spec.views ?? [];
  const scale = spec._derived?.sceneScale ?? 1;

  // Leaves room for the balloon gutters and the dimension run. Filling more of
  // the sheet than this pushes the annotation hard against the frame.
  const DEFAULT_FIT = 0.78;

  /**
   * How much of that margin is actually needed right now.
   *
   * The 0.78 above is not a taste; it is the width the gutters occupy. With the
   * numbering switched off there are no gutters, and the margin is holding back
   * a drawing for annotation that is not being drawn. 1 means "leave it all",
   * which is what a sheet showing its balloons asks for.
   */
  let fitGain = 1;

  /**
   * The part of the viewport something else is covering.
   *
   * A drawer rising over a phone's lower half hides the model, which sits
   * centred. Sliding the view up by a guessed constant got most of the way and
   * left the bottom of the subject behind the drawer's edge, because how much
   * to slide depends on how tall the drawer is and how tall the subject
   * projects — neither of which a constant knows.
   *
   * So the caller states what is covered and the framing follows: the drawing
   * is fitted to the band that is left AND centred in it. Both the camera and
   * its target move along the camera's own up vector, so scale, framing and
   * every projected annotation stay consistent with each other.
   */
  let safeTop = 0;
  let safeBottom = 0;
  /** Where the offset is easing from, and when it started. See `update`. */
  let offsetFrom = 0;
  let offsetAt = -1e9;

  /** The fraction of the viewport height the drawing may actually use. */
  const usable = () => Math.max(1 - safeTop - safeBottom, 0.12);
  /** How far up the screen the subject must sit to be centred in that band. */
  const wantOffset = () => 0.5 - (safeTop + usable() / 2);
  /** The eased value right now, so a change mid-ease starts from here. */
  const currentOffset = () => {
    const k = Math.min((performance.now() - offsetAt) / OFFSET_MS, 1);
    return offsetFrom + (wantOffset() - offsetFrom) * easeInOut(k);
  };

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
  function fitDistance(az, el, fov, target, fit, heightFrac) {
    const hFrac = heightFrac || 1;
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
    // The vertical term is measured against the band left over, not the whole
    // viewport — that is what stops the subject growing back into the drawer.
    const need = Math.max(halfH / (tanY * fit * hFrac), halfW / (tanY * aspect * fit));
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
    // Capped well short of 1. `fitDistance` measures the silhouette
    // ORTHOGRAPHICALLY — eight dot products onto the camera basis — while the
    // scene renders in perspective, so the near corner of a long subject lands
    // bigger than the estimate and the real extent overshoots `fit` by a few
    // per cent. At 0.78 that slack is invisible. Near 1 it is the difference
    // between a framed drawing and a cropped one.
    const fit = Math.min(state.fit * fitGain, FIT_CEILING) * state.zoom;
    const dist = fitDistance(state.az, state.el, state.fov, state.target, fit, usable()) * state.distMul;

    const el = Math.max(-89.5, Math.min(89.5, state.el)) * DEG;
    const az = state.az * DEG;
    const r = Math.cos(el) * dist;
    camera.position.set(
      state.target.x + Math.sin(az) * r,
      state.target.y + Math.sin(el) * dist,
      state.target.z + Math.cos(az) * r,
    );
    camera.lookAt(state.target);

    /*
       Eased over TIME, not per frame.

       A `+= (want - now) * k` each frame is a different duration on every
       machine — it converged in a third of a second here and was still a tenth
       short after nearly two seconds under a software renderer, which is how it
       first looked like the arithmetic was wrong rather than unfinished. The
       view tween above is measured against the clock for the same reason.
    */
    const want = wantOffset();
    const k = Math.min((performance.now() - offsetAt) / OFFSET_MS, 1);
    const offsetNow = offsetFrom + (want - offsetFrom) * easeInOut(k);

    /*
       The shift is applied to the PROJECTION, not to the camera.
    
       Translating a perspective camera sideways moves near points further
       across the screen than far ones, so a subject that spans depth does not
       shift by the amount asked for — it came out about a tenth short, which is
       exactly the sort of residue that gets "corrected" with a fudge factor.
       `setViewOffset` windows the frustum instead: every point moves by the
       same screen distance, by construction, and the projection matrix the
       annotation layer reads is the same one.
    */
    const VH = 1000;
    if (offsetNow !== 0) {
      const aspectNow = camera.aspect || 1.6;
      camera.setViewOffset(VH * aspectNow, VH, 0, offsetNow * VH, VH * aspectNow, VH);
    } else {
      camera.clearViewOffset();
    }

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

    /**
     * Give back the margin the annotation layer is not using. See `fitGain`.
     * Re-framing is continuous, so this takes effect over the next few frames
     * rather than jumping.
     */
    setFitGain(g) { fitGain = Math.max(1, Number(g) || 1); },

    /**
     * Declare what is covering the viewport, in fractions of its height, and
     * the drawing is fitted to and centred in what remains. Both default to 0,
     * which is the whole sheet and the behaviour every wide layout gets.
     */
    setSafeArea(top = 0, bottom = 0) {
      const clamp = (v) => Math.min(Math.max(Number(v) || 0, 0), 0.8);
      const nextTop = clamp(top);
      const nextBottom = clamp(bottom);
      if (nextTop === safeTop && nextBottom === safeBottom) return;
      // Start the ease from wherever it had got to, so a drawer closed halfway
      // through the last one does not jump.
      offsetFrom = currentOffset();
      offsetAt = performance.now();
      safeTop = nextTop;
      safeBottom = nextBottom;
    },
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
