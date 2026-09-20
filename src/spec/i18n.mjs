/**
 * Two languages on one sheet.
 *
 * A drawing carries two kinds of text and they come from different places:
 *
 *   sheet furniture  "KEY TO ITEMS", "Drawing no.", "Drag to orbit" — invented
 *                    by the renderer, identical on every sheet, so it ships
 *                    translated here.
 *
 *   the subject      part names, callout lines, captions, the title block —
 *                    written by whoever authored the spec. No dictionary can
 *                    guess "60 mm ductile-iron sludge draw-off", so the spec
 *                    carries its own translations in `i18n.locales.<code>`.
 *
 * The overlay is a flat map of PATH -> string, keyed the way a reader would
 * name the thing: `parts.<id>.name`, `callouts.7.text`, `views.side.caption`.
 * Ids rather than array indices, so inserting a part at the top of the list
 * does not silently re-point every translation after it.
 *
 * Nothing here touches geometry. Switching language rewrites strings in place
 * and leaves the scene, the camera and the running motions exactly as they
 * were — the sheet does not reload, it changes language.
 *
 * A LANGUAGE HERE CARRIES ITS DRAFTING STANDARD, NOT JUST ITS WORDS.
 *
 * English is ISO practice: first angle, elevations, SECTION A-A, a title block
 * of Drawing no. / Sheet / Scale / Rev. Chinese is GB, and GB does not name
 * those things the same way:
 *
 *   views          GB/T 17451 六个基本视图 — 主视图 (front to back), 右视图
 *                  (right to left), 俯视图 (top down). Not 正视图 / 侧视图,
 *                  which are everyday words rather than the standard's names.
 *   sections       GB/T 4458.1 — a cut view is a 剖视图 and its label takes an
 *                  em dash: "B—B 剖视图", never "SECTION B-B" transliterated.
 *   title block    GB/T 10609.1 — 单位名称, 图样名称, 图样代号, 阶段标记.
 *   projection     GB/T 14692 — 第一角画法 / 第三角画法.
 *   materials      GB/T 4457.5 剖面符号 — 金属材料, 非金属材料, 液体, 泥土.
 *   parts list     GB/T 10609.2 — the numbered key to items is a 明细栏.
 *
 * Which view is which is geometry, not a guess: az is measured from +Z toward
 * +X, so az=0 puts the camera on +Z, which with +X forward and +Y up is the
 * object's right-hand side — GB calls that projection 右视图. az=90 puts the
 * camera in front of the object: 主视图.
 *
 * What does NOT change with language is anything that is a fact about the
 * drawing rather than a way of saying it. First angle stays first angle; the
 * dimension figures, the tolerance and the units keep their values — GB and
 * ISO both write millimetres as mm.
 */

/** What the authored fields are written in when `i18n.base` says nothing. */
export const BASE_LOCALE = 'en';

/**
 * Sheet furniture, per locale.
 *
 * A `chrome.<key>` entry in a spec overlay overrides any of these, for an
 * author who wants their own phrasing — the dictionary is a default, not a lock.
 */
