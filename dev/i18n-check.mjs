/**
 * Offline verification for the language layer.
 *
 * A translation fails quietly. The page still renders, the panels still have
 * headings, and a reader who only speaks the second language simply finds half
 * the sheet in a language they cannot read — no error, no blank, nothing to
 * notice in review. So the things that must hold are asserted here rather than
 * left to the eye:
 *
 *   the toggle is exhaustive   every translated string comes back
 *   the toggle is reversible   switching back restores the authored text exactly
 *   the paths are stable       ids, not array positions
 *   the dictionaries agree     one language cannot grow a key the other lacks
 *   the examples keep up       a part added without its translation is a failure
 *
 *   node dev/i18n-check.mjs
 */

import { readFileSync } from 'node:fs';
import { normalizeSpec } from '../src/spec/normalize.mjs';
import { validateSpec } from '../src/spec/validate.mjs';
import {
  CHROME, applyLocale, chromeText, localeList, localizableSlots, localeCoverage,
} from '../src/spec/i18n.mjs';

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (cond) console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`);
  else { failures++; console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`); }
};

const clone = (v) => JSON.parse(JSON.stringify(v));

/** Smallest spec that passes structural validation, for the validator cases. */
const base = (extra = {}) => ({
  meta: { title: 'TEST RIG', units: 'mm' },
  bounds: { length: 100, width: 100, height: 100 },
  parts: [
    { id: 'a', name: 'FRAME', note: 'welded', group: 'body', shape: { type: 'box', size: [10, 10, 10] } },
    { id: 'b', name: 'COVER', group: 'body', shape: { type: 'box', size: [5, 5, 5] } },
  ],
  ...extra,
});

/* ------------------------------------------------------------------- slots */

console.log('\nslots — keyed by what a reader would name, not by array position');
{
  const spec = normalizeSpec(base({
    annotations: { callouts: [{ n: 3, text: 'the frame', anchor: 'a' }] },
    motions: [{ id: 'spin', label: 'SPIN', set: { d: 1 } }],
    drivers: [{ id: 'd' }],
  }));
  const paths = localizableSlots(spec).map((s) => s.path);

  ok(paths.includes('parts.a.name') && paths.includes('parts.a.note'),
    'a part is addressed by its id');
  ok(paths.includes('callouts.3.text'), 'a callout is addressed by its balloon number');
  ok(paths.includes('motions.spin.label'), 'a motion is addressed by its id');
  ok(!paths.some((p) => /^parts\.\d+\./.test(p)), 'no path is keyed by array index');

  // Two parts, one group: translating "body" twice would be two chances to
  // disagree, and the hover card would show whichever it hit.
  const groupPaths = paths.filter((p) => p.startsWith('groups.'));
  ok(groupPaths.length === 1 && groupPaths[0] === 'groups.body',
    'a group shared by two parts is one slot, not two', groupPaths.join(', '));

  const empty = localizableSlots(normalizeSpec(base()));
  ok(!empty.map((s) => s.path).includes('parts.b.note'),
    'a field the spec never wrote produces no slot');
}

/* ------------------------------------------------------------- apply / back */

console.log('\napplying a locale — exhaustive, reversible, and honest about gaps');
{
  const spec = normalizeSpec(base({
    annotations: { callouts: [{ n: 1, text: 'the frame', anchor: 'a' }] },
    i18n: {
      base: 'en',
      locales: { zh: { label: '中文', strings: { 'parts.a.name': '机架', 'groups.body': '本体', 'callouts.1.text': '机架' } } },
    },
  }));
  const before = JSON.stringify(spec);

  const r = applyLocale(spec, 'zh');
  ok(spec.parts[0].name === '机架', 'a translated string is rewritten in place');
  ok(spec.parts[0].note === 'welded', 'an untranslated string falls back to what the author wrote');
  ok(spec.parts[0].group === '本体' && spec.parts[1].group === '本体',
    'one group entry retitles every part in that group');
  // Three overlay entries plus the captions of the views normalize invented;
  // the untranslated remainder is what keeps this short of the total.
  ok(r.translated >= 3 && r.translated < r.total,
    'the count reports what actually changed', `${r.translated}/${r.total}`);

  applyLocale(spec, 'en');
  ok(JSON.stringify(spec) === before, 'switching back restores the spec byte for byte');

  // The round trip has to survive being driven repeatedly, which is what a
  // reader flipping the toggle actually does.
  for (let i = 0; i < 4; i++) { applyLocale(spec, 'zh'); applyLocale(spec, 'en'); }
  ok(JSON.stringify(spec) === before, 'four round trips leave it unchanged');
}

/* ------------------------------------------------------------ default views */

