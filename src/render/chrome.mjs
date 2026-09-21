/**
 * The drafting sheet's DOM.
 *
 * Every panel, button and readout is generated from the spec. There is no
 * `FIRE` or `TURRET AZIMUTH` anywhere in this file — the console rows come from
 * `spec.views` / `spec.motions`, and the instrument rows from
 * `spec.instruments`. Swapping subject is a data change.
 *
 * Language works the same way. Nothing here holds a literal string: the sheet's
 * own furniture comes from the i18n dictionary and everything else from the
 * spec, and both are read through `dyn()` so a language switch re-reads them
 * rather than rebuilding the sheet.
 *
 * WHAT IS ON SCREEN IS A STATE, NOT A LAYOUT.
 *
 * The three information panels can each be open or shut, the two annotation
 * layers on or off. All of it is written onto `#sheet` as data attributes, and
 * the stylesheet decides what each state looks like at each width. This file
 * therefore never positions anything and never consults a breakpoint — it only
 * says which state the sheet is in.
 *
 * The one thing CSS cannot do is pick the OPENING state, because that differs
 * per layout and per width. So the stylesheet declares it in a custom property
 * (`--panel-key: open`) and this file reads it back and applies it. A panel the
 * reader has touched is then left alone forever after: their choice outranks
 * the layout's opinion, including across a resize.
 */

import { compileExpr } from '../spec/expr.mjs';
import { chromeText, localeList } from '../spec/i18n.mjs';
import { resolveViewGlyph, resolveMotionGlyph, uiGlyph } from './icons.mjs';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/**
 * printf-ish: %d, %.1f, %05.2f, %+.1f, plus any trailing literal (units).
 * Only the first conversion is substituted, so a trailing literal `%` — as in
 * "%.0f %" — survives.
 */
function formatValue(fmt, v) {
  if (!fmt) return String(Math.round(v));
  return fmt.replace(/%([+0]*)(\d+)?(?:\.(\d+))?([dfs])/, (_, flags, width, prec, kind) => {
    let s;
    if (kind === 'd') s = String(Math.round(v));
    else if (kind === 'f') s = v.toFixed(prec == null ? 1 : Number(prec));
    else s = String(v);

    if (flags.includes('+') && !s.startsWith('-')) s = `+${s}`;

    if (width) {
      const w = Number(width);
      const pad = flags.includes('0') ? '0' : ' ';
      const signed = s.startsWith('-') || s.startsWith('+');
      if (s.length < w) {
        // zero padding goes after the sign, space padding before it
        s = signed && pad === '0'
          ? s[0] + s.slice(1).padStart(w - 1, pad)
          : s.padStart(w, pad);
      }
    }
    return s;
  });
}

/**
 * The publisher's mark: a droplet inside a shield.
 *
 * Drawn in the sheet's own idiom rather than pasted in as artwork — one stroke
 * weight, `currentColor` for the shield so it is the same ink as the frame
 * around it, and a single brand blue for the drop. That is the whole tuning:
 * the identity is the shield and the droplet, and everything else about it is
 * the drafting sheet's, so it sits on the paper instead of on top of it.
 */
const LOGO = `
<svg class="mark" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M5.7 4.9 H26.3 V15.6 C26.3 22.4 21.9 27.5 16 29.8 C10.1 27.5 5.7 22.4 5.7 15.6 Z"
        stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
  <path d="M16 8.2 C16 8.2 10.8 14.4 10.8 18.1 A5.2 5.2 0 0 0 21.2 18.1 C21.2 14.4 16 8.2 16 8.2 Z"
        fill="var(--brand)"/>
  <path d="M13.2 18.6 A2.7 2.7 0 0 0 15.9 21.3" stroke="var(--paper-hi)" stroke-width="1.1"
        stroke-linecap="round" opacity=".7"/>
</svg>`;

/**
 * The three panels that can step aside, in one table.
 *
 * `key` is the slug used everywhere — in the data attribute the stylesheet
 * matches on, in the custom property it reads the default back out of, and in
 * the dictionary key for the panel's name. One spelling, three uses.
 */