export const CHROME = {
  en: {
    // The sheet's byline. One lockup in both languages — a mark is a name, and
    // a reader who knows it is looking for the characters, not a translation.
    'brand.signature': '环境极客（EnvirGeek）',

    'panel.key': 'Key to items',
    'panel.instruments': 'Instrumentation',
    'key.projection': 'Projection',
    'key.units': 'Units',
    'key.tolerance': 'Tol.',
    'tb.org': 'Organisation',
    'tb.title': 'Title',
    'tb.drawingNo': 'Drawing no.',
    'tb.sheet': 'Sheet',
    'tb.scale': 'Scale',
    'tb.rev': 'Rev.',
    'tb.drawn': 'Drawn',
    'tb.checked': 'Checked',
    'tb.date': 'Date',
    'tb.status': 'Status',
    'row.view': 'View',
    'row.motion': 'Motion',
    'row.lang': 'Lang',
    'hint': 'Drag to orbit · Scroll to zoom',

    'projection.FIRST ANGLE': 'FIRST ANGLE',
    'projection.THIRD ANGLE': 'THIRD ANGLE',

    'material.metal': 'machined metal',
    'material.casting': 'casting',
    'material.plastic': 'moulded plastic',
    'material.glass': 'glazing',
    'material.rubber': 'elastomer',
    'material.wood': 'timber',
    'material.concrete': 'concrete',
    'material.masonry': 'masonry',
    'material.liquid': 'fluid',
    'material.insulation': 'insulation',
    'material.fabric': 'fabric',
    'material.earth': 'earth / fill',

    // The views normalize invents when a spec declares none. An author who
    // declares their own views translates those through the overlay instead.
    'view.iso.label': 'ISO',
    'view.q34f.label': '3/4 F',
    'view.q34r.label': '3/4 R',
    'view.side.label': 'SIDE',
    'view.side.caption': 'SIDE ELEVATION',
    'view.side.sub': 'datum condition',
    'view.front.label': 'FRONT',
    'view.front.caption': 'FRONT ELEVATION',
    'view.front.sub': 'viewed on arrow F',
    'view.plan.label': 'PLAN',
    'view.plan.caption': 'PLAN VIEW',
    'view.plan.sub': 'looking down on datum',
  },

  zh: {
    'brand.signature': '环境极客（EnvirGeek）',

    // 明细栏 rather than a literal "零件索引": GB/T 10609.2 is what a numbered
    // key to items is called on a Chinese sheet, and the balloons are its 序号.
    'panel.key': '明细栏',
    'panel.instruments': '仪表读数',
    'key.projection': '画法',
    // 计量单位, not the bare 单位 — on a GB sheet 单位 on its own reads as the
    // issuing organisation, which is a different cell in the title block.
    'key.units': '计量单位',
    // GB/T 1804: the sheet-wide tolerance is the one NOT written against a
    // dimension, and that is exactly what this cell states.
    'key.tolerance': '未注公差',
    // Title block per GB/T 10609.1.
    'tb.org': '单位名称',
    'tb.title': '图样名称',
    'tb.drawingNo': '图样代号',
    'tb.sheet': '张次',
    'tb.scale': '比例',
    'tb.rev': '版次',
    'tb.drawn': '制图',
    'tb.checked': '审核',
    'tb.date': '日期',
    'tb.status': '阶段标记',
    'row.view': '视图',
    'row.motion': '动作',
    'row.lang': '语言',
    'hint': '拖动旋转 · 滚轮缩放',

    // GB/T 14692 names the projection method 画法, not 投影.
    'projection.FIRST ANGLE': '第一角画法',
    'projection.THIRD ANGLE': '第三角画法',

    // GB/T 4457.5 剖面符号 vocabulary, so the hover card names a substance the
    // way the section hatching on the sheet already does.
    'material.metal': '金属材料',
    'material.casting': '铸造金属',
    'material.plastic': '非金属材料',
    'material.glass': '玻璃',
    'material.rubber': '橡胶',
    'material.wood': '木材',
    'material.concrete': '混凝土',
    'material.masonry': '砖',
    'material.liquid': '液体',
    'material.insulation': '绝热材料',
    'material.fabric': '织物',
    'material.earth': '泥土 / 回填土',

    // GB/T 17451 六个基本视图. The sub-line states the projection direction,
    // which is how a Chinese sheet says which view you are looking at.
    'view.iso.label': '轴测',
    'view.q34f.label': '前 3/4',
    'view.q34r.label': '后 3/4',
    'view.side.label': '右视',
    'view.side.caption': '右视图',
    'view.side.sub': '由右向左投射 · 基准状态',
    'view.front.label': '主视',
    'view.front.caption': '主视图',
    'view.front.sub': '由前向后投射 · 按 F 向',
    'view.plan.label': '俯视',
    'view.plan.caption': '俯视图',
    'view.plan.sub': '由上向下投射 · 基准面',
  },
};

/**
 * What a language calls itself. A button reading "CHINESE" is no use to the
 * reader who needs it, so the toggle shows the endonym.
 */
export const LOCALE_LABEL = {
  en: 'EN', zh: '中文', 'zh-TW': '繁體', ja: '日本語', ko: '한국어',
  de: 'DE', fr: 'FR', es: 'ES', it: 'IT', pt: 'PT', ru: 'RU', ar: 'AR',
};

/** Locale code shape: `en`, `zh`, `zh-TW`, `pt-BR`. */
export const LOCALE_CODE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

const baseOf = (spec) => spec?.i18n?.base ?? BASE_LOCALE;

/**
 * Every string on the sheet a translator could reasonably want to change, with
 * the accessor pair needed to read and rewrite it.
 *
 * Only fields that are actually present produce a slot: translating a note the
 * spec never wrote would put text on a sheet that has nowhere to show it,
 * which is why the validator treats an unresolvable path as an error.
 *
 * @param {object} spec - normalized spec
 * @returns {Array<{ path: string, builtin?: string, get: () => string, set: (v: string) => void }>}
 */