console.log('\nbuilt-in views — a spec that declares none still reads in Chinese');
{
  const spec = normalizeSpec(base({
    i18n: { locales: { zh: { strings: {} } } },
  }));
  applyLocale(spec, 'zh');
  const side = spec.views.find((v) => v.id === 'side');
  ok(side.caption === '右视图', 'an invented view caption comes from the built-in dictionary', side.caption);
  ok(spec.views.find((v) => v.id === 'iso').label === '轴测', 'and so does its console button');

  applyLocale(spec, 'en');
  ok(side.caption === 'SIDE ELEVATION', 'and it goes back');

  // An authored view is the author's to translate; the dictionary must not
  // reach in and overwrite a label it happens to recognise.
  const authored = normalizeSpec(base({
    views: [{ id: 'side', label: 'SIDE', caption: 'SIDE ELEVATION', projection: 'orthographic', az: 0, el: 0 }],
    i18n: { locales: { zh: { strings: {} } } },
  }));
  applyLocale(authored, 'zh');
  ok(authored.views[0].caption === 'SIDE ELEVATION',
    'an authored view is left alone when the spec has no translation for it');
}

/* ------------------------------------------------------------- the console */

console.log('\nthe toggle — what the console offers and what it calls it');
{
  const one = localeList(normalizeSpec(base()));
  ok(one.length === 1 && one[0].code === 'en',
    'a spec with no i18n block offers a single language, so no toggle is drawn');

  const two = localeList(base({ i18n: { locales: { zh: { strings: {} } } } }));
  ok(two.length === 2 && two[0].code === 'en' && two[1].code === 'zh',
    'the base language comes first');
  ok(two[1].label === '中文', 'a language is labelled in its own script, not in English');

  const named = localeList(base({ i18n: { locales: { zh: { label: '简体', strings: {} } } } }));
  ok(named[1].label === '简体', 'a spec can override the button text');

  const spec = base({ i18n: { locales: { zh: { strings: { 'chrome.hint': '按住拖动' } } } } });
  ok(chromeText(spec, 'zh', 'hint') === '按住拖动', 'a spec can override one of the renderer\'s own strings');
  ok(chromeText(spec, 'zh', 'panel.key') === CHROME.zh['panel.key'], 'the rest still come from the dictionary');
  ok(chromeText(spec, 'ja', 'panel.key') === CHROME.en['panel.key'],
    'an undeclared language falls back to the base language rather than to a blank');
}

/* ------------------------------------------------------- dictionary parity */

console.log('\nthe dictionaries — one language cannot quietly grow a key the other lacks');
{
  const codes = Object.keys(CHROME);
  const reference = Object.keys(CHROME.en).sort();
  for (const code of codes) {
    if (code === 'en') continue;
    const keys = Object.keys(CHROME[code]).sort();
    const missing = reference.filter((k) => !keys.includes(k));
    const extra = keys.filter((k) => !reference.includes(k));
    ok(!missing.length, `${code} translates every key English has`, missing.join(', '));
    ok(!extra.length, `${code} has no key English does not`, extra.join(', '));
    const blank = keys.filter((k) => !String(CHROME[code][k]).trim());
    ok(!blank.length, `${code} has no empty string`, blank.join(', '));
  }
}

/* ----------------------------------------------------------------- standards */

console.log('\nthe Chinese column is GB, not English drafting with Chinese words in it');
{
  // Each of these is a place where the obvious translation is NOT what a
  // Chinese drawing says, which is exactly why they are pinned here.
  const GB = {
    'view.front.caption': ['主视图', 'GB/T 17451 — the front view is 主视图, not 正视图'],
    'view.side.caption': ['右视图', 'GB/T 17451 — az=0 projects right to left'],
    'view.plan.caption': ['俯视图', 'GB/T 17451'],
    'projection.FIRST ANGLE': ['第一角画法', 'GB/T 14692 — 画法, not 投影'],
    'panel.key': ['明细栏', 'GB/T 10609.2 — a numbered key to items is a 明细栏'],
    'tb.org': ['单位名称', 'GB/T 10609.1'],
    'tb.title': ['图样名称', 'GB/T 10609.1 — not 图名'],
    'tb.drawingNo': ['图样代号', 'GB/T 10609.1 — not 图号'],
    'tb.status': ['阶段标记', 'GB/T 10609.1 — the drawing stage, not a status'],
    'key.tolerance': ['未注公差', 'GB/T 1804 — the tolerance not written against a dimension'],
    'material.metal': ['金属材料', 'GB/T 4457.5 剖面符号'],
    'material.liquid': ['液体', 'GB/T 4457.5 剖面符号'],
  };
  for (const [key, [want, why]] of Object.entries(GB)) {
    ok(CHROME.zh[key] === want, `${key} follows ${why.split(' — ')[0]}`,
      CHROME.zh[key] === want ? why : `got "${CHROME.zh[key]}", expected "${want}"`);
  }

  // The everyday words. Readable, widely used, and not what the standard calls
  // these views — a sheet issued to GB should not carry them.
  const loose = Object.entries(CHROME.zh).filter(([, v]) => v === '正视图' || v === '侧视图');
  ok(!loose.length, 'no view is labelled with the everyday word instead of the GB name',
    loose.map(([k]) => k).join(', '));

  // A section is a 剖视图 and its label takes an em dash: "B—B 剖视图".
  for (const name of ['mbt-mk6', 'radial-engine']) {
    const strings = JSON.parse(readFileSync(`examples/${name}/spec.json`, 'utf8'))
      .i18n?.locales?.zh?.strings ?? {};
    const sections = Object.entries(strings)
      .filter(([k]) => /^views\..+\.caption$/.test(k) && /剖/.test(k + strings[k]));
    ok(sections.length > 0 && sections.every(([, v]) => /^[A-Z]—[A-Z] 剖视图$/.test(v)),
      `${name} labels its section the GB way`, sections.map(([, v]) => v).join(', '));
  }
}

