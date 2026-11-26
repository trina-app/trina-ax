# Windows installer only when the Windows app changed

- Date (UTC): 2026-11-26 06:32
- Branch: `ci/windows-ship-when-changed`
- Status: in progress
- Where: release CI (`.github/workflows/release.yml` prepare, `scripts/release/windows-cadence.ts`, a new
  `scripts/release/windows-inputs.ts`), `desktop/build.ts` (its entry list moves to `desktop/build-entries.ts`).
  Why: the owner, 2026-11-26: "우리는 웹만 바꾸면 되어서, 실제로 버전이 올라가도 윈도우 앱은 변경이 안되는 케이스가
  대다수" (most releases change only the web, so the Windows app does not change).
- Version impact: none. Release CI only; the shipped desktop bundles are byte for byte the same.

## Goal

The Windows installer (3–4 eSigner signings each) ships only when the Windows app itself changed since the last
release with the installer, at most about once a week. A web or server change reaches Windows desks without a new
installer, because the app opens the team server's pages.

## Premise check

- The Windows app is the desk shell: Electron 44, main process, 3 preloads, 5 small screens and the in-app browser's
  page script (`desktop/build.ts`), packaged by `desktop/electron-builder.config.ts`. The team's web app is not in it:
  the app loads `<team address>`. The office zip (server, web, native helpers) is not in it either.
- Part right: the shell bundles `@mycel/shared` through its barrels, so 107 of 144 `shared/src` files (the whole
  server API schema set) are in the bundle; zod schemas are not tree-shaken. A server API change thus changes the
  Windows app's bytes even when the shell does not use it.
- No server-enforced minimum desk-app version exists. The page and the app agree on bridge versions
  (`shared/src/desktop-bridge.ts`, `shared/src/api/local-apps.ts`); a page that wants a newer one refuses that feature
  on the old app ("too old").

## Scope

In:
- `windows-inputs.ts`: the Windows app's fingerprint, built exactly like `dist:win` (every bundle of
  `desktop/build-entries.ts`, minified; electron-builder.config.ts with its own files; the raw packaging files;
  `desktop/package.json` without `version`; the bun.lock closure of electron and electron-builder), and the bridge
  versions.
- Rule: same app → no Windows installer on any day; changed → the 7 days as before; a changed bridge version → at
  once; cannot tell (no checkout, build fails) → the 7 days with a warning. Kept: re-run consistency, `Windows: yes|no`,
  input, monthly signing guard, unsigned-last ships once, API failure skips with a warning.
- release.yml prepare: the last Windows tag (`windows-cadence.ts last`), its checkout next to this one
  (`.windows-last`), `bun install --ignore-scripts` in both, `decide --last-tree`.
- Tests, RELEASE-CI.md 11장, a decision file, `changes/windows-ship-when-changed.md`.

Out:
- Narrowing the desktop's `@mycel/shared` imports so server API schemas leave the bundle (the root of "API change =
  Windows change"); reported as a follow-up.
- The Mac app (same shell; Apple signing has no per-signing cost): report only.

## Steps

1. `desktop/build-entries.ts`; `desktop/build.ts` builds from it.
2. `scripts/release/windows-inputs.ts`.
3. `windows-cadence.ts`: `last` command, `change` in the rule, `--last-tree`.
4. release.yml prepare steps.
5. Tests (`tests/unit/windows-cadence.test.ts`), docs, decision, changes file.

## Risks

- A file packaging reads that the fingerprint misses: a test walks the Windows keys of electron-builder's config and
  fails on a named file not fingerprinted, and on a new top-level key.
- Old tags lack `desktop/build-entries.ts`: the current list is used on both trees (an entry that is missing counts as
  changed).
- Bun 1.3.12 cannot bundle files its own test process has loaded: the repository test runs the fingerprint in a child
  process, as release.yml does.
