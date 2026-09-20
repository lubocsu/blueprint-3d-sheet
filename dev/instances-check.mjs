/**
 * Offline verification for the instance patterns.
 *
 * Two of these exist because a real drawing needed them and the vocabulary
 * could not say it:
 *
 *   `angles`   A nozzle orientation plan gives bearings — 30°, 90°, 150° … or
 *              80°, 152°, 188°, 224°, 296°. A radial ring divides `arc` evenly
 *              from zero, so every one of those would have been quietly moved.
 *              The alternative was to author each nozzle as its own part, which
 *              is what the density gate exists to discourage.
 *
 *   `helical`  A ring cannot rise, so a spiral stair had no expression at all.
 *              It came out as a scattered band of treads at one height with a
 *              tube threaded through them that read as a spring.
 *
 * Placement is asserted against the real `instanceMatrices`, not against a
 * rendered page, so a failure points at the arithmetic rather than at a picture.
 *
 *   node dev/instances-check.mjs
 */

import { instanceMatrices } from '../src/build/assembly.mjs';
import { validateSpec } from '../src/spec/validate.mjs';
import { checkRichness } from '../src/spec/richness.mjs';

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (cond) console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`);
  else { failures++; console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`); }
};

const pos = (m) => ({ x: m.elements[12], y: m.elements[13], z: m.elements[14] });
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
/**
 * Bearing in the XZ plane, measured the way the radial pattern lays it out.
 *
 * A right-handed rotation about +Y takes (r,0,0) to (r·cos a, 0, −r·sin a), so
 * the ring runs CLOCKWISE seen from above and the z term is negated here. That
 * is the convention `radial` has always had; `angles` and `helical` inherit it
 * rather than introducing a second one, because changing it would silently move
 * every instanced part in the committed examples.
 */
const bearing = (p) => {
  const d = (Math.atan2(-p.z, p.x) * 180) / Math.PI;
  return (d % 360 + 360) % 360;
};

/* ------------------------------------------------------------------ radial */

console.log('\nradial — the existing behaviour must not shift');
{
  const m = instanceMatrices({ pattern: 'radial', count: 4, axis: 'y', radius: 100 });
  ok(m.length === 4, 'a full ring produces `count` instances');
  // A full circle divides by count, so four repeats sit at 0 / 90 / 180 / 270
  // and the last does NOT land back on the first.
  const b = m.map((x) => Math.round(bearing(pos(x))));
  ok(JSON.stringify(b) === JSON.stringify([0, 90, 180, 270]),
    'a full 360° ring divides by count, not count-1', b.join(' '));
  ok(near(Math.hypot(pos(m[1]).x, pos(m[1]).z), 100, 1e-9), 'every instance sits on the radius');

  const arc = instanceMatrices({ pattern: 'radial', count: 3, axis: 'y', radius: 10, arc: 90 });
  const ab = arc.map((x) => Math.round(bearing(pos(x))));
  ok(JSON.stringify(ab) === JSON.stringify([0, 45, 90]),
    'a partial arc divides by count-1 so the last lands on the arc end', ab.join(' '));
}

/* ------------------------------------------------------------------ angles */

console.log('\nangles — explicit bearings');
{
  // The inlet nozzles off the real orientation plan.
  const N1 = [30, 90, 150, 210, 270, 330];
  const m = instanceMatrices({ pattern: 'radial', angles: N1, axis: 'y', radius: 5704 });
  ok(m.length === 6, 'the angle list sets the instance count without a `count`');
  const got = m.map((x) => Math.round(bearing(pos(x))));
  ok(JSON.stringify(got) === JSON.stringify(N1), 'each repeat lands on its own bearing', got.join(' '));

  // The irregular ones, which no even division can produce.
  const N4 = [80, 152, 188, 224, 296];
  const irregular = instanceMatrices({ pattern: 'radial', angles: N4, axis: 'y', radius: 5706 });
  const got4 = irregular.map((x) => Math.round(bearing(pos(x))));
  ok(JSON.stringify(got4) === JSON.stringify(N4), 'irregular spacing survives exactly', got4.join(' '));

  // The bug this replaces: an even ring would have put them somewhere else.
  const even = instanceMatrices({ pattern: 'radial', count: 5, axis: 'y', radius: 5706 });
  const evenB = even.map((x) => Math.round(bearing(pos(x))));
  ok(JSON.stringify(evenB) !== JSON.stringify(N4),
    'an even ring really would have moved them', `would have been ${evenB.join(' ')}`);

  ok(instanceMatrices({ pattern: 'radial', angles: [0, 120], count: 9, axis: 'y', radius: 5 }).length === 2,
    'the angle list wins over a disagreeing count');
}

/* ----------------------------------------------------------------- helical */

