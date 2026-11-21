# Onboarding Tools step: Google Drive and Gmail can be connected for the team, or each person connects their own

- Date (UTC): 2026-11-21 10:05
- Branch: `fix/onboarding-google-team-or-own`
- Status: in progress
- Where: web/ (onboarding step, Connectors wording, i18n). Why: UI only, reuses the existing team Google flows.
- Version impact: patch (a fix to an existing onboarding screen and its wording; no new API, no migration)

## Goal

The owner's step 5/6 "Tools for your team" showed Google Drive and Gmail only with a "Team pick" switch, while a team
(shared) Google account already exists in Admin › Connected apps (Drive shares, Gmail's shared account). The step must offer
both: connect one shared Google account for the team, or ask everyone to connect their own. "Team pick" is unclear.

## Scope

In:
- Drive and Gmail rows: a "Connect for the team" button that opens the same dialog Admin › Connected apps uses
  (DriveShares.tsx DriveShareDialog, GoogleAppTeam.tsx team dialog); once connected the row shows the account like
  Notion/Slack show Connected. Only where the server can do it (Drive set up; Gmail set up and the server sends `team`).
- The per-person switch moves under the row's line and is renamed "Ask everyone to connect their own"; the row's line
  says plainly what each choice means. A team account connected counts as the step done.
- One name in the product: `connectors.recommendedTag` and `connectors.recommend` use the same concept wording.
- Intro paragraph updated. All six languages.

- Extra (coordinator, connections audit #227): Calendar, Docs and Sheets rows the same way; Notion gets the switch
  (TEAM_CONNECT_TOOLS = Slack only); My setup counts a Drive an admin shares (DriveConnection.teamShares); the admin page
  is called by its label "Admin › Connected apps" in the welcome copy, ToolsStep comments and the 11-20 decision.

Out: a grouped "Google" row (one row per app keeps the existing dialogs as they are), any new connection logic or API.

## Steps

1. Export the two existing dialogs; ToolsStep reads the admin Google statuses and shares and opens them.
2. Wording in en.ts, then ko, ja, zh, es, id.
3. Unit tests (web/test/unit/welcome.test.tsx) and e2e (welcome-tools.spec.ts) updated for the new words and button.
4. Check 1440 and 390, light and dark.

## Decisions

None new; extends docs/decisions/20261120-team-vs-personal-onboarding.md (Google rows get the team row's button too).

## Risks

Admin-only reads on the step (the step is the owner's). A Drive share made from the step has the same people step as in
Admin (default nobody until Save), unchanged.

## Tests

`bun run typecheck`, `bun run check:prepush`, web unit tests for welcome, the welcome-tools e2e.

## Result

