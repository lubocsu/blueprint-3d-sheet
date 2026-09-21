/**
 * Offline verification for the touch layer.
 *
 * A touchscreen is the one input this page cannot be checked by looking at it,
 * and the failure mode is total: get `touch-action` wrong and the browser
 * claims the second finger for a page zoom, `pointercancel` arrives mid-gesture
 * and pinch does nothing — on a desk, with a mouse, everything still works
 * perfectly and nobody notices for a release.
 *
 * So the gestures are dispatched here as REAL touch events, through the
 * devtools protocol, against a real built page in a viewport with touch
 * emulation on. Synthetic `PointerEvent`s would not do: they skip the browser's
 * own gesture arbitration, which is the part most likely to be wrong.
 *
 * What has to hold:
 *
 *   one finger orbits        the same drag a mouse does
 *   two fingers scale        apart is closer, together is further
 *   a tap names a part       there is no hover to do it instead
 *   a tap STAYS              a finger is not on the glass between taps, so a
 *                            per-frame pick would clear the card instantly
 *   bare paper clears it     and nothing else does
 *
 *   node dev/touch-check.mjs out/mbt-mk6/index.html
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer';
import { CHROME_FLAGS } from './shot.mjs';

const args = process.argv.slice(2);
const page$ = args.find((a) => !a.startsWith('--')) ?? 'out/mbt-mk6/index.html';

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (cond) console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`);
  else { failures++; console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`); }
};

const browser = await puppeteer.launch({ headless: true, args: CHROME_FLAGS });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

// A phone, declared as one: `hasTouch` is what makes the events below arrive as
// touch rather than as mouse, and `isMobile` is what makes the stylesheet's
// coarse-pointer rules apply.
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
await page.goto(pathToFileURL(resolve(page$)).href, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction('window.__B2D__ && window.__B2D__.ready', { timeout: 30000 });
await new Promise((r) => setTimeout(r, 1200));

const cdp = await page.createCDPSession();
const touch = (type, pts = []) => cdp.send('Input.dispatchTouchEvent', {
  type,
  touchPoints: pts.map(([x, y], i) => ({ x, y, id: i + 1 })),
});
const settle = (ms = 260) => new Promise((r) => setTimeout(r, ms));

const read = () => page.evaluate(() => ({
  az: +window.__B2D__.viewCtl.state.az.toFixed(2),
  zoom: +window.__B2D__.viewCtl.state.zoom.toFixed(3),
  card: document.getElementById('hoverCard').classList.contains('show'),
  part: document.getElementById('hoverCard').querySelector('.n')?.textContent ?? '',
  hotRows: document.querySelectorAll('#key .item.hot').length,
}));

/* --------------------------------------------------------- gestures */

console.log('\ngestures — a finger does what a mouse does, by different means');
{
  const before = await read();
  await touch('touchStart', [[195, 430]]);
  await touch('touchMove', [[255, 430]]);
  await touch('touchMove', [[300, 430]]);
  await touch('touchEnd');
  const after = await read();
  ok(Math.abs(after.az - before.az) > 5, 'one finger orbits',
    `az ${before.az} -> ${after.az}`);
}
{
  const before = await read();
  await touch('touchStart', [[160, 430], [230, 430]]);
  await touch('touchMove', [[120, 430], [270, 430]]);
  await touch('touchMove', [[80, 430], [310, 430]]);
  await touch('touchEnd');
  const after = await read();
  ok(after.zoom > before.zoom * 1.2, 'fingers apart bring it closer',
    `zoom ${before.zoom} -> ${after.zoom}`);

  await touch('touchStart', [[80, 430], [310, 430]]);
  await touch('touchMove', [[140, 430], [250, 430]]);
  await touch('touchMove', [[180, 430], [210, 430]]);
  await touch('touchEnd');
  const back = await read();
  ok(back.zoom < after.zoom * 0.85, 'fingers together take it away',
    `zoom ${after.zoom} -> ${back.zoom}`);
}

