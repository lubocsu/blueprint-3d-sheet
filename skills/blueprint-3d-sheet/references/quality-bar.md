# The quality bar, and how it is measured

Nothing in the renderer enforces quality. A spec with four boxes renders
perfectly and looks like nothing. So the bar lives in checks you can run, and
this file explains what each one protects and what a failure is telling you.

Two tiers throughout: **floor** failures are errors and block the build;
**target** shortfalls are warnings, and become errors under `--strict`.

---

## `b2d validate` — the density gate

Source: `${CLAUDE_PLUGIN_ROOT}/src/spec/richness.mjs`. Thresholds scale by subject class,
so a wristwatch is not held to a tank's part count — but nothing gets a pass on
*annotation* density, because notes and callouts are cheap for any subject and
are most of what makes a page read as a drawing.

| Check | Why it exists |
|---|---|
| Effective part count, instances included | The single best proxy for "is this a drawing or a diagram". Instanced repeats count, so honest density is also the cheap route. |
| A name on every part | The hover card reads it. A part with no name is a shape. |
| A note on ≥50% (target 80%) of parts | One concrete fact each — material, size, rating, count. This is the difference between a model and a drawing. |
| Callouts, dimensions, views, motions, instruments, details, materials | Floors per subject class. A sheet missing any of these reads as unfinished. |
| ≥2 orthographic views | A general-arrangement sheet without plates is not one. |
| A section view declared | The one view that reads as engineering for non-vehicle subjects. |
| Something animates | A static page is a picture. |
| **≥60% of parts separate on EXPLODE** | The machine-checkable form of "the explode isn't thorough enough". Declaring top-level `explode` satisfies it for the whole assembly at once. |
| **A section view has interior parts to reveal** | Cutting a shell that contains nothing yields a picture of the shell. Checks for parts that are `hidden` or visibility-switched. |
| Provenance (`meta.researched`, `meta.grounding`) | Present only on machine-generated specs; flags a sheet whose figures cannot be traced to anything. Absent on hand-authored specs, which are left alone. |

A failure here is a list of exactly what is short. Fix the listed items and run
again — do not pad to satisfy the count.

---

## `b2d selftest` — renders everything and checks the sheet

Renders a PNG for every view and every motion, then asserts sheet-level
properties that are tedious to eyeball across a dozen images:

- panels hidden in orthographic (plate) mode
- at least one dimension visible on each orthographic view
- balloon spacing above a minimum, so leaders stay readable
- no balloon sitting on top of a panel
- no runtime errors, no external network requests

It also reports mesh count, triangle count and build time.

**The assertions catch regressions, not ugliness.** A sheet can pass every one
and still be badly framed, wrongly proportioned, or visually dead. Open the
PNGs. You are the only one who will notice.

---

## `dev/explode-check.mjs` — does it actually come apart?

```bash
node "${CLAUDE_PLUGIN_ROOT}/dev/explode-check.mjs" <dir>/index.html --motion explode --section secBB
```

Four measurements, chosen because the obvious one is misleading:

**Participation** — share of parts carrying an explode channel. Should be 100%
with a top-level `explode` declaration.

**Spread** — mean pairwise distance between part centres, before vs after. This
is the honest test of "came apart" rather than "moved". Expect roughly ×2.

**Burial** — mean fraction of each part's volume inside another. Reported for
information, and the *drop* is the claim, not the absolute level. Burial is
strongly shape-dependent: nine cylinders arranged radially around a case have
overlapping axis-aligned boxes however well they separate, so a compact radial
engine sits far higher than a tank at the same real quality.

**Enclosure** — share of bodies almost entirely inside another. This is the one
to watch: it should largely resolve. Some residual is honest — a piston needs to
travel most of a barrel length to come clear, and pushing every part that far
scatters the drawing.

Measured per *instance*, not per part, because unioning a ring of nine cylinders
into one box would make it appear to enclose the whole engine.

**Internals reveal** — asserts hidden parts are invisible on a normal view and
visible on both EXPLODE and the section. A failure here usually means the
visibility bind is missing a driver, or `hidden` was set without a channel.

---

## `dev/anchor-check.mjs` — do the leaders behave in 3D?

```bash
node "${CLAUDE_PLUGIN_ROOT}/dev/anchor-check.mjs" <dir>/index.html --motion drive
```

Two principles that are easy to claim and easy to silently break:

**1. The exit point is a real point on the component, and it slides.** As the
viewpoint changes, the leader's exit point moves across the part's actual
surface rather than being nailed to one vertex. The check reads the anchor in
the part's *local* frame, because screen movement alone would also happen if the
point were fixed. Expect most visible callouts to register movement; callouts on
parts that are hidden in that view are correctly skipped.

**2. Leaders do not follow moving parts.** With a motion running, anchor travel
should be **0.00 px**. Leaders are anchored above the animation channels, so a
spinning wheel does not drag its label around — but explode *is* followed,
because a part separated for inspection needs its label to come with it.

---

## `dev/smoothness.mjs` — annotation stability under motion

Samples leader positions during a slow orbit. Because the layer fades out,
freezes, re-solves once the picture is quiet, and fades back in, travel during
the move should be **0.0 px** at every percentile. Non-zero means the deferred
regeneration has been broken and labels are sweeping across the drawing.

---

## What none of this measures

Whether the figures are *true*. The gate can force a note onto every part; it
cannot tell whether the note is right. `scripts/evidence.mjs` is the counterpart
— it judges the material going in, before anything is authored. Run it first,
close the gaps with the user, and the sheet will be worth the density it is
being held to.
