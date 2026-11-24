# Desktop fixtures: stop every Electron process before the profile is removed

- Date (UTC): 2026-11-24 06:42
- Branch: `fix/rtc-native-cleanup`
- Status: done
- Where: Team AX core, `desktop/e2e`. Why: the test runner of the desktop app is there (see docs/REPOSITORY-RULES.md)
- Version impact: none, test only

## Goal

Desktop e2e `rtc-native.spec.ts` failed its cleanup on dev a216547f2: `rmSync` of the temp folder threw ENOTEMPTY. A re-run passed.

## Cause

`fixtureResult` (desktop/e2e/fixture-run.ts) killed only the Electron main process with SIGKILL when the result line came, and returned at once. Its helpers (GPU, network service, renderers) were not killed.
- Measured on this Mac: 3 or 4 helpers alive at the kill, every run.
- The profile was still written after the kill (Cookies, the cache index, Shared Dictionary, the service worker database), every run.
- The orphaned helpers held the fixture's output pipes for up to 3 minutes.
- The spec then removed the folder while they wrote. A removal racing those writes failed 5 of 5 times (ENOENT without `force`). With `force`, ENOTEMPTY results when a write creates an entry after the folder was read.

## Scope

In: the fixture runs in its own process group; the runner kills the whole group and returns only at `close`, when every process holding its output has exited. A timeout waits the same way.
Out: the app itself. A user's quit goes through Electron's own shutdown, which ends its helpers; only this runner's SIGKILL of the main process left them.

## Steps

1. Probe: processes alive and writes into the profile after the kill.
2. Group kill and wait for `close`; the same probe after.
3. Desktop e2e `rtc-native.config.ts` locally.

## Decisions

None.

## Result

See the PR.
