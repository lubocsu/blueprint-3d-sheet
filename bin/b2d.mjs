#!/usr/bin/env node
/**
 * b2d — 2D drawing -> interactive 3D blueprint page.
 *
 *   b2d ingest <file|->  [--archetype x] [--out spec.json] [--research|--no-research]
 *   b2d bundle init "<subject>"
 *   b2d bundle add-url <bundle> <url> [--role manual|drawing|photo|spec|cad]
 *   b2d bundle fetch|score|select|status <bundle>
 *   b2d bundle prune [--older-than-days n] [--dry-run]
 *   b2d validate <spec>  [--strict]
 *   b2d build <spec>     [--out dir] [--no-minify] [--embed-font f.woff2] [--lang zh]
 *   b2d i18n <spec>      [--locale zh] [--missing] [--out strings.json]
 *   b2d selftest <spec>  [--out dir] [--shots dir]
 *   b2d serve            [--port 5178]
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateSpec } from '../src/spec/validate.mjs';
import { checkRichness } from '../src/spec/richness.mjs';
import { normalizeSpec } from '../src/spec/normalize.mjs';
import { localeCoverage, localizableSlots, localeList } from '../src/spec/i18n.mjs';
import { writePage } from '../src/emit/page.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const C = {
  dim:  (s) => `\x1b[2m${s}\x1b[0m`,
  red:  (s) => `\x1b[31m${s}\x1b[0m`,
  yel:  (s) => `\x1b[33m${s}\x1b[0m`,
  grn:  (s) => `\x1b[32m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

const argv = process.argv.slice(2);
const cmd = argv[0];
const positional = argv.slice(1).filter((a) => !a.startsWith('--'));
const flag = (name, dflt = undefined) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
};
const has = (name) => argv.includes(`--${name}`);

async function readSpec(path) {
  if (!path) die('missing <spec> argument');
  if (!existsSync(path)) die(`spec not found: ${path}`);
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    die(`could not parse ${path}: ${err.message}`);
  }
}

function die(msg) {
  console.error(C.red(`error: ${msg}`));
  process.exit(1);
}

function report(spec, { strict }) {
  const structural = validateSpec(spec, { strict });
  if (!structural.ok) {
    console.error(C.red(`\n✗ ${structural.errors.length} schema/semantic error(s):`));
    for (const e of structural.errors) console.error('  ' + e);
    return { ok: false };
  }
  for (const w of structural.warnings) console.error(C.yel('  warn  ') + w);

  const rich = checkRichness(spec, { strict });
  const s = rich.stats;
  console.error(C.dim(
    `  ${s.archetype} · ${s.authoredParts} parts (${s.effectiveParts} with instances) · ` +
    `${s.callouts} callouts · ${s.dimensions} dims · ${s.views} views · ` +
    `${s.motions} motions · ${s.instruments} readouts · ${s.details} details · ` +
    `notes ${Math.round(s.noteRatio * 100)}%`));

  // A half-translated sheet still renders, and quietly falls back to the
  // authored language partway down the legend. Say how far each one got.
  if (spec.i18n) {
    try {
      for (const c of localeCoverage(normalizeSpec(spec))) {
        console.error(C.dim(`  ${c.code}: ${c.covered}/${c.total} strings translated` +
                            `${c.covered < c.total ? ` (${c.total - c.covered} fall back to ${spec.i18n.base ?? 'en'})` : ''}`));
      }
    } catch { /* structural problems are already reported above */ }
  }

  for (const w of rich.warnings) console.error(C.yel('  thin  ') + w);
  if (!rich.ok) {
    console.error(C.red(`\n✗ density gate: ${rich.errors.length} shortfall(s):`));
    for (const e of rich.errors) console.error('  ' + e);
    return { ok: false };
  }
  return { ok: true };
}

/* ----------------------------------------------------------------- commands */

