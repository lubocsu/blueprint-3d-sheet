/**
 * Motion-quality probe for the annotation layer.
 *
 * The balloons are laid out fresh every frame, so the thing that actually
 * matters is whether that layout is a CONTINUOUS function of the camera. This
 * spins the model and reports how far each balloon travels per frame: a smooth
 * layout shows a tight distribution with no outliers, a chattering one shows
 * large spikes where a balloon jumped from one gutter to another.
 *
 *   node dev/smoothness.mjs <page.html> [--deg 1] [--frames 240]
 */
import puppeteer from 'puppeteer';
import { pathToFileURL } from 'node:url';
import { CHROME_FLAGS } from './shot.mjs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node dev/smoothness.mjs <page.html> [--deg N] [--frames N]');
  process.exit(1);
}
const flag = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? Number(process.argv[i + 1]) : d;
};
const degPerFrame = flag('deg', 1);
const frames = flag('frames', 240);

// A single page.evaluate here drives hundreds of animation frames, each with an
// annotation re-solve. Puppeteer's default protocolTimeout is 180 s, which is
// ample on a GPU and not on a CI runner falling back to software rendering -
// where this surfaces as an opaque ProtocolError rather than a slow pass.
const PROTOCOL_TIMEOUT = 900000;
const browser = await puppeteer.launch({ headless: true, args: CHROME_FLAGS, protocolTimeout: PROTOCOL_TIMEOUT });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 950, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(file).href, { waitUntil: 'load' });
await page.waitForFunction('window.__B2D__ && window.__B2D__.ready', { timeout: 30000 });

const res = await page.evaluate(async ({ degPerFrame, frames }) => {
  const B = window.__B2D__;
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  // Position of every VISIBLE balloon, keyed by index, so a balloon that was
  // simply hidden never masquerades as a jump when it returns.
  const snap = () => {
    const out = new Map();
    document.querySelectorAll('#ann .balloon').forEach((c, i) => {
      if (c.style.display === 'none') return;
      out.set(i, [+c.getAttribute('cx'), +c.getAttribute('cy')]);
    });
    return out;
  };

  B.setView('iso');
  for (let i = 0; i < 60; i++) await nextFrame();

  let prev = snap();
  const jumps = [];
  for (let s = 0; s < frames; s++) {
    B.viewCtl.nudge(degPerFrame, 0);
    await nextFrame();
    const cur = snap();
    for (const [k, p] of cur) {
      const q = prev.get(k);
      if (!q) continue;                  // just became visible: not a jump
      jumps.push(Math.hypot(p[0] - q[0], p[1] - q[1]));
    }
    prev = cur;
  }
  jumps.sort((a, b) => a - b);
  const at = (f) => jumps[Math.min(jumps.length - 1, Math.floor(f * jumps.length))] ?? 0;
  return {
    samples: jumps.length,
    median: at(0.5), p95: at(0.95), p99: at(0.99),
    max: jumps[jumps.length - 1] ?? 0,
    over40: jumps.filter((j) => j > 40).length,
  };
}, { degPerFrame, frames });

await browser.close();

console.log(`spin ${degPerFrame}deg/frame x ${frames} frames, ${res.samples} samples`);
console.log(`  median ${res.median.toFixed(1)}px  p95 ${res.p95.toFixed(1)}px  ` +
            `p99 ${res.p99.toFixed(1)}px  max ${res.max.toFixed(1)}px`);
console.log(`  jumps over 40px: ${res.over40} (${(100 * res.over40 / Math.max(res.samples, 1)).toFixed(2)}%)`);

/* ---------------------------------------------------------------- assert */

// This script used to print these numbers and exit 0 whatever they said. The
// whole point of deferred regeneration is that the layer does not move while
// the picture does, so that claim is now guarded rather than merely reported.
//
// The layer is frozen during a spin, so the honest expectation is exactly zero
// movement. One pixel of headroom covers the solver's own rounding without
// admitting the failure this measures: annotations sweeping across the drawing.
const MAX_JUMP_PX = 1;

let failures = 0;
if (!res.samples) {
  console.log(`
  [31mx[0m no samples collected - nothing was actually measured`);
  failures++;
}
for (const [label, value] of [['median', res.median], ['p95', res.p95], ['p99', res.p99], ['max', res.max]]) {
  if (value >= MAX_JUMP_PX) {
    console.log(`  [31mx[0m ${label} travel ${value.toFixed(1)}px exceeds ${MAX_JUMP_PX}px - ` +
                `the annotation layer is moving while the picture moves`);
    failures++;
  }
}

if (failures) {
  console.log(`
[31msmoothness check failed[0m`);
  process.exit(1);
}
console.log(`
[32mannotation layer held still[0m`);
