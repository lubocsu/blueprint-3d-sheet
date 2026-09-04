#!/usr/bin/env node
/**
 * Bilingual docs drift silently: someone edits one README and the other keeps
 * asserting last month's behaviour. Nobody notices, because nobody reads both.
 *
 * Section count is a crude tripwire, but it catches the failure that actually
 * happens — a section added or removed on one side only. It cannot tell whether
 * a translation is accurate; that still needs a person.
 *
 *   node scripts/check-readmes.mjs
 */

import { readFileSync, existsSync } from 'node:fs';

const EN = 'README.md';
const ZH = 'README.zh-CN.md';

let failures = 0;
const fail = (msg) => { failures++; console.error(`  x ${msg}`); };
const pass = (msg) => console.log(`  - ${msg}`);

for (const f of [EN, ZH]) {
  if (!existsSync(f)) { fail(`${f} is missing`); process.exit(1); }
}

const en = readFileSync(EN, 'utf8');
const zh = readFileSync(ZH, 'utf8');

/** Top-level sections only; sub-headings are free to differ. */
const sections = (text) => text.split('\n').filter((l) => l.startsWith('## '));

const enSecs = sections(en);
const zhSecs = sections(zh);
if (enSecs.length !== zhSecs.length) {
  fail(`section drift: ${EN} has ${enSecs.length}, ${ZH} has ${zhSecs.length}`);
} else {
  pass(`both READMEs have ${enSecs.length} sections`);
}

// The switcher only works if each side points at the other.
if (!en.includes(ZH)) fail(`${EN} does not link to ${ZH}`);
else if (!zh.includes(EN)) fail(`${ZH} does not link back to ${EN}`);
else pass('the language switcher links both ways');

// A broken image on GitHub is invisible until someone opens the page.
const IMAGE = /!\[[^\]]*\]\(([^)]+)\)/g;
let images = 0;
for (const [name, text] of [[EN, en], [ZH, zh]]) {
  for (const m of text.matchAll(IMAGE)) {
    const src = m[1];
    if (/^https?:/.test(src)) continue;
    images++;
    if (!existsSync(src)) fail(`${name} references a missing image: ${src}`);
  }
}
if (!failures) pass(`${images} local image reference(s) resolve`);

// The honest caveat is the one most likely to be dropped in translation.
const CAVEAT = /## (Not in this release|本版本未包含的内容)/;
if (!CAVEAT.test(en) || !CAVEAT.test(zh)) {
  fail('one side is missing the "not in this release" section');
} else {
  pass('both sides still carry the unfinished-work disclosure');
}

if (failures) {
  console.error(`\nREADME check failed with ${failures} problem(s)`);
  process.exit(1);
}
console.log('\nREADMEs agree');
