# First run: follow-ups after the re-review of #210 and #211

- Date (UTC): 2026-11-08 12:41
- Branch: `fix/first-run-followups`
- Status: done
- Where: trina-ax `shared/src/team-link.ts` (and its phone copy), `desktop/` (host strip), `mobile/` (start-up
  removals), `docs/DECISIONS.md`. Why: small fixes the re-review of the first-run work asked for (see
  docs/REPOSITORY-RULES.md)
- Version impact: patch (no new screen, no API change)

## Goal

Five follow-ups from the re-review of "First run: one box" (#210) and "First run, phase 2" (#211).

## Scope

In:
1. `isLoopbackHost` also knows IPv4-mapped loopback (`[::ffff:127.0.0.1]`, `[::ffff:7f00:1]`), the unspecified
   addresses (`[::]`, `0.0.0.0`, `0`) and the rest of 0.0.0.0/8, so a link from outside cannot reach this machine
   through them. Test table rows.
2. `cutGlued`: a Korean word glued straight onto a host with no path (`https://acme.trina.app입니다`) reads as the
   host. Test.
3. The desktop host strip and the phone footer no longer make the page jump on every team open: while `/api/me` has
   not answered yet on a page that is not a sign-in page, the line waits 300 ms before it takes space (`hostLineNow`,
   shared); a sign-in page and a signed-out answer show it at once. Test.
4. The phone's start: the start's device check and the owed-removal retry run one after the other; the stored devices
   change one storage step at a time (no network inside), and a retry takes out only what it removed (a slow removal
   could write the owed list over the old team's new entry). Test with a slow network.
5. DECISIONS: the host line is a hint (a page script can hide the phone footer; a fake server can answer its own
   `/api/me`); the protection is ④ and the outside-trina.app question.

Out: anything else.

## Steps

1. Plan. 2. Parser (both copies) + table. 3. Desktop strip timing + test. 4. Phone start order + test. 5. DECISIONS,
CHANGELOG. 6. Checks, units, first-run e2e specs, PR.

## Risks

The strip delay must never hide the address on a sign-in page or after a signed-out answer; a test checks both.

## Tests

`bun run typecheck`, `bun run typecheck:mobile`, `bun run check:i18n`, `bun run check:docs`, `bun run docs:api`; units
`team-link`, `e-desktop-common`, `mobile-push`, `mobile-security`, `app-links`; web e2e first-run related specs.

## Result

All five done. Besides the asked queue, the phone's stored devices now change one short storage step at a time, with no
network inside, and a retry takes out only what it removed: a single queue around the network would have held a leave
behind a slow removal, so a registration of the new team could land first and be cleared (a test covers both races).
The glued-host cut also takes the sentence's period after the word (`https://acme.trina.app입니다.`).

Checks: `typecheck`, `typecheck:mobile`, `check:i18n` (0 issues), `check:docs`, `docs:api` (no change) pass. Units
(parser on both copies, desktop, mobile, app links, i18n, route registry): 324 pass, 0 fail. Web unit tests in Docker:
1752 pass, 1 fail (the `team-files.test.ts` case that fails on an untouched dev). Web e2e (first-run, team-link, auth,
settings-ia, apps-install): 37 passed. Built desktop app against a local dev server with fake data: a signed-in reopen
never attached the strip (0 of about 100 samples in each of 3 reopens, every 10 ms for 4 s); `/login` had it in every
sample, from the first one.