/* ------------------------------------------------------------ picking */

console.log('\npicking — the tap is the hover, and it stays put');

await page.evaluate(() => {
  window.__B2D__.setView('iso');
  window.__B2D__.zoom(1 / window.__B2D__.viewCtl.state.zoom);
});
await settle(1400);

// Which parts carry a balloon, so the legend assertion below is only made where
// there is a legend row to light. A part with no callout lighting nothing is
// correct, not a miss.
const anchored = new Set(await page.evaluate(() =>
  (window.__B2D__.spec.annotations?.callouts ?? []).map((c) => c.anchor)));
const nameOf = await page.evaluate(() =>
  Object.fromEntries(window.__B2D__.spec.parts.map((p) => [p.name, p.id])));

// Sweep the middle band rather than trusting one coordinate: the framing
// depends on the subject's proportions and this file is run against whichever
// sheet it is handed.
let hit = null;
let anchoredHit = null;
for (let y = 380; y <= 500 && !anchoredHit; y += 20) {
  for (let x = 120; x <= 280; x += 20) {
    await touch('touchStart', [[x, y]]);
    await touch('touchEnd');
    await settle(150);
    const s = await read();
    if (!s.card) continue;
    hit ??= { x, y, ...s };
    if (anchored.has(nameOf[s.part])) { anchoredHit = { x, y, ...s }; break; }
  }
}

ok(!!hit, 'a tap on the model names the part', hit ? `"${hit.part}"` : 'nothing hit');
ok(!!anchoredHit && anchoredHit.hotRows === 1,
  'a tap on a numbered part lights exactly its legend row',
  anchoredHit ? `"${anchoredHit.part}" -> ${anchoredHit.hotRows} row(s)` : 'no numbered part was hit');

if (hit) {
  // Long enough that a per-frame pick, if one were running, would have cleared
  // it several dozen times over.
  await settle(1200);
  ok((await read()).card, 'the card stays up with no finger on the glass');

  await touch('touchStart', [[12, 300]]);
  await touch('touchEnd');
  await settle(300);
  ok(!(await read()).card, 'a tap on bare paper clears it');
}

/* ------------------------------------------------------------- layout */

console.log('\nlayout — what a coarse pointer gets instead of hover');
{
  const probe = await page.evaluate(() => {
    const b = document.querySelector('#console [data-group="view"] .btn');
    const label = b?.querySelector('.btnLabel');
    const cs = label && getComputedStyle(label);
    const sheet = document.getElementById('sheet');
    return {
      // Hidden by a clip path on a desk; on a touchscreen it has to be readable,
      // because there is no tooltip to carry the name instead.
      labelVisible: !!cs && cs.clipPath === 'none' && cs.position === 'static',
      labelText: label?.textContent ?? '',
      touchAction: getComputedStyle(document.getElementById('stage')).touchAction,
      hint: document.getElementById('hint')?.textContent ?? '',
      panelsShut: ['key', 'instr', 'tb']
        .every((k) => sheet.getAttribute(`data-panel-${k}`) === 'shut'),
      overlay: getComputedStyle(sheet).getPropertyValue('--panel-overlay').trim(),
    };
  });
  ok(probe.touchAction === 'none', 'the canvas takes every gesture', `touch-action: ${probe.touchAction}`);
  ok(probe.labelVisible && probe.labelText.length > 0,
    'console buttons show their name, not just a glyph', `"${probe.labelText}"`);
  ok(probe.panelsShut, 'the panels start folded at this width');
  ok(probe.overlay === 'yes', 'and open over the drawing rather than beside it');
}

console.log('\nno runtime errors');
ok(errors.length === 0, 'the page threw nothing throughout', errors.slice(0, 2).join(' | '));

await browser.close();

console.log(failures
  ? `\n\x1b[31m${failures} touch check(s) failed\x1b[0m`
  : '\n\x1b[32mtouch checks passed\x1b[0m');
process.exit(failures ? 1 : 0);
