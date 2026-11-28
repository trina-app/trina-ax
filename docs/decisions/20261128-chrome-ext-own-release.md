# The Chrome extension stays in this repo and releases on its own tag, straight to the stores

- Date: 2026-11-28
- Status: accepted
- Supersedes: none (adds to [the AI's browser in the person's own Chrome](20261128-trina-in-chrome.md), whose README said
  "Publishing to the Chrome Web Store (not done)")
- Branch: ci/chrome-ext-own-release (the owner, 2026-11-28; plan
  [20261128-1103-chrome-ext-own-release](../AGENTS/plan/20261128-1103-chrome-ext-own-release.md))

- **Ask:** keep the extension (`chrome-extension/`, store item pfalalpmbomdafcmobbjlgekhdfjepmc, 0.1.0 uploaded by hand)
  in this repo, but release it on its own cadence, independent of the app's releases and of one release a day.
- **Rule, own tag:** a tag `chrome-v<MAJOR.MINOR.PATCH>` on a commit of dev or main runs
  `.github/workflows/chrome-extension.yml`: the tag must name `EXTENSION_VERSION`; the extension's tests and typecheck;
  the zip; a GitHub release that is never "latest" (install docs read `releases/latest` for the app); the Chrome Web
  Store API v2 (upload, then publish with the dashboard's visibility) in the environment `chrome-store`. Edge Add-ons
  only with `EDGE_ADDONS=on`. `release.yml` (tags `v*`) never sees these tags; the one-release-a-day rule
  ([release once a day](../RELEASE-CI.md)) is about the app's releases and its Windows signing quota, not this.
- **Rule, a version is never reused:** what the zip is built from has one fingerprint (`chrome-extension/inputs.ts`: the
  sources the bundle imports without comments and types, pages, icons, page script, package versions) recorded with the
  version in `chrome-extension/shipped.json` by `bun run chrome:bump`. A guard test fails on a stale fingerprint;
  `chrome:check` (check:prepush, CI) fails a pull request whose fingerprint differs from its base without a higher
  version. So a server PR that changes the browser contract in `shared/` bumps the extension too.
- **Rule, older extensions keep working:** each released version keeps a snapshot of what it sends and reads
  (`tests/fixtures/chrome-protocol/<version>.json`); `tests/unit/chrome-ext-protocol.test.ts` fails when today's server
  contract would refuse what that version sends or stop sending what it reads. Unknown frame types are fine (the
  extension skips them). Accepted exceptions are listed in the test with their reason.
- **Store sign-in:** a service account through Workload Identity Federation (no key; recommended), or an OAuth client
  with a refresh token. The owner makes them (docs/RELEASE-CI.md 16 "처음 한 번"); nothing is stored until then.
- **Left out:** the server holding back new browser tools from an older extension (the extension reports its version;
  not needed until a tool is added), store listing text and screenshots over the API (the dashboard, by hand).
- **Version impact:** none for the app; the extension goes 0.1.0 → 0.2.0.