async function cmdValidate() {
  const spec = await readSpec(positional[0]);
  console.error(C.bold(`validating ${basename(positional[0])}`));
  const r = report(spec, { strict: has('strict') });
  if (!r.ok) process.exit(1);
  console.error(C.grn('\n✓ spec is valid and meets the density bar'));
}

async function cmdBuild() {
  const path = positional[0];
  const spec = await readSpec(path);
  console.error(C.bold(`building ${basename(path)}`));

  const r = report(spec, { strict: has('strict') });
  if (!r.ok) {
    if (!has('force')) {
      console.error(C.dim('\n  (pass --force to build anyway)'));
      process.exit(1);
    }
    console.error(C.yel('\n  --force: building despite the above'));
  }

  // `--lang` picks which language the page OPENS in; every declared language
  // still ships in the page and the reader can switch at any time.
  const lang = flag('lang', null);
  if (typeof lang === 'string') {
    const known = localeList(spec).map((l) => l.code);
    if (!known.includes(lang)) die(`spec has no "${lang}" locale (has ${known.join(', ')})`);
    if (spec.i18n) spec.i18n = { ...spec.i18n, default: lang };
  }

  const id = normalizeSpec(spec).meta.id;
  const outDir = String(flag('out', join(ROOT, 'out', id)));
  const embedFont = flag('embed-font', null);
  const { file, bytes } = await writePage(spec, outDir, {
    minify: !has('no-minify'),
    embedFont: typeof embedFont === 'string' ? embedFont : null,
  });
  console.error(C.grn(`\n✓ ${file}  ${(bytes / 1024).toFixed(0)} kB, self-contained`));
  console.log(file);
}

/**
 * Print the translatable strings as a ready-to-fill `strings` map.
 *
 * Translating a sheet by hand means first knowing what there is to translate,
 * and the paths are derived from the spec rather than guessable. `--missing`
 * narrows it to what a locale has not covered yet, which is the form you want
 * on the second pass.
 */
async function cmdI18n() {
  const path = positional[0];
  const spec = await readSpec(path);
  const code = String(flag('locale', 'zh'));
  const existing = spec.i18n?.locales?.[code]?.strings ?? {};
  const slots = localizableSlots(normalizeSpec(spec));

  const out = {};
  for (const s of slots) {
    if (has('missing') && existing[s.path] != null) continue;
    out[s.path] = existing[s.path] ?? s.get();
  }

  const body = JSON.stringify(out, null, 2);
  const dest = flag('out', null);
  if (typeof dest === 'string') {
    await writeFile(dest, `${body}\n`, 'utf8');
    console.error(C.grn(`✓ ${dest}`));
  } else {
    console.log(body);
  }
  const covered = slots.filter((s) => existing[s.path] != null).length;
  console.error(C.dim(`  ${Object.keys(out).length} string(s) listed · ` +
                      `${code} currently covers ${covered}/${slots.length}`));
}

/** Resolve once the page has rendered `n` frames, bounded for throttled headless Chrome. */
async function settle(page, n = 90, maxMs = 12000) {
  await page.evaluate(({ count, timeout }) => new Promise((resolve) => {
    let i = 0;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(i);
    };
    const timer = setTimeout(done, timeout);
    const tick = () => (++i >= count ? done() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  }), { count: n, timeout: maxMs });
}

