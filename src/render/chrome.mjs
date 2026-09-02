/**
 * The drafting sheet's DOM.
 *
 * Every panel, button and readout is generated from the spec. There is no
 * `FIRE` or `TURRET AZIMUTH` anywhere in this file — the console rows come from
 * `spec.views` / `spec.motions`, and the instrument rows from
 * `spec.instruments`. Swapping subject is a data change.
 */

import { compileExpr } from '../spec/expr.mjs';
import { MATERIAL_LABEL } from './materials.mjs';

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

const LOGO = `
<svg class="mark" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="1" y="1" width="30" height="30" stroke="currentColor" stroke-width="1.4"/>
  <path d="M16 6 L26 16 L16 26 L6 16 Z" stroke="currentColor" stroke-width="1.4"/>
  <path d="M16 11 L21 16 L16 21 L11 16 Z" fill="currentColor" opacity=".85"/>
</svg>`;

export function buildChrome(rootEl, spec, { onView, onMotion } = {}) {
  const meta = spec.meta;

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
  const brand = el('div', 'brand');
  brand.innerHTML = LOGO;
  const brandText = el('div');
  brandText.appendChild(el('div', 'org', meta.org || meta.title));
  if (meta.division) brandText.appendChild(el('div', 'division', meta.division));
  brand.appendChild(brandText);
  rootEl.appendChild(brand);

  const docTitle = el('div', 'docTitle');
  docTitle.appendChild(el('div', 't', meta.title));
  if (meta.subtitle) docTitle.appendChild(el('div', 's', meta.subtitle));
  rootEl.appendChild(docTitle);

  /* ------------------------------------------------------------ key to items */
  const callouts = [...(spec.annotations?.callouts ?? [])].sort((a, b) => a.n - b.n);
  const keyItems = new Map();
  if (callouts.length) {
    const key = el('section', 'panel');
    key.id = 'key';
    key.appendChild(el('h2', null, 'Key to items'));
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
      item.appendChild(el('span', 'tx', c.text));
      items.appendChild(item);
      keyItems.set(c.n, item);
    }
    key.appendChild(items);

    const metaRow = el('div', 'meta');
    metaRow.innerHTML =
      `<span>Projection<b>${meta.projection}</b></span>` +
      `<span>Units<b>${meta.units}</b></span>` +
      `<span>Tol.<b>${meta.tolerance}</b></span>`;
    key.appendChild(metaRow);
    rootEl.appendChild(key);
  }

  /* ------------------------------------------------------- instrumentation */
  const instrRows = [];
  if (spec.instruments?.length) {
    const panel = el('section', 'panel');
    panel.id = 'instr';
    panel.appendChild(el('h2', null, 'Instrumentation'));
    const rows = el('div', 'rows');
    for (const ins of spec.instruments) {
      const row = el('div', 'row');
      row.appendChild(el('span', 'k', ins.label));
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
  const tbTitle = el('div', 'tb-title');
  tbTitle.appendChild(el('div', 'k', 'Title'));
  tbTitle.appendChild(el('div', 'v', meta.title));
  block.appendChild(tbTitle);
  const cells = el('div', 'cells');
  const CELLS = [
    ['Drawing no.', tb.drawingNo], ['Sheet', tb.sheet], ['Scale', tb.scale], ['Rev.', tb.rev],
    ['Drawn', tb.drawn], ['Checked', tb.checked], ['Date', tb.date], ['Status', tb.status],
  ];
  for (const [k, v] of CELLS) {
    const c = el('div', 'cell');
    c.appendChild(el('div', 'k', k));
    const vn = el('div', `v${k === 'Status' ? ' status' : ''}`, v ?? '—');
    vn.title = v ?? '';
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

  if (spec.views?.length) {
    const row = el('div', 'ctrlRow');
    row.appendChild(el('span', 'rowLabel', 'View'));
    for (const v of spec.views) {
      const b = el('button', 'btn', v.label);
      b.type = 'button';
      b.addEventListener('click', () => onView?.(v.id));
      row.appendChild(b);
      viewButtons.set(v.id, b);
    }
    consoleEl.appendChild(row);
  }
  if (spec.motions?.length) {
    const row = el('div', 'ctrlRow');
    row.appendChild(el('span', 'rowLabel', 'Motion'));
    for (const m of spec.motions) {
      const b = el('button', 'btn', m.label);
      b.type = 'button';
      b.addEventListener('click', () => onMotion?.(m.id));
      row.appendChild(b);
      motionButtons.set(m.id, b);
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

  const hint = el('div', null, 'Drag to orbit · Scroll to zoom');
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

  return {
    updateInstruments(scope) {
      for (const r of instrRows) {
        r.node.textContent = formatValue(r.format, r.fn(scope));
      }
    },

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
      if (view?.caption) {
        capC.textContent = view.caption;
        capS.textContent = view.sub ?? '';
        capS.style.display = view.sub ? '' : 'none';
        caption.classList.add('show');
      } else {
        caption.classList.remove('show');
      }
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
      const bits = [MATERIAL_LABEL[part.material] ?? part.material];
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
