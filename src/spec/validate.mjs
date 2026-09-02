/**
 * Structural + semantic validation of an AssemblySpec.
 *
 * Structural errors come from ajv against schema.json. Semantic errors are the
 * ones that actually bite at runtime: dangling parent/anchor references, cycles,
 * channel bindings that name a driver nobody declared.
 *
 * Shape unions get special treatment — a raw ajv `oneOf` failure lists every
 * branch that didn't match, which is useless. We re-validate against the single
 * branch matching `shape.type` and report that instead.
 */

import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compileExpr, ExprError } from './expr.mjs';

const schema = JSON.parse(
  readFileSync(fileURLToPath(new URL('./schema.json', import.meta.url)), 'utf8'),
);

const ajv = new Ajv({ allErrors: true, strict: false, verbose: true });
addFormats(ajv);
const validateStructure = ajv.compile(schema);

// Standalone compiled validators for each shape branch, keyed by `type`.
const shapeBranches = new Map();
for (const branch of schema.$defs.shape.oneOf) {
  const t = branch.properties?.type?.const;
  if (!t) continue;
  shapeBranches.set(t, ajv.compile({ ...branch, $defs: schema.$defs }));
}

/** Names an expression may use without declaring a driver. */
const BUILTIN_VARS = new Set(['t', 'fps']);

const fmt = (e) => `${e.instancePath || '/'} ${e.message}`;

/** Replace opaque shape-oneOf failures with the error from the right branch. */
function refineShapeErrors(errors, spec) {
  const out = [];
  const seen = new Set();
  for (const e of errors) {
    const isShapeUnion = e.keyword === 'oneOf' && /\/shape(\/|$)/.test(e.instancePath);
    if (!isShapeUnion) {
      // Suppress the noisy per-branch children of a oneOf we're about to refine.
      if (errors.some((o) => o.keyword === 'oneOf' && /\/shape(\/|$)/.test(o.instancePath)
                             && e.instancePath.startsWith(o.instancePath) && e !== o)) continue;
      const line = fmt(e);
      if (!seen.has(line)) { seen.add(line); out.push(line); }
      continue;
    }
    const value = e.data;
    const type = value?.type;
    if (!type) { out.push(`${e.instancePath} shape is missing "type"`); continue; }
    const branch = shapeBranches.get(type);
    if (!branch) {
      out.push(`${e.instancePath} unknown shape type "${type}" (expected one of ${[...shapeBranches.keys()].join(', ')})`);
      continue;
    }
    if (branch(value)) {
      out.push(`${e.instancePath} shape "${type}" failed the union check but matched its own branch — likely a nested csg operand problem`);
    } else {
      for (const be of branch.errors ?? []) {
        const line = `${e.instancePath}${be.instancePath} (shape "${type}") ${be.message}`;
        if (!seen.has(line)) { seen.add(line); out.push(line); }
      }
    }
  }
  return out;
}

