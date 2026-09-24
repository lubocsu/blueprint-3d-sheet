# Authoring an AssemblySpec

`node scripts/spec-guide.mjs <class>` prints the *vocabulary* — every shape,
decorator, channel and expression the builder understands. This file covers the
*judgement*: how to decompose a subject, how to reach density without padding,
and the conventions that are genuinely easy to get backwards.

Read `${CLAUDE_PLUGIN_ROOT}/src/spec/schema.json` when you need the exact field list. It
is the contract, and `validate` checks against it directly.

---

## Contents

- [Reading figures off a drawing](#reading-figures-off-a-drawing)
- [Decomposing a subject](#decomposing-a-subject)
- [Conventions that are easy to get backwards](#conventions-that-are-easy-to-get-backwards)
- [Reaching density honestly](#reaching-density-honestly)
- [Interior parts, section and explode](#interior-parts-section-and-explode)
- [Motion](#motion)
- [Views, dimensions, callouts](#views-dimensions-callouts)
- [Two languages](#two-languages)
- [Working order](#working-order)

---

## Reading figures off a drawing

**Render the region you are transcribing, on its own, at 4000 px or more.** Not
the sheet it sits on — the table, the title block, the orientation plan, the
dimension string. Then read it.

This is the cheapest correction in the whole workflow and the one most often
skipped. A nozzle schedule read off a whole-sheet render came back with six
entries wrong: DN100 for what the drawing says is DN150, DN50 for DN65, 排气
膨胀口 for 排气防爆口. Re-rendered at 4600 px across the table alone, every one
of them was unambiguous. The cost was thirty seconds.

```bash
node dev/dxf-preview.mjs drawing.dxf zoom.png --region 633,428,726,582 --width 4600
```

`--region` takes drawing units; a full-extent pass prints the bbox to read them
off. `--tiles auto` splits a set that is tiled across model space — a dozen A1
sheets in a row render as an unreadable strip otherwise.

The reason this matters more than it looks: **a figure you misread does not
announce itself.** An absent number leaves a gap you can see and ask about. A
number transcribed wrong becomes something the sheet asserts in 20 mm type, and
it will be believed. Every downstream check — the density gate, grounding,
`selftest` — passes a confidently wrong figure exactly as it passes a right one.

The same applies to anything the drawing states rather than draws: parts lists,
material tables, weight columns, azimuth plans, welding callouts.

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

**Parent a sub-assembly. Do not scatter it.** When several parts make up one
thing — a platform and its beams, posts, handrail and toe plate; a ladder and
its rungs and cage; a stair and its treads and stringer — give them a `parent`
rather than authoring them all at the top level and positioning each by hand.

This is not tidiness. It makes a whole class of error *unrepresentable*. A
platform deck authored on bearing 250° with its beams, stanchions and handrail
left at bearing 0° renders as a deck with no supports and no railing: the
members exist, they are simply nowhere near the platform. Nothing complains,
because each part is individually valid. Parented to the deck, they inherit its
frame and cannot be anywhere else. The same mistake put a cage's vertical straps
six times further out than the hoops they tie together.

Rule of thumb: if the thing would move when its host moves, or if you would
call it *part of* the host rather than a neighbour of it, parent it.

One honest cost: a part with children cannot have its static instances merged
into one draw call, because merging bakes away the per-instance frames the
children need. On a large assembly that is a real number of extra draws. It is
almost always the right trade — a sub-assembly that cannot come apart wrongly is
worth more than the draw calls — but it is why the builder does not simply
parent everything for you.

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

**A radial ring divides `arc` evenly from zero.** When the drawing gives real
bearings — and a nozzle orientation plan always does — say so with `angles`
instead, or every one of them is quietly moved:

```json
"instances": { "pattern": "radial", "axis": "y", "radius": 5704,
               "angles": [30, 90, 150, 210, 270, 330] }
```

`angles` sets the count by its own length, and handles the irregular case
(`[80, 152, 188, 224, 296]`) that no even division can express. Authoring one
part per nozzle to work around it is exactly what the density gate discourages.

**A ring cannot rise; `helical` can.** Spiral stair treads, screw flights and
helical baffles need `rise`, the total climb along `axis` across the whole
sweep. The last instance lands exactly on it:

```json
"instances": { "pattern": "helical", "axis": "y", "radius": 6250,
               "count": 48, "arc": 900, "rise": 12260, "orient": true }
```

A `helical` with no `rise` is just a ring, and validate says so.

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

**Do not give a motion an `icon`.** The console works out its glyph by following
`set` into the `channel.bind` expressions and taking the animation primitive
those drivers actually move — so a motion that separates the assembly gets the
separation glyph, and one that runs an emitter gets particles, with nothing
written down. Writing `icon` overrides that, and an override is a claim about
the motion that the geometry can then quietly stop agreeing with.

**A motion is not a use of a driver.** Every driver needs both sides: something
that sets it (a motion, or a view's `set`) and something that reads it (a
channel expression, or an instrument). A driver with only the write side is a
console button that does nothing when pressed — validate reports it, and
`--strict` fails on it.

A generic glyph on a motion button is usually that same fault seen from the
other end, and not an icon problem: the derivation found no animation primitive
to follow because the driver reaches none. Fix the binding rather than reaching
for `icon` to cover the half of it you can see.

## Views, dimensions, callouts

**Views**: at least three orthographic plates plus perspective views and one
section. Orthographic views are reached by tweening the field of view down, so
they transition smoothly rather than popping.

A view's console glyph is drawn from its own `az`/`el`/`projection`/`section`
against `bounds` — the subject's box seen from that viewpoint — so a view you
invent is already described by its button and `view.icon` is not needed. The
same applies as above: prefer leaving it off.

`label` is capped at 8 characters and is what shows under the glyph on a
touchscreen, where there is no hover and no tooltip. Keep it to something that
survives being read at 8.5px: `SIDE`, `SEC A-A`, `3/4 R`.

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

## Two languages

A sheet can be issued in more than one language. The renderer translates its own
furniture — panel headings, the title block's field names, the view captions it
invents. The subject's words are yours, and they go in an `i18n` block:

```json
"i18n": {
  "base": "en",
  "locales": {
    "zh": { "label": "中文", "strings": { "parts.gun.barrel.name": "120 mm 44 倍径滑膛炮" } }
  }
}
```

Run `b2d i18n spec.json --missing` and work from what it prints rather than
inventing paths. Keys are ids, never positions: `parts.<id>.name|note`,
`groups.<name>` (one entry retitles the whole group), `callouts.<n>.text`,
`views.<id>.label|caption|sub`, `motions.<id>.label`, `instruments.<i>.label`,
`meta.*`. A path that resolves to nothing fails validation, because the
alternative is a line that silently never reaches the sheet.

**Translate the drawing, not the words.** Chinese here means GB, and GB names
things its own way: the front view is 主视图 and not 正视图, a cut view is a
剖视图 labelled `B—B` with an em dash, the title block reads 图样名称 /
图样代号 / 阶段标记, the projection is 第一角画法, and materials take their
names from the 剖面符号 table (金属材料, 非金属材料, 液体). The renderer
already does this for its own furniture — match it in your captions instead of
transliterating the English.

Leave alone anything that is a fact rather than a way of saying it: dimension
figures, the tolerance, the units, drawing numbers, revision letters, dates and
personal names are the same on both sheets.

Console labels stay short — about eight characters is what a button fits, in
either language.

## Working order

Before any of this, render the regions you are going to transcribe from — see
*Reading figures off a drawing*. Every number below has to come from somewhere,
and re-reading a table once the spec is built costs far more than reading it
right the first time.

Then build the spec in this order; each step makes the next one checkable.

1. `meta` and `bounds` — get the envelope right first, everything scales from it
2. Primary structure and enclosure, with real transforms
3. `validate` — catch schema and semantic errors while the file is small
4. Working elements and their parent chain
5. Interior parts, hidden, with the visibility channel
6. Drivers, motions, channels; then `instruments`
7. Views including the section, `explode`, dimensions, callouts
8. Translations, if the sheet is to be issued in more than one language
9. `validate --strict`, then `build`, then `selftest` — and look at the shots
