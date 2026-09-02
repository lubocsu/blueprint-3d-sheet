# Changelog

## 0.1.0 — unreleased

First public packaging. The pipeline itself has been in use privately; this
release is about making it installable by other people.

### Added
- Claude Code plugin manifests (`.claude-plugin/`), so the repository is both a
  plugin and its own marketplace.
- `skills/blueprint-3d-sheet/` — the authoring skill, with every path anchored to
  `${CLAUDE_PLUGIN_ROOT}` instead of a relative directory that only resolved when
  the working directory happened to be the skill's own.
- CI across ubuntu / macOS / windows on Node 20 and 22, running the three offline
  check suites, `validate --strict`, both builds, the headless selftests, and the
  explode and anchor checks.
- An assertion, in both CI and the deploy, that an emitted page contains no
  external URL. The deploy refuses to publish a page that fails it.
- GitHub Pages deployment. The repository stores specs, not pages; every sheet is
  rebuilt from `examples/*/spec.json` on push.
- MIT licence.

### Changed
- Renamed from `blueprint-to-display`.
- Documented `PUPPETEER_SKIP_DOWNLOAD=1` as the lean install. `--omit=optional`
  is explicitly warned against: it also strips esbuild's platform binary, so the
  install fails outright.
- The skill and plugin descriptions now state what reaches the network and what
  does not, rather than leaving a reader to infer it — and no longer present
  web evidence-gathering as something this version does.

### Not in this release

Gathering evidence from the web is unfinished and is **not** claimed as a
capability of this version. The code ships and is disclosed rather than hidden:

- `src/ingest/bundle.mjs` downloads URLs you supply. Verified only against a
  local test server (`dev/gather-check.mjs`, 24 assertions) — never against a
  real source.
- `src/ingest/research.mjs` calls a search-backed model. **Never run at all**;
  there were no credentials on the development machine.

Neither appears in the skill's workflow, in the plugin description, or in the
README's command list. Anything said about them is structural reasoning about
the code, not an observation of it working.

### Known gaps
- `hasCredentials()` reports success when only an `ant` profile is on disk, which
  the pinned SDK cannot read — the call then fails with a 401 instead of the
  intended message. Affects only the unfinished `ingest` / `research` paths.
- The sheet layout assumes a desktop-sized window.
