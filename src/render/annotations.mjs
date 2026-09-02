/**
 * SVG overlay: numbered balloons and their leader lines.
 *
 * Anchors track 3D points — in the reference the balloons re-arrange continuously
 * as the model orbits, which rules out baked-in positions. Each anchor is stored
 * in its part's *local* space, so a callout on the turret rides the turret when
 * it slews, then is re-projected every frame.
 *
 * Balloons snap to gutters (see `assignGutters`) and leaders leave them on a
 * horizontal shoulder, which is what gives the sheet its ordered look.
 *
 * Dimensions are NOT here — they are world-space geometry in `dimensions.mjs`.
 */

import * as THREE from 'three';

const SVG_NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

const BALLOON_R = 11;

/**
 * Balloons snap to four gutters rather than floating on a ring. Within a
 * vertical gutter every balloon shares an X; within a horizontal one they share
 * a Y. That shared coordinate is the whole point — it is what reads as
 * draughtsman's alignment instead of scatter.
 */
const GUTTER_MARGIN = 58;   // px from the sheet edge to the balloon centre
const GUTTER_PITCH_MIN = 30;
/** Hard floor on balloon-to-balloon spacing along a gutter. */
const MIN_SEPARATION = 27;
const GUTTER_PITCH_MAX = 64;

/**
 * A gutter is not one rigid line. Balloons sit in one of a few lanes stepped
 * out from the drawing, chosen by how far out the anchor itself is. Members of
 * a lane align exactly with each other — that is where the order comes from —
 * but the gutter as a whole has a stepped profile instead of a dead-straight
 * column, which is what the reference actually looks like.
 */
const LANE_STEP = 26;
const LANE_COUNT = 3;

/**
 * How much better another gutter must score before a balloon moves to it.
 * This is the single most important number for motion quality: at 0 the
 * balloons chatter between sides as the model turns; too high and they cling
 * to a gutter that no longer faces their anchor.
 */
const GUTTER_HYSTERESIS = 0.30;

/**
 * Balloon motion. The exponential approach keeps ordinary tracking tight
 * (a balloon following its anchor moves a couple of px a frame), while the
 * speed cap turns the occasional gutter change — a re-target of most of the
 * sheet's width — into a readable arc instead of a flick. Without the cap the
 * first frame of a re-seat eats a third of the distance.
 */
const GLIDE_RATE = 6.0;          // exponential approach, per second
const GLIDE_MAX_SPEED = 1500;    // px per second

/** Leaders leave the balloon on a horizontal shoulder before angling in. */
const SHOULDER_MIN = 46;
const SHOULDER_MAX = 108;
const SHOULDER_FRAC = 0.05;   // of sheet width, measured off the reference

/* ------------------------------------------------------------ gutter layout */

/** Subtract the panel bands from a gutter's usable run. */
function freeRuns(lo, hi, blocked) {
  const merged = blocked
    .map(([a, b]) => [Math.max(a, lo), Math.min(b, hi)])
    .filter(([a, b]) => b > a)
    .sort((p, q) => p[0] - q[0]);
  const out = [];
  let cur = lo;
  for (const [s, e] of merged) {
    if (s > cur) out.push([cur, s]);
    cur = Math.max(cur, e);
  }
  if (cur < hi) out.push([cur, hi]);
  return out.filter(([a, b]) => b - a > GUTTER_PITCH_MIN);
}

const runsLength = (runs) => runs.reduce((s, [a, b]) => s + (b - a), 0);

/** Map a distance measured along the concatenated free runs back to a coordinate. */
function alongRuns(runs, t) {
  let acc = 0;
  for (const [s, e] of runs) {
    const len = e - s;
    if (t <= acc + len) return s + (t - acc);
    acc += len;
  }
  const last = runs[runs.length - 1];
  return last ? last[1] : 0;
}

