# The Chrome extension releases on its own tag, to the Chrome Web Store through its API

- Date (UTC): 2026-11-28 11:03
- Branch: `ci/chrome-ext-own-release`
- Status: done
- Where: `.github/workflows/chrome-extension.yml`, `chrome-extension/`, `scripts/chrome-store/`, `docs/RELEASE-CI.md`.
  Why: the extension lives in this repo (it shares the protocol in `shared/src/api/chrome.ts`) but ships on its own
  cadence (owner, 2026-11-28).
- Version impact: none for the server and apps (CI, docs and the extension's own version only); the extension goes
  0.1.0 → 0.2.0 (minor: the desktop-app pairing and profile changes landed after the hand upload of 0.1.0).

## Goal

The owner uploaded 0.1.0 by hand. From now on a tag `chrome-v<semver>` builds, tests and publishes the extension,
independent of Trina releases and of the one-release-a-day rule. The store never gets the same version twice, and a
newer server keeps working with the extension version before it.

## Scope

In:
- `.github/workflows/chrome-extension.yml`: tag `chrome-v*` and manual run. Checks the tag against `EXTENSION_VERSION`,
  that the tagged commit is on dev or main, runs the extension's unit tests and typecheck, builds the zip, attaches it to
  a GitHub release "Trina in Chrome <version>" (never "latest", which install docs read), uploads and publishes to the
  Chrome Web Store (API v2, publisher + item, visibility as set in the dashboard) in the protected environment
  `chrome-store`. Auth: a service account through Workload Identity Federation (no key), or an OAuth client + refresh
  token. Optional Edge Add-ons job behind the repo variable `EDGE_ADDONS=on`, environment `edge-addons`, off by default.
- Version guard: `chrome-extension/shipped.json` keeps the version and a fingerprint of everything the zip is built
  from (sources found through their imports, pages, icons, page script, package versions). `bun run chrome:bump
  patch|minor|major` bumps and records it. A guard test fails when the fingerprint is stale; `chrome:check` (in
  check:prepush and CI's quick job) fails when the fingerprint changed against the base branch without a higher version.
- Protocol compatibility: recorded frames of each released extension version
  (`tests/fixtures/chrome-protocol/<version>.json`) must still parse with today's server schemas, and the server's hello
  still carries what that version reads. A release records its frames file (the workflow refuses a version without one).
- docs/RELEASE-CI.md section 16 "Chrome extension releases": how to cut one, the one-time setup (Google Cloud console,
  Web Store dashboard, GitHub environment), compatibility rules.

Out: creating credentials or secrets, publishing anything, changing release.yml or dev-build.yml.

## Steps

1. Plan (this file).
2. Fingerprint, shipped.json, bump/check script, guard test, check:prepush + ci.yml step.
3. Store publish scripts (Chrome v2, Edge v1.1) with unit tests on a mocked fetch.
4. Workflow.
5. Protocol fixture + test.
6. Docs, decision file, README of the extension.

## Decisions

`docs/decisions/20261128-chrome-ext-own-release.md`.

## Risks

- A GitHub release marked latest would break `releases/latest` readers (install docs, llms.txt): created with
  `--latest=false`.
- release.yml runs on `v*`: `chrome-v*` does not match it.
- Publishing goes through review; a failed upload leaves the store as it was.

## Tests

`bun run typecheck`, `bun test tests/unit/chrome-*.test.ts`, `bun run check:prepush`, actionlint on the workflow.

## Result

Built as planned. Differences: the fingerprint hashes TypeScript-transpiled code (comments and types do not count) and
follows workspace imports (`@mycel/shared/…`) and transitive npm packages; a 0.1.0 protocol snapshot was made from
e1ffb7743 (the store-screenshot commit, nearest to the hand upload) and the one tightening it shows (the label pattern)
is accepted in the test with its reason; `chrome:check` also refuses removing a released version's protocol file. A
re-run keeps the GitHub release's first zip. Review fixes: no asset clobber, Edge has no staged mode, transitive
packages, `propertyNames` compared and unknown schema keywords fail closed.
