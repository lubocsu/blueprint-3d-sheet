/**
 * Driver state.
 *
 * A driver is a named scalar the whole page agrees on. Console buttons push
 * targets at it, channels read it to move geometry, instrument rows print it.
 * Nothing else in the runtime knows what a "turret" or a "crankshaft" is —
 * that vocabulary lives entirely in the spec.
 */

export function createDrivers(spec) {
  const defs = new Map((spec.drivers ?? []).map((d) => [d.id, d]));
  const values = Object.create(null);
  const targets = Object.create(null);
  const prev = Object.create(null);

  for (const d of defs.values()) {
    values[d.id] = d.init;
    targets[d.id] = d.init;
    prev[d.id] = d.init;
  }

  /** motion id -> spec.motions entry, for the ones currently latched on */
  const active = new Map();
  /** momentary motions get released after this long; long enough for a rising edge */
  const MOMENTARY_HOLD = 0.22;
  const holds = new Map();

  const scope = Object.create(null);
  scope.t = 0;

  /**
   * State the current view implies, e.g. a section view that wants the
   * internals revealed. It sits between the declared defaults and the motions,
   * so switching to a cutaway view puts the model into the cutaway state
   * without a second click, and a motion can still override it.
   */
  let viewSet = Object.create(null);

  function recomputeTargets() {
    for (const d of defs.values()) targets[d.id] = d.init;
    for (const [id, v] of Object.entries(viewSet)) {
      if (id in targets) targets[id] = v;
    }
    for (const m of active.values()) {
      for (const [id, v] of Object.entries(m.set)) {
        if (id in targets) targets[id] = v;
      }
    }
  }

  return {
    values, targets, defs,

    isActive: (id) => active.has(id),
    activeIds: () => [...active.keys()],

    toggle(motion) {
      if (active.has(motion.id)) {
        active.delete(motion.id);
      } else {
        // motions sharing a group are mutually exclusive (view-like behaviour)
        if (motion.group) {
          for (const [id, m] of [...active]) if (m.group === motion.group) active.delete(id);
        }
        active.set(motion.id, motion);
        if (motion.momentary) holds.set(motion.id, MOMENTARY_HOLD);
      }
      recomputeTargets();
      return active.has(motion.id);
    },

    /** Apply the driver state a view implies. Pass null to clear it. */
    setViewState(set) {
      viewSet = set && typeof set === 'object' ? { ...set } : Object.create(null);
      recomputeTargets();
    },

    /** Latch a motion on without toggling (used to restore state). */
    activate(motion) {
      active.set(motion.id, motion);
      if (motion.momentary) holds.set(motion.id, MOMENTARY_HOLD);
      recomputeTargets();
    },

    reset() {
      active.clear();
      holds.clear();
      recomputeTargets();
    },

    update(dt, t) {
      for (const [id, remain] of [...holds]) {
        const left = remain - dt;
        if (left <= 0) { holds.delete(id); active.delete(id); recomputeTargets(); }
        else holds.set(id, left);
      }

      for (const d of defs.values()) {
        prev[d.id] = values[d.id];
        const target = targets[d.id];
        const cur = values[d.id];
        // exponential approach; frame-rate independent
        const k = 1 - Math.exp(-(d.ease ?? 2) * dt);
        let next = cur + (target - cur) * k;
        if (Math.abs(next - target) < 1e-6) next = target;
        values[d.id] = Math.min(Math.max(next, d.min), d.max);
        scope[d.id] = values[d.id];
      }
      scope.t = t;
      return scope;
    },

    /** True on the frame a value crosses upward through `edge`. */
    rising(id, edge = 0.5) {
      return prev[id] < edge && values[id] >= edge;
    },

    scope,
  };
}