async function cmdSelftest() {
  const path = positional[0];
  const spec = await readSpec(path);
  const norm = normalizeSpec(spec);
  const id = norm.meta.id;

  const outDir = String(flag('out', join(ROOT, 'out', id)));
  const shotDir = String(flag('shots', join(outDir, 'shots')));
  await mkdir(shotDir, { recursive: true });

  const { file } = await writePage(spec, outDir, { minify: !has('no-minify') });
  console.error(C.bold(`selftest ${basename(path)} -> ${shotDir}`));

  const puppeteer = (await import('puppeteer')).default;
  const { CHROME_FLAGS } = await import('../dev/shot.mjs');
  const browser = await puppeteer.launch({ headless: true, args: CHROME_FLAGS });
  const page = await browser.newPage();

  const problems = [];
  page.on('pageerror', (e) => problems.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });

  await page.setViewport({ width: 1600, height: 950, deviceScaleFactor: 2 });
  // `pathToFileURL` rather than string concatenation: `--out` may be relative,
  // and a relative path behind `file://` resolves to a host name, not a file.
  // It also escapes a path with spaces or non-ASCII in it, which hand-built
  // URLs silently get wrong.
  await page.goto(pathToFileURL(resolve(file)).href, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('window.__B2D__ && window.__B2D__.ready', { timeout: 30000 });

  const stats = await page.evaluate(() => ({ ...window.__B2D__.stats, buildMs: window.__B2D__.buildMs }));
  console.error(C.dim(`  ${stats.meshes} meshes · ${Math.round(stats.tris)} tris · ` +
                      `${stats.merged} merged · ${stats.buildMs.toFixed(0)} ms build`));

  const shots = [];
  const failures = [];

  for (const v of norm.views) {
    await page.evaluate((vid) => { window.__B2D__.clearMotions(); window.__B2D__.setView(vid); }, v.id);
    // Wait on RENDERED FRAMES, not wall-clock. Headless Chrome throttles
    // requestAnimationFrame hard, so a setTimeout settles far fewer frames than
    // it looks like and the probe ends up measuring the tail of the balloon
    // glide rather than the layout at rest.
    await settle(page, 90);
    const out = join(shotDir, `view-${v.id}.png`);
    await page.screenshot({ path: out });
    shots.push(out);

    // Sheet-quality assertions. These encode the properties that are easy to
    // regress and tedious to eyeball across every view.
    const probe = await page.evaluate(() => {
      const vis = (sel) => {
        const n = document.querySelector(sel);
        if (!n) return false;
        const s = getComputedStyle(n);
        return s.visibility !== 'hidden' && s.opacity !== '0';
      };
      const balloons = [...document.querySelectorAll('#ann .balloon')]
        .filter((c) => c.style.display !== 'none')
        .map((c) => ({ x: +c.getAttribute('cx'), y: +c.getAttribute('cy') }));

      const panels = ['#key', '#instr', '#titleblock', '#console']
        .map((s) => document.querySelector(s))
        .filter((n) => n && vis(`#${n.id}`))
        .map((n) => n.getBoundingClientRect());

      let minGap = Infinity;
      for (let i = 0; i < balloons.length; i++) {
        for (let j = i + 1; j < balloons.length; j++) {
          minGap = Math.min(minGap, Math.hypot(balloons[i].x - balloons[j].x, balloons[i].y - balloons[j].y));
        }
      }
      const onPanel = balloons.filter((b) =>
        panels.some((r) => b.x > r.left - 6 && b.x < r.right + 6 && b.y > r.top - 6 && b.y < r.bottom + 6)).length;

      // Every view and motion button should carry a glyph derived from the
      // spec. A button with no <svg> at all means the icon layer threw and was
      // swallowed; a console where they are ALL identical means the derivation
      // stopped deriving and everything fell back to the generic shape.
      const glyphs = [...document.querySelectorAll(
        '#console [data-group="view"] .btn, #console [data-group="motion"] .btn')]
        .map((b) => b.querySelector('svg')?.innerHTML ?? '');

      return {
        plate: document.getElementById('sheet').classList.contains('plate'),
        glyphless: glyphs.filter((g) => !g).length,
        distinctGlyphs: new Set(glyphs).size,
        glyphButtons: glyphs.length,
        keyVisible: vis('#key'),
        instrVisible: vis('#instr'),
        dims: [...document.querySelectorAll('.dimlabel')].filter((t) => t.style.display !== 'none').length,
        balloons: balloons.length,
        // null, not Infinity: page.evaluate serialises through JSON, where
        // Infinity becomes null anyway — and `null < 24` is TRUE, so the
        // caller would report a bogus failure and then crash formatting it.
        minGap: balloons.length > 1 ? minGap : null,
        onPanel,
      };
    });

    const ortho = v.projection === 'orthographic';
    const where = `view "${v.id}"`;
    if (ortho && (probe.keyVisible || probe.instrVisible)) {
      failures.push(`${where}: orthographic plate should hide the KEY / INSTRUMENTATION panels`);
    }
    if (ortho && probe.dims === 0) {
      failures.push(`${where}: an orthographic plate should carry at least one dimension`);
    }
    if (probe.onPanel > 0) {
      failures.push(`${where}: ${probe.onPanel} balloon(s) sitting on a panel`);
    }
    if (probe.minGap != null && probe.minGap < 24) {
      failures.push(`${where}: two balloons only ${probe.minGap.toFixed(0)}px apart (need >= 24)`);
    }
    if (probe.glyphless > 0) {
      failures.push(`${where}: ${probe.glyphless} console button(s) drew no glyph`);
    }
    // Two buttons may legitimately share a glyph — two motions that both drive
    // emitters do the same kind of thing. All of them sharing one does not
    // happen by chance.
    if (probe.glyphButtons > 2 && probe.distinctGlyphs < 2) {
      failures.push(`${where}: all ${probe.glyphButtons} console glyphs are identical`);
    }
  }

  for (const m of norm.motions) {
    await page.evaluate((mid) => {
      window.__B2D__.clearMotions();
      window.__B2D__.setView(window.__B2D__.spec.views[0].id);
      window.__B2D__.setMotion(mid, true);
      window.__B2D__.advance(2.5);
    }, m.id);
    await settle(page, 40);
    const out = join(shotDir, `motion-${m.id}.png`);
    await page.screenshot({ path: out });
    shots.push(out);
  }

  // Every language the sheet offers. A translation that throws, empties a
  // panel or never actually lands only shows up when the page is switched, and
  // the shots make a wrong line visible to a reader of that language.
  const locales = await page.evaluate(() => window.__B2D__.locales ?? []);
  if (locales.length > 1) {
    const seen = [];
    for (const code of locales) {
      const probe = await page.evaluate((c) => {
        window.__B2D__.clearMotions();
        window.__B2D__.setView(window.__B2D__.spec.views[0].id);
        // The motion loop left the drivers wherever it stopped, and an explode
        // that has not relaxed yet holds the camera framing wide. Run the
        // simulation home first so the language shot is of the sheet at rest.
        window.__B2D__.advance(4);
        window.__B2D__.setLocale(c);
        const text = (sel) => document.querySelector(sel)?.textContent?.trim() ?? '';
        return {
          lang: document.documentElement.lang,
          title: document.title,
          heading: text('#key h2') || text('#instr h2'),
          hasKey: Boolean(document.querySelector('#key .item')),
          hasConsole: Boolean(document.querySelector('#console .btn')),
          firstItem: text('#key .item .tx'),
          // Addressed by GROUP, not by document order. The console has grown
          // rows since — layers, panels — and "the first button in the console"
          // quietly stopped meaning "a view button" the moment one of them was
          // appended first. It still had a label, so nothing failed; the probe
          // was simply no longer measuring what it is named after.
          firstView: text('#console [data-group="view"] .btn'),
        };
      }, code);
      // The same 90 frames the view loop waits for: the balloon layout glides
      // into place, and a shot taken mid-glide would show a layout the reader
      // never sees.
      await settle(page, 90);
      const out = join(shotDir, `lang-${code}.png`);
      await page.screenshot({ path: out });
      shots.push(out);

      const where = `locale "${code}"`;
      if (probe.lang !== code) failures.push(`${where}: <html lang> stayed at "${probe.lang}"`);
      if (!probe.title) failures.push(`${where}: the page title came out empty`);
      // Only assert on panels this sheet actually has — a spec with no
      // callouts has no legend to translate.
      if (probe.hasKey && !probe.firstItem) failures.push(`${where}: the legend lost its text`);
      if (probe.hasConsole && !probe.firstView) failures.push(`${where}: a console button lost its label`);
      seen.push(probe);
    }
    // A toggle that changes nothing is the failure worth catching: the sheet
    // furniture is translated by the renderer, so it must differ every time.
    const headings = seen.map((p) => p.heading).filter(Boolean);
    if (headings.length === locales.length && new Set(headings).size !== locales.length) {
      failures.push(`the language toggle left the panel headings identical across ${locales.join(', ')}`);
    }
    // Back to where we started, exactly.
    const home = await page.evaluate((c) => {
      window.__B2D__.setLocale(c);
      return { heading: document.querySelector('#key h2')?.textContent?.trim() ?? '', title: document.title };
    }, locales[0]);
    if (home.heading !== seen[0].heading || home.title !== seen[0].title) {
      failures.push(`switching back to "${locales[0]}" did not restore the sheet`);
    }
  }

  // no external requests is a hard requirement of the emitted page
  const external = await page.evaluate(() =>
    performance.getEntriesByType('resource')
      .map((e) => e.name)
      .filter((n) => !n.startsWith('file:') && !n.startsWith('data:')));

  await browser.close();

  if (external.length) {
    console.error(C.red(`\n✗ page made ${external.length} external request(s):`));
    for (const u of external.slice(0, 8)) console.error('  ' + u);
    process.exit(1);
  }
  if (problems.length) {
    console.error(C.red(`\n✗ ${problems.length} runtime error(s):`));
    for (const p of problems.slice(0, 12)) console.error('  ' + p);
    process.exit(1);
  }
  if (failures.length) {
    console.error(C.red(`\n✗ ${failures.length} sheet-quality failure(s):`));
    for (const f of failures) console.error('  ' + f);
    process.exit(1);
  }

  console.error(C.grn(`\n✓ ${shots.length} shots · sheet checks passed · ` +
                      `no runtime errors · no external requests`));
  for (const s of shots) console.log(s);
}

