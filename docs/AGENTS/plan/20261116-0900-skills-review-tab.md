# Team skills › To review shows only what waits, and the nav says how many

- Date (UTC): 2026-11-16 09:00
- Branch: `fix/skills-review-tab`
- Status: in progress
- Where: trina-ax core, `web/` (Team skills page, the Trina panel and the phone drawer). Why: team skills are a core
  feature (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a fix to an existing screen; no API or data change

## Goal

The owner looked at Team skills › To review and said it looks bad, and asked whether a waiting review shows a
notification like chat does. The tab listed a suggestion registered weeks ago, its "Registered as …" line read like an
error (the accent colour), two grey settings sentences with raw paths sat above the list, and a one-row list had a
person header. The navigation's Team skills row had no count.

## Approach

1. To review lists only waiting suggestions (and share proposals). Decided ones move to a folded "Reviewed" section
   under the list (the shared `ListSection`, folded by default, count beside the label). With nothing waiting: the plain
   empty state, then "Reviewed" if there are any. No new request: the one review read is split by status.
2. The "Registered as …" link is a quiet link in muted text; a turned-down row's note keeps the danger colour.
3. Removed from the tab: "Folders you manage: …" (the review dialog's folder field already says where). "Who can
   edit" shows only on the Skills tab, where the skills are. Rows say the folder in words ("Team skills", a group's
   name), not a path.
4. A person heading only when it helps: several people, or several items of one person. One row: the person's name is
   in the row's line.
5. The Team skills row in the Trina panel and the phone drawer shows the number waiting for this person
   (`pendingReview + sharesToReview`), with one shared count pill (`CountPill`) that the rooms' unread badge and a
   folded room folder's pill now use too. Read on load and on `skillsChanged`, a reconnect, and a file change under a
   skills folder. No polling. Nothing at 0.

## Decisions

docs/decisions/20261116-skills-review-tab.md

## Risks

Six app languages; phone and desktop; the shared pill is used by the rooms list (same classes, no visual change).
Another reviewer's turn-down does not reach my window as an event: my count follows on the next event or load.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, web unit tests (member-contribute, nav), the e2e spec
`web/test/e2e/skills-review-tab.spec.ts` and `team-skills.spec.ts`.

## Result

(filled in at the end)
