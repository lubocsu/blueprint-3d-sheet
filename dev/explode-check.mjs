/**
 * Verifies the two claims an exploded view is easy to make and hard to keep:
 *
 *   1. It actually comes APART. Every participating part separates, and the
 *      pairwise overlap of their bounding boxes collapses — an assembly that
 *      merely inflates scores badly here, which is the point.
 *   2. The INTERNALS are revealed, and only when asked. Parts marked hidden are
 *      invisible on a normal view and visible on EXPLODE and on the section.
 *
 *   node dev/explode-check.mjs <page.html> [--motion explode] [--section secBB]
 */
import puppeteer from 'puppeteer';
import { pathToFileURL } from 'node:url';
import { CHROME_FLAGS } from './shot.mjs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node dev/explode-check.mjs <page.html> [--motion id] [--section id]');
  process.exit(1);
}
const argOf = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const motionId = argOf('motion', 'explode');
const sectionId = argOf('section', null);
const plainView = argOf('view', 'iso');

const browser = await puppeteer.launch({ headless: true, args: CHROME_FLAGS });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 950, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(file).href, { waitUntil: 'load' });
await page.waitForFunction('window.__B2D__ && window.__B2D__.ready', { timeout: 30000 });

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (cond) console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`);
  else { failures++; console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`); }
};

const sample = await page.evaluate(async ({ motionId, sectionId, plainView }) => {
  const B = window.__B2D__;
  const wait = (n) => new Promise((r) => {
    let i = 0;
    const t = () => (++i >= n ? r() : requestAnimationFrame(t));
    requestAnimationFrame(t);
  });

  const snapshot = () => {
    const out = {};
    for (const id of B.partIds()) out[id] = B.partState(id);
    return out;
  };

  const hidden = B.spec.parts.filter((p) => p.hidden).map((p) => p.id);
  const participating = B.spec.parts
    .filter((p) => (p.channels ?? []).some((c) => c.type === 'explode')).map((p) => p.id);

  B.clearMotions();
  B.setView(plainView);
  await wait(40);
  const rest = snapshot();
  const traceAtRest = B.explodeTraceVisible();

  B.setMotion(motionId, true);
  // Drive the eased driver to its target without waiting in real time.
  B.advance(6);
  await wait(20);
  const blown = snapshot();
  const traceVisible = B.explodeTraceVisible();

  let sectioned = null;
  if (sectionId) {
    B.clearMotions();
    B.setView(sectionId);
    B.advance(4);
    await wait(20);
    sectioned = snapshot();
  }

  return { rest, blown, sectioned, hidden, participating, traceVisible,
           traceAtRest, total: B.partIds().length };
}, { motionId, sectionId, plainView });

/* ------------------------------------------------------------------ geometry */

const vol = (b) => (b ? (b[1][0] - b[0][0]) * (b[1][1] - b[0][1]) * (b[1][2] - b[0][2]) : 0);
const overlap = (a, b) => {
  if (!a || !b) return 0;
  let v = 1;
  for (let k = 0; k < 3; k++) {
    const lo = Math.max(a[0][k], b[0][k]);
    const hi = Math.min(a[1][k], b[1][k]);
    if (hi <= lo) return 0;
    v *= hi - lo;
  }
  return v;
};

const centre = (b) => [0, 1, 2].map((k) => (b[0][k] + b[1][k]) / 2);

/**
 * Burial (mean fraction of a part's volume inside another) and enclosure (share
 * of parts almost entirely inside another) plus mean pairwise centroid
 * separation.
 *
 * Burial alone is a poor gate: it is strongly shape-dependent. A radial engine
 * stays high however well it separates, because nine cylinders arranged around
 * a case have overlapping axis-aligned boxes no matter where they sit. So the
 * pass/fail claims are the shape-robust ones — burial must fall, enclosure must
 * nearly vanish, and the parts must actually spread — with the raw burial
 * number reported for information.
 */
function measure(state, ids) {
  // Per instance, not per part — see the note on partState.
  const boxes = ids.flatMap((id) => state[id]?.boxes ?? []);
  if (boxes.length < 2) return { buried: 0, enclosed: 0, spread: 0 };

  let acc = 0, enclosed = 0;
  for (let i = 0; i < boxes.length; i++) {
    const own = vol(boxes[i]) || 1;
    let worst = 0;
    for (let j = 0; j < boxes.length; j++) {
      if (i === j) continue;
      worst = Math.max(worst, overlap(boxes[i], boxes[j]) / own);
    }
    acc += Math.min(worst, 1);
    if (worst >= 0.9) enclosed++;
  }

  const cs = boxes.map(centre);
  let sum = 0, pairs = 0;
  for (let i = 0; i < cs.length; i++) {
    for (let j = i + 1; j < cs.length; j++) {
      sum += Math.hypot(cs[i][0] - cs[j][0], cs[i][1] - cs[j][1], cs[i][2] - cs[j][2]);
      pairs++;
    }
  }
  return {
    buried: acc / boxes.length,
    enclosed: enclosed / boxes.length,
    spread: pairs ? sum / pairs : 0,
  };
}