console.log('\nhelical — a ring that climbs');
{
  const m = instanceMatrices({
    pattern: 'helical', count: 5, axis: 'y', radius: 100, arc: 360, rise: 400,
  });
  ok(m.length === 5, 'produces `count` instances');
  const ys = m.map((x) => pos(x).y);
  ok(near(ys[0], 0) && near(ys[4], 400),
    'the first sits at 0 and the LAST lands exactly on `rise`', ys.join(' '));
  const even = ys.every((y, i) => i === 0 || near(y - ys[i - 1], 100, 1e-9));
  ok(even, 'the rise is divided evenly');
  ok(m.every((x) => near(Math.hypot(pos(x).x, pos(x).z), 100, 1e-9)),
    'the radius is held all the way up');

  // A full-circle helix divides by count-1, unlike a full-circle ring, or a
  // stair's top tread would stop one step short of the landing.
  const b = m.map((x) => Math.round(bearing(pos(x))));
  ok(b[0] === 0 && (b[4] === 0 || b[4] === 360), 'a 360° helix completes the turn', b.join(' '));

  const multi = instanceMatrices({
    pattern: 'helical', count: 3, axis: 'y', radius: 10, arc: 900, rise: 1200,
  });
  const mb = multi.map((x) => Math.round(bearing(pos(x))));
  ok(mb.join(' ') === '0 90 180', 'a 900° sweep wraps past 360 correctly', mb.join(' '));

  // Explicit angles plus rise: the list says where each tread points, the rise
  // says how high it sits.
  const mixed = instanceMatrices({
    pattern: 'helical', angles: [0, 90, 180], axis: 'y', radius: 10, rise: 300,
  });
  const mys = mixed.map((x) => Math.round(pos(x).y));
  ok(JSON.stringify(mys) === JSON.stringify([0, 150, 300]), 'angles and rise compose', mys.join(' '));
}

/* --------------------------------------------------------- axis and mirror */

console.log('\naxis and mirror still apply');
{
  const x = instanceMatrices({ pattern: 'helical', count: 3, axis: 'x', radius: 50, arc: 180, rise: 90 });
  ok(near(pos(x[2]).x, 90, 1e-9), 'a helix about X climbs in X', String(Math.round(pos(x[2]).x)));

  const m = instanceMatrices({ pattern: 'radial', angles: [0, 90], axis: 'y', radius: 10, mirror: 'z' });
  ok(m.length === 4, 'mirror doubles an angle-listed set');
}

/* ------------------------------------------------- validation and counting */

console.log('\nthe gates understand the new patterns');
{
  const base = (instances) => ({
    meta: { title: 'TEST RIG', units: 'mm' },
    bounds: { length: 10, width: 10, height: 10 },
    drivers: [{ id: 'a' }],
    parts: [{
      id: 'p', name: 'PART', note: 'a part with a note',
      shape: { type: 'box', size: [1, 1, 1] },
      channels: [{ type: 'spin', axis: 'y', bind: 'a' }],
      instances,
    }],
  });

  const good = validateSpec(base({ pattern: 'helical', count: 8, axis: 'y', radius: 10, rise: 100 }));
  ok(good.ok, 'a well-formed helical spec validates', good.errors.join('; '));

  const noRise = validateSpec(base({ pattern: 'helical', count: 8, axis: 'y', radius: 10 }));
  ok(noRise.ok && noRise.warnings.some((w) => /rise/.test(w)),
    'a helix with no rise warns rather than fails');

  const anglesOnly = validateSpec(base({ pattern: 'radial', angles: [10, 20], axis: 'y', radius: 5 }));
  ok(anglesOnly.ok, 'an angle list satisfies the count requirement', anglesOnly.errors.join('; '));

  const noCount = validateSpec(base({ pattern: 'radial', axis: 'y', radius: 5 }));
  ok(!noCount.ok && noCount.errors.some((e) => /count/.test(e)),
    'neither count nor angles is still an error');

  const wrongPattern = validateSpec(base({ pattern: 'linear', angles: [10, 20], count: 2, step: [1, 0, 0] }));
  ok(!wrongPattern.ok && wrongPattern.errors.some((e) => /angles/.test(e)),
    '"angles" on a linear pattern is rejected');

  // The density gate has to count an angle list, or placing six nozzles by
  // bearing would score as one part.
  const stats = checkRichness(base({ pattern: 'radial', angles: [0, 60, 120, 180, 240, 300], axis: 'y', radius: 5 }));
  ok(stats.stats.effectiveParts === 6, 'the density gate counts an angle list as its length',
    `counted ${stats.stats.effectiveParts}`);
}

if (failures) {
  console.error(`\n\x1b[31m${failures} check(s) failed\x1b[0m`);
  process.exit(1);
}
console.log('\n\x1b[32minstance patterns place what they say they place\x1b[0m');
