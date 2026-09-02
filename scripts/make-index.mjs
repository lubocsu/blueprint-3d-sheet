#!/usr/bin/env node
/**
 * Writes the landing page that lists the built demo sheets.
 *
 * Reads what was actually built rather than a hard-coded list, so adding an
 * example to `examples/` puts it on the site with no edit here. Metadata comes
 * from each spec, not from the emitted HTML — the spec is the contract.
 *
 * Deliberately as self-contained as the sheets it links to: no fonts, no
 * scripts, no external anything.
 *
 *   node scripts/make-index.mjs site
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The smoke rig exercises the renderer and deliberately fails the density gate,
 * so it is neither built for the site nor listed on it. One list, so the build
 * loop and the index can never disagree about what belongs here.
 */
const HIDDEN = new Set(['smoke']);

/** `--list` prints the buildable example slugs, one per line, for the CI loop. */
if (process.argv[2] === '--list') {
  for (const e of readdirSync('examples', { withFileTypes: true })) {
    if (!e.isDirectory() || HIDDEN.has(e.name)) continue;
    if (existsSync(join('examples', e.name, 'spec.json'))) console.log(e.name);
  }
  process.exit(0);
}

const site = process.argv[2] ?? 'site';

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const kb = (bytes) => `${Math.round(bytes / 1024)} kB`;

const sheets = readdirSync(site, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !HIDDEN.has(e.name))
  .map((e) => {
    const page = join(site, e.name, 'index.html');
    const spec = join('examples', e.name, 'spec.json');
    if (!existsSync(page) || !existsSync(spec)) return null;
    const s = JSON.parse(readFileSync(spec, 'utf8'));
    const instances = (s.parts ?? []).reduce((n, p) => n + (p.instances?.count ?? 1), 0);
    return {
      slug: e.name,
      title: s.meta?.title ?? e.name,
      subtitle: s.meta?.subtitle ?? '',
      parts: (s.parts ?? []).length,
      instances,
      views: (s.views ?? []).length,
      motions: (s.motions ?? []).length,
      callouts: (s.annotations?.callouts ?? []).length,
      size: statSync(page).size,
    };
  })
  .filter(Boolean)
  .sort((a, b) => b.parts - a.parts);

if (!sheets.length) {
  console.error(`no built sheets found under ${site}/`);
  process.exit(1);
}

const cards = sheets.map((s) => `      <a class="sheet" href="./${esc(s.slug)}/">
        <h2>${esc(s.title)}</h2>
        <p class="sub">${esc(s.subtitle)}</p>
        <dl>
          <div><dt>parts</dt><dd>${s.parts}<span class="of"> · ${s.instances} with instances</span></dd></div>
          <div><dt>views</dt><dd>${s.views}</dd></div>
          <div><dt>motions</dt><dd>${s.motions}</dd></div>
          <div><dt>callouts</dt><dd>${s.callouts}</dd></div>
          <div><dt>page</dt><dd>${kb(s.size)}<span class="of"> · self-contained</span></dd></div>
        </dl>
        <span class="open">Open the sheet &rarr;</span>
      </a>`).join('\n');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>blueprint-3d-sheet · demo sheets</title>
<style>
:root {
  --paper: #f2efe6; --ink: #1c1f24; --muted: #6b7078;
  --rule: #c9c3b4; --accent: #b3541e; --card: #fbf9f4;
}
@media (prefers-color-scheme: dark) {
  :root {
    --paper: #14171b; --ink: #e6e2d8; --muted: #8d939c;
    --rule: #333941; --accent: #e08c4e; --card: #1b1f25;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: clamp(1.5rem, 5vw, 4rem);
  background: var(--paper); color: var(--ink);
  font: 15px/1.6 ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
}
header { border-bottom: 2px solid var(--ink); padding-bottom: 1rem; margin-bottom: 2rem; }
h1 { margin: 0 0 .4rem; font-size: clamp(1.3rem, 3.5vw, 2rem); letter-spacing: .06em; text-transform: uppercase; }
header p { margin: 0; color: var(--muted); max-width: 62ch; }
main { display: grid; gap: 1.25rem; grid-template-columns: repeat(auto-fit, minmax(min(100%, 21rem), 1fr)); }
.sheet {
  display: block; padding: 1.25rem 1.4rem; text-decoration: none; color: inherit;
  background: var(--card); border: 1px solid var(--rule);
  transition: border-color .15s, transform .15s;
}
.sheet:hover, .sheet:focus-visible { border-color: var(--accent); transform: translateY(-2px); }
.sheet h2 { margin: 0 0 .3rem; font-size: 1rem; letter-spacing: .04em; }
.sub { margin: 0 0 1rem; color: var(--muted); font-size: .82rem; }
dl { margin: 0 0 1rem; display: grid; gap: .15rem; }
dl > div { display: flex; gap: .6rem; border-bottom: 1px dotted var(--rule); padding-bottom: .15rem; }
dt { color: var(--muted); min-width: 5.5rem; text-transform: uppercase; font-size: .7rem; letter-spacing: .08em; padding-top: .18rem; }
dd { margin: 0; font-size: .85rem; }
.of { color: var(--muted); }
.open { color: var(--accent); font-size: .8rem; letter-spacing: .04em; }
footer { margin-top: 2.5rem; padding-top: 1rem; border-top: 1px solid var(--rule); color: var(--muted); font-size: .78rem; max-width: 70ch; }
code { background: color-mix(in srgb, var(--ink) 8%, transparent); padding: .1em .35em; }
a { color: var(--accent); }
</style>
</head>
<body>
<header>
  <h1>blueprint-3d-sheet</h1>
  <p>Each sheet below is one HTML file with no server, no network and no external
     assets. Orbit it, section it, explode it, run its motions. Built from a
     schema-validated spec by a deterministic pipeline.</p>
</header>
<main>
${cards}
</main>
<footer>
  <p>These pages are rebuilt from <code>examples/*/spec.json</code> on every push;
     the repository stores specs, not pages.</p>
  <p>Best on a desktop-sized window — the drafting-sheet layout assumes one.
     Requires WebGL. No cookies, no analytics, no requests leave your browser.</p>
</footer>
</body>
</html>
`;

writeFileSync(join(site, 'index.html'), html);
console.log(`index.html → ${sheets.length} sheet(s): ${sheets.map((s) => s.slug).join(', ')}`);