/* -------------------------------------------------------- 1. it comes apart */

console.log(`\nexplode "${motionId}" — does it actually come apart?`);
{
  const share = sample.participating.length / sample.total;
  ok(share >= 0.6, 'at least 60% of parts carry an explode channel',
    `${sample.participating.length}/${sample.total} (${Math.round(share * 100)}%)`);

  const visibleAtRest = sample.participating.filter((id) => sample.rest[id]?.box);
  let moved = 0;
  let worstTravel = 0;
  for (const id of visibleAtRest) {
    const a = sample.rest[id].box, b = sample.blown[id]?.box;
    if (!b) continue;
    const d = Math.hypot(
      (b[0][0] + b[1][0]) / 2 - (a[0][0] + a[1][0]) / 2,
      (b[0][1] + b[1][1]) / 2 - (a[0][1] + a[1][1]) / 2,
      (b[0][2] + b[1][2]) / 2 - (a[0][2] + a[1][2]) / 2);
    if (d > 0.05) moved++;
    worstTravel = Math.max(worstTravel, d);
  }
  ok(moved >= visibleAtRest.length * 0.95,
    'every visible participating part translates',
    `${moved}/${visibleAtRest.length} moved, farthest ${worstTravel.toFixed(2)} scene units`);

  const ids = Object.keys(sample.rest);
  const a = measure(sample.rest, ids);
  const b = measure(sample.blown, ids);

  ok(b.spread > a.spread * 1.25,
    'parts spread apart, not merely translate together',
    `mean pairwise separation ${a.spread.toFixed(2)} → ${b.spread.toFixed(2)} ` +
    `(×${(b.spread / (a.spread || 1)).toFixed(2)})`);

  ok(b.buried < a.buried,
    'mean burial drops — the assembly opens rather than inflating',
    `${(a.buried * 100).toFixed(1)}% → ${(b.buried * 100).toFixed(1)}% ` +
    '(absolute level is shape-dependent; the drop is the claim)');

  // Some residual nesting is honest: a piston inside its bore needs to travel
  // most of a barrel length to come clear, and pushing every part that far
  // scatters the drawing. The bar is that enclosure largely resolves, not that
  // it vanishes — the exact figure is printed so a regression is visible.
  ok(b.enclosed <= 0.10 && b.enclosed <= a.enclosed * 0.4,
    'enclosure largely resolves — parts come out of what contained them',
    `${(a.enclosed * 100).toFixed(1)}% → ${(b.enclosed * 100).toFixed(1)}% of bodies`);

  ok(sample.traceVisible === true && sample.traceAtRest === false,
    'explode traces appear when exploded and not before',
    `at rest ${sample.traceAtRest}, exploded ${sample.traceVisible}`);
}

/* -------------------------------------------------- 2. internals are revealed */

if (sample.hidden.length) {
  console.log('\ninternals — hidden until a view or motion asks');
  const shownAtRest = sample.hidden.filter((id) => sample.rest[id]?.visible);
  ok(shownAtRest.length === 0,
    `all ${sample.hidden.length} internal parts are invisible on ${plainView.toUpperCase()}`,
    shownAtRest.length ? `leaking: ${shownAtRest.slice(0, 5).join(', ')}` : '');

  const shownBlown = sample.hidden.filter((id) => sample.blown[id]?.visible);
  ok(shownBlown.length === sample.hidden.length,
    `all internals appear on ${motionId.toUpperCase()}`,
    `${shownBlown.length}/${sample.hidden.length}`);

  if (sample.sectioned) {
    const shownSec = sample.hidden.filter((id) => sample.sectioned[id]?.visible);
    ok(shownSec.length === sample.hidden.length,
      `all internals appear on ${sectionId.toUpperCase()}`,
      `${shownSec.length}/${sample.hidden.length}`);
  }
} else {
  console.log('\n\x1b[2mno parts marked hidden — internals check skipped\x1b[0m');
}

await browser.close();

if (failures) {
  console.log(`\n\x1b[31m${failures} check(s) failed\x1b[0m`);
  process.exit(1);
}
console.log('\n\x1b[32mexplode checks passed\x1b[0m');
