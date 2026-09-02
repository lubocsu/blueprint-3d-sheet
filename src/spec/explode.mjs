/**
 * Who participates in the exploded view.
 *
 * Shared by the density gate (which runs before normalize and must judge the
 * same set the runtime will actually animate) and by normalize itself.
 *
 * An exploded view whose skin stays put is not an exploded view. In practice
 * authors wire up the five parts they were thinking about and leave the other
 * thirty, so the assembly puffs up slightly and the interior stays covered.
 * `spec.explode.driver` fixes that in one line — and where an author has
 * already wired explode channels that all bind the SAME driver, their intent is
 * unambiguous, so we extend it to the parts they did not get to rather than
 * making them enumerate the rest. Mixed binds mean the author is being
 * deliberate about which parts move, and we leave that alone.
 */

/**
 * @param {object} spec  a raw or normalized spec
 * @returns {{driver: string|null, inferred: boolean}}
 */
export function explodeDriverFor(spec) {
  const declared = spec?.explode?.driver;
  if (declared) return { driver: String(declared), inferred: false };

  const binds = new Set();
  for (const p of spec?.parts ?? []) {
    for (const c of p.channels ?? []) {
      if (c.type === 'explode') binds.add(String(c.bind));
    }
  }
  if (binds.size === 1) return { driver: [...binds][0], inferred: true };
  return { driver: null, inferred: false };
}

/** How many parts will actually separate, and out of how many. */
export function explodeParticipation(spec) {
  const parts = spec?.parts ?? [];
  const { driver, inferred } = explodeDriverFor(spec);
  const wired = parts.filter((p) => (p.channels ?? []).some((c) => c.type === 'explode')).length;
  return {
    driver,
    inferred,
    wired,
    total: parts.length,
    // With a driver in play every part gets a channel attached at normalize time.
    participating: driver ? parts.length : wired,
  };
}