async function cmdIngest() {
  const { ingest } = await import('../src/ingest/index.mjs');
  const input = positional[0];
  if (!input) die('missing <file> argument');
  // --research / --no-research override the automatic thin-brief detection;
  // null means "decide for me".
  const research = has('no-research') ? false : (has('research') ? true : null);
  const axes = flag('research-axes', null);
  const spec = await ingest(input, {
    archetype: flag('archetype', null),
    notes: flag('notes', null),
    research,
    researchAxes: typeof axes === 'string' ? axes.split(',').map((a) => a.trim()).filter(Boolean) : null,
    refreshResearch: has('refresh-research'),
    dossier: typeof flag('dossier', null) === 'string' ? String(flag('dossier')) : null,
    reference: typeof flag('reference', null) === 'string' ? String(flag('reference')) : null,
    bundle: typeof flag('bundle', null) === 'string' ? String(flag('bundle')) : null,
    verbose: true,
  });
  const out = flag('out', null);
  const json = JSON.stringify(spec, null, 2);
  if (typeof out === 'string') {
    await mkdir(dirname(resolve(out)), { recursive: true });
    await writeFile(out, json, 'utf8');
    console.error(C.grn(`\n✓ wrote ${out}`));
    console.log(out);
  } else {
    console.log(json);
  }
}

