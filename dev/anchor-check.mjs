/**
 * Verifies the two annotation principles that are easy to claim and easy to
 * silently break:
 *
 *   1. The leader's exit point is a real point ON the component, and it SLIDES
 *      across that component's surface as the viewpoint changes.
 *   2. The leader does NOT follow a part that is spinning or reciprocating
 *      during a motion demo.
 *
 * This script used to print those numbers and exit 0 whatever they said — it
 * would happily report "(FOLLOWING THE PART)" and still pass. As a CI gate that
 * is worse than nothing: it looks like the principle is guarded when it is not.
 * It now asserts.
 *
 *   node dev/anchor-check.mjs <page.html> [--motion drive] [--ready-timeout ms]
 */
import puppeteer from 'puppeteer';
import { pathToFileURL } from 'node:url';
import { CHROME_FLAGS } from './shot.mjs';

/* ------------------------------------------------------------- thresholds */

/**
 * A leader that moves with its part has failed principle 2 outright. Two pixels
 * is the noise floor of the annotation solver's own rounding, not a tolerance
 * for drift.
 */
const MAX_TRAVEL_PX = 2;

/**
 * Not every anchor should slide. Some parts present nearly the same face across
 * the whole probe orbit, and holding still is the correct answer there — on
 * `mbt-mk6` 10 of 16 slide, on `radial-engine` 12 of 12. Half is a floor that
 * catches the real regression (anchors nailed to a fixed local point) without
 * failing on shape.
 */
const MIN_SLID_SHARE = 0.5;

/* ------------------------------------------------------------------- args */

const file = process.argv[2];
if (!file) {
  console.error('usage: node dev/anchor-check.mjs <page.html> [--motion id] [--ready-timeout ms]');
  process.exit(1);
}
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const motionId = arg('motion', null);
// Software rendering on a CI runner is far slower than a local GPU; 30 s was
// enough here and not on ubuntu-latest, which is a property of the runner
// rather than of the page.
const readyTimeout = Number(arg('ready-timeout', 120000));

let failures = 0;
const fail = (msg) => { failures++; console.log(`  \x1b[31mx\x1b[0m ${msg}`); };
const pass = (msg) => console.log(`  \x1b[32m-\x1b[0m ${msg}`);

/* ------------------------------------------------------------------- probe */

// A single page.evaluate here drives hundreds of animation frames, each with an
// annotation re-solve. Puppeteer's default protocolTimeout is 180 s, which is
// ample on a GPU and not on a CI runner falling back to software rendering -
// where this surfaces as an opaque ProtocolError rather than a slow pass.
const PROTOCOL_TIMEOUT = 900000;
const browser = await puppeteer.launch({ headless: true, args: CHROME_FLAGS, protocolTimeout: PROTOCOL_TIMEOUT });
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error(`  page error: ${e.message}`));
  await page.setViewport({ width: 1600, height: 950, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(file).href, { waitUntil: 'load' });

  const t0 = Date.now();
  try {
    await page.waitForFunction('window.__B2D__ && window.__B2D__.ready', { timeout: readyTimeout });
  } catch {
    console.error(`the page never became ready within ${readyTimeout} ms ` +
                  `(WebGL may be unavailable, or this renderer is very slow)`);
    process.exitCode = 1;
    throw new Error('page not ready');
  }
  console.log(`page ready in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

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
  if (!slide.count) {
    fail('no callouts were found on the page at all');
  } else {
    const share = slide.slid / slide.count;
    const line = `${slide.slid}/${slide.count} callouts moved their anchor across the surface ` +
                 `when the viewpoint changed (${(share * 100).toFixed(0)}%)`;
    if (share >= MIN_SLID_SHARE) pass(line);
    else fail(`${line} — below the ${(MIN_SLID_SHARE * 100).toFixed(0)}% floor; ` +
              `anchors may be nailed to a fixed local point`);
  }

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

    console.log(`\nprinciple 2 — leaders ignore the "${motionId}" motion:`);
    const line = `worst anchor travel while the motion runs: ${held.worst.toFixed(2)}px ` +
                 `over ${held.n} leaders`;
    if (!held.n) {
      fail(`${line} — no visible leaders to measure, so nothing was actually checked`);
    } else if (held.worst < MAX_TRAVEL_PX) {
      pass(`${line} (held still)`);
    } else {
      fail(`${line} — FOLLOWING THE PART; leaders must resolve above the animation channels`);
    }
  }
} finally {
  // Without this a thrown probe leaves a headless Chrome running and the
  // failure arrives as an unhandled rejection with no useful message.
  await browser.close();
}

if (failures) {
  console.log(`\n\x1b[31manchor checks failed\x1b[0m — ${failures} principle(s) violated`);
  process.exit(1);
}
console.log('\n\x1b[32manchor checks passed\x1b[0m');