export function localizableSlots(spec) {
  const slots = [];
  const add = (path, obj, key, builtin) => {
    if (typeof obj?.[key] !== 'string' || obj[key] === '') return;
    slots.push({ path, builtin, get: () => obj[key], set: (v) => { obj[key] = v; } });
  };

  const meta = spec?.meta ?? {};
  for (const k of ['title', 'subtitle', 'org', 'division', 'tolerance']) add(`meta.${k}`, meta, k);
  for (const k of ['drawingNo', 'sheet', 'scale', 'rev', 'drawn', 'checked', 'date', 'status']) {
    add(`meta.titleBlock.${k}`, meta.titleBlock, k);
  }

  for (const p of spec?.parts ?? []) {
    for (const k of ['name', 'note']) add(`parts.${p.id}.${k}`, p, k);
  }

  // A group is one shared label worn by many parts, so it gets one slot that
  // rewrites all of them — otherwise translating "running gear" would mean
  // writing it out once per road wheel, and the copies would drift.
  const groups = new Map();
  for (const p of spec?.parts ?? []) {
    if (typeof p.group !== 'string' || !p.group) continue;
    if (!groups.has(p.group)) groups.set(p.group, []);
    groups.get(p.group).push(p);
  }
  for (const [name, members] of groups) {
    slots.push({
      path: `groups.${name}`,
      get: () => members[0].group,
      set: (v) => { for (const p of members) p.group = v; },
    });
  }

  for (const c of spec?.annotations?.callouts ?? []) add(`callouts.${c.n}.text`, c, 'text');

  // Dimensions, instruments and datums have no id to key on, so these are
  // indexed — documented, because reordering them does move the translations.
  for (const [i, d] of (spec?.annotations?.dimensions ?? []).entries()) add(`dimensions.${i}.label`, d, 'label');
  for (const [i, ins] of (spec?.instruments ?? []).entries()) add(`instruments.${i}.label`, ins, 'label');
  for (const [i, dd] of (spec?.datums ?? []).entries()) add(`datums.${i}.label`, dd, 'label');

  for (const v of spec?.views ?? []) {
    // A view normalize invented falls back to the built-in dictionary, so a
    // spec that declares no views still reads in the reader's language.
    for (const k of ['label', 'caption', 'sub']) {
      add(`views.${v.id}.${k}`, v, k, v._builtin ? `view.${v.id}.${k}` : undefined);
    }
    add(`views.${v.id}.section.label`, v.section, 'label');
  }

  for (const m of spec?.motions ?? []) add(`motions.${m.id}.label`, m, 'label');

  return slots;
}

/** The locales this sheet can be read in, base first, each labelled in itself. */
export function localeList(spec) {
  const base = baseOf(spec);
  const declared = spec?.i18n?.locales ?? {};
  const label = (code) => declared[code]?.label ?? LOCALE_LABEL[code] ?? code.toUpperCase();
  const out = [{ code: base, label: label(base) }];
  for (const code of Object.keys(declared)) {
    if (code !== base) out.push({ code, label: label(code) });
  }
  return out;
}

/**
 * Look up a piece of sheet furniture.
 *
 * Falls back overlay -> requested locale -> base locale -> English -> the key
 * itself, so a half-filled dictionary degrades to readable text rather than to
 * a blank panel heading.
 */
export function chromeText(spec, lang, key) {
  const override = spec?.i18n?.locales?.[lang]?.strings?.[`chrome.${key}`];
  if (typeof override === 'string') return override;
  return CHROME[lang]?.[key] ?? CHROME[baseOf(spec)]?.[key] ?? CHROME[BASE_LOCALE][key] ?? key;
}

/*
 * Slots and the authored text are worked out once per spec and kept here
 * rather than on the spec itself: the table has to be built from the ORIGINAL
 * strings. Re-deriving it from a spec already switched to Chinese would key a
 * group on its Chinese name and never find its way back.
 */
const SLOTS = new WeakMap();
const AUTHORED = new WeakMap();

/**
 * Rewrite every translatable string in `spec` to `lang`, in place.
 *
 * The authored text is snapshotted on the first call and kept as the base
 * locale, so switching back is exact and a missing translation falls through to
 * what the author actually wrote rather than to an empty string.
 *
 * @returns {{ locale: string, translated: number, total: number }}
 */
export function applyLocale(spec, lang) {
  let slots = SLOTS.get(spec);
  if (!slots) { slots = localizableSlots(spec); SLOTS.set(spec, slots); }
  let snapshot = AUTHORED.get(spec);
  if (!snapshot) {
    snapshot = Object.fromEntries(slots.map((s) => [s.path, s.get()]));
    AUTHORED.set(spec, snapshot);
  }
  const strings = spec?.i18n?.locales?.[lang]?.strings ?? {};

  let translated = 0;
  for (const s of slots) {
    const authored = snapshot[s.path] ?? s.get();
    const overlay = strings[s.path];
    const builtin = s.builtin ? CHROME[lang]?.[s.builtin] : undefined;
    const next = overlay ?? builtin ?? authored;
    if (next !== authored) translated++;
    if (next !== s.get()) s.set(next);
  }
  return { locale: lang, translated, total: slots.length };
}

/**
 * How much of the sheet each locale actually covers, and which of its keys
 * point at nothing.
 *
 * Reported by `b2d validate`, because a translation that stops halfway is the
 * failure mode here: the page still renders, it just quietly goes back to the
 * authored language partway down the legend.
 */
export function localeCoverage(spec) {
  const paths = new Set(localizableSlots(spec).map((s) => s.path));
  const base = baseOf(spec);
  const out = [];
  for (const [code, def] of Object.entries(spec?.i18n?.locales ?? {})) {
    if (code === base) continue;
    const keys = Object.keys(def?.strings ?? {});
    out.push({
      code,
      covered: keys.filter((k) => paths.has(k)).length,
      total: paths.size,
      unknown: keys.filter((k) => !paths.has(k) && !k.startsWith('chrome.')),
      unknownChrome: keys.filter((k) => k.startsWith('chrome.') && !(k.slice(7) in CHROME[BASE_LOCALE])),
    });
  }
  return out;
}
