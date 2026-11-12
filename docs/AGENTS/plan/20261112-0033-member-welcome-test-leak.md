# Web tests: member-welcome waits for each unmount, so later test files render again

- Date (UTC): 2026-11-12 00:33
- Branch: `fix/member-welcome-test-leak`
- Status: done
- Where: web tests only (`web/test/unit/member-welcome.test.tsx`). Why: a test fix (see docs/REPOSITORY-RULES.md)
- Version impact: none, tests only

## Goal

A full `bun run test:web` on dev failed about 195 tests (welcome, onb6-skills, share-to-room, …) that pass alone.
`member-welcome.test.tsx` called the test host's async `unmount()` without `await` (the only test file of 58 that
did). One test unmounts and mounts again at once, so two React `act()` scopes overlapped and from then on renders in
the same process stayed `<div></div>`: 8 of its own 15 tests and every later file that renders.

## Scope

In: `await` every `unmount()` in that file. Out: the test host itself.

## Result

member-welcome alone 15/15 (was 7/15); member-welcome then welcome 74/74; full `bun run test` in web 2624 pass, 0
fail (was 195 fail). Found by pairing each of the 50 test files changed since 7eaded006 with welcome.test.tsx.