function printBundleTable(manifest) {
  const rows = manifest.sources.map((s) => ({
    id: s.id,
    role: s.role,
    kind: s.kind ?? '',
    status: s.status,
    score: s.score ?? '',
    title: (s.title || s.url).slice(0, 72),
  }));
  if (!rows.length) {
    console.error(C.dim('  no urls in this bundle'));
    return;
  }
  console.table(rows);
}

async function cmdBundle() {
  const sub = argv[1];
  const { initBundle, addBundleUrl, fetchBundle, scoreBundle, selectBundle, bundleStatus, pruneBundles } =
    await import('../src/ingest/bundle.mjs');

  if (sub === 'init') {
    const subject = argv[2];
    if (!subject || subject.startsWith('--')) die('missing <subject>');
    const out = flag('out', null);
    const { bundleDir, created } = await initBundle(subject, {
      outDir: typeof out === 'string' ? out : null,
      archetype: flag('archetype', null),
    });
    console.error(C.grn(`${created ? 'created' : 'opened'} bundle: ${bundleDir}`));
    console.log(bundleDir);
    return;
  }

  if (sub === 'add-url') {
    const bundleDir = argv[2];
    const url = argv[3];
    if (!bundleDir || !url) die('usage: b2d bundle add-url <bundle> <url> [--role role]');
    const { entry, added } = await addBundleUrl(bundleDir, url, {
      role: String(flag('role', 'manual')),
      title: typeof flag('title', null) === 'string' ? String(flag('title')) : null,
    });
    console.error(C.grn(`${added ? 'added' : 'updated'} ${entry.id} (${entry.role})`));
    console.log(entry.id);
    return;
  }

  if (sub === 'fetch') {
    const bundleDir = argv[2];
    if (!bundleDir) die('usage: b2d bundle fetch <bundle> [--screenshots]');
    const manifest = await fetchBundle(bundleDir, { screenshots: has('screenshots') });
    printBundleTable(manifest);
    return;
  }

  if (sub === 'score') {
    const bundleDir = argv[2];
    if (!bundleDir) die('usage: b2d bundle score <bundle>');
    const manifest = await scoreBundle(bundleDir);
    printBundleTable(manifest);
    return;
  }

  if (sub === 'select') {
    const bundleDir = argv[2];
    if (!bundleDir) die('usage: b2d bundle select <bundle> [--max n]');
    const max = Number(flag('max', 5));
    const { manifest } = await selectBundle(bundleDir, { max: Number.isFinite(max) ? max : 5 });
    printBundleTable(manifest);
    console.error(C.grn(`selected ${manifest.selected?.length ?? 0} file(s)`));
    console.log(resolve(bundleDir, 'dossier.json'));
    return;
  }

  if (sub === 'status') {
    const bundleDir = argv[2];
    if (!bundleDir) die('usage: b2d bundle status <bundle>');
    console.log(JSON.stringify(await bundleStatus(bundleDir), null, 2));
    return;
  }

  if (sub === 'prune') {
    const older = Number(flag('older-than-days', 30));
    const result = await pruneBundles({
      olderThanDays: Number.isFinite(older) ? older : 30,
      dryRun: has('dry-run'),
    });
    console.error(C.grn(`${result.dryRun ? 'would remove' : 'removed'} ${result.removed.length} bundle(s)`));
    for (const p of result.removed) console.log(p);
    return;
  }

  console.error(`b2d bundle

  b2d bundle init "<subject>"           [--out dir] [--archetype x]
  b2d bundle add-url <bundle> <url>     [--role manual|drawing|photo|spec|cad] [--title "..."]
  b2d bundle fetch <bundle>             [--screenshots]
  b2d bundle score <bundle>
  b2d bundle select <bundle>            [--max 3]
  b2d bundle status <bundle>
  b2d bundle prune                      [--older-than-days 30] [--dry-run]
`);
  process.exit(sub ? 1 : 0);
}

