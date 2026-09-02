---
name: blueprint-3d-sheet
description: >-
  Turn a 2D drawing, CAD file, photo, or written brief into ONE self-contained
  interactive 3D engineering sheet — orthographic plates plus perspective views,
  numbered callouts on leader lines, dimensions, a section cutaway, a full
  exploded view, live instrument readouts, and animated motions, all in a single
  offline index.html. Use this whenever someone wants a physical object turned
  into an explorable 3D drawing: "turn this drawing into 3D", a blueprint or
  general-arrangement page, an exploded view, a cutaway or section, an
  interactive machine/product breakdown, a technical illustration that moves —
  for vehicles, engines, aircraft, buildings, pressure vessels, appliances,
  mechanisms, instruments, or anything else with parts. Also use it to validate,
  rebuild, or raise the quality of an existing AssemblySpec (spec.json), and
  whenever a drawing, DXF/SVG, or engineering photo is handed over with no
  clearer instruction than "make something out of this".
  The emitted page is offline and self-contained: no network requests, no
  telemetry. Authoring, validating and building need no credentials and no
  network; the only network access required is a first-time `npm install`,
  which may download a Chromium build via puppeteer. Gathering evidence from
  the web is NOT part of this release — see "Not in this release" below.
---

# Interactive 3D blueprint sheets

You are producing a **general-arrangement drawing that moves**: one HTML file,
no server, no network, no external assets, that renders a subject as an
engineering sheet you can orbit, section, explode and drive.

```
brief / drawing ──▶ AssemblySpec (JSON) ──build──▶ Three.js scene ──▶ one index.html
   you author it        the contract          deterministic       self-contained
                  validated · hand-editable · replayable
```

**You author the spec. The pipeline does everything else.** That split is the
whole design: you emit *data*, never code, so the result can be schema-checked,
measured against a density bar, hand-corrected and rebuilt without you in the
loop. Every step here is offline and needs no credentials. When the supplied
material is too thin to draw from, this skill's answer is to say so and ask —
not to go looking, and never to invent.

## Setup (once per machine)

Before the first command, check whether dependencies are installed and install
them if not:

```bash
ls "${CLAUDE_PLUGIN_ROOT}/node_modules" >/dev/null 2>&1 || npm install --prefix "${CLAUDE_PLUGIN_ROOT}"
```

That pulls three, esbuild, ajv, dxf-parser, puppeteer and the Anthropic SDK,
and puppeteer downloads a Chromium (~300 MB). The Chromium is what renders the
verification screenshots in step 6 — without it `selftest` fails with a clear
message naming the fix, and everything else still works.

If the download is unwelcome, install lean and skip only the screenshots:

```bash
PUPPETEER_SKIP_DOWNLOAD=1 npm install --prefix "${CLAUDE_PLUGIN_ROOT}"
```

Authoring, `validate` and `build` all run under the lean install. Add Chromium
later with `npx puppeteer browsers install chrome`.

Do **not** use `npm install --omit=optional` — it also strips esbuild's own
platform binary and the install fails.

## Workflow

### 1. Judge the material before you use it

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/blueprint-3d-sheet/scripts/evidence.mjs" "<the brief>"        # or a path to a .dxf/.svg/.png
```

This scores the input on seven axes and names what is missing. It is the one
step people skip, and skipping it is how you end up with a confident-looking
sheet full of invented figures.

Read the gap list, then **close the gaps with evidence, not with your
imagination**. In practice that means one of three things, in this order:

1. Read what the user already gave you more carefully — a DXF's text layer, a
   spec sheet, a photo caption often carries the figure you are missing.
2. Ask the user. A named gap is a specific, answerable question: "what is the
   overall length?" beats "tell me more".
3. Say the figure is unknown and draw without it.

An absent figure is recoverable — a note can say the value is unknown — but an
invented one silently becomes a lie the drawing asserts in 20 mm type. If the
gaps are wide enough that the sheet would be mostly invention, **stop and tell
the user that**, rather than producing something confident and hollow.

If the subject was named only by category ("a pump", "一辆主战坦克"), say so and
pin it to a real or representative model first. You cannot draw the inside of a
machine nobody has identified.

### 2. Get the authoring guide for this subject class

```bash
GUIDE="${CLAUDE_PLUGIN_ROOT}/skills/blueprint-3d-sheet/scripts/spec-guide.mjs"
node "$GUIDE" vehicle          # or: node "$GUIDE" "a radial aero engine"
```

Prints the shape vocabulary, detail decorators, animation channels, expression
grammar, geometry conventions, class-specific decomposition advice, and the
density bar — generated from the pipeline's own source, so it is exactly what
`b2d validate` will hold you to. Read it before writing any JSON.

For a CAD input, also dump the extracted outlines: they carry **true**
coordinates, so use them as `extrude` profiles instead of estimating.

### 3. Author `spec.json`

Write the file. `references/authoring.md` covers the parts that are judgement
rather than vocabulary — how to decompose, how to reach density honestly, and
the handful of conventions that are easy to get backwards.

Author the spec yourself from the material you have. There is no
model-backed generation path in this release — `ingest` exists in the CLI but
needs credentials and is not part of the supported workflow.

### 4. Gate it

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/b2d.mjs" validate spec.json
```

