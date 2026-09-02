/**
 * Verifies the two annotation principles that are easy to claim and easy to
 * silently break:
 *
 *   1. The leader's exit point is a real point ON the component, and it SLIDES
 *      across that component's surface as the viewpoint changes.
 *   2. The leader does NOT follow a part that is spinning or reciprocating
 *      during a motion demo.
 *
 *   node dev/anchor-check.mjs <page.html> [--motion drive]
 */
import puppeteer from 'puppeteer';
import { pathToFileURL } from 'node:url';
import { CHROME_FLAGS } from './shot.mjs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node dev/anchor-check.mjs <page.html> [--motion id]');
  process.exit(1);
}
const mi = process.argv.indexOf('--motion');
const motionId = mi >= 0 ? process.argv[mi + 1] : null;

const browser = await puppeteer.launch({ headless: true, args: CHROME_FLAGS });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 950, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(file).href, { waitUntil: 'load' });
await page.waitForFunction('window.__B2D__ && window.__B2D__.ready', { timeout: 30000 });

const settle = (n) => page.evaluate((c) => new Promise((r) => {
  let i = 0;
  const t = () => (++i >= c ? r() : requestAnimationFrame(t));
  requestAnimationFrame(t);
}), n);

/* ---- principle 1: the exit point slides over the surface --------------- */

const slide = await page.evaluate(async (settleFrames) => {
  const B = window.__B2D__;
  const wait = (n) => new Promise((r) => {
    let i = 0;
    const t = () => (++i >= n ? r() : requestAnimationFrame(t));
    requestAnimationFrame(t);
  });

  // Read the chosen anchor in the part's own local frame, which is where
  // "slid across the surface" is actually meaningful — screen movement alone
  // would also happen if the point were nailed down.
  const readLocals = () => {
    const out = [];
    for (const c of B.annotationCallouts ?? []) {
      out.push(c.chosen ? [c.chosen.x, c.chosen.y, c.chosen.z] : null);
    }
    return out;
  };

  B.setView('iso');
  await wait(settleFrames);
  const start = readLocals();

  const moved = new Array(start.length).fill(0);
  for (let step = 0; step < 6; step++) {
    B.orbit(55, 6);
    await wait(settleFrames);
    const now = readLocals();
    for (let i = 0; i < now.length; i++) {
      if (!now[i] || !start[i]) continue;
      const d = Math.hypot(now[i][0] - start[i][0], now[i][1] - start[i][1], now[i][2] - start[i][2]);
      moved[i] = Math.max(moved[i], d);
    }
  }
  return { count: start.length, moved, slid: moved.filter((m) => m > 1e-6).length };
}, 70);

console.log('principle 1 — exit point slides on the component:');
console.log(`  ${slide.slid}/${slide.count} callouts moved their anchor across the surface ` +
            `when the viewpoint changed`);

/* ---- principle 2: leaders ignore moving parts -------------------------- */

if (motionId) {
  const held = await page.evaluate(async ({ id, settleFrames }) => {
    const B = window.__B2D__;
    const wait = (n) => new Promise((r) => {
      let i = 0;
      const t = () => (++i >= n ? r() : requestAnimationFrame(t));
      requestAnimationFrame(t);
    });
    const dots = () => [...document.querySelectorAll('#ann .anchorDot')]
      .filter((d) => d.style.display !== 'none')
      .map((d) => [+d.getAttribute('cx'), +d.getAttribute('cy')]);

    B.setView('iso');
    B.clearMotions();
    await wait(settleFrames);
    B.setMotion(id, true);
    await wait(settleFrames);          // let the motion spin up AND resettle

    const a = dots();
    await wait(45);                    // parts are moving hard through here
    const c = dots();

    let worst = 0;
    for (let i = 0; i < Math.min(a.length, c.length); i++) {
      worst = Math.max(worst, Math.hypot(a[i][0] - c[i][0], a[i][1] - c[i][1]));
    }
    return { worst, n: Math.min(a.length, c.length) };
  }, { id: motionId, settleFrames: 70 });

  console.log(`principle 2 — leaders ignore the "${motionId}" motion:`);
  console.log(`  worst anchor travel while the motion runs: ${held.worst.toFixed(2)}px ` +
              `over ${held.n} leaders  ${held.worst < 2 ? '(held still)' : '(FOLLOWING THE PART)'}`);
}

await browser.close();