/**
 * Research a subject on its own, without building anything.
 *
 * A dossier is worth having as a reviewable artefact in its own right: it can be
 * read, corrected, version-controlled and reused across builds. Splitting it out
 * also means the one stage that needs the network can be run where the network
 * is, and the result carried to where the build happens.
 */
async function cmdResearch() {
  const { researchSubject, needsResearch } = await import('../src/ingest/research.mjs');
  const { guessArchetype } = await import('../src/ingest/archetypes.mjs');
  const { formatEvidence, explainEvidence } = await import('../src/ingest/evidence.mjs');

  const subject = positional[0];
  if (!subject) die('missing <subject> argument');

  const chosen = String(flag('archetype', null) ?? guessArchetype(subject));
  const axes = flag('research-axes', null);
  const decision = needsResearch({
    kind: 'brief', brief: subject, archetype: chosen,
    force: true,
    axes: typeof axes === 'string' ? axes.split(',').map((a) => a.trim()).filter(Boolean) : null,
  });

  console.error(C.bold(`researching ${subject}`));
  console.error(C.dim(`  archetype: ${chosen}`));
  console.error(formatEvidence(decision.report));
  console.error(explainEvidence(decision.report));

  const r = await researchSubject({
    subject, archetype: chosen, gaps: decision.gaps,
    refresh: has('refresh-research'), verbose: true,
  });

  if (!r.dossier) {
    console.error(C.yel(`
  no dossier: ${r.why}`));
    if (r.requestPath) console.error(C.dim(`  wrote ${r.requestPath} — fill it in and pass it with --dossier`));
    process.exit(1);
  }

  const json = JSON.stringify(r.dossier, null, 2);
  const out = flag('out', null);
  if (typeof out === 'string') {
    await mkdir(dirname(resolve(out)), { recursive: true });
    await writeFile(out, json, 'utf8');
    console.error(C.grn(`
✓ wrote ${out}`));
    console.log(out);
  } else {
    console.log(json);
  }
}