Fix what it lists and run again. The gate is not advisory: it is the same check
that made the reference sheets dense, and it fails specs that would render as a
few boring boxes. `--strict` promotes the warnings to errors.

### 5. Build

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/b2d.mjs" build spec.json --out <dir>
```

Produces one self-contained `index.html`.

### 6. Verify — and actually look at it

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/b2d.mjs" selftest spec.json          # every view + motion, plus sheet assertions
node "${CLAUDE_PLUGIN_ROOT}/dev/explode-check.mjs" <dir>/index.html --motion explode --section secBB
node "${CLAUDE_PLUGIN_ROOT}/dev/anchor-check.mjs"  <dir>/index.html --motion drive
```

`selftest` writes a PNG per view and per motion. **Open them.** The assertions
catch regressions, not ugliness — a sheet can pass every check and still be
framed badly, and you are the only one who will notice.

The two `dev/` checks measure the properties that are easy to claim and easy to
break: that the assembly genuinely comes apart and reveals its interior, and
that leader lines behave in 3D. `references/quality-bar.md` explains what each
number means and what a failure is telling you.

## The standard

These are the things that separate a real sheet from a 3D model with labels.
They are enforced by code where possible; the rest is on you.

**Every part earns its note.** A name in engineering caps and one concrete
factual detail — a material, a size, a rating, a count. "Cast link, 196 mm
pitch", not "part of the track". The gate requires this on most parts because
notes are what the hover card reads and what makes the page read as a drawing.

**Density comes from instances and decorators, not repetition.** Seven road
wheels is one part with `instances.count: 7`. Twenty bolts is one `boltCircle`.
A spec that lists them individually is both worse and longer.

**Model the inside.** An exploded view of a hollow shell shows a hollow shell,
and a section through one shows two lines. Give interior parts `"hidden": true`
plus a visibility channel bound to `max(apart, reveal)`, declare both drivers,
and let the section view carry `"set": { "reveal": 1 }`. This is the single
biggest difference between a sheet that impresses and one that doesn't.

**Explode as a whole.** Declare top-level `"explode": { "driver": "apart" }` and
every part participates. Wiring explode onto the six parts you happened to think
about leaves the skin sitting where it started, which is not an exploded view.

**Estimate honestly, and say when you did.** If a dimension came from the
subject's known typical size rather than the drawing, the note should read that
way. The sheet is allowed to be approximate; it is not allowed to pretend.

## Reference material

Read these when the moment calls for them rather than up front:

| File | When |
|---|---|
| `references/authoring.md` | Writing the spec — decomposition strategy, conventions that are easy to get backwards, worked patterns |
| `references/quality-bar.md` | Interpreting the gate and the three verification scripts; what each principle protects |
| `references/troubleshooting.md` | A check failed, the build looks wrong, or something renders black |
| `${CLAUDE_PLUGIN_ROOT}/README.md` | Why the architecture is shaped this way; what the renderer does |

Two committed examples are worth reading before your first spec — they are the
calibration for "dense enough":

- `${CLAUDE_PLUGIN_ROOT}/examples/mbt-mk6/spec.json` — 51 parts, 244 with instances, full
  interior, section and exploded views
- `${CLAUDE_PLUGIN_ROOT}/examples/radial-engine/spec.json` — a different subject class
  entirely, proving the vocabulary is domain-neutral

## Not in this release

**It does not gather evidence from the web.** The repository carries `bundle`
and `research` code that can download URLs and call a search-backed model, but
that work is unfinished: `bundle` has only ever been exercised against a local
test server, and `research` has never been run at all. Neither is a capability
this version offers, and neither belongs in your workflow. If the material is
thin, use the three steps in section 1.

**It does not put remote assets into the finished page.** The emitted
`index.html` is offline and self-contained, and that is a property worth
protecting: it is what lets a sheet be mailed, archived, or opened in ten years.
