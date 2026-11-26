# The Windows installer ships only when the Windows app changed, at most about once a week

- Date: 2026-11-26
- Status: accepted
- Supersedes: the "7 days" bullet of [20261126-windows-weekly](20261126-windows-weekly.md) (the rest of it stands)
- Branch: ci/windows-ship-when-changed (the owner, 2026-11-26; plan [20261126-0632-windows-when-changed](../AGENTS/plan/20261126-0632-windows-when-changed.md))

- **Ask:** the owner: "우리는 웹만 바꾸면 되어서, 실제로 버전이 올라가도 윈도우 앱은 변경이 안되는 케이스가 대다수".
  Ship the Windows installer only when the Windows app actually changed.
- **Premise, checked:** right that the web is not in the Windows app: it is the desk shell (Electron, main process,
  three preloads, five small screens, the in-app browser's page script), and it opens the team server's address, which
  sends the web app. A web or server change reaches Windows desks without a new installer. Only part right that the app
  rarely changes: the shell imports `@mycel/shared` through its barrels, so most of `shared/src` (the server API zod
  schemas, 107 of 144 files) is in its bundle and is not tree-shaken. Over the releases v0.8.0..v0.19.0 the shell's
  bundle changed in all but one (v0.13.0 → v0.13.1), mostly from API schema changes the shell does not use.
- **Rule:** after the existing checks (a run again of a published tag, `Windows: no`, the monthly signing guard,
  `Windows: yes`, no earlier installer, the unsigned last installer when signing is on):
  - the Windows app of this tag is compared with that of the last release with the installer on this channel
    (`scripts/release/windows-inputs.ts`): the nine bundles `desktop/build.ts` makes (`desktop/build-entries.ts`, built
    like `dist:win`, byte for byte the same as `dist/`), electron-builder's config with its own files, the files
    packaging reads as they are (and every other Windows file in `desktop/build-resources/`), release.yml's
    `BUN_VERSION`, `desktop/package.json` without `version`, and bun.lock's entries for Electron and
    electron-builder and what they pull in. Mac-only and Linux-only files are not in it.
  - the same: no Windows installer, on any day.
  - a bridge version the team's pages check against the app (`*_BRIDGE_VERSION`, `WORK_FILES_WIDE_VERSION` in
    `shared/src/desktop-bridge.ts` and `shared/src/api/local-apps.ts`; not the Mac-only dictation one) changed: it
    ships now, whatever the day. There is no server-enforced minimum desk-app version; these are what an older app is
    "too old" for.
  - changed: it ships when that installer is 7 or more days old (Korea), as before.
  - cannot tell (no checkout of that tag, an install or a bundle that fails): the 7 days alone, with a warning.
- **How:** `prepare` finds the tag (`windows-cadence.ts last`), checks it out next to this one (`.windows-last`,
  `continue-on-error`), runs `bun install --frozen-lockfile --ignore-scripts` in both, and `decide --last-tree`.
- **Why a built fingerprint, not a path diff:** a diff of the paths that feed the build counts every version bump,
  comment and test edit; the built bundles count only what reaches the installer.
- **Left out:** narrowing the shell's `@mycel/shared` imports so unused API schemas leave the bundle (that would let
  most API-only releases skip Windows too; a follow-up). The Mac app (the same shell, quietly updated on every
  release; Apple signing has no per-signing cost) stays on every release.
- **Tests:** `tests/unit/windows-cadence.test.ts` (the rule with the comparison, the fingerprint on small trees and on
  this repository, the bridge versions, electron-builder's Windows keys, the `last` command and `--last-tree`, the
  workflow's wiring).
- **Version impact:** none (release CI only; the shipped desktop bundles do not change).
