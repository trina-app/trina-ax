# Team skills: the review count follows another reviewer's action at once

- Date (UTC): 2026-11-16 12:16
- Branch: `fix/skills-review-count-live`
- Status: done
- Where: Team AX core (`server/src/skills/`, `web/src/store/live.ts`). Why: skills review is a core feature (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a fix to the count added in 20261116-0900-skills-review-tab

## Goal

The Team skills row shows how many suggestions and share proposals wait for my review. When another reviewer turns one
down, my count stays until the next skill event, a reconnect or a reload: the server tells only the suggester. (A
registration does update it, because a file changes under a skills folder.) The count should follow at once.

## Scope

In:
- After a suggestion is registered or turned down, the people who could review it get one quiet realtime event.
- The same for a share proposal to a group that is dismissed, applied or moved to another target.
- The suggester who also reviews the folder gets it for their own new suggestion (their other windows).
- The web reads the count and the lists again on it.

Out: a new inbox entry, banner or push (nobody is asked anything); a share that expires (the count already leaves it
out by its date when read).

## Steps

1. Server: `server/src/skills/review-live.ts` with the quiet event (`notice`, code `skills_changed`, no text, like
   `integrations_changed`) and a helper that publishes it to a list of people.
2. `suggestions.ts`: publish to the reviewers of the row (as it was before the review) except the suggester, who
   already gets `skill_suggestion_reviewed`. On a new suggestion every reviewer already gets `skill_suggested`; only
   a suggester who reviews the folder is added.
3. `share.ts`: publish to the group's writers on dismiss, on apply (when it is done) and to the old group on a target
   change.
4. Web: `live.ts` fires `skillsChanged` on `skills_changed`, no toast.
5. Tests: server unit (who gets it, who does not), web unit (the count reads again, no toast).

## Decisions

none (the event follows the quiet notices that exist: `integrations_changed`, `profile_changed`).

## Risks

- A window with an older web bundle does not know the code: it shows nothing useful. Other quiet codes had the same
  step when they were added.
- No migration, no permission change: the event carries no data, and goes only to people who could already read the
  suggestion or the share.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, server unit tests for skills and notifications, web
unit tests for the touched files, e2e `skills-review-tab` and `team-skills`.

## Result

Built as planned. The event is the quiet notice `skills_changed` (`server/src/skills/review-live.ts`); the web fires
`skillsChanged` on it with no toast. It goes to the people who could review the row (the reviewer too, for their other
windows), not to the suggester (their result notice already does it) and not to anyone who reviews nothing. Share
proposals had the same gap on dismiss, on an apply that only merges, and on a move back to the team: covered.

Tests: `tests/unit/skill-review-live.test.ts`, a case in `tests/unit/group-skill-shares.test.ts`, a case in
`web/test/unit/member-contribute.test.tsx`. By hand on a private copy of the QA team (two reviewers, one elsewhere):
the count dropped within two seconds of the other reviewer's turn-down, with no toast and no inbox entry.

PR: https://github.com/trina-app/trina-ax/pull/1122
