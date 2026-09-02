# Troubleshooting

Failures grouped by where they surface. Most have one cause.

## Validation

**`grid instances need "steps"`** — grid takes `counts` and `steps`, both plural
arrays, one step vector per axis. Linear takes singular `count` and `step`.

**`unknown identifier in bind`** — every name in an expression must be a driver
you declared, or `t`, or `fps`. There is no implicit vocabulary.

**Shape rejected with a wall of `oneOf` errors** — the validator re-checks
against the branch matching your `shape.type` and reports that branch's errors
specifically. Read the tail of the message, not the head.

**`only N/M parts separate on EXPLODE`** — add top-level
`"explode": { "driver": "<id>" }`. It attaches a channel to every part that
lacks one.

**`a section view is declared but no part is hidden or visibility-switched`** —
there is nothing inside the shell for the cut to reveal. Add interior parts;
see `authoring.md`.

**Density shortfalls** — the message lists exactly what is short. Reach it with
instances and detail decorators, not with more part entries.

## Build

**Part missing from the render, warning on stderr** — geometry construction
threw and that one part was skipped. The warning names the part and the reason.
Usually a malformed profile (must be a closed CCW polygon, first point not
repeated) or a `csg` operand that produced nothing.

**Model off-frame, or tiny** — framing uses the geometry that was actually
built, not `bounds`. If something sits far outside the envelope — an antenna, a
boom, a mis-signed transform — it drags the fit box with it. Check the outlier's
world position before adjusting `bounds`.

## Rendering

**A sub-assembly flies off in the wrong direction on explode** — its parent has
a rotation, and you set a per-part `explode` vector by eye in the wrong frame.
Delete it and let the automatic vector do the work; it accounts for the parent
chain.

**Instances march along the wrong axis after rotating a part** — `instances.step`
is in the *parent's* frame, applied before the part's own rotation. Change the
step vector, not the rotation.

**Section shows the outside skin with a slice missing** — the cut is keeping the
half nearest the camera. Add `"flip": true` to the section.

**Interior parts never appear** — the visibility bind is missing one of its
drivers, or `hidden: true` was set with no visibility channel at all, in which
case the part is hidden forever. Bind is normally `max(apart, reveal)` with both
drivers declared.

**Instanced moving parts all move in unison** — add `"spread": "auto"` to the
`oscillate` or `reciprocate` channel so instances phase apart around 360°.

**A whole subtree renders black** — an ancestor has a rotate or scale over a
large `overflow: hidden` subtree. Translate is safe; rotate and scale are not.

**Emitted smoke or steam comes from the wrong place** — the emitter is attached
to whichever part was convenient rather than where gas physically leaves the
machine. Move it to the muzzle, the grille, the vent.

## Verification

**`anchor-check` reports fewer sliding callouts than you have** — callouts on
parts hidden in that view are correctly skipped. Count against the parts visible
in the view you tested, not the total.

**Anchor travel is non-zero during a motion** — leaders are following an
animated part. They should be anchored above the animation channels; explode is
the one motion they are meant to follow.

**`explode-check` says enclosure did not resolve** — parts are nested along the
same axis and separating radially cannot free them. Check whether the nested
parts share a parent whose own separation is cancelling theirs.

**Headless screenshots come back blank** — the Chrome flags matter under
SwiftShader. Use `dev/shot.mjs`, which sets them, rather than driving puppeteer
directly.

**A check settles at a different value each run** — headless Chrome throttles
`requestAnimationFrame` hard, so waiting on wall-clock time settles far fewer
frames than it looks like. Wait on *rendered frames*; `selftest` already does.

## Setup

**`Cannot find module 'ajv/dist/2020.js'`** — dependencies are not installed.
Run `npm install --prefix "${CLAUDE_PLUGIN_ROOT}"`.

**Puppeteer missing or Chromium not downloaded** — `selftest` and the two `dev/`
checks need it. Reinstall without `PUPPETEER_SKIP_DOWNLOAD`, or run
`npx puppeteer browsers install chrome`. The download is ~300 MB and is what
produces the verification screenshots.