/**
 * Assign every callout to one of four gutters and lay it out along that gutter.
 *
 * Three things are being balanced, in this order of importance:
 *
 *  1. MOTION. Everything here is recomputed every frame as the model turns, so
 *     the layout must be a continuous function of the anchors. Gutter choice is
 *     the one genuinely discrete decision, so it carries hysteresis; positions
 *     then glide rather than snap.
 *  2. NOT OCCLUDING THE DRAWING. Gutters sit outside the projected silhouette,
 *     so balloons never land on the model.
 *  3. ORDER WITHOUT RIGIDITY. Members are ordered by anchor position (which
 *     also stops leaders crossing — same order as their anchors means the
 *     diagonals cannot swap over), grouped into clusters by subsystem with a
 *     gap between clusters, and stepped into lanes by how deep the anchored
 *     feature sits. Balloons in a lane align exactly; the gutter as a whole is
 *     a staircase, not a rigid column.
 */
function assignGutters(live, centre, w, h, avoidRects, silh) {
  if (!live.length) return;

  // Gutters hug the drawing rather than the sheet edge. Parking them on the
  // frame is what produced leaders long enough to cross the whole page; the
  // reference keeps its balloons just clear of the silhouette.
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  const OFF = 46;
  const gx0 = clamp((silh ? silh.minX - OFF : GUTTER_MARGIN), GUTTER_MARGIN, w * 0.42);
  const gx1 = clamp((silh ? silh.maxX + OFF : w - GUTTER_MARGIN), w * 0.58, w - GUTTER_MARGIN);
  const gy0 = clamp((silh ? silh.minY - OFF * 0.8 : GUTTER_MARGIN), GUTTER_MARGIN, h * 0.34);
  const gy1 = clamp((silh ? silh.maxY + OFF * 0.8 : h - GUTTER_MARGIN), h * 0.66, h - GUTTER_MARGIN);

  const pad = 12;

  // Gutters stop short of the corners. Two balloons meeting where the top
  // gutter runs into the right one is a whole class of collision that no
  // per-gutter rule can see; keeping the runs apart makes it impossible instead
  // of something to detect and repair afterwards.
  const CORNER_PAD = MIN_SEPARATION + LANE_STEP * (LANE_COUNT - 1);
  const spans = {
    left:   { axis: 'y', sign: -1, coord: gx0, lo: gy0 + CORNER_PAD, hi: gy1 - CORNER_PAD },
    right:  { axis: 'y', sign:  1, coord: gx1, lo: gy0 + CORNER_PAD, hi: gy1 - CORNER_PAD },
    top:    { axis: 'x', sign: -1, coord: gy0, lo: gx0 + CORNER_PAD, hi: gx1 - CORNER_PAD },
    bottom: { axis: 'x', sign:  1, coord: gy1, lo: gx0 + CORNER_PAD, hi: gx1 - CORNER_PAD },
  };

  for (const [name, g] of Object.entries(spans)) {
    const blocked = [];
    for (const r of avoidRects) {
      if (g.axis === 'y') {
        if (g.coord >= r.left - pad && g.coord <= r.right + pad) blocked.push([r.top - pad, r.bottom + pad]);
      } else {
        if (g.coord >= r.top - pad && g.coord <= r.bottom + pad) blocked.push([r.left - pad, r.right + pad]);
      }
    }
    g.runs = freeRuns(g.lo, g.hi, blocked);
    g.capacity = Math.max(0, Math.floor(runsLength(g.runs) / GUTTER_PITCH_MIN));
    g.members = [];
  }

  // Score each gutter by how well it faces the anchor, then pick the best —
  // but with HYSTERESIS. Without it, a balloon sitting near the diagonal
  // flip-flops between two gutters as the model turns and jumps hundreds of
  // pixels every few frames. It only moves once another gutter is clearly
  // better, so rotation stays smooth.
  const NORMALS = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] };
  const names = Object.keys(NORMALS);

  for (const c of live) {
    const dx = c.anchor.x - centre.x;
    const dy = c.anchor.y - centre.y;
    const m = Math.hypot(dx, dy) || 1;
    const ux = dx / m, uy = dy / m;

    c._scores = {};
    for (const k of names) {
      const [nx, ny] = NORMALS[k];
      // a landscape sheet has more vertical run, so the side gutters hold more
      const bias = (k === 'left' || k === 'right') ? 1.18 : 1.0;
      c._scores[k] = (ux * nx + uy * ny) * bias;
    }

    const best = names.reduce((a, b) => (c._scores[b] > c._scores[a] ? b : a));
    const cur = c._gutter;
    c._want = (cur && c._scores[best] < c._scores[cur] + GUTTER_HYSTERESIS) ? cur : best;
  }

  const order = [...live].sort((p, q) => q._scores[q._want] - p._scores[p._want]);

  // Incumbency first. Gutter capacity moves around as the silhouette grows and
  // shrinks through a rotation, and without this a balloon that never changed
  // its own mind still gets bumped to another side because someone else won the
  // capacity race that frame. Sitting tenants keep their seat.
  for (const c of order) {
    c._seated = false;
    const g = c._gutter;
    if (!g || !spans[g]) continue;

    // Stay put unless you want to move AND there is room where you want to go.
    //
    // Requiring `_want === _gutter` to keep a seat is what made this oscillate:
    // a balloon displaced by capacity never became an incumbent, so every frame
    // it re-asked for its first choice, was refused, and was displaced again —
    // a period-2 cycle that never settles even with a stationary camera.
    const wantsMove = c._want !== g
      && spans[c._want].members.length < spans[c._want].capacity;
    if (!wantsMove && spans[g].members.length < spans[g].capacity) {
      spans[g].members.push(c);
      c._seated = true;
    }
  }

  for (const c of order) {
    if (c._seated) continue;
    let target = c._want;
    if (spans[target].members.length >= spans[target].capacity) {
      const alt = names
        .filter((k) => spans[k].members.length < spans[k].capacity)
        .sort((a, b) => c._scores[b] - c._scores[a])[0];
      if (alt) target = alt;
    }
    c._gutter = target;
    spans[target].members.push(c);
  }

  for (const g of Object.values(spans)) {
    const list = g.members;
    if (!list.length) continue;
    const L = runsLength(g.runs);
    if (L <= 0) continue;

    // order by the anchor's position along the gutter
    list.sort((p, q) => (g.axis === 'y' ? p.anchor.y - q.anchor.y : p.anchor.x - q.anchor.x));

    // Lane assignment: balloons pointing at deeper features step further out,
    // banded into thirds. Balloons sharing a band align exactly with each other
    // — that is where the order comes from — while the gutter as a whole gets a
    // staircase profile rather than one rigid line.
    const reachOf = (c) => (g.axis === 'y'
      ? Math.abs(c.anchor.x - centre.x)
      : Math.abs(c.anchor.y - centre.y));
    const sortedReach = list.map(reachOf).sort((p, q) => p - q);
    const at = (f) => sortedReach[Math.min(sortedReach.length - 1, Math.floor(f * sortedReach.length))] ?? 0;
    const band1 = at(1 / 3), band2 = at(2 / 3);
    // Deadband so a balloon sitting on a band edge doesn't step in and out of
    // its lane every frame as the thresholds drift with the rotation.
    const LANE_DEADBAND = 0.12;
    const laneOf = (c) => {
      if (list.length < 3) return 0;
      const r = reachOf(c);
      const prev = c._lane ?? 0;
      const up = (edge) => r > edge * (1 + LANE_DEADBAND);
      const down = (edge) => r < edge * (1 - LANE_DEADBAND);
      let lane = r > band2 ? 2 : (r > band1 ? 1 : 0);
      if (lane > prev && !up(lane === 2 ? band2 : band1)) lane = prev;
      if (lane < prev && !down(prev === 2 ? band2 : band1)) lane = prev;
      return lane;
    };
    const outward = g.sign;

    // Break the run into clusters of consecutive callouts belonging to the same
    // subsystem. The gaps between clusters are what stop the gutter reading as
    // one undifferentiated line of balloons — and because the grouping follows
    // the part's own `group`, the spacing tells you something.
    const clusters = [];
    for (const c of list) {
      const grp = c.rec.spec.group ?? '';
      const last = clusters[clusters.length - 1];
      if (last && last.group === grp) last.items.push(c);
      else clusters.push({ group: grp, items: [c] });
    }

    const n = list.length;
    let pitch = GUTTER_PITCH_MAX;
    let gap = pitch * 0.85;                       // extra space between clusters
    let total = pitch * (n - 1) + gap * (clusters.length - 1);
    if (total > L) {
      // Crowded: shrink pitch and gap together so the block lands exactly in
      // the run. Clamping to a minimum here instead would let the block run
      // past the end, where `alongRuns` pins everything to the last coordinate
      // and the balloons pile on top of one another.
      const k = L / total;
      pitch *= k;
      gap *= k;
      total = L;
    }

    // Desired position of each member, measured along the CONCATENATED free
    // runs. Staying in run-space until the very end is what guarantees no
    // balloon can be nudged into the band a panel occupies — those bands simply
    // do not exist in this coordinate.
    let cursor = Math.max(0, (L - total) / 2);
    const seq = [];
    clusters.forEach((cl, ci) => {
      cl.items.forEach((c, ii) => {
        seq.push({ c, t: cursor });
        if (ii < cl.items.length - 1) cursor += pitch;
      });
      if (ci < clusters.length - 1) cursor += pitch + gap;   // the cluster break
    });

    // Enforce minimum separation directly rather than trusting the arithmetic
    // above to imply it. Fragmented runs and shrunken cluster gaps can both land
    // two balloons on top of each other; a monotone push-apart fixes that
    // without reordering anyone, so leaders still cannot cross.
    for (let i = 1; i < seq.length; i++) {
      seq[i].t = Math.max(seq[i].t, seq[i - 1].t + MIN_SEPARATION);
    }
    for (let i = seq.length - 2; i >= 0; i--) {
      seq[i].t = Math.min(seq[i].t, seq[i + 1].t - MIN_SEPARATION);
    }
    const overshoot = seq[seq.length - 1].t - L;
    if (overshoot > 0) for (const s of seq) s.t -= overshoot;
    const under = -seq[0].t;
    if (under > 0) for (const s of seq) s.t += under;
    for (const s of seq) s.along = alongRuns(g.runs, Math.min(Math.max(s.t, 0), L));

    const hits = (cx, cy) => avoidRects.some((r) =>
      cx > r.left - 6 && cx < r.right + 6 && cy > r.top - 6 && cy < r.bottom + 6);

    for (const { c, along } of seq) {
      let lane = laneOf(c);
      // Lanes step outward, i.e. toward the sheet edge — which is exactly where
      // the panels live. Fall back inward rather than park on the legend.
      let coord = g.coord + outward * lane * LANE_STEP;
      while (lane > 0) {
        const px = g.axis === 'y' ? coord : along;
        const py = g.axis === 'y' ? along : coord;
        if (!hits(px, py)) break;
        lane -= 1;
        coord = g.coord + outward * lane * LANE_STEP;
      }
      c._lane = lane;
      if (g.axis === 'y') c.target.set(coord, along);
      else c.target.set(along, coord);
    }
  }

  // No screen-space repair pass, no corner pass, no panel nudge. Placement
  // happens once, in run-space, where the panel bands do not exist and the
  // monotone separation is exact; the corner padding above removes the only
  // collision run-space cannot see. Stacking repair passes on top of each other
  // is what made this oscillate — each one undid the last.

}

