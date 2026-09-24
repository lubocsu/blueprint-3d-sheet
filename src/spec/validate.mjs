/**
 * Structural + semantic validation of an AssemblySpec.
 *
 * Structural errors come from ajv against schema.json. Semantic errors are the
 * ones that actually bite at runtime: dangling parent/anchor references, cycles,
 * channel bindings that name a driver nobody declared.
 *
 * Drivers are checked from both sides. What READS a driver (a channel
 * expression, an instrument) and what WRITES one (a motion button, a view's
 * implied state) are tracked apart, because a control pushing at a driver that
 * nothing reads is not a use of that driver — it is a dead button.
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
import { driverDefaults, normalizeSpec } from './normalize.mjs';
import { localizableSlots, CHROME, BASE_LOCALE } from './i18n.mjs';

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

/** 'motion "prime"' / 'motions "idle", "cruise" and view "secBB"' */
function namedWriters(writers) {
  const group = (kind, plural) => {
    const ids = writers.filter((w) => w.kind === kind).map((w) => `"${w.id}"`);
    return ids.length ? `${ids.length > 1 ? plural : kind} ${ids.join(', ')}` : null;
  };
  return [group('motion', 'motions'), group('view', 'views')].filter(Boolean).join(' and ');
}

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

function semanticCheck(spec, { strict = false } = {}) {
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
    const { min, max, init } = driverDefaults(d);
    if (min >= max) {
      // Checking init against a range that makes no sense only adds noise.
      errors.push(`/drivers/${i} ("${d.id}") min ${min} must be < max ${max}`);
      continue;
    }
    if (init < min || init > max) errors.push(`/drivers/${i} ("${d.id}") init ${init} outside [${min}, ${max}]`);
  }

  // expression bindings — the single most common thing a generated spec gets wrong
  /** driver ids something READS: channel binds and terms, instrument expressions. */
  const readDrivers = new Set();
  /** driver id -> the motions and views that WRITE it. */
  const driverWriters = new Map();
  const addWriter = (id, kind, who) => {
    if (!driverWriters.has(id)) driverWriters.set(id, []);
    driverWriters.get(id).push({ kind, id: who });
  };
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
      } else readDrivers.add(v);
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

  // An assembly-wide explode reads its driver without any authored channel
  // naming it — normalize attaches the channel to every part that has none.
  // Miss this and the one spec that wires explode the recommended way looks
  // like it declared a driver nobody reads.
  if (spec.explode?.driver != null) checkExpr(String(spec.explode.driver), '/explode');

  // motions must drive declared drivers
  const motionIds = new Set();
  for (const [i, m] of (spec.motions ?? []).entries()) {
    if (motionIds.has(m.id)) errors.push(`/motions/${i} duplicate motion id "${m.id}"`);
    motionIds.add(m.id);
    for (const k of Object.keys(m.set ?? {})) {
      if (!driverIds.has(k)) {
        errors.push(`/motions/${i} ("${m.id}") sets "${k}" which is not a declared driver`);
      } else addWriter(k, 'motion', m.id);
    }
  }

  // views
  const viewIds = new Set();
  for (const [i, v] of (spec.views ?? []).entries()) {
    if (viewIds.has(v.id)) errors.push(`/views/${i} duplicate view id "${v.id}"`);
    viewIds.add(v.id);
    // A view's `set` writes drivers exactly as a motion's does, and the runtime
    // drops any key that is not a declared driver without saying so.
    for (const k of Object.keys(v.set ?? {})) {
      if (!driverIds.has(k)) {
        errors.push(`/views/${i} ("${v.id}") sets "${k}" which is not a declared driver`);
      } else addWriter(k, 'view', v.id);
    }
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

  // Three ways a driver can be wired wrong, and they are not the same fault.
  // Counting a motion's `set` as "use" hid the middle one: `examples/radial-engine`
  // shipped a PRIME button pushing a driver no channel read, and the published
  // demo had a console control that changed nothing.
  for (const d of drivers) {
    const isRead = readDrivers.has(d.id);
    const wrote = driverWriters.get(d.id) ?? [];
    if (isRead && wrote.length) continue;

    if (!isRead && !wrote.length) {
      warnings.push(`driver "${d.id}" is declared but nothing reads or sets it`);
    } else if (!isRead) {
      // The one the reader of the sheet actually meets: a live control that
      // moves nothing. An error under --strict, which is what CI runs.
      const buttons = wrote.filter((w) => w.kind === 'motion').length;
      const dead = buttons
        ? `the button${buttons > 1 ? 's' : ''} will do nothing`
        : `selecting ${wrote.length > 1 ? 'those views' : 'the view'} changes nothing`;
      (strict ? errors : warnings).push(
        `driver "${d.id}" is set by ${namedWriters(wrote)} but no channel or instrument reads it — ${dead}`);
    } else {
      warnings.push(`driver "${d.id}" is read by a channel or instrument but no motion or view sets it — it stays at its init value for the life of the page`);
    }
  }

  // instance pattern needs the right count field for its kind
  for (const [i, p] of parts.entries()) {
    const inst = p.instances;
    if (!inst) continue;
    const explicitAngles = Array.isArray(inst.angles) && inst.angles.length > 0;
    if (inst.pattern === 'grid') {
      if (!inst.counts?.length) errors.push(`/parts/${i} ("${p.id}") grid instances need "counts" (e.g. [3, 2])`);
      if (!inst.steps?.length) errors.push(`/parts/${i} ("${p.id}") grid instances need "steps"`);
    } else if (!explicitAngles && !(inst.count > 0)) {
      errors.push(`/parts/${i} ("${p.id}") ${inst.pattern} instances need a "count" (or an "angles" list)`);
    }
    if (explicitAngles && inst.pattern !== 'radial' && inst.pattern !== 'helical') {
      errors.push(`/parts/${i} ("${p.id}") "angles" only applies to radial or helical instances, not ${inst.pattern}`);
    }
    if (explicitAngles && inst.count > 0 && inst.count !== inst.angles.length) {
      warnings.push(`/parts/${i} ("${p.id}") has ${inst.angles.length} angle(s) but count ${inst.count}; the angle list wins`);
    }
    if ((inst.pattern === 'radial' || inst.pattern === 'helical') && !(inst.radius >= 0)) {
      warnings.push(`/parts/${i} ("${p.id}") ${inst.pattern} instances with no "radius" all land on the axis`);
    }
    // A helix that does not climb is a ring, and is almost certainly a mistake
    // rather than intent — the pattern exists only for the rise.
    if (inst.pattern === 'helical' && !inst.rise) {
      warnings.push(`/parts/${i} ("${p.id}") helical instances with no "rise" are just a radial ring`);
    }
  }

  // translations — a path that resolves to nothing is a translation that will
  // never appear on the sheet, and the page gives no hint that it was dropped
  if (spec.i18n) {
    const base = spec.i18n.base ?? BASE_LOCALE;
    const locales = spec.i18n.locales ?? {};
    const dflt = spec.i18n.default ?? base;
    if (dflt !== base && !(dflt in locales)) {
      errors.push(`/i18n default locale "${dflt}" is neither the base language nor declared in /i18n/locales`);
    }
    // Paths are checked against the NORMALIZED spec: a spec that declares no
    // views still gets the six default ones, and they are translatable.
    let resolved = spec;
    try { resolved = normalizeSpec(spec); } catch { /* keep the authored spec */ }
    const paths = new Set(localizableSlots(resolved).map((s) => s.path));

    for (const [code, def] of Object.entries(locales)) {
      const where = `/i18n/locales/${code}`;
      const strings = def?.strings ?? {};
      const keys = Object.keys(strings);
      if (!keys.length) {
        warnings.push(`${where} declares a language but translates nothing; only the sheet furniture will change`);
      }
      for (const [k, v] of Object.entries(strings)) {
        if (typeof v !== 'string' || !v.trim()) {
          errors.push(`${where} "${k}" is empty; drop the key instead — an untranslated string falls back to ${base}`);
          continue;
        }
        if (k.startsWith('chrome.')) {
          if (!(k.slice(7) in CHROME[BASE_LOCALE])) {
            errors.push(`${where} "${k}" is not one of the renderer's own strings`);
          }
          continue;
        }
        if (!paths.has(k)) {
          errors.push(`${where} "${k}" does not name any text in this spec`);
          continue;
        }
        // The console buttons are a fixed-width row; the schema caps the
        // authored label at 8 and a translation has to live in the same space.
        if (/^(views|motions)\.[^.]+\.label$/.test(k) && [...v].length > 8) {
          warnings.push(`${where} "${k}" is ${[...v].length} characters; console buttons fit about 8`);
        }
      }
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
 * @param {object} spec
 * @param {{ strict?: boolean }} [opts] strict promotes the warnings that mean a
 *   visibly broken page — a console button bound to a driver nothing reads — to
 *   errors, the way the density gate's target tier does.
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
export function validateSpec(spec, { strict = false } = {}) {
  if (typeof spec !== 'object' || spec === null) {
    return { ok: false, errors: ['spec is not an object'], warnings: [] };
  }
  const structuralOk = validateStructure(spec);
  const errors = structuralOk ? [] : refineShapeErrors(validateStructure.errors ?? [], spec);

  // Semantic checks assume the shape is roughly right; running them on a
  // structurally broken spec produces cascading nonsense.
  if (!structuralOk) return { ok: false, errors, warnings: [] };

  const { errors: semErrors, warnings } = semanticCheck(spec, { strict });
  return { ok: semErrors.length === 0, errors: semErrors, warnings };
}

export { schema };
