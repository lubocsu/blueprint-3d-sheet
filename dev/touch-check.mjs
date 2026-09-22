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
 * Plus one case that is neither a phone nor a desk — a narrow window with a
 * mouse — because that is where the stylesheet's idea of the layout and the
 * runtime's idea of it can disagree while neither looks wrong on its own.
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

/**
 * Wait for the page to actually PAINT, not for a stopwatch.
 *
 * The two things a tap changes are written at different moments: the legend
 * highlight lands synchronously inside `onHover`, while the card that names the
 * part is drawn by the main loop on its next frame. Read in between and you see
 * a card from the previous tap over a legend that has already moved on.
 *
 * Sleeping long enough is not a fix, it is the same race with better odds —
 * and the odds are worst exactly where it matters, since headless Chrome
 * throttles rAF hard and its software renderer is slower again. Two frames is
 * the actual condition.
 */
const painted = (p = page) => p.evaluate(() => new Promise((r) => {
  // Raced against a timer so a page that stops painting fails an assertion
  // instead of hanging the job until the runner's timeout.
  const done = setTimeout(r, 2000);
  requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(done); r(); }));
}));

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

/*
 * A FRESH PAGE, and an AIMED tap.
 *
 * Two things were wrong with doing this on the page the gestures ran on.
 *
 * It inherited that page's state. The pinch left the zoom at 0.43 and a
 * `touchEnd` carrying no points, and whether the runtime's pointer map came
 * back empty from that is the browser's business, not something to assume — one
 * stale entry and every later press is a second finger, so `dragging` is false
 * and no tap is ever recognised. Compensating with a zoom reset papered over
 * half of that. A new page has no state to inherit.
 *
 * And it aimed blind. A 63-point grid across the middle band, hoping something
 * was under one of them — which depends on the subject's proportions, the
 * framing, and how much of the sheet the drawing fills, all of which this
 * branch changed. When it missed, the report was "nothing hit", which says
 * nothing about why.
 *
 * Now the page is asked where the parts ARE: each callout's anchor part is
 * projected to screen through the live camera, and those points are tapped. A
 * miss now means the pick is broken, which is what this is supposed to detect.
 */
console.log('\npicking — the tap is the hover, and it stays put');

const pick = await browser.newPage();
const pickErrors = [];
pick.on('pageerror', (e) => pickErrors.push(String(e)));
await pick.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
await pick.goto(pathToFileURL(resolve(page$)).href, { waitUntil: 'load', timeout: 60000 });
await pick.waitForFunction('window.__B2D__ && window.__B2D__.ready', { timeout: 30000 });
await settle(1600);

const pickCdp = await pick.createCDPSession();
const readPick = () => pick.evaluate(() => ({
  card: document.getElementById('hoverCard').classList.contains('show'),
  part: document.getElementById('hoverCard').querySelector('.n')?.textContent ?? '',
  hotRows: document.querySelectorAll('#key .item.hot').length,
}));

/**
 * Tap, then wait for the CONDITION rather than for a duration.
 *
 * The legend highlight lands synchronously inside `onHover`; the card naming
 * the part is drawn by the main loop on a later frame. How much later is not
 * knowable from here — a shared CI runner rendering through SwiftShader with
 * rAF throttled is an order of magnitude off a laptop, and every attempt to
 * pick a sleep that covers it has been a guess that held locally and broke
 * there. So this polls until the card says what the tap should have made it
 * say, and gives up on a deadline rather than on a frame count.
 *
 * @param {boolean} want - whether the card should end up showing
 */
const tap = async (x, y, want = true, deadlineMs = 4000) => {
  await pickCdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
  await pickCdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const until = Date.now() + deadlineMs;
  let s = await readPick();
  while (s.card !== want && Date.now() < until) {
    await settle(120);
    s = await readPick();
  }
  return s;
};

