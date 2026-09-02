# Authoring an AssemblySpec

`node scripts/spec-guide.mjs <class>` prints the *vocabulary* — every shape,
decorator, channel and expression the builder understands. This file covers the
*judgement*: how to decompose a subject, how to reach density without padding,
and the conventions that are genuinely easy to get backwards.

Read `${CLAUDE_PLUGIN_ROOT}/src/spec/schema.json` when you need the exact field list. It
is the contract, and `validate` checks against it directly.

---

## Contents

- [Decomposing a subject](#decomposing-a-subject)
- [Conventions that are easy to get backwards](#conventions-that-are-easy-to-get-backwards)
- [Reaching density honestly](#reaching-density-honestly)
- [Interior parts, section and explode](#interior-parts-section-and-explode)
- [Motion](#motion)
- [Views, dimensions, callouts](#views-dimensions-callouts)
- [Working order](#working-order)

---

## Decomposing a subject

Start from the structural core and work outward, because the parent chain is
what makes motion compose. A gun parented to a turret follows its slew for free;
a gun positioned in world coordinates has to be animated twice and will drift.

A decomposition that reads as engineering usually has these layers:

1. **Primary structure** — hull, chassis, casing, frame, foundation, shell.
2. **Enclosure** — panels, covers, cladding, glazing, skirts. Often removable,
   which makes them good candidates for a visibility toggle.
3. **Working elements** — whatever rotates, reciprocates, articulates or flows.
   This is where the motion lives, so give each moving thing its own part.
4. **Interfaces** — hatches, ports, nozzles, connectors, controls, lamps.
5. **Interior** — the assemblies inside the enclosure. See below; this is the
   layer most often skipped and the one that carries the most impact.

The subject class guidance from `spec-guide.mjs` tells you what each layer
usually contains for this kind of object. Follow it — it is the difference
between "eight boxes" and a drawing.

## Conventions that are easy to get backwards

**Axes.** X is length (fore/aft), Y is up, Z is width (lateral). Y = 0 is the
ground plane.

**View angles.** `az` is measured from +Z toward +X. Because X is the length
axis, **`az: 0` looks at the flank and gives you the SIDE elevation**, and
`az: 90` gives the FRONT. Getting this backwards produces a sheet whose plates
are all labelled wrong, and nothing will complain.

**Instance offsets live in the parent's frame.** `instances.step` is applied
before the part's own rotation, so a repeat is unaffected by how the part is
turned. If you rotate a part 90° and then wonder why its instances march along
the wrong axis, this is why — and the fix is to change `step`, not the rotation.

**Grid instances take `counts` and `steps`,** both plural, both arrays:
`"instances": { "pattern": "grid", "counts": [2, 11], "steps": [[0,160,0], [0,0,130]] }`.
Linear takes the singular `count` and `step`. Mixing them is the most common
validation failure.

**Every identifier in an expression must be a declared driver,** or the two
built-ins `t` (seconds) and `fps`. There is no implicit vocabulary; a typo in a
bind is a validation error, which is deliberate.

**Rotational channels are in degrees.** `spin`'s bind is a *rate* in deg/s;
`reciprocate`'s bind is a *crank angle* in degrees.

## Reaching density honestly

The gate wants a lot of parts. There are two ways to get there and only one of
them is any good.

**Use `instances`.** Seven road wheels is one part with `instances.count: 7`.
Nine cylinders around a crankcase is one part with a radial pattern. The gate
counts instances, so this is both the honest route and the cheap one.

**Use detail decorators.** Most of the density in a real drawing is fasteners,
louvres, grilles, rivet rows and tread plate. One `boltCircle` line becomes
twenty-four bolts that shade and outline correctly. `spec-guide.mjs` lists all
twelve generators. A spec with no decorators looks like a CAD export, not a
drawing.

**Do not** pad with near-duplicate parts, empty notes, or callouts that repeat
each other. The gate can be satisfied that way and the sheet will still be bad,
which is worse than failing.

**Add `spread: "auto"`** to `oscillate` and `reciprocate` on instanced parts so
the instances phase apart around 360°. Without it a radial engine's pistons all
move in unison, which reads as obviously wrong to anyone who knows the machine.

## Interior parts, section and explode

This is the section worth re-reading. It is where most sheets fall short.

**Interior parts exist and are hidden by default:**

```json
{ "id": "power.engine", "name": "V12 DIESEL, 1 500 hp", "hidden": true,
  "note": "60° V12, 27.4 L, 1 500 hp at 2 600 rpm",
  "channels": [{ "type": "visibility", "bind": "max(apart, reveal)" }] }
```

Declare **both** drivers. `apart` is pushed to 1 by the EXPLODE motion; `reveal`
is set by the section view:

```json
{ "id": "secBB", "label": "SEC B-B", "az": 34, "el": 16,
  "section": { "plane": "xy", "at": 0, "flip": true },
  "set": { "reveal": 1, "skirts": 0 } }
```

**`flip` matters.** Without it the cut keeps the half nearest the camera and you
are looking at the outside skin with a slice missing — technically a section,
visually useless. With `flip: true` the near half is removed and you see in.
Check the screenshot; this one is obvious once you look and invisible if you
don't.

**A view can put the model into a state.** `"set": { … }` applies driver values
that the view implies, sitting between the declared defaults and any active
motion. That is how a cutaway reveals its interior without the user having to
press a second button.

**Explode the whole assembly:**

```json
"explode": { "driver": "apart", "scale": 1.0, "trace": true }
```

Declaring this attaches an explode channel to every part that lacks one, derives
each part's separation vector, and draws the thin broken leader from each part
back to where it came from. Per-part `explode` vectors still win where you set
them explicitly.

Separation is ordered by how far out a part sits and how deeply it is nested, so
the skin travels and the core barely moves — the assembly opens rather than
inflating. Displacement does not compound down the parent chain, so a part five
levels deep is not launched off the sheet.

## Motion

Motions are named driver states; the console renders one button each.

```json
{ "id": "drive", "label": "DRIVE", "set": { "speed": 12.2 } }
{ "id": "fire", "label": "FIRE", "set": { "fire": 1, "blast": 1 }, "momentary": true }
```

Bind channels to expressions over those drivers. The ten primitives cover every
subject class — a tank's DRIVE, a turbine's SPIN and a door's OPEN are the same
`spin`, `oscillate` and `articulate`.

**Put effects where they physically happen.** A gun's muzzle blast vents from
the muzzle and the fume extractor, not the breech. A radiator exhausts through
its grille. This sounds obvious and is the thing most often gotten wrong,
because it is easy to attach an emitter to whichever part you were editing. If
the note says something about where gas leaves the machine, the emitter should
be there.

For a continuously accumulating angle, declare a driver with a very large `max`
and let a motion push it there; the eased approach gives a smooth ramp.

## Views, dimensions, callouts

**Views**: at least three orthographic plates plus perspective views and one
section. Orthographic views are reached by tweening the field of view down, so
they transition smoothly rather than popping.

**Dimensions** are declared in world coordinates and rendered as real 3D
geometry with arrowheads. The layer picks which dimensions belong on which view
from the dominant axis, so a length dimension appears on the side and plan
plates rather than on all of them at once.

**Callouts** are numbered 1..N with no gaps. Give the anchor a part id and
nothing else — **do not try to place the balloon.** The annotation layer solves
the whole layout in 3D: it picks a leader exit point on the part's actual
surface, re-picks it as the viewpoint changes, assigns balloons to gutters, and
keeps leaders off the panels. A callout on a hidden part is dropped
automatically and returns when the part appears, so interior callouts are safe
to declare.

`instruments` are live readouts — label plus an expression over the drivers,
with a printf-style format. Six rows is the reference density.

## Working order

Build the spec in this order; each step makes the next one checkable.

1. `meta` and `bounds` — get the envelope right first, everything scales from it
2. Primary structure and enclosure, with real transforms
3. `validate` — catch schema and semantic errors while the file is small
4. Working elements and their parent chain
5. Interior parts, hidden, with the visibility channel
6. Drivers, motions, channels; then `instruments`
7. Views including the section, `explode`, dimensions, callouts
8. `validate --strict`, then `build`, then `selftest` — and look at the shots