function semanticCheck(spec) {
  const errors = [];
  const warnings = [];

  const parts = spec.parts ?? [];
  const drivers = spec.drivers ?? [];
  const ids = new Map();

  for (const [i, p] of parts.entries()) {
    if (ids.has(p.id)) errors.push(`/parts/${i} duplicate part id "${p.id}"`);
    else ids.set(p.id, i);
  }

  // parent references + cycle detection
  for (const [i, p] of parts.entries()) {
    if (p.parent == null) continue;
    if (!ids.has(p.parent)) {
      errors.push(`/parts/${i} ("${p.id}") parent "${p.parent}" is not a declared part`);
      continue;
    }
    if (p.parent === p.id) errors.push(`/parts/${i} ("${p.id}") is its own parent`);
  }
  const state = new Map(); // 0 unvisited 1 on-stack 2 done
  const byId = new Map(parts.map((p) => [p.id, p]));
  const walk = (id, trail) => {
    const s = state.get(id) ?? 0;
    if (s === 2) return;
    if (s === 1) { errors.push(`parent cycle: ${[...trail, id].join(' -> ')}`); return; }
    state.set(id, 1);
    const par = byId.get(id)?.parent;
    if (par && byId.has(par)) walk(par, [...trail, id]);
    state.set(id, 2);
  };
  for (const p of parts) walk(p.id, []);

  // driver table
  const driverIds = new Set(drivers.map((d) => d.id));
  const dupDrivers = drivers.map((d) => d.id).filter((id, i, a) => a.indexOf(id) !== i);
  for (const id of new Set(dupDrivers)) errors.push(`/drivers duplicate driver id "${id}"`);
  for (const [i, d] of drivers.entries()) {
    const min = d.min ?? 0, max = d.max ?? 1, init = d.init ?? 0;
    if (min >= max) errors.push(`/drivers/${i} ("${d.id}") min ${min} must be < max ${max}`);
    if (init < min || init > max) errors.push(`/drivers/${i} ("${d.id}") init ${init} outside [${min}, ${max}]`);
  }

  // expression bindings — the single most common thing a generated spec gets wrong
  const usedDrivers = new Set();
  const checkExpr = (src, where) => {
    if (src == null) return;
    let compiled;
    try { compiled = compileExpr(src); }
    catch (err) {
      errors.push(`${where} bad expression "${src}": ${err instanceof ExprError ? err.message : err}`);
      return;
    }
    for (const v of compiled.vars) {
      if (BUILTIN_VARS.has(v)) continue;
      if (!driverIds.has(v)) {
        errors.push(`${where} expression "${src}" references "${v}" which is not a declared driver`);
      } else usedDrivers.add(v);
    }
  };

  for (const [i, p] of parts.entries()) {
    for (const [j, ch] of (p.channels ?? []).entries()) {
      const where = `/parts/${i}/channels/${j} ("${p.id}" ${ch.type})`;
      checkExpr(ch.bind, where);
      for (const k of ['amp', 'freq', 'phase', 'rate', 'stroke', 'from', 'to']) {
        if (typeof ch[k] === 'string') checkExpr(ch[k], `${where}.${k}`);
      }
      if (ch.type === 'explode' && !p.explode) {
        // fine — normalize derives one, just note it
      }
      const needsTarget = ['oscillate', 'reciprocate', 'articulate', 'impulse'];
      if (needsTarget.includes(ch.type) && !ch.target) {
        errors.push(`${where} channel type "${ch.type}" requires a "target" like "pos.y" or "rot.z"`);
      }
      if (ch.type === 'spin' && !ch.axis) {
        errors.push(`${where} spin channel requires an "axis"`);
      }
    }
  }

  for (const [i, ins] of (spec.instruments ?? []).entries()) {
    checkExpr(ins.expr, `/instruments/${i} ("${ins.label}")`);
  }

  // motions must drive declared drivers
  const motionIds = new Set();
  for (const [i, m] of (spec.motions ?? []).entries()) {
    if (motionIds.has(m.id)) errors.push(`/motions/${i} duplicate motion id "${m.id}"`);
    motionIds.add(m.id);
    for (const k of Object.keys(m.set ?? {})) {
      if (!driverIds.has(k)) {
        errors.push(`/motions/${i} ("${m.id}") sets "${k}" which is not a declared driver`);
      } else usedDrivers.add(k);
    }
  }

  // views
  const viewIds = new Set();
  for (const [i, v] of (spec.views ?? []).entries()) {
    if (viewIds.has(v.id)) errors.push(`/views/${i} duplicate view id "${v.id}"`);
    viewIds.add(v.id);
  }

  // callouts
  const ns = new Set();
  for (const [i, c] of (spec.annotations?.callouts ?? []).entries()) {
    if (!ids.has(c.anchor)) {
      errors.push(`/annotations/callouts/${i} (n=${c.n}) anchor "${c.anchor}" is not a declared part`);
    }
    if (ns.has(c.n)) errors.push(`/annotations/callouts/${i} duplicate callout number ${c.n}`);
    ns.add(c.n);
  }
  const sorted = [...ns].sort((a, b) => a - b);
  if (sorted.length && (sorted[0] !== 1 || sorted[sorted.length - 1] !== sorted.length)) {
    warnings.push(`callout numbers should run 1..${sorted.length} without gaps (got ${sorted.join(', ')})`);
  }

  for (const [i, d] of (spec.annotations?.dimensions ?? []).entries()) {
    const same = d.from.every((v, k) => v === d.to[k]);
    if (same) errors.push(`/annotations/dimensions/${i} ("${d.label}") from and to are the same point`);
    for (const vid of d.views ?? []) {
      if (!viewIds.has(vid)) warnings.push(`/annotations/dimensions/${i} references unknown view "${vid}"`);
    }
  }

  for (const d of drivers) {
    if (!usedDrivers.has(d.id)) warnings.push(`driver "${d.id}" is declared but never read by any channel, motion or instrument`);
  }

  // instance pattern needs the right count field for its kind
  for (const [i, p] of parts.entries()) {
    const inst = p.instances;
    if (!inst) continue;
    if (inst.pattern === 'grid') {
      if (!inst.counts?.length) errors.push(`/parts/${i} ("${p.id}") grid instances need "counts" (e.g. [3, 2])`);
      if (!inst.steps?.length) errors.push(`/parts/${i} ("${p.id}") grid instances need "steps"`);
    } else if (!(inst.count > 0)) {
      errors.push(`/parts/${i} ("${p.id}") ${inst.pattern} instances need a "count"`);
    }
    if (inst.pattern === 'radial' && !(inst.radius >= 0)) {
      warnings.push(`/parts/${i} ("${p.id}") radial instances with no "radius" all land on the axis`);
    }
  }

  // csg nesting depth — three-bvh-csg gets slow fast, and deep nesting is
  // almost always a generation mistake rather than intent
  const depth = (shape, d = 0) => {
    if (shape?.type !== 'csg') return d;
    return Math.max(...shape.operands.map((o) => depth(o.shape, d + 1)));
  };
  for (const [i, p] of parts.entries()) {
    const dd = depth(p.shape);
    if (dd > 3) errors.push(`/parts/${i} ("${p.id}") csg nested ${dd} deep; flatten to <= 3`);
  }

  return { errors, warnings };
}

/**
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
export function validateSpec(spec) {
  if (typeof spec !== 'object' || spec === null) {
    return { ok: false, errors: ['spec is not an object'], warnings: [] };
  }
  const structuralOk = validateStructure(spec);
  const errors = structuralOk ? [] : refineShapeErrors(validateStructure.errors ?? [], spec);

  // Semantic checks assume the shape is roughly right; running them on a
  // structurally broken spec produces cascading nonsense.
  if (!structuralOk) return { ok: false, errors, warnings: [] };

  const { errors: semErrors, warnings } = semanticCheck(spec);
  return { ok: semErrors.length === 0, errors: semErrors, warnings };
}

export { schema };