/* ---------------------------------------------------------------- validator */

console.log('\nvalidation — a translation that points at nothing is an error, not a shrug');
{
  const bad = validateSpec(base({
    i18n: { locales: { zh: { strings: { 'parts.nope.name': '没有' } } } },
  }));
  ok(!bad.ok && bad.errors.some((e) => /does not name any text/.test(e)),
    'a path that resolves to nothing is rejected', bad.errors.join('; '));

  const typo = validateSpec(base({
    i18n: { locales: { zh: { strings: { 'chrome.hnit': '提示' } } } },
  }));
  ok(!typo.ok && typo.errors.some((e) => /renderer's own strings/.test(e)),
    'a misspelled renderer key is rejected');

  const blank = validateSpec(base({
    i18n: { locales: { zh: { strings: { 'parts.a.name': '   ' } } } },
  }));
  ok(!blank.ok && blank.errors.some((e) => /is empty/.test(e)),
    'an empty translation is rejected — dropping the key is the way to fall back');

  const dangling = validateSpec(base({
    i18n: { default: 'ja', locales: { zh: { strings: { 'parts.a.name': '机架' } } } },
  }));
  ok(!dangling.ok && dangling.errors.some((e) => /default locale/.test(e)),
    'opening in a language the spec does not carry is rejected');

  // The six default views only exist after normalization, and translating them
  // has to be legal — this is the check that keeps the validator honest about
  // where it resolves paths.
  const builtin = validateSpec(base({
    i18n: { locales: { zh: { strings: { 'views.side.caption': '侧视图' } } } },
  }));
  ok(builtin.ok, 'a path into a view normalize invented resolves', builtin.errors.join('; '));

  const long = validateSpec(base({
    motions: [{ id: 'spin', label: 'SPIN', set: { d: 1 } }],
    drivers: [{ id: 'd' }],
    i18n: { locales: { zh: { strings: { 'motions.spin.label': '一二三四五六七八九' } } } },
  }));
  ok(long.ok && long.warnings.some((w) => /console buttons fit/.test(w)),
    'an over-long console label warns without failing the build');

  const hollow = validateSpec(base({ i18n: { locales: { zh: { strings: {} } } } }));
  ok(hollow.ok && hollow.warnings.some((w) => /translates nothing/.test(w)),
    'a declared but empty language warns');

  const none = validateSpec(base());
  ok(none.ok && !none.warnings.some((w) => /i18n/.test(w)),
    'a spec with no i18n block says nothing about languages');
}

/* ----------------------------------------------------------- the examples */

console.log('\nthe shipped examples — every word on the sheet has a Chinese line');

/**
 * The prose families only. A drawing number, a revision letter, a scale and a
 * dimension reading "9 980" are the same in both languages, and demanding a
 * translation for them would be noise nobody would keep clean.
 */
const PROSE = /^(meta\.(title|subtitle|org|division)|parts\..+\.(name|note)|groups\..+|callouts\.\d+\.text|instruments\.\d+\.label|views\..+\.(label|caption|sub)|motions\..+\.label)$/;

for (const name of ['mbt-mk6', 'radial-engine']) {
  const raw = JSON.parse(readFileSync(`examples/${name}/spec.json`, 'utf8'));
  const spec = normalizeSpec(clone(raw));
  const declared = localeList(raw).map((l) => l.code);
  ok(declared.includes('zh'), `${name} ships a Chinese translation`, declared.join(', '));

  const strings = raw.i18n?.locales?.zh?.strings ?? {};
  const untranslated = localizableSlots(spec)
    .map((s) => s.path)
    .filter((p) => PROSE.test(p) && strings[p] == null);
  ok(!untranslated.length, `${name} leaves no prose untranslated`,
    untranslated.slice(0, 6).join(', ') + (untranslated.length > 6 ? ` (+${untranslated.length - 6})` : ''));

  const [cov] = localeCoverage(spec);
  ok(cov && cov.unknown.length === 0, `${name} has no dead translation keys`,
    (cov?.unknown ?? []).join(', '));

  // And the whole thing still survives the trip there and back.
  const before = JSON.stringify(spec);
  applyLocale(spec, 'zh');
  const changed = JSON.stringify(spec) !== before;
  applyLocale(spec, 'en');
  ok(changed && JSON.stringify(spec) === before, `${name} switches and comes back unchanged`);
}

if (failures) {
  console.error(`\n\x1b[31m${failures} check(s) failed\x1b[0m`);
  process.exit(1);
}
console.log('\n\x1b[32mthe sheet says the same thing in both languages\x1b[0m');
