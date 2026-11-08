# First run: follow-ups after the re-review of #210 and #211

- Date (UTC): 2026-11-08 12:41
- Branch: `fix/first-run-followups`
- Status: in progress
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
3. The desktop host strip no longer makes the page jump on every team open: while `/api/me` has not answered yet on a
   page that is not a sign-in page, the strip waits 300 ms before it takes space; a sign-in page and a signed-out answer
   show it at once. Test.
4. The phone's start: `settleDevice` and `retryRemovals` run one after the other (a slow removal could write the owed
   list over the old team's new entry). Test with a slow network.
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

(filled in at the end)
