/**
 * The chrome lab's controls.
 *
 * Everything here drives a built page through the two doors it already opens:
 * the `data-chrome` attribute on `#sheet`, and `window.__B2D__`, which is the
 * same surface `selftest` drives. Nothing is simulated and nothing is stubbed —
 * if a layout looks right in here it will look the same in the file, because it
 * IS the file.
 *
 * Same-origin is the only requirement, which is why this is served by
 * `dev/serve.mjs` from the repository root rather than opened off a file:// path.
 */

const VARIANTS = [
  ['a', 'a · quiet yield', 'the sheet in full; it steps aside while you move it'],
  ['b', 'b · instrument rail', 'handles rack on the left edge, toolbar centred'],
  ['c', 'c · viewport first', 'nothing but the drawing until you ask'],
];

const SIZES = [
  [1600, 950, 'desktop'],
  [1280, 800, 'laptop'],
  [834, 1112, 'tablet · portrait'],
  [390, 844, 'phone · portrait'],
  [740, 360, 'phone · landscape'],
];

const SHEETS = [
  ['/out/mbt-mk6/index.html', 'mbt-mk6', '16 callouts, 7 views, 6 motions'],
  ['/out/radial-engine/index.html', 'radial-engine', '12 callouts, nearly cubic'],
];

const frame = document.getElementById('frame');
const shell = document.getElementById('shell');
const caption = document.getElementById('caption');
const warn = document.getElementById('warn');

const state = {
  variant: 'a',
  size: SIZES[0],
  sheet: SHEETS[0][0],
  lang: null,
};

const say = (msg) => {
  warn.hidden = !msg;
  warn.textContent = msg ?? '';
};

/** The built page's own runtime, once it has finished starting up. */
function api() {
  try { return frame.contentWindow?.__B2D__?.ready ? frame.contentWindow.__B2D__ : null; }
  catch { return null; }
}
const sheetEl = () => {
  try { return frame.contentDocument?.getElementById('sheet') ?? null; }
  catch { return null; }
};

/* ------------------------------------------------------------------ buttons */

function buttons(host, items, isOn, onPick) {
  host.textContent = '';
  for (const it of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.append(it.label);
    if (it.hint) {
      const h = document.createElement('span');
      h.className = 'hint';
      h.textContent = it.hint;
      b.append(h);
    }
    b.addEventListener('click', () => { onPick(it); render(); });
    b.dataset.value = String(it.value);
    host.append(b);
  }
  paintPressed(host, isOn);
}

function paintPressed(host, isOn) {
  for (const b of host.querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(!!isOn(b.dataset.value)));
  }
}

/* -------------------------------------------------------------------- frame */

function fitShell() {
  const [w, h] = state.size;
  shell.style.width = `${w}px`;
  shell.style.height = `${h}px`;
  const box = shell.parentElement.parentElement.getBoundingClientRect();
  // Scale, never resize: the stylesheet's breakpoints have to evaluate against
  // the width on the label, not against this window's spare room.
  const k = Math.min((box.width - 40) / w, (box.height - 70) / h, 1);
  shell.style.transform = `scale(${k})`;
  shell.parentElement.style.width = `${w * k}px`;
  shell.parentElement.style.height = `${h * k}px`;
  caption.textContent = `${w} x ${h} · ${state.size[2]} · layout ${state.variant} · ${k < 1 ? `${Math.round(k * 100)}%` : '1:1'}`;
}

function applyToFrame() {
  const el = sheetEl();
  if (el) el.setAttribute('data-chrome', state.variant);
  const b2d = api();
  if (b2d && state.lang && b2d.locale !== state.lang) b2d.setLocale(state.lang);
  renderLangs();
  renderDrive();
}

