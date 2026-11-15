# Slack page: problems of the official app offer only what an admin can do

- Date (UTC): 2026-11-15 08:09
- Branch: `fix/slack-admin-official-errors`
- Status: done
- Where: web/src/pages/admin/Slack.tsx and the six app languages. Why: the page's own problem lines (docs/REPOSITORY-RULES.md: web screens live in web/)
- Version impact: patch, a wording and link fix of an existing screen; no API change

## Goal

QA tracking TC-2960. When the team uses the official Trina Slack app (`mode: 'official'`, served by the hosting
service), Admin › Connected apps › Slack shows the own app's fixes for a problem: "Enter new tokens under Replace
tokens" (an official app has no tokens to enter) and "Add them in Slack app settings › OAuth & Permissions and
reinstall" (the admin has no access to the official app's settings). A rate limit from Slack says "The server cannot
reach Slack. Check the server's internet connection", which is wrong in both modes.

## Scope

In:
- `GET /api/admin/slack` already says the mode (`mode`); the page picks the fix by code and mode.
- The official app: a refused connection, missing permissions, an organisation-wide install and anything unknown say
  one short line with "Add to Slack" in it, which adds the app again (the same flow as "Add to Slack" on the page;
  no copying, no Slack settings). The owner and admins both see it (both can add the official app).
- `ratelimited`: "Slack is busy right now. It tries again by itself in a few minutes." in both modes.
- The team's own app keeps its current fixes.
- All six languages (en, ko, ja, id, es, zh).

Out: the server's error codes and how the official connection reports them.

## Steps

1. One table per mode in Slack.tsx; a small hook for "Add to Slack" shared by the official card, "Update Slack
   permissions" and the new problem line.
2. New strings in en.ts and the five other languages.
3. Unit tests (web/test/unit/slack-screens.test.tsx) for both modes; an e2e assertion in slack-in-connectors.spec.ts.
4. Screenshots 1440 and 390, before and after, with a mocked `/api/admin/slack`.

## Plain-words check

No "token", "scope", "OAuth" or Slack settings page in the official app's lines. "Add to Slack" is the button's own
name on this page.

## Risks

None of data or permissions: words and a button that already exists elsewhere on the page. No migration.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run test:web`, `bun run build:web`,
tests/unit/c-slack*.test.ts, e2e slack-in-connectors.spec.ts and the Slack shots spec.

## Result

Built as planned. Slack.tsx picks the fix with `slackFix(code, mode)` (two tables); the official app's refused /
missing-permission / org-wide / unknown problems show one line with an "Add to Slack" button (`OfficialFix`, the same
install flow through the new `useSlackInstall` hook, which the official card and "Update Slack permissions" now share).
`ratelimited` has its own line in both modes. docs/SLACK.md says it. PR: see the branch's pull request.