async function cmdServe() {
  process.env.PORT = String(flag('port', 5178));
  await import('../dev/serve.mjs');
}

const COMMANDS = {
  validate: cmdValidate,
  build: cmdBuild,
  i18n: cmdI18n,
  selftest: cmdSelftest,
  ingest: cmdIngest,
  research: cmdResearch,
  bundle: cmdBundle,
  serve: cmdServe,
};

const wantsHelp = cmd === '--help' || cmd === '-h' || has('help');
if (!cmd || !COMMANDS[cmd] || wantsHelp) {
  console.error(`b2d — 2D drawing -> interactive 3D blueprint page

  b2d ingest <file|brief.txt>  [--archetype x] [--out spec.json] [--notes "..."]
                               [--research | --no-research] [--research-axes a,b]
                               [--dossier facts.json] [--reference photo.png] [--bundle dir]
                               [--refresh-research]
  b2d research <subject>       [--archetype x] [--out dossier.json] [--research-axes a,b]
  b2d bundle init "<subject>"  [--out dir] [--archetype x]
  b2d bundle add-url <bundle> <url> [--role manual|drawing|photo|spec|cad]
  b2d bundle fetch|score|select|status <bundle>
  b2d bundle prune             [--older-than-days 30] [--dry-run]
  b2d validate <spec.json>     [--strict]
  b2d build <spec.json>        [--out dir] [--no-minify] [--embed-font f.woff2] [--force]
                               [--lang zh]   which language the page opens in
  b2d i18n <spec.json>         [--locale zh] [--missing] [--out strings.json]
                               list the translatable strings, ready to fill in
  b2d selftest <spec.json>     [--out dir] [--shots dir]
  b2d serve                    [--port 5178]
`);
  process.exit(cmd && !COMMANDS[cmd] && !wantsHelp ? 1 : 0);
}

try {
  await COMMANDS[cmd]();
} catch (err) {
  // A stack trace helps nobody diagnose "you forgot the API key".
  console.error(C.red(`\nerror: ${err.message}`));
  if (err.report?.warnings?.length) {
    for (const w of err.report.warnings) console.error(C.yel('  warn  ') + w);
  }
  if (process.env.B2D_DEBUG) console.error(err.stack);
  else console.error(C.dim('  (set B2D_DEBUG=1 for a stack trace)'));
  process.exit(1);
}
