# Chat connect card: Connect for the team for Google Drive and the Google apps (#253)

- Date (UTC): 2026-11-22 05:19
- Branch: `fix/253-chat-card-team-google`
- Status: done
- Where: server/src/chat (connect_service), shared/src/api/ws.ts (the card), web/src/components/chat (the card).
  Why: the chat card is where people ask; it should offer what onboarding and Admin › Connected apps offer.
- Version impact: patch, a fix that makes the chat card match the other connection surfaces (only optional card
  fields are added).

## Goal

docs/CONNECTIONS.md mismatch 8: onboarding (ToolsStep) and Admin › Connected apps can connect Google Drive and Gmail
(and Calendar, Docs, Sheets) for the whole team, but a chat only offers a personal connection. An owner or admin asked
in a chat to connect Drive or Gmail now also gets "Connect for the team", which opens the same dialogs
(DriveShareDialog, GoogleAppTeamDialog). Members keep the personal connection only. A member a team connection already
covers (a working team Drive share, the team's shared Google account) is told it is connected, as My setup counts it.

## Scope

In:
- Drive card (target google_drive): a working team share this person may use = connected (no card). An owner or admin
  gets the card with a second button, Connect for the team (DriveShareDialog). Personal flow unchanged.
- Google apps (Gmail, Calendar, Docs, Sheets): members unchanged (no card, the way in words). An owner or admin, where
  the app can be connected and is not connected for them, gets a card (target google_app): Connect for the team
  (GoogleAppTeamDialog) and their own connection on its page (Settings › Connectors › the app), as before.
- done check: connected for this person, or (admin) a team connection made that does not include them, told so.
- The ToolsStep's Google team hook and dialog moved to components/integrations so the card uses the same ones (no
  behaviour change on the step).
- 6 languages, docs/CONNECTIONS.md, the user docs that describe the chat card.

Out: a personal Google app sign-in inside the card (stays on its page); Slack.

## Steps

1. shared: ConnectServiceRequest target 'google_app', googleApp, teamOffer.
2. server: connect-service.ts Drive team share check, admin cards, done(), outcome; tests.
3. web: ConnectCard team button + dialog, google_app case; lib/connectCard; tests.
4. i18n, docs, changes/chat-card-team-google.md.

## Decisions

None new: follows docs/decisions/20261121-onboarding-google-team-or-own.md (team and own, both ways).

## Risks

No migration. Permissions: the team dialogs call admin endpoints, which check the role; the card's done reads the
role again. Phone app: no Google sign-in there, so no team button on a phone.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run check:prepush`, server tests/unit for
connect-service, web unit tests for the card.

## Result

Built as planned. Server: `connect-service.ts` (Drive team share = connected, `teamOffer` for owners and admins, the
`google_app` card, done reads the role again and reports "connected for the team" when the admin is not among the
users), `connect-google-app.ts` `googleAppTeamCard`. Web: `ConnectCard.tsx` Connect for the team and the google_app
case, the hook and dialog moved to `components/integrations/GoogleTeam.tsx` (ToolsStep imports them, no change there).
All four Google apps get the team way, not only Gmail: the same dialog serves them. Tests in
`tests/unit/connect-service.test.ts`, `tests/unit/connect-google-app.test.ts`, `web/test/unit/connect-card.test.tsx`.