const PANELS = [
  { key: 'key', node: 'key', glyph: 'key', name: 'panel.key' },
  { key: 'instr', node: 'instr', glyph: 'instruments', name: 'panel.instruments' },
  { key: 'tb', node: 'titleblock', glyph: 'titleBlock', name: 'panel.titleBlock' },
];

/** The annotation layers a reader can switch off when the sheet gets busy. */
const LAYERS = [
  { key: 'callouts', glyph: 'callouts', name: 'layer.callouts' },
  { key: 'dims', glyph: 'dimensions', name: 'layer.dimensions' },
];

/** True while the pointer in use cannot hover — a finger, not a mouse. */
const coarsePointer = () => {
  try { return window.matchMedia('(hover: none) and (pointer: coarse)').matches; }
  catch { return false; }
};

export function buildChrome(rootEl, spec, {
  locale, onView, onMotion, onLocale, onLayer, onPanel,
} = {}) {
  const meta = spec.meta;
  let lang = locale ?? spec.i18n?.default ?? spec.i18n?.base ?? 'en';

  /** Sheet furniture in the language currently on screen. */
  const t = (key, fallback) => {
    const s = chromeText(spec, lang, key);
    return s === key && fallback != null ? fallback : s;
  };

  /**
   * Text that has to be re-read when the language changes — either furniture,
   * or a spec string that `applyLocale` rewrote in place. Registering the read
   * rather than the result is what makes the toggle exhaustive: a label nobody
   * registered would be a label frozen in the language it was built in.
   */
  const refresh = [];
  const dyn = (node, read) => {
    refresh.push(() => { node.textContent = read(); });
    return node;
  };

  /**
   * The same idea for an attribute.
   *
   * A tooltip and a screen-reader name are text a reader reads, so they have to
   * follow the language like every other string. They are just not text nodes,
   * and a `dyn()` that only knows how to write `textContent` would leave them
   * frozen in whatever language the sheet was built in — silently, because
   * nothing on screen shows them until you hover.
   */
  const dynAttr = (node, attr, read) => {
    refresh.push(() => { node.setAttribute(attr, read()); });
    return node;
  };

  /* ------------------------------------------------------------ sheet frame */
  const frame = el('div', 'frame');
  rootEl.appendChild(frame);

  const COLS = 'ABCDEFGHIJK';
  for (let i = 0; i < COLS.length; i++) {
    const pct = ((i + 0.5) / COLS.length) * 100;
    for (const edge of ['top', 'bottom']) {
      const z = el('div', 'zone', COLS[i]);
      z.style.left = `${pct}%`;
      z.style[edge] = '3px';
      z.style.transform = 'translateX(-50%)';
      frame.appendChild(z);
    }
  }
  for (let i = 0; i < 7; i++) {
    const pct = ((i + 0.5) / 7) * 100;
    for (const edge of ['left', 'right']) {
      const z = el('div', 'zone', String(7 - i));
      z.style.top = `${pct}%`;
      z.style[edge] = '5px';
      z.style.transform = 'translateY(-50%)';
      frame.appendChild(z);
    }
  }

  /* ---------------------------------------------------------------- heading */
  // Top left is the signature: who issued this sheet, not what it is of. It is
  // the same on every sheet the tool draws, so it comes from the dictionary
  // like the rest of the furniture — and a spec that wants its own byline
  // overrides `chrome.brand.signature`. The organisation the *subject* belongs
  // to is a different fact and lives in the title block, where a drawing has
  // always carried it.
  const brand = el('div', 'brand');
  brand.innerHTML = LOGO;
  const brandText = el('div');
  brandText.appendChild(dyn(el('div', 'sig'), () => t('brand.signature')));
  if (meta.division) brandText.appendChild(dyn(el('div', 'division'), () => meta.division));
  brand.appendChild(brandText);
  rootEl.appendChild(brand);

  const docTitle = el('div', 'docTitle');
  docTitle.appendChild(dyn(el('div', 't'), () => meta.title));
  if (meta.subtitle) docTitle.appendChild(dyn(el('div', 's'), () => meta.subtitle));
  rootEl.appendChild(docTitle);

  /* ------------------------------------------------------- panel open / shut */

  /**
   * Panels the reader has decided about. Their choice survives a resize; a
   * panel not in here is still the layout's to place, so widening the window
   * can bring back a legend the reader never asked to lose.
   */
  const decided = new Set();
  const panelNodes = new Map();

  /** Set from `--card-docked`; see `showCard`. */
  let cardDocked = false;

  /**
   * Layers the reader has decided about, kept apart from the panels' set only
   * because they are asked at different moments. Same rule: once a reader has
   * said what they want, a resize does not get to revise it.
   */
  const decidedLayers = new Set();

  const panelState = (key) => rootEl.getAttribute(`data-panel-${key}`) ?? 'open';

  function setPanel(key, open, { byReader = false } = {}) {
    rootEl.setAttribute(`data-panel-${key}`, open ? 'open' : 'shut');
    if (byReader) decided.add(key);
    paintPanelButtons();
    onPanel?.(key, open);
  }

  /**
   * Take the opening state from the stylesheet.
   *
   * Which panels a layout starts with is a layout question and differs by
   * width, so the answer lives with the layout. Re-run on resize for every
   * panel the reader has not overruled.
   */
  function applyPanelDefaults() {
    const cs = getComputedStyle(rootEl);
    // Read here rather than in `showCard`, which runs every frame.
    cardDocked = cs.getPropertyValue('--card-docked').trim() === 'yes';
    for (const p of PANELS) {
      if (decided.has(p.key)) continue;
      if (!panelNodes.has(p.key)) continue;
      const want = cs.getPropertyValue(`--panel-${p.key}`).trim() || 'open';
      rootEl.setAttribute(`data-panel-${p.key}`, want === 'shut' ? 'shut' : 'open');
    }
    // The layers are the same question asked about the overlays. Set the state
    // and light the button; the caller re-reads it and tells the annotation
    // layer, which is why nothing is notified from in here — this also runs
    // during `buildChrome`, before there is an annotation layer to tell.
    for (const l of LAYERS) {
      if (decidedLayers.has(l.key)) continue;
      const want = cs.getPropertyValue(`--layer-${l.key}`).trim() || 'on';
      const on = want !== 'off';
      rootEl.setAttribute(`data-layer-${l.key}`, on ? 'on' : 'off');
      layerButtons.get(l.key)?.classList.toggle('on', on);
    }
    paintPanelButtons();
  }

  /**
   * A panel's header.
   *
   * The heading stays an `<h2>` carrying the panel's name as real text — it is
   * what a reader sees and what the quality gate reads back to prove the
   * language switch reached this panel. The toggle is a button nested inside
   * it, drawn as a glyph with no text of its own, so the heading's text content
   * is still exactly the heading.
   */
  function panelHead(p) {
    const h = el('h2');
    const btn = el('button', 'panelToggle');
    btn.type = 'button';
    btn.innerHTML = uiGlyph(p.glyph);
    dynAttr(btn, 'data-tip', () => t(p.name));
    dynAttr(btn, 'aria-label', () => t(p.name));
    btn.addEventListener('click', () => setPanel(p.key, panelState(p.key) !== 'open', { byReader: true }));
    h.appendChild(btn);
    h.appendChild(dyn(el('span', 'h2Text'), () => t(p.name)));
    return h;
  }

  /* ------------------------------------------------------------ key to items */
  const callouts = [...(spec.annotations?.callouts ?? [])].sort((a, b) => a.n - b.n);
  const keyItems = new Map();
  if (callouts.length) {
    const p = PANELS[0];
    const key = el('section', 'panel');
    key.id = 'key';
    key.appendChild(panelHead(p));
    const body = el('div', 'panelBody');
    const items = el('div', `items${callouts.length <= 5 ? ' single' : ''}`);

    // The reference fills column-major: 1-5 left, 6-10 right.
    const half = Math.ceil(callouts.length / 2);
    const ordered = [];
    for (let r = 0; r < half; r++) {
      ordered.push(callouts[r]);
      if (callouts[r + half]) ordered.push(callouts[r + half]);
    }
    for (const c of ordered) {
      const item = el('div', 'item');
      item.appendChild(el('span', 'bal', String(c.n)));
      item.appendChild(dyn(el('span', 'tx'), () => c.text));
      items.appendChild(item);
      keyItems.set(c.n, item);
    }
    body.appendChild(items);

    const metaRow = el('div', 'meta');
    const FACTS = [
      ['key.projection', () => t(`projection.${meta.projection}`, meta.projection)],
      ['key.units', () => meta.units],
      ['key.tolerance', () => meta.tolerance],
    ];
    for (const [k, read] of FACTS) {
      const cell = el('span');
      cell.append(dyn(el('span'), () => t(k)), dyn(el('b'), read));
      metaRow.appendChild(cell);
    }
    body.appendChild(metaRow);
    key.appendChild(body);
    rootEl.appendChild(key);
    panelNodes.set(p.key, key);
  }

  /* ------------------------------------------------------- instrumentation */
  const instrRows = [];
  if (spec.instruments?.length) {
    const p = PANELS[1];
    const panel = el('section', 'panel');
    panel.id = 'instr';
    panel.appendChild(panelHead(p));
    const body = el('div', 'panelBody');
    const rows = el('div', 'rows');
    for (const ins of spec.instruments) {
      const row = el('div', 'row');
      row.appendChild(dyn(el('span', 'k'), () => ins.label));
      const v = el('span', 'v', '—');
      row.appendChild(v);
      rows.appendChild(row);
      let fn = () => 0;
      try { fn = compileExpr(ins.expr).fn; } catch { /* validated upstream */ }
      instrRows.push({ node: v, fn, format: ins.format });
    }
    body.appendChild(rows);
    panel.appendChild(body);
    rootEl.appendChild(panel);
    panelNodes.set(p.key, panel);
  }

  /* ------------------------------------------------------------ title block */
  const tb = meta.titleBlock;
  const block = el('section', 'panel');
  block.id = 'titleblock';
  block.appendChild(panelHead(PANELS[2]));
  const tbBody = el('div', 'panelBody');
  if (meta.org) {
    const tbOrg = el('div', 'tb-org');
    tbOrg.appendChild(dyn(el('div', 'k'), () => t('tb.org')));
    tbOrg.appendChild(dyn(el('div', 'v'), () => meta.org));
    tbBody.appendChild(tbOrg);
  }
  const tbTitle = el('div', 'tb-title');
  tbTitle.appendChild(dyn(el('div', 'k'), () => t('tb.title')));
  tbTitle.appendChild(dyn(el('div', 'v'), () => meta.title));
  tbBody.appendChild(tbTitle);
  const cells = el('div', 'cells');
  const CELLS = [
    ['tb.drawingNo', 'drawingNo'], ['tb.sheet', 'sheet'], ['tb.scale', 'scale'], ['tb.rev', 'rev'],
    ['tb.drawn', 'drawn'], ['tb.checked', 'checked'], ['tb.date', 'date'], ['tb.status', 'status'],
  ];
  for (const [k, field] of CELLS) {
    const c = el('div', 'cell');
    c.appendChild(dyn(el('div', 'k'), () => t(k)));
    const vn = el('div', `v${field === 'status' ? ' status' : ''}`);
    refresh.push(() => {
      vn.textContent = tb[field] ?? '—';
      vn.title = tb[field] ?? '';
    });
    c.appendChild(vn);
    cells.appendChild(c);
  }
  tbBody.appendChild(cells);
  block.appendChild(tbBody);
  rootEl.appendChild(block);
  panelNodes.set(PANELS[2].key, block);

  /* ---------------------------------------------------------------- console */

  const consoleEl = el('section');
  consoleEl.id = 'console';
  const viewButtons = new Map();
  const motionButtons = new Map();
  const langButtons = new Map();
  const layerButtons = new Map();
  const panelButtons = new Map();

  const group = (name, labelKey) => {
    const row = el('div', 'ctrlRow');
    row.dataset.group = name;
    row.appendChild(dyn(el('span', 'rowLabel'), () => t(labelKey)));
    return row;
  };

  /**
   * A console button: a glyph, a name, and a tooltip.
   *
   * The name is a real text node and stays one in every layout. Hiding it is
   * the stylesheet's business — on a wide screen the glyph plus a hover
   * tooltip is enough, on a phone there is no hover at all and the word has to
   * be under the icon or the button is a guess. Either way it is in the
   * document, which is also what a screen reader and the quality gate read.
   */
  const iconButton = (glyph, readLabel, readTip = readLabel) => {
    const b = el('button', 'btn');
    b.type = 'button';
    b.innerHTML = glyph;
    b.appendChild(dyn(el('span', 'btnLabel'), readLabel));
    dynAttr(b, 'data-tip', readTip);
    dynAttr(b, 'aria-label', readTip);
    return b;
  };

  if (spec.views?.length) {
    const row = group('view', 'row.view');
    for (const v of spec.views) {
      const b = iconButton(
        resolveViewGlyph(v, spec.bounds),
        () => v.label,
        () => v.caption || v.label,
      );
      b.addEventListener('click', () => onView?.(v.id));
      row.appendChild(b);
      viewButtons.set(v.id, b);
    }
    consoleEl.appendChild(row);
  }

  if (spec.motions?.length) {
    const row = group('motion', 'row.motion');
    for (const m of spec.motions) {
      const b = iconButton(resolveMotionGlyph(spec, m, compileExpr), () => m.label);
      b.addEventListener('click', () => onMotion?.(m.id));
      row.appendChild(b);
      motionButtons.set(m.id, b);
    }
    consoleEl.appendChild(row);
  }

  // The annotation layers. A sheet carrying sixteen balloons and a full
  // dimension run is correct and also, while you are turning the thing over to
  // look at its shape, in the way. Switching a layer off is not a different
  // drawing — it is the same drawing with one of its overlays lifted.
  {
    const row = group('layer', 'row.layer');
    for (const l of LAYERS) {
      const b = iconButton(uiGlyph(l.glyph), () => t(l.name));
      b.addEventListener('click', () => {
        const next = rootEl.getAttribute(`data-layer-${l.key}`) !== 'off';
        setLayer(l.key, !next, { byReader: true });
      });
      row.appendChild(b);
      layerButtons.set(l.key, b);
    }
    consoleEl.appendChild(row);
  }

  // The panels, next to the layers, because they are the same question: what
  // is on the glass besides the drawing. Duplicated by each panel's own header
  // toggle on purpose — a layout that docks them off-screen needs somewhere to
  // call them back from, and one that keeps them in place needs the handle on
  // the panel itself.
  if (panelNodes.size) {
    const row = group('panel', 'row.panel');
    for (const p of PANELS) {
      if (!panelNodes.has(p.key)) continue;
      const b = iconButton(uiGlyph(p.glyph), () => t(p.name));
      // Addressable per panel, so a layout can hide the handles it already
      // provides elsewhere and keep only the ones it does not.
      b.dataset.panel = p.key;
      b.addEventListener('click', () => setPanel(p.key, panelState(p.key) !== 'open', { byReader: true }));
      row.appendChild(b);
      panelButtons.set(p.key, b);
    }
    // One handle for all of them: the reader wants the drawing, not a
    // negotiation with three panels.
    const focus = iconButton(uiGlyph('focus'), () => t('row.focus'));
    focus.classList.add('focusBtn');
    focus.addEventListener('click', () => {
      const anyOpen = PANELS.some((p) => panelNodes.has(p.key) && panelState(p.key) === 'open');
      for (const p of PANELS) {
        if (panelNodes.has(p.key)) setPanel(p.key, !anyOpen, { byReader: true });
      }
    });
    row.appendChild(focus);
    panelButtons.set('_focus', focus);
    consoleEl.appendChild(row);
  }

  // The language row appears only when there is a second language to go to.
  // Button text is each language's own name, never translated — a reader
  // looking for Chinese is looking for 中文, not for whatever "Chinese" is in
  // the language they cannot read.
  const locales = localeList(spec);
  if (locales.length > 1) {
    const row = group('lang', 'row.lang');
    for (const l of locales) {
      const b = el('button', 'btn lang', l.label);
      b.type = 'button';
      b.lang = l.code;
      dynAttr(b, 'data-tip', () => l.label);
      b.setAttribute('aria-label', l.label);
      b.addEventListener('click', () => onLocale?.(l.code));
      row.appendChild(b);
      langButtons.set(l.code, b);
    }
    consoleEl.appendChild(row);
  }
  rootEl.appendChild(consoleEl);

  /* ----------------------------------------------------------------- layers */

  /**
   * @param {boolean} notify - false while seeding the opening state.
   *
   * The seed runs inside `buildChrome`, and the handler on the other end of
   * `onLayer` closes over an annotation layer that the caller has not built
   * yet — it cannot, since it needs the chrome this call is still returning.
   * Both layers start on, which is what the annotation and dimension modules
   * already default to, so there is nothing to tell anyone about.
   */
  function setLayer(key, on, { notify = true, byReader = false } = {}) {
    rootEl.setAttribute(`data-layer-${key}`, on ? 'on' : 'off');
    layerButtons.get(key)?.classList.toggle('on', on);
    if (byReader) decidedLayers.add(key);
    if (notify) onLayer?.(key, on);
  }

  /* --------------------------------------------------------------- captions */
  const caption = el('div');
  caption.id = 'viewCaption';
  const capC = el('div', 'c');
  const capS = el('div', 's');
  caption.append(capC, capS);
  rootEl.appendChild(caption);

  let curView = null;
  function paintCaption() {
    if (curView?.caption) {
      capC.textContent = curView.caption;
      capS.textContent = curView.sub ?? '';
      capS.style.display = curView.sub ? '' : 'none';
      caption.classList.add('show');
    } else {
      caption.classList.remove('show');
    }
  }
  refresh.push(paintCaption);

  // What the pointer does here depends on what the pointer IS. A finger cannot
  // scroll to zoom and a mouse cannot pinch, so the line is chosen at read
  // time rather than baked in, and re-read if the pointer changes under us —
  // which it does, on a tablet the moment a keyboard and trackpad are attached.
  const hint = dyn(el('div'), () => t(coarsePointer() ? 'hint.touch' : 'hint'));
  hint.id = 'hint';
  rootEl.appendChild(hint);

  const card = el('div');
  card.id = 'hoverCard';
  const cardN = el('div', 'n');
  const cardD = el('div', 'd');
  const cardM = el('div', 'm');
  card.append(cardN, cardD, cardM);
  rootEl.appendChild(card);

  /* ------------------------------------------------------------------- API */
  let hotCallout = null;
  let busy = false;

  function paintPanelButtons() {
    let anyOpen = false;
    for (const p of PANELS) {
      if (!panelNodes.has(p.key)) continue;
      const open = panelState(p.key) === 'open';
      anyOpen = anyOpen || open;
      panelButtons.get(p.key)?.classList.toggle('on', open);
    }
    panelButtons.get('_focus')?.classList.toggle('on', !anyOpen);
  }

  /** Re-read every registered string, and light up the active language. */
  function paint() {
    for (const fn of refresh) fn();
    for (const [code, b] of langButtons) b.classList.toggle('on', code === lang);
  }

  // Both the panels and the layers take their opening state from the stylesheet,
  // which is the only thing that knows how wide the sheet is.
  applyPanelDefaults();
  paint();

  try {
    window.matchMedia('(hover: none) and (pointer: coarse)')
      .addEventListener('change', () => paint());
  } catch { /* older browsers: the hint stays as first read */ }

  return {
    updateInstruments(scope) {
      for (const r of instrRows) {
        r.node.textContent = formatValue(r.format, r.fn(scope));
      }
    },

    /**
     * Switch language. The caller has already rewritten the spec's own strings
     * through `applyLocale`, so this is purely a re-read — the scene, the
     * camera and any running motion carry on untouched.
     */
    setLocale(next) {
      lang = next;
      paint();
    },

    get locale() { return lang; },

    setActiveView(id) {
      for (const [k, b] of viewButtons) b.classList.toggle('on', k === id);
    },

    setActiveMotions(ids) {
      const set = new Set(ids);
      for (const [k, b] of motionButtons) b.classList.toggle('on', set.has(k));
    },

    /**
     * Orthographic views become clean drawing plates: the legend and the live
     * readouts step aside so the elevation has the sheet to itself, exactly as
     * the reference does on SIDE, FRONT and PLAN.
     *
     * This is on top of whatever the reader chose, never instead of it — a
     * plate is a plate even if the legend was pinned open a moment ago.
     */
    setPlateMode(on) {
      rootEl.classList.toggle('plate', !!on);
    },

    /**
     * The picture is being moved. The panels step aside for as long as it is,
     * which is the whole point: while you are turning the model over, the one
     * thing you want off the glass is the text sitting on top of it.
     */
    setBusy(on) {
      // Called every frame from the main loop, so it only touches the DOM when
      // the answer actually changes.
      if (busy === !!on) return;
      busy = !!on;
      rootEl.classList.toggle('busy', busy);
    },

    /** Re-ask the stylesheet where the panels go. Cheap; call it on resize. */
    applyPanelDefaults,

    /**
     * True when an open panel is covering the drawing rather than sitting
     * beside it — a phone, essentially, where a panel is a card over the model.
     *
     * The caller needs this because it changes what the annotation layer can
     * usefully do: with the model behind a card there is nowhere to put a
     * balloon, and the solver will dutifully find the sliver of paper that is
     * left and run every leader into it.
     */
    get panelsOverlaying() {
      if (getComputedStyle(rootEl).getPropertyValue('--panel-overlay').trim() !== 'yes') return false;
      return PANELS.some((p) => panelNodes.has(p.key) && panelState(p.key) === 'open');
    },

    setPanel,
    setLayer,
    layerOn: (key) => rootEl.getAttribute(`data-layer-${key}`) !== 'off',

    setCaption(view) {
      curView = view ?? null;
      paintCaption();
    },

    /** Highlight the legend row matching a hovered part. */
    setHotCallout(n) {
      if (hotCallout === n) return;
      if (hotCallout != null) keyItems.get(hotCallout)?.classList.remove('hot');
      hotCallout = n;
      if (n != null) keyItems.get(n)?.classList.add('hot');
    },

    showCard(part, x, y) {
      if (!part) { card.classList.remove('show'); return; }
      cardN.textContent = part.name;
      cardD.textContent = part.note ?? '';
      cardD.style.display = part.note ? '' : 'none';
      const bits = [t(`material.${part.material}`, part.material)];
      if (part.group) bits.push(part.group);
      cardM.textContent = bits.join(' · ');
      card.classList.add('show');

      // A docked card is placed entirely by the stylesheet. Writing `top` here
      // as well would give a fixed box both a top and a bottom and it would
      // stretch to span them — which is not a near miss, it is most of the
      // screen. Clearing both is also what restores it if the window was
      // narrow a moment ago and is not any more.
      if (cardDocked) {
        card.style.left = '';
        card.style.top = '';
        return;
      }
      const w = card.offsetWidth || 240, h = card.offsetHeight || 60;
      const px = Math.min(Math.max(x + 16, 8), window.innerWidth - w - 8);
      const py = Math.min(Math.max(y - h - 14, 8), window.innerHeight - h - 8);
      card.style.left = `${px}px`;
      card.style.top = `${py}px`;
    },

    callouts,
  };
}

export { formatValue };
