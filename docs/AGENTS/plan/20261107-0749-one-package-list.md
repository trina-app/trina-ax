# One list of system packages and binaries for every install path

- Date (UTC): 2026-11-07 07:49
- Branch: `feat/one-package-list`
- Status: in progress
- Where: trina-ax scripts (image + installers). Why: the hosted image, a self-hosted Linux server and an office Mac
  get different system packages today, so one release behaves differently by install path (see
  docs/REPOSITORY-RULES.md)
- Version impact: minor. A plain self-hosted install now also installs the dev environment's packages, CJK fonts and
  a pinned headless browser, and `install-linux.sh` gets `--minimal`

## Goal

The hosted image (`scripts/image/*`) has srt, Chromium, CJK fonts, ffmpeg, python3 and build tools. A server made with
`scripts/install-linux.sh` gets only the core packages, the dev environment is a separate manual step, and an office
Mac has no browser. So HTML to PDF (feat/html-to-pdf) works only where a Chromium happens to exist.

The product owner and the infra engineer agreed on one shared list, a CI check that fails when the scripts disagree,
and pinned versions in the list.

## Scope

In:
- `scripts/system/packages.json`: distro packages per supported release (Debian 12, 13, Ubuntu 24.04) and arch,
  grouped by purpose, each group marked always / default / image / optional; floors (`>=`) for apt packages; downloaded
  artifacts (node, srt, chrome-headless-shell) with a version and a sha256 per platform.
- `scripts/system/packages.sh`: one shell helper that reads the list (the kit's bun or jq) and installs groups,
  checks floors, downloads and verifies an artifact, switches the browser, writes `MYCEL_HTML_PDF_BROWSER`.
- Use it in `scripts/image/customize.sh` (+ the stagers), `scripts/install-linux.sh` (default = the image's groups,
  `--minimal` = only the always groups), `scripts/dev-env/srt/install-srt.sh`, `scripts/dev-env/install-trial.sh`,
  `scripts/office/office-install.sh` (pinned chrome-headless-shell in `<prefix>/browser`).
- The browser at one fixed path: `/opt/trina/chrome-headless-shell/<version>/` + `current` on Linux,
  `<prefix>/browser/chrome-headless-shell/<version>/` + `current` on a Mac; `MYCEL_HTML_PDF_BROWSER` in
  `/etc/default/<id>` and in the office server's environment.
- Updates: the list ships in the bundle's `root/`, so a changed list is a root change (`rootSince`); `mycel-ctl update`
  runs `root/packages.sh sync` after the root files are in place (missing packages, browser to the pinned version, old
  versions removed). The office updater runs the new zip's `office-install.sh --update`, which does the same for the Mac.
- `tests/unit/system-packages.test.ts` (in `bun run test:unit`): the list is well formed, every artifact has a version
  and a sha256 per platform, no install or image script hardcodes a package list, the image's groups are the
  installer's default groups, the two readers (bun, jq) read the same list.
- Rule in docs/REPOSITORY-RULES.md and CLAUDE.md; install docs, scripts/image/README.md, DECISIONS, CHANGELOG.

Out:
- Turning the dev environment on by default (polkit rule, slice, server drop-in, node and srt in `/opt/trina`): still
  `install-srt.sh`, an explicit choice.
- `server/src/files/html-pdf.ts` (another branch): it already honours `MYCEL_HTML_PDF_BROWSER`.
- Workflow changes: the new test runs inside the existing unit job.

## Steps

1. The list and the helper, with the real sha256 of every pinned download.
2. install-linux.sh: read the list from the kit's `root/`, `--minimal` / `--no-minimal` kept in `install.json`, the
   browser, the env line; `deps.txt` goes (an older bundle without the list still installs from its `deps.txt`).
3. build-bundle.ts ships `root/packages.json` and `root/packages.sh`; build-office.ts ships them in the zip.
4. customize.sh, build.sh, build-ami.sh, test-customize.sh; install-srt.sh; install-trial.sh; office-install.sh and the
   office supervisor's environment.
5. mycel-ctl update: `syncSystem` after the root files; Go test.
6. The CI test, docs, CHANGELOG.
7. Checks: `bash -n`, shellcheck if present, `bun run typecheck`, unit tests of the area, Go tests of mycel-ctl, a real
   install of the groups and the browser in a throwaway Debian 13 container.

## Risks

- A default install now runs a larger apt transaction and downloads about 130 MB for the browser. A failure in a
  default group or the browser only warns (the server works without them); a failure in an always group stops as before.
- Every change of the list is a root change: the root update timer applies it, not the app's own updater.
- The browser is root-owned on Linux and owned by the office account on a Mac, in folders nobody else can write
  (`trustedBrowser`).
- No migration, no UI, no i18n.

## Tests

`bun run typecheck`, `bun test tests/unit/system-packages.test.ts` and the touched unit tests (g-scripts,
g-bundle-linux, publish-server, office, dev-env-srt, devenv-hosted-boot, image-build-ami), `go test ./cmd/mycel-ctl/`,
`bun run check:docs`, the Debian 13 container install.

## Result

Filled in at the end.
