# blueprint-3d-sheet

Architecture, commands and the authoring guide already live in `README.md` and
`skills/blueprint-3d-sheet/references/`. This file carries only the conventions
a session cannot read off the code.

## Parallel work: use a worktree

Several sessions are often open on this project at once. **Before starting any
experimental change, enter a worktree.** Do not switch branches in the main
checkout.

The desktop app has a `worktree` toggle on the new-session screen ("Work in an
isolated copy of the repository"). **Prefer it** — the session then starts in
the worktree instead of switching into one partway through, so there is no
window in which work sits in the shared checkout. Entering a worktree from
inside a session is the fallback for when that was missed.

Sessions sharing one directory share a HEAD and a working tree. A branch switch
in one session moves all of them, and uncommitted work follows HEAD across the
switch — so a commit can land on a branch it does not belong to. That has
happened here: a finished i18n feature spent an afternoon sitting uncommitted on
a branch named for something else, and any commit during that window would have
gone to the wrong place.

`worktree.baseRef` is left at its default (`fresh`), so each worktree branches
from `origin/main` and parallel experiments stay independent of each other. Set
it to `head` only when work is deliberately stacked on another branch.

Each worktree needs its own `npm install` (~82 MB here). Point
`PUPPETEER_CACHE_DIR` at a shared path rather than downloading a Chromium per
worktree.

## `examples/` is published

Every `examples/*/spec.json` is built and deployed to the public demo site by
`.github/workflows/pages.yml`. A sheet built from someone's drawings or project
data does **not** go there — keep it outside the repository, with the source
material it came from.

## Before committing

`npm run check` runs the same offline probes CI does. A push to `main`
redeploys the demo site, so a broken `main` is a broken demo.