/** Every numbered part's centre, in screen pixels, as the page sees it now. */
const targets = await pick.evaluate(() => {
  const B = window.__B2D__;
  const V = B.stage.camera.position.constructor;
  const nameOf = new Map(B.spec.parts.map((p) => [p.id, p.name]));
  const out = [];
  for (const c of B.spec.annotations?.callouts ?? []) {
    const st = B.partState(c.anchor);
    if (!st?.visible || !st.box) continue;
    const [mn, mx] = st.box;
    const v = new V((mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2);
    v.project(B.stage.camera);
    const x = (v.x * 0.5 + 0.5) * innerWidth;
    const y = (-v.y * 0.5 + 0.5) * innerHeight;
    if (x < 12 || x > innerWidth - 12 || y < 12 || y > innerHeight - 12) continue;
    out.push({ id: c.anchor, name: nameOf.get(c.anchor) ?? c.anchor, x: Math.round(x), y: Math.round(y) });
  }
  return out;
});

const anchored = new Set(await pick.evaluate(() =>
  (window.__B2D__.spec.annotations?.callouts ?? []).map((c) => c.anchor)));
const idOfName = await pick.evaluate(() =>
  Object.fromEntries(window.__B2D__.spec.parts.map((p) => [p.name, p.id])));

/*
   A point on the canvas with no model under it: below the drawing, above the
   toolbar. Tapping it is how the selection is CLEARED between targets.

   That clearing is not tidiness, it is what makes the wait mean anything. The
   card is already showing after the first hit, so "wait until the card shows"
   is satisfied before the next tap has been processed at all — and the read
   comes back with the previous part's name against the new part's highlight.
   That is how this managed to report a part as unnumbered while pointing at a
   numbered one. Clear first, and every wait is a real transition.
*/
const BARE = { x: 195, y: 700 };

let hit = null;
let anchoredHit = null;
const named = [];
for (const t of targets) {
  await tap(BARE.x, BARE.y, false);
  const s = await tap(t.x, t.y);
  if (!s.card) continue;
  named.push(s.part);
  hit ??= { ...t, ...s };
  // The tap lands on whatever surface is nearest the camera at that point,
  // which need not be the part aimed at — so what matters is whether the part
  // it DID name carries a balloon.
  if (anchored.has(idOfName[s.part])) { anchoredHit = { ...t, ...s }; break; }
}

ok(!!hit, 'a tap on the model names the part',
  hit ? `"${hit.part}"` : `${targets.length} numbered part(s) aimed at, none named anything`);
ok(!!anchoredHit && anchoredHit.hotRows === 1,
  'a tap on a numbered part lights exactly its legend row',
  anchoredHit
    ? `"${anchoredHit.part}" -> ${anchoredHit.hotRows} row(s)`
    : `named ${named.length ? named.join(', ') : 'nothing'} — none of them numbered`);

if (hit) {
  // Long enough that a per-frame pick, if one were running, would have cleared
  // it several dozen times over.
  await settle(1200);
  ok((await readPick()).card, 'the card stays up with no finger on the glass');

  ok(!(await tap(BARE.x, BARE.y, false)).card, 'a tap on bare paper clears it');

  /*
     A press that stays put is a tap however long it is held.

     There used to be a 400ms limit here, on the theory that a longer press was
     a drag that happened to end where it began — but `moved` is a path length,
     so such a drag already fails on the distance it covered and the limit was
     only discarding slow deliberate taps. On a phone that is a page ignoring
     you; and it is what made every tap vanish on CI, where the round trip
     between the two dispatched events is itself longer than the limit.
  */
  const slow = await (async () => {
    await tap(BARE.x, BARE.y, false);
    await pickCdp.send('Input.dispatchTouchEvent',
      { type: 'touchStart', touchPoints: [{ x: hit.x, y: hit.y, id: 1 }] });
    await settle(900);
    await pickCdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    const until = Date.now() + 4000;
    let s = await readPick();
    while (!s.card && Date.now() < until) { await settle(120); s = await readPick(); }
    return s;
  })();
  ok(slow.card, 'a press held still for nearly a second is still a tap',
    slow.card ? `named "${slow.part}"` : 'discarded');
}

ok(pickErrors.length === 0, 'nothing threw while picking', pickErrors.slice(0, 2).join(' | '));
await pick.close();

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

/* --------------------------------------------------- numbering and framing */

/*
 * The one overlay that starts OFF on a narrow upright sheet, and the framing
 * that is coupled to it.
 *
 * `DEFAULT_FIT` is 0.78 because the balloon gutters take the rest, and the
 * gutters are horizontal — so on a phone a fifth of the only scarce axis is
 * being held for balloons nobody has asked for yet. Switching the numbering
 * back on has to hand that width straight back, or the drawing would keep the
 * space and the balloons would be laid out over it.
 */
console.log('\nnumbering — off by default here, and the framing knows');
{
  const width = () => page.evaluate(() => {
    const B = window.__B2D__;
    const [mn, mx] = B.fitBoxes().rest;
    const V = B.stage.camera.position.constructor;
    const xs = [];
    for (const x of [mn[0], mx[0]]) for (const y of [mn[1], mx[1]]) for (const z of [mn[2], mx[2]]) {
      const v = new V(x, y, z); v.project(B.stage.camera);
      xs.push((v.x * 0.5 + 0.5) * innerWidth);
    }
    return (Math.max(...xs) - Math.min(...xs)) / innerWidth;
  });
  const balloons = () => page.evaluate(() =>
    [...document.querySelectorAll('#ann .balloon')].filter((c) => c.style.display !== 'none').length);

  // The pinch above left the zoom wherever the last gesture put it, and every
  // number below is a fraction of the viewport — so the zoom is wound back to 1
  // explicitly. It used to be reset as a side effect of the picking section,
  // which is exactly the kind of order dependency that makes a check pass for a
  // reason nobody wrote down.
  await page.evaluate(() => {
    window.__B2D__.setView('iso');
    window.__B2D__.zoom(1 / window.__B2D__.viewCtl.state.zoom);
  });
  await settle(1600);
  const offOn = await page.evaluate(() => window.__B2D__.layerOn('callouts'));
  const wideFill = await width();
  ok(offOn === false, 'the numbering starts off on a narrow upright sheet');
  ok(wideFill > 0.88, 'and the drawing has the gutter margin back',
    `${Math.round(wideFill * 100)}% of the width`);
  ok(wideFill <= 1, 'without being cropped by it', `${Math.round(wideFill * 100)}%`);

  await page.evaluate(() => window.__B2D__.setLayer('callouts', true));
  await settle(1800);
  const backFill = await width();
  const n = await balloons();
  ok(n > 0, 'one press brings the balloons back', `${n} drawn`);
  ok(backFill < wideFill - 0.05, 'and the framing gives the gutters their width again',
    `${Math.round(wideFill * 100)}% -> ${Math.round(backFill * 100)}%`);

  await page.evaluate(() => window.__B2D__.setLayer('callouts', false));
  await settle(900);
}

/* ------------------------------------------------- a narrow window, a mouse */

/*
 * The case that is neither a desk nor a phone, and is therefore the one nobody
 * looks at: a narrow viewport driven by a POINTER THAT HOVERS. A resized
 * desktop window, a small laptop, a tablet with a trackpad.
 *
 * It earned its own section by producing a real defect. The stylesheet docks
 * the hover card to an edge below 768px, using `bottom`; the runtime placed it
 * under the pointer using `top`. The runtime decided which to do by asking
 * whether the pointer was coarse, and the stylesheet by asking how wide the
 * window was — two different questions that agree on a phone and on a desk and
 * disagree exactly here. A `position: fixed` box given both a top and a bottom
 * stretches to span them, so the card naming one part became half the screen.
 *
 * Both now read one declaration, `--card-docked`. This is what says they still
 * do — and note that the coarse-pointer checks above would never have caught
 * it, because a phone is one of the two cases where the two questions agree.
 */
console.log('\na narrow window with a mouse — where the two layout opinions meet');
{
  const narrow = await browser.newPage();
  const narrowErrors = [];
  narrow.on('pageerror', (e) => narrowErrors.push(String(e)));
  // Deliberately NOT hasTouch: this pointer hovers.
  await narrow.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await narrow.goto(pathToFileURL(resolve(page$)).href, { waitUntil: 'load', timeout: 60000 });
  await narrow.waitForFunction('window.__B2D__ && window.__B2D__.ready', { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1400));

  let card = null;
  for (let y = 330; y < 620 && !card; y += 22) {
    for (let x = 110; x < 290; x += 26) {
      await narrow.mouse.move(x, y);
      // Same reason as the tap sweep above: the card is drawn by the main loop,
      // so a frame has to have gone by before there is anything to measure.
      await painted(narrow);
      card = await narrow.evaluate(() => {
        const c = document.getElementById('hoverCard');
        if (!c.classList.contains('show')) return null;
        const r = c.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), vh: innerHeight };
      });
      if (card) break;
    }
  }

  if (!card) {
    ok(false, 'a part could be hovered at this width', 'nothing hit across the sweep');
  } else {
    const share = card.h / card.vh;
    ok(share < 0.25, 'the card that names a part stays a card',
      `${card.w}x${card.h} = ${Math.round(share * 100)}% of the viewport height`);
  }
  ok(narrowErrors.length === 0, 'nothing threw at this width', narrowErrors.slice(0, 2).join(' | '));
  await narrow.close();
}

console.log('\nno runtime errors');
ok(errors.length === 0, 'the page threw nothing throughout', errors.slice(0, 2).join(' | '));

await browser.close();

console.log(failures
  ? `\n\x1b[31m${failures} touch check(s) failed\x1b[0m`
  : '\n\x1b[32mtouch checks passed\x1b[0m');
process.exit(failures ? 1 : 0);
