/**
 * Offline verification that a driver is checked from both sides.
 *
 * A driver has a read side and a write side and they fail differently, but the
 * validator used to pool them into one "used" set. A motion pushing a value at
 * a driver counted as use, so this arrangement scored clean:
 *
 *   drivers:  { "id": "prime" }
 *   motions:  { "id": "prime", "label": "PRIME", "set": { "prime": 1 } }
 *   channels: nothing binds it
 *
 * which is a console button, on the published page, that does nothing when a
 * reader presses it. `examples/radial-engine` shipped exactly that. Nothing in
 * the renderer can catch it — a driver nobody reads is not an error at runtime,
 * it is just a number moving in memory — so it has to be caught here.
 *
 * The three states and what each means for the page:
 *
 *   written, never read   a dead control; the reader presses it and waits
 *   read, never written   frozen at its init value; the geometry never moves
 *   neither               a spare line in the driver table, harmless
 *
 * Only the first is an error under --strict, because only the first lies to
 * whoever is looking at the sheet.
 *
 *   node dev/drivers-check.mjs
 */

import { validateSpec } from '../src/spec/validate.mjs';

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (cond) console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`);
  else { failures++; console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`); }
};

/** Smallest spec that passes structural validation. Drivers are the subject. */
const base = (extra = {}) => ({
  meta: { title: 'DRIVER RIG', units: 'mm' },
  bounds: { length: 100, width: 100, height: 100 },
  parts: [
    { id: 'a', name: 'FRAME', note: 'welded', group: 'body', shape: { type: 'box', size: [10, 10, 10] } },
    { id: 'b', name: 'COVER', group: 'body', shape: { type: 'box', size: [5, 5, 5] } },
  ],
  ...extra,
});

/** The same parts, with one of them carrying a channel. */
const withChannel = (id, channel) =>
  base().parts.map((p) => (p.id === id ? { ...p, channels: [channel] } : p));

/** Everything either side of the driver report says, errors and warnings alike. */
const notes = (spec, strict = false) => {
  const r = validateSpec(spec, { strict });
  return [...r.errors, ...r.warnings].filter((m) => m.startsWith('driver "'));
};
const says = (spec, needle) => notes(spec).some((m) => m.includes(needle));
const passesStrict = (spec) => validateSpec(spec, { strict: true }).ok;

/* --------------------------------------------------------- the dead control */

console.log('\na driver a button pushes but nothing reads');
{
  const spec = base({
    drivers: [{ id: 'prime' }],
    motions: [{ id: 'prime', label: 'PRIME', set: { prime: 1 } }],
  });

  ok(validateSpec(spec).ok, 'the spec is otherwise valid');
  ok(says(spec, 'is set by motion "prime" but no channel or instrument reads it'),
    'the warning names the motion and says the button is dead', notes(spec)[0]);

  const strict = validateSpec(spec, { strict: true });
  ok(!strict.ok && strict.errors.some((m) => m.includes('"prime"')),
    'under --strict it is an error, which is what CI and the examples run');

  // The old behaviour: a motion's `set` counted as a read, so this said nothing.
  ok(notes(spec).length === 1, 'and it is reported once, not once per side');
}

console.log('\nthe same driver, once something reads it');
{
  const instrumented = base({
    drivers: [{ id: 'prime' }],
    motions: [{ id: 'prime', label: 'PRIME', set: { prime: 1 } }],
    instruments: [{ label: 'PRIME', expr: 'prime * 100', format: '%d' }],
  });
  ok(!notes(instrumented).length && passesStrict(instrumented),
    'an instrument counts as a reader');

  const bound = base({
    drivers: [{ id: 'prime' }],
    motions: [{ id: 'prime', label: 'PRIME', set: { prime: 1 } }],
    parts: withChannel('a', { type: 'oscillate', target: 'pos.y', bind: 'prime', amp: 'prime * 2' }),
  });
  ok(!notes(bound).length, 'so does a channel expression');
}

/* --------------------------------------------------- a view is a writer too */

console.log('\nviews write drivers exactly as motions do');
{
  const viewOnly = base({
    drivers: [{ id: 'reveal' }],
    views: [{ id: 'sec', label: 'SEC', set: { reveal: 1 } }],
  });
  ok(says(viewOnly, 'is set by view "sec"') && says(viewOnly, 'selecting the view changes nothing'),
    "a view-only write with no reader is reported in the view's own terms", notes(viewOnly)[0]);

  const read = base({
    drivers: [{ id: 'reveal' }],
    views: [{ id: 'sec', label: 'SEC', set: { reveal: 1 } }],
    parts: withChannel('b', { type: 'visibility', bind: 'reveal' }),
  });
  ok(!notes(read).length,
    'and a view alone is writer enough, so nothing warns once something reads it');

  // The runtime drops a `set` key that is not a declared driver, silently.
  const typo = validateSpec(base({
    drivers: [{ id: 'reveal' }],
    views: [{ id: 'sec', label: 'SEC', set: { reveel: 1 } }],
  }));
  ok(!typo.ok && typo.errors.some((m) => m.includes('/views/0') && m.includes('"reveel"')),
    'a view that sets an undeclared driver is an error, as a motion already was');
}

/* ------------------------------------------------------- the frozen driver */

console.log('\na driver nothing can move');
{
  const frozen = base({
    drivers: [{ id: 'gear', min: 0, max: 1, init: 0.5 }],
    parts: withChannel('a', { type: 'spin', axis: 'y', bind: 'gear * 90' }),
  });
  ok(says(frozen, 'no motion or view sets it'),
    'a read with no writer warns that it stays at its init value', notes(frozen)[0]);
  ok(passesStrict(frozen),
    'but never an error, even under --strict: a constant bias is a legitimate thing to author');
}

console.log('\na driver neither side touches');
{
  const spare = base({ drivers: [{ id: 'unused' }] });
  ok(says(spare, 'declared but nothing reads or sets it'),
    'the spare line is still reported, and says which kind of nothing it is', notes(spare)[0]);
  ok(passesStrict(spare), 'and stays a warning — it changes nothing on the page');
}

/* ------------------------------------------ the assembly-wide explode reads */

console.log('\nan assembly-wide explode reads its driver without naming it in a channel');
{
  // `explode.driver` is the recommended way to wire a full exploded view:
  // normalize attaches the channel to every part, so no authored channel
  // mentions the driver. Miss that read and the best-wired spec warns.
  const wide = base({
    drivers: [{ id: 'apart' }],
    explode: { driver: 'apart' },
    motions: [{ id: 'apart', label: 'EXPL', set: { apart: 1 } }],
  });
  ok(!notes(wide).length && passesStrict(wide),
    'the top-level explode counts as the reader', notes(wide)[0]);

  const typo = validateSpec(base({
    drivers: [{ id: 'apart' }],
    explode: { driver: 'aprat' },
    motions: [{ id: 'apart', label: 'EXPL', set: { apart: 1 } }],
  }));
  ok(!typo.ok && typo.errors.some((m) => m.includes('/explode') && m.includes('"aprat"')),
    'and a typo in it is an error rather than a silently inert explode');
}

if (failures) {
  console.error(`\n\x1b[31m${failures} check(s) failed\x1b[0m`);
  process.exit(1);
}
console.log('\n\x1b[32mevery declared driver is answerable for both sides\x1b[0m');
