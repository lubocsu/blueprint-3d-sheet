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
 */

import { compileExpr } from '../spec/expr.mjs';
import { chromeText, localeList } from '../spec/i18n.mjs';

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

export function buildChrome(rootEl, spec, { locale, onView, onMotion, onLocale } = {}) {
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

  /* ------------------------------------------------------------ key to items */
  const callouts = [...(spec.annotations?.callouts ?? [])].sort((a, b) => a.n - b.n);
  const keyItems = new Map();
  if (callouts.length) {
    const key = el('section', 'panel');
    key.id = 'key';
    key.appendChild(dyn(el('h2'), () => t('panel.key')));
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
    key.appendChild(items);

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
    key.appendChild(metaRow);
    rootEl.appendChild(key);
  }

  /* ------------------------------------------------------- instrumentation */
  const instrRows = [];
  if (spec.instruments?.length) {
    const panel = el('section', 'panel');
    panel.id = 'instr';
    panel.appendChild(dyn(el('h2'), () => t('panel.instruments')));
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
    panel.appendChild(rows);
    rootEl.appendChild(panel);
  }

  /* ------------------------------------------------------------ title block */
  const tb = meta.titleBlock;
  const block = el('section', 'panel');
  block.id = 'titleblock';
  if (meta.org) {
    const tbOrg = el('div', 'tb-org');
    tbOrg.appendChild(dyn(el('div', 'k'), () => t('tb.org')));
    tbOrg.appendChild(dyn(el('div', 'v'), () => meta.org));
    block.appendChild(tbOrg);
  }
  const tbTitle = el('div', 'tb-title');
  tbTitle.appendChild(dyn(el('div', 'k'), () => t('tb.title')));
  tbTitle.appendChild(dyn(el('div', 'v'), () => meta.title));
  block.appendChild(tbTitle);
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
  block.appendChild(cells);
  rootEl.appendChild(block);

  /* ---------------------------------------------------------------- console */
  const consoleEl = el('section');
  consoleEl.id = 'console';
  const viewButtons = new Map();
  const motionButtons = new Map();
  const langButtons = new Map();

  if (spec.views?.length) {
    const row = el('div', 'ctrlRow');
    row.appendChild(dyn(el('span', 'rowLabel'), () => t('row.view')));
    for (const v of spec.views) {
      const b = dyn(el('button', 'btn'), () => v.label);
      b.type = 'button';
      b.addEventListener('click', () => onView?.(v.id));
      row.appendChild(b);
      viewButtons.set(v.id, b);
    }
    consoleEl.appendChild(row);
  }
  if (spec.motions?.length) {
    const row = el('div', 'ctrlRow');
    row.appendChild(dyn(el('span', 'rowLabel'), () => t('row.motion')));
    for (const m of spec.motions) {
      const b = dyn(el('button', 'btn'), () => m.label);
      b.type = 'button';
      b.addEventListener('click', () => onMotion?.(m.id));
      row.appendChild(b);
      motionButtons.set(m.id, b);
    }
    consoleEl.appendChild(row);
  }

  // The language row appears only when there is a second language to go to.
  // Button text is each language's own name, never translated — a reader
  // looking for Chinese is looking for 中文, not for whatever "Chinese" is in
  // the language they cannot read.
  const locales = localeList(spec);
  if (locales.length > 1) {
    const row = el('div', 'ctrlRow');
    row.appendChild(dyn(el('span', 'rowLabel'), () => t('row.lang')));
    for (const l of locales) {
      const b = el('button', 'btn lang', l.label);
      b.type = 'button';
      b.lang = l.code;
      b.addEventListener('click', () => onLocale?.(l.code));
      row.appendChild(b);
      langButtons.set(l.code, b);
    }
    consoleEl.appendChild(row);
  }
  rootEl.appendChild(consoleEl);

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

  const hint = dyn(el('div'), () => t('hint'));
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

  /** Re-read every registered string, and light up the active language. */
  function paint() {
    for (const fn of refresh) fn();
    for (const [code, b] of langButtons) b.classList.toggle('on', code === lang);
  }
  paint();

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
     */
    setPlateMode(on) {
      rootEl.classList.toggle('plate', !!on);
    },

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