export function createAnnotations(svg, spec, ctx) {
  const { records, inner, camera, canvas } = ctx;

  const callouts = [];

  const gLead = svgEl('g');
  const gBal = svgEl('g');
  svg.append(gLead, gBal);

  /* ------------------------------------------------------------- callouts */
  for (const c of spec.annotations?.callouts ?? []) {
    const rec = records.get(c.anchor);
    if (!rec) continue;

    // The authored `point` is a HINT about where on the part to attach, not a
    // hard coordinate — the solver picks a real surface point near it and
    // re-picks as the viewpoint changes. It is resolved into the part's STATIC
    // frame (above the animation channels) so a spinning wheel or a stroking
    // piston never drags its leader around.
    const idx = Math.min(Math.max(c.instance ?? 0, 0), rec.nodes.length - 1);
    const staticFrame = rec.nodes[idx].parent;
    staticFrame.updateMatrixWorld(true);
    const hintWorld = inner.localToWorld(new THREE.Vector3(...c.point));
    const hintLocal = staticFrame.worldToLocal(hintWorld.clone());

    const leader = svgEl('path', { class: 'leader' });
    const dot = svgEl('circle', { class: 'anchorDot', r: 2.2 });
    const circle = svgEl('circle', { class: 'balloon', r: BALLOON_R });
    const label = svgEl('text', { class: 'bnum' });
    label.textContent = String(c.n);
    gLead.append(leader, dot);
    gBal.append(circle, label);

    // How far from the hint the solver may wander. A derived hint (normalize
    // guessed it) gets a loose leash; an authored one gets a tight one.
    rec.localBox.getBoundingSphere(new THREE.Sphere());
    const hintRadius = Math.max(rec.localBox.getSize(new THREE.Vector3()).length() * 0.5, 1);

    callouts.push({
      spec: c, rec,
      hintLocal, hintWorld,
      hintWorldValid: !c._pointDerived,
      hintRadius: c._pointDerived ? hintRadius * 2.5 : hintRadius,
      chosen: null,
      leader, dot, circle, label,
      instance: idx,
      inLayout: false,
      pos: null, target: new THREE.Vector2(),
    });
  }

  // Dimensions live in `render/dimensions.mjs` — they are world-space geometry
  // now, not an SVG overlay, so nothing for this module to build.

  /* ----------------------------------------------------------------- state */
  const raycaster = new THREE.Raycaster();
  let frame = 0;
  let hotPart = null;
  const _v = new THREE.Vector3();
  const _c = new THREE.Vector3();

  /** Rects the balloons should keep clear of, refreshed on resize. */
  let avoidRects = [];
  function refreshAvoid() {
    avoidRects = ['#key', '#instr', '#titleblock', '#console']
      .map((sel) => document.querySelector(sel))
      .filter(Boolean)
      .map((n) => n.getBoundingClientRect());
  }
  refreshAvoid();

  function project(v, w, h) {
    _v.copy(v).project(camera);
    return { x: (_v.x * 0.5 + 0.5) * w, y: (-_v.y * 0.5 + 0.5) * h, z: _v.z };
  }

  /* --------------------------------------------------------- solve / draw */

  /**
   * The layout is SOLVED, not tracked.
   *
   * Every operation that changes the picture — a view switch, a motion toggle,
   * an orbit drag, a wheel zoom, a resize — bumps an activity clock. While the
   * clock is hot the annotation layer fades out and holds still. Once the
   * picture has been quiet for `SETTLE_MS` the whole layout is re-solved once
   * (fresh surface anchors, fresh gutter assignment, fresh placement) and fades
   * back in.
   *
   * This is what "延迟生成" buys: nothing sweeps across the drawing while the
   * user is moving it, and the result is adapted to wherever they stopped.
   */
  const SETTLE_MS = 400;
  const FADE_RATE = 9;

  let lastActivity = -1e9;
  let needsSolve = true;
  let opacity = 0;

  const _camPos = new THREE.Vector3();
  const _wp = new THREE.Vector3();
  const _wn = new THREE.Vector3();
  const _toCam = new THREE.Vector3();

  /** The frame a part occupies BEFORE its animation channels run. */
  const staticFrameOf = (c) =>
    (c.rec.nodes[c.instance] ?? c.rec.nodes[0]).parent;

  /** World position of a stored local anchor, carrying any explode offset. */
  function anchorWorld(c, out) {
    const frame = staticFrameOf(c);
    frame.updateMatrixWorld(true);
    out.copy(c.chosen ?? c.hintLocal).applyMatrix4(frame.matrixWorld);
    // Leaders ignore spin and reciprocation but must follow a part that has
    // been separated for inspection.
    const off = c.rec.explodeOffset;
    if (off) out.add(off);
    return out;
  }

  /**
   * Choose the surface point the leader should come out of.
   *
   * Candidates were sampled off the real geometry at build time, so the chosen
   * point is genuinely ON the component. Re-choosing each solve is what makes
   * the exit point slide around the part as the viewpoint changes.
   */
  function pickAnchor(c, w, h, centre, gutterDir) {
    const cands = c.rec.anchors;
    if (!cands?.length) return c.hintLocal.clone();

    const frame = staticFrameOf(c);
    frame.updateMatrixWorld(true);
    camera.getWorldPosition(_camPos);

    let best = null;
    let bestScore = -Infinity;
    for (const cand of cands) {
      _wp.copy(cand.p).applyMatrix4(frame.matrixWorld);
      _wn.copy(cand.n).transformDirection(frame.matrixWorld);
      _toCam.copy(_camPos).sub(_wp).normalize();

      const facing = _wn.dot(_toCam);
      if (facing < 0.12) continue;                 // pointing away from us

      const sp = project(_wp, w, h);
      if (sp.z <= -1 || sp.z >= 1) continue;

      // Favour the side of the part the balloon will sit on, so the leader is
      // short and does not cut back across the body.
      let dirScore = 0;
      if (gutterDir) {
        const dx = sp.x - centre.x, dy = sp.y - centre.y;
        const len = Math.hypot(dx, dy) || 1;
        dirScore = (dx / len) * gutterDir.x + (dy / len) * gutterDir.y;
      }

      // An authored `point` is a hint about WHERE ON THE PART to attach, not a
      // hard coordinate — stay in its neighbourhood but still slide.
      const hintPull = c.hintWorldValid
        ? -_wp.distanceTo(c.hintWorld) / (c.hintRadius || 1)
        : 0;

      const score = facing * 0.9 + dirScore * 1.1 + hintPull * 0.8;
      if (score > bestScore) { bestScore = score; best = cand; }
    }
    return best ? best.p.clone() : c.hintLocal.clone();
  }

  const GUTTER_DIRS = {
    left: { x: -1, y: 0 }, right: { x: 1, y: 0 },
    top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 },
  };

  function solve(w, h) {
    const centre = project(_c.setFromMatrixPosition(inner.matrixWorld), w, h);

    let silh = null;
    if (ctx.bbox) {
      const b = ctx.bbox;
      silh = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
      for (const x of [b.min.x, b.max.x]) {
        for (const y of [b.min.y, b.max.y]) {
          for (const z of [b.min.z, b.max.z]) {
            const p = project(_v.set(x, y, z), w, h);
            silh.minX = Math.min(silh.minX, p.x); silh.maxX = Math.max(silh.maxX, p.x);
            silh.minY = Math.min(silh.minY, p.y); silh.maxY = Math.max(silh.maxY, p.y);
          }
        }
      }
    }

    const live = [];
    for (const c of callouts) {
      const node = c.rec.nodes[c.instance] ?? c.rec.nodes[0];
      const shown = node.visible && (c.rec.holders[c.instance]?.visible !== false);
      if (!shown) { c.inLayout = false; continue; }

      // Pass 1: pick an anchor knowing only which way it faces, so the gutter
      // assignment has something real to work from.
      c.chosen = pickAnchor(c, w, h, centre, null);
      anchorWorld(c, _v);
      const a = project(_v, w, h);
      if (a.z <= -1 || a.z >= 1) { c.inLayout = false; continue; }

      c.inLayout = true;
      c.anchor = a;
      live.push(c);
    }

    if (!live.length) return;

    assignGutters(live, centre, w, h, avoidRects, silh);

    // Pass 2: now that each callout knows which side it will live on, re-pick
    // the exit point to face that side.
    for (const c of live) {
      c.chosen = pickAnchor(c, w, h, centre, GUTTER_DIRS[c._gutter] ?? null);
      anchorWorld(c, _v);
      c.anchor = project(_v, w, h);
    }
    assignGutters(live, centre, w, h, avoidRects, silh);

    // Snap: we are invisible at this moment, so there is nothing to glide.
    for (const c of live) c.pos = new THREE.Vector2(c.target.x, c.target.y);

    // Occlusion is judged once here rather than every frame.
    for (const c of live) {
      anchorWorld(c, _v);
      raycaster.set(camera.position, _v.clone().sub(camera.position).normalize());
      const hits = raycaster.intersectObjects(ctx.pickables, false);
      const first = hits.find((hh) => hh.object.visible);
      const dist = camera.position.distanceTo(_v);
      c.occluded = !!first && first.distance < dist - dist * 0.02
                   && first.object.userData.partId !== c.spec.anchor;
    }
  }

  function draw(w, h) {
    const shoulder = Math.min(Math.max(w * SHOULDER_FRAC, SHOULDER_MIN), SHOULDER_MAX);

    for (const c of callouts) {
      const show = c.inLayout && c.pos;
      for (const el of [c.leader, c.dot, c.circle, c.label]) {
        el.style.display = show ? '' : 'none';
      }
      if (!show) continue;

      // Re-project the anchor every frame: the balloon is parked, but the part
      // it points at may still be travelling (an explode easing open).
      anchorWorld(c, _v);
      const a = project(_v, w, h);
      const bx = c.pos.x, by = c.pos.y;

      const dirX = (a.x - bx) >= 0 ? 1 : -1;
      const reach = Math.abs(a.x - bx) - BALLOON_R;
      const sh = Math.min(shoulder, Math.max(reach * 0.55, 0));
      const sx = bx + dirX * BALLOON_R;

      if (sh < 10 || Math.abs(a.y - by) < 6) {
        const ll = Math.hypot(a.x - bx, a.y - by) || 1;
        c.leader.setAttribute('d',
          `M ${(bx + ((a.x - bx) / ll) * BALLOON_R).toFixed(1)} ${(by + ((a.y - by) / ll) * BALLOON_R).toFixed(1)} ` +
          `L ${a.x.toFixed(1)} ${a.y.toFixed(1)}`);
      } else {
        const kx = sx + dirX * sh;
        c.leader.setAttribute('d',
          `M ${sx.toFixed(1)} ${by.toFixed(1)} L ${kx.toFixed(1)} ${by.toFixed(1)} ` +
          `L ${a.x.toFixed(1)} ${a.y.toFixed(1)}`);
      }

      c.dot.setAttribute('cx', a.x.toFixed(1));
      c.dot.setAttribute('cy', a.y.toFixed(1));
      c.circle.setAttribute('cx', bx.toFixed(1));
      c.circle.setAttribute('cy', by.toFixed(1));
      c.label.setAttribute('x', bx.toFixed(1));
      c.label.setAttribute('y', by.toFixed(1));

      const hot = hotPart != null && c.spec.anchor === hotPart;
      c.leader.setAttribute('class', `leader${c.occluded ? ' occ' : ''}${hot ? ' hot' : ''}`);
      c.dot.setAttribute('class', `anchorDot${hot ? ' hot' : ''}`);
      c.circle.setAttribute('class', `balloon${hot ? ' hot' : ''}`);
      c.label.setAttribute('class', `bnum${hot ? ' hot' : ''}`);
    }
  }

  return {
    refreshAvoid,
    callouts,

    setHot(partId) { hotPart = partId; },

    /** Something changed the picture: fade out, freeze, re-solve when quiet. */
    bump() { lastActivity = performance.now(); needsSolve = true; },

    get opacity() { return opacity; },

    update(w, h, dt = 1 / 60) {
      frame++;

      const view = ctx.viewCtl?.current ?? null;
      const suppressed = view?.callouts === false;

      // A view tween counts as activity for as long as it runs.
      if (ctx.viewCtl?.tweening) lastActivity = performance.now();

      const quiet = performance.now() - lastActivity > SETTLE_MS;
      if (quiet && needsSolve) { solve(w, h); needsSolve = false; }

      const want = (quiet && !suppressed) ? 1 : 0;
      opacity += (want - opacity) * (1 - Math.exp(-FADE_RATE * Math.min(dt, 0.1)));
      if (opacity < 0.002) opacity = 0;
      svg.style.opacity = opacity.toFixed(3);

      if (opacity > 0) draw(w, h);
    },
  };
}
