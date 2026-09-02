/**
 * The ten animation primitives.
 *
 * This is where the generality claim is actually cashed. A tank's DRIVE, a
 * radial engine's CYCLE, a car door's OPEN and a pump's STROKE are all the same
 * handful of channels bound to different drivers — no subject-specific code
 * exists anywhere in the runtime.
 *
 * Every channel writes *additively* onto the node's authored base transform, so
 * two channels on one part compose instead of fighting.
 */

import * as THREE from 'three';
import { compileExpr } from '../spec/expr.mjs';
import { PALETTE } from '../render/materials.mjs';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { lineMaterial, WEIGHTS } from '../build/edges.mjs';

const DEG = Math.PI / 180;
const AXIS = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };

/** Deterministic per-index noise, so smoke looks scattered but never re-rolls. */
function hash(i) {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

const num = (v, fallback = 0) => {
  if (typeof v === 'number') return v;
  return fallback;
};

/**
 * Prepare per-channel state and compile every expression once.
 * @returns {object[]} bound channel instances ready for `applyChannels`
 */
export function bindChannels(spec, records, scene) {
  const bound = [];

  const partById = new Map(spec.parts.map((p) => [p.id, p]));
  const explodeBind = (p) => {
    const ch = (p?.channels ?? []).find((c) => c.type === 'explode');
    return ch ? String(ch.bind) : null;
  };

  /**
   * The separation a part inherits from the sub-assembly it hangs off.
   *
   * Displacement is inherited through the scene graph: without compensation a
   * part five levels down receives its own offset plus all five ancestors', so
   * a modest separation turns into parts launched off the sheet. Subtracting
   * makes each part's WORLD displacement exactly its own `explode` vector, and
   * the assembly blooms evenly instead of compounding.
   *
   * Only the NEAREST separating ancestor is subtracted, not the whole chain:
   * by induction that ancestor's own total displacement is already just its own
   * vector, so subtracting its grandparents too would over-correct.
   *
   * Ancestors bound to a different expression are skipped — if an author has
   * deliberately given a sub-assembly its own explode driver the two motions
   * are independent and must not cancel.
   */
  const inheritedExplode = (part) => {
    const own = explodeBind(part);
    if (!own) return [0, 0, 0];
    for (let p = partById.get(part.parent); p; p = partById.get(p.parent)) {
      if (explodeBind(p) === own) return p.explode ?? [0, 0, 0];
    }
    return [0, 0, 0];
  };

  for (const part of spec.parts) {
    const rec = records.get(part.id);
    if (!rec) continue;

    for (const ch of part.channels ?? []) {
      const compile = (src, dflt) => {
        if (src == null) return () => dflt;
        if (typeof src === 'number') return () => src;
        try { return compileExpr(src).fn; }
        catch { return () => dflt; }
      };

      const inst = {
        type: ch.type,
        spec: ch,
        rec,
        bind: compile(ch.bind, 1),
        state: { angle: 0, envT: -1, particles: null, dash: 0 },
      };

      switch (ch.type) {
        case 'oscillate':
        case 'reciprocate':
        case 'articulate':
        case 'impulse':
          inst.channelName = ch.target.split('.')[0];      // pos | rot | scale
          inst.axis = ch.target.split('.')[1];             // x | y | z
          inst.amp = compile(ch.amp, 1);
          inst.freq = compile(ch.freq, 1);
          inst.phase = compile(ch.phase, 0);
          inst.stroke = compile(ch.stroke, 1);
          inst.from = compile(ch.from, 0);
          inst.to = compile(ch.to, 1);
          break;

        case 'spin':
          inst.vec = AXIS[ch.axis] ?? AXIS.y;
          break;

        case 'pathFollow': {
          const pts = (ch.path ?? []).map(([x, y, z]) => new THREE.Vector3(x, y, z));
          if (pts.length >= 2) {
            inst.curve = new THREE.CatmullRomCurve3(pts, ch.closed !== false, 'catmullrom', 0.0);
            inst.orient = ch.orient !== false;
          }
          break;
        }

        case 'explode': {
          // Convert the authored world-ish separation vector into the space the
          // node's transform actually lives in, or a rotated sub-assembly flies
          // off in the wrong direction.
          const own = part.explode ?? [0, 0, 0];
          const up = inheritedExplode(part);
          const v = new THREE.Vector3(own[0] - up[0], own[1] - up[1], own[2] - up[2]);
          const frame = rec.nodes[0].parent;
          frame.updateMatrixWorld(true);
          const basis = new THREE.Matrix4().extractRotation(frame.matrixWorld).invert();
          inst.offset = v.clone().applyMatrix4(basis);
          // Length at full separation, for consumers that need "how far along
          // is this" — the relative vector no longer matches part.explode.
          rec.explodeFull = v.length();
          break;
        }

        case 'emit': {
          inst.emitter = makeEmitter(ch, rec, scene);
          break;
        }

        case 'flow': {
          inst.flowLine = makeFlowLine(ch, rec);
          break;
        }
      }

      bound.push(inst);
    }
  }

  return bound;
}

/* ------------------------------------------------------------------ emitters */

const EMIT_MAX = 26;

/** Per-ring materials, so a resize can refresh their screen-space widths. */
const emitterMaterials = [];
export function setEmitterResolution(w, h) {
  for (const m of emitterMaterials) m.resolution.set(w, h);
}

function makeEmitter(ch, rec, scene) {
  // Expanding ink rings: line-art smoke/steam/exhaust in the drafting idiom.
  const rings = [];
  const group = new THREE.Group();
  const seg = 18;
  for (let i = 0; i < EMIT_MAX; i++) {
    const pts = [];
    for (let k = 0; k < seg; k++) {
      const a1 = (k / seg) * Math.PI * 2;
      const a2 = ((k + 1) / seg) * Math.PI * 2;
      pts.push(Math.cos(a1), Math.sin(a1), 0, Math.cos(a2), Math.sin(a2), 0);
    }
    const g = new LineSegmentsGeometry();
    g.setPositions(pts);
    // Each ring needs its OWN material: they fade independently, and
    // `lineMaterial()` hands back a shared cached instance, so every ring in
    // every emitter would end up wearing the last one's opacity — which is
    // zero as soon as any ring finishes dying.
    const m = new LineMaterial({
      color: new THREE.Color(PALETTE.inkSoft).getHex(),
      linewidth: WEIGHTS.normal,
      worldUnits: false,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
    });
    const hasWin = typeof window !== 'undefined';
    m.resolution.set(hasWin ? window.innerWidth : 1920, hasWin ? window.innerHeight : 1080);
    emitterMaterials.push(m);
    const line = new LineSegments2(g, m);
    line.raycast = () => {};
    line.visible = false;
    line.renderOrder = 3;
    group.add(line);
    rings.push({ line, life: -1, seed: hash(i * 7.3) });
  }
  rec.nodes[0].add(group);
  return { group, rings, next: 0, accum: 0 };
}

function updateEmitter(inst, k, dt) {
  const e = inst.emitter;
  if (!e) return;
  const ch = inst.spec;
  const rate = num(ch.rate, 8) * k;
  const life = num(ch.life, 1.6);
  const size = num(ch.size, 0.25);
  const spread = num(ch.spread, 0.35);
  const dir = new THREE.Vector3(...(ch.dir ?? [0, 1, 0])).normalize();
  const at = new THREE.Vector3(...(ch.at ?? [0, 0, 0]));

  if (rate > 0) {
    e.accum += rate * dt;
    while (e.accum >= 1) {
      e.accum -= 1;
      const r = e.rings[e.next % EMIT_MAX];
      e.next++;
      r.life = 0;
      r.seed = hash(e.next * 3.77);
      r.vel = dir.clone()
        .add(new THREE.Vector3((r.seed - 0.5) * spread, (hash(e.next * 1.7) - 0.5) * spread * 0.4,
                               (hash(e.next * 5.1) - 0.5) * spread))
        .multiplyScalar(num(ch.speed, 1.4));
      r.line.position.copy(at);
      r.line.scale.setScalar(size * 0.3);
    }
  }

  for (const r of e.rings) {
    if (r.life < 0) { r.line.visible = false; continue; }
    r.life += dt;
    if (r.life > life) { r.life = -1; r.line.visible = false; continue; }
    const u = r.life / life;
    r.line.visible = true;
    r.line.position.addScaledVector(r.vel, dt);
    r.line.scale.setScalar(size * (0.3 + u * 2.4));
    r.line.material.opacity = 0.78 * (1 - u) * (1 - u);
  }
}

function makeFlowLine(ch, rec) {
  const pts = (ch.path ?? []).map(([x, y, z]) => new THREE.Vector3(x, y, z));
  if (pts.length < 2) return null;
  const curve = new THREE.CatmullRomCurve3(pts, ch.closed === true, 'catmullrom', 0);
  const samples = curve.getPoints(Math.max(24, pts.length * 8));
  const flat = [];
  for (let i = 0; i < samples.length - 1; i++) {
    flat.push(samples[i].x, samples[i].y, samples[i].z,
              samples[i + 1].x, samples[i + 1].y, samples[i + 1].z);
  }
  const g = new LineSegmentsGeometry();
  g.setPositions(flat);
  const m = lineMaterial(WEIGHTS.normal, { color: PALETTE.accent, opacity: 0.9, dashed: true });
  const line = new LineSegments2(g, m);
  line.computeLineDistances();
  line.raycast = () => {};
  line.renderOrder = 4;
  rec.nodes[0].add(line);
  return line;
}

/* --------------------------------------------------------------------- apply */

const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();

/**
 * Reset every animated node to its base transform, then fold in each channel.
 */
export function applyChannels(bound, scope, dt) {
  // 1. reset — channels are additive, so they need a clean slate each frame
  const touched = new Set();
  for (const inst of bound) {
    if (touched.has(inst.rec)) continue;
    touched.add(inst.rec);
    inst.rec.nodes.forEach((node, i) => {
      const b = inst.rec.baseTransforms[i];
      node.position.copy(b.pos);
      node.quaternion.copy(b.quat);
      node.scale.copy(b.scale);
      node.visible = !inst.rec.spec.hidden;
    });
  }

  // 2. fold
  for (const inst of bound) {
    const { rec, spec: ch } = inst;
    const k = inst.bind(scope);

    switch (inst.type) {

      case 'spin': {
        // `bind` is a rate in degrees/second
        inst.state.angle = (inst.state.angle + k * dt) % 360;
        _q.setFromAxisAngle(inst.vec, inst.state.angle * DEG);
        for (const node of rec.nodes) node.quaternion.multiply(_q);
        break;
      }

      case 'oscillate': {
        const amp = inst.amp(scope), freq = inst.freq(scope), ph = inst.phase(scope);
        const spread = instanceSpread(ch, rec.nodes.length);
        writePerNode(rec, inst.channelName, inst.axis, (i) =>
          amp * Math.sin(scope.t * freq * Math.PI * 2 + (ph + spread * i) * DEG) * k);
        break;
      }

      case 'reciprocate': {
        // `bind` is the crank angle in degrees; classic slider-crank projection.
        // `spread` phases the instances apart — a radial engine's nine pistons
        // sit 40° apart on the same crank throw.
        const stroke = inst.stroke(scope), ph = inst.phase(scope);
        const rod = num(ch.rod, 0);
        const spread = instanceSpread(ch, rec.nodes.length);
        const r = stroke / 2;
        writePerNode(rec, inst.channelName, inst.axis, (i) => {
          const a = (k + ph + spread * i) * DEG;
          if (rod > 0) {
            return r * Math.cos(a) + Math.sqrt(Math.max(rod * rod - (r * Math.sin(a)) ** 2, 0)) - rod;
          }
          return r * Math.cos(a);
        });
        break;
      }

      case 'articulate': {
        const from = inst.from(scope), to = inst.to(scope);
        const u = Math.min(Math.max(k, 0), 1);
        writeChannel(rec, inst.channelName, inst.axis, from + (to - from) * u);
        break;
      }

      case 'impulse': {
        const attack = num(ch.attack, 0.05), decay = num(ch.decay, 0.45);
        const st = inst.state;
        if (k >= 0.5 && st.lastK < 0.5) st.envT = 0;          // rising edge
        st.lastK = k;
        if (st.envT >= 0) {
          st.envT += dt;
          const e = st.envT <= attack
            ? st.envT / Math.max(attack, 1e-4)
            : Math.max(0, 1 - (st.envT - attack) / Math.max(decay, 1e-4));
          if (st.envT > attack + decay) st.envT = -1;
          writeChannel(rec, inst.channelName, inst.axis, num(ch.amp, 1) * e);
        }
        break;
      }

      case 'pathFollow': {
        if (!inst.curve) break;
        const n = rec.nodes.length;
        for (let i = 0; i < n; i++) {
          const u = (i / n + k) % 1;
          const t = u < 0 ? u + 1 : u;
          inst.curve.getPointAt(t, _v);
          rec.nodes[i].position.copy(_v);
          if (inst.orient) {
            const tan = inst.curve.getTangentAt(t);
            const up = new THREE.Vector3(0, 1, 0);
            const m = new THREE.Matrix4().lookAt(new THREE.Vector3(), tan, up);
            rec.nodes[i].quaternion.setFromRotationMatrix(m);
          }
        }
        break;
      }

      case 'visibility': {
        const on = k > 0.5;
        for (const node of rec.nodes) node.visible = on;
        break;
      }

      case 'explode': {
        const amt = Math.min(Math.max(k, 0), 1);
        for (const node of rec.nodes) node.position.addScaledVector(inst.offset, amt);
        for (const m of [rec.material]) if (m?.uniforms?.uGhost) m.uniforms.uGhost.value = amt * 0.25;
        // Published for the annotation layer. Leaders are anchored in the
        // static frame so a spinning wheel doesn't drag them around, but a part
        // that has been separated for inspection DOES need its leader to come
        // with it, or you can't tell which piece is which.
        rec.explodeOffset = (rec.explodeOffset ?? new THREE.Vector3())
          .copy(inst.offset).multiplyScalar(amt);
        break;
      }

      case 'emit':
        updateEmitter(inst, Math.min(Math.max(k, 0), 1), dt);
        break;

      case 'flow': {
        if (!inst.flowLine) break;
        inst.state.dash = (inst.state.dash - k * dt * 12) % 1000;
        inst.flowLine.material.dashOffset = inst.state.dash;
        inst.flowLine.visible = Math.abs(k) > 0.01;
        break;
      }
    }
  }
}

/** Degrees of phase added per instance index. `"auto"` spreads evenly over 360°. */
function instanceSpread(ch, count) {
  if (ch.spread == null) return 0;
  if (ch.spread === 'auto') return count > 0 ? 360 / count : 0;
  return Number(ch.spread) || 0;
}

function writeChannel(rec, channel, axis, value) {
  writePerNode(rec, channel, axis, () => value);
}

function writePerNode(rec, channel, axis, valueAt) {
  rec.nodes.forEach((node, i) => {
    const value = valueAt(i);
    if (channel === 'pos') {
      node.position[axis] += value;
    } else if (channel === 'scale') {
      node.scale[axis] *= (1 + value);
    } else {
      _q.setFromAxisAngle(AXIS[axis], value * DEG);
      node.quaternion.multiply(_q);
    }
  });
}