function render() {
  fitShell();
  const want = state.sheet + (state.lang ? `?lang=${state.lang}` : '');
  if (!frame.src.endsWith(want)) {
    frame.src = want;
  } else {
    applyToFrame();
  }
  paintPressed(document.getElementById('variants'), (v) => v === state.variant);
  paintPressed(document.getElementById('sizes'), (v) => v === state.size.join('x'));
  paintPressed(document.getElementById('sheets'), (v) => v === state.sheet);
}

frame.addEventListener('load', () => {
  say(null);
  // The scene takes a moment; poll rather than guess, and give up loudly.
  let tries = 0;
  const wait = setInterval(() => {
    if (api()) { clearInterval(wait); applyToFrame(); return; }
    if (++tries > 100) {
      clearInterval(wait);
      say(`${state.sheet} did not come up. Built? ` +
          'node bin/b2d.mjs build examples/mbt-mk6/spec.json --out out/mbt-mk6');
    }
  }, 100);
});

/* --------------------------------------------------------- the live controls */

function renderLangs() {
  const b2d = api();
  const host = document.getElementById('langs');
  const codes = b2d?.locales ?? [];
  buttons(
    host,
    codes.map((c) => ({ value: c, label: c })),
    (v) => v === (b2d?.locale ?? ''),
    (it) => { state.lang = it.value; api()?.setLocale(it.value); },
  );
}

/**
 * The controls worth having while judging a layout: what the sheet looks like
 * on each view, with a motion running, and with each overlay lifted.
 */
function renderDrive() {
  const b2d = api();
  const host = document.getElementById('drive');
  if (!b2d) { host.textContent = 'waiting for the sheet…'; return; }

  const items = [];
  for (const v of b2d.spec.views) items.push({ value: `view:${v.id}`, label: `view · ${v.label}` });
  for (const m of b2d.spec.motions) items.push({ value: `motion:${m.id}`, label: `motion · ${m.label}` });
  items.push({ value: 'layer:callouts', label: 'layer · item numbers' });
  items.push({ value: 'layer:dims', label: 'layer · dimensions' });
  for (const k of ['key', 'instr', 'tb']) items.push({ value: `panel:${k}`, label: `panel · ${k}` });

  buttons(host, items, (v) => {
    const [kind, id] = String(v).split(':');
    if (kind === 'view') return b2d.viewCtl.currentId === id;
    if (kind === 'motion') return b2d.drivers.isActive(id);
    if (kind === 'layer') return b2d.layerOn(id);
    if (kind === 'panel') return sheetEl()?.getAttribute(`data-panel-${id}`) === 'open';
    return false;
  }, (it) => {
    const [kind, id] = it.value.split(':');
    if (kind === 'view') b2d.setView(id);
    if (kind === 'motion') b2d.setMotion(id, !b2d.drivers.isActive(id));
    if (kind === 'layer') b2d.setLayer(id, !b2d.layerOn(id));
    if (kind === 'panel') b2d.setPanel(id, sheetEl()?.getAttribute(`data-panel-${id}`) !== 'open');
  });
}

/* --------------------------------------------------------------------- boot */

buttons(
  document.getElementById('variants'),
  VARIANTS.map(([v, label, hint]) => ({ value: v, label, hint })),
  (v) => v === state.variant,
  (it) => { state.variant = it.value; },
);
buttons(
  document.getElementById('sizes'),
  SIZES.map((s) => ({ value: s.join('x'), label: `${s[0]} x ${s[1]}`, hint: s[2] })),
  (v) => v === state.size.join('x'),
  (it) => { state.size = SIZES.find((s) => s.join('x') === it.value); },
);
buttons(
  document.getElementById('sheets'),
  SHEETS.map(([url, label, hint]) => ({ value: url, label, hint })),
  (v) => v === state.sheet,
  (it) => { state.sheet = it.value; },
);

addEventListener('resize', fitShell);
render();
// The live controls reflect state the page changes on its own — a motion
// latching, a view tween landing — so they are repainted rather than only
// written to.
setInterval(() => { if (api()) { renderDrive(); renderLangs(); } }, 900);
