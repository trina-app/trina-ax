# Slack sign-in from the desktop app finishes in the app

- Date (UTC): 2026-11-22 00:16
- Branch: `fix/connector-desktop-handoff`
- Status: in progress
- Where: server (`server/src/integrations/slack/service.ts`, `server/src/routes/{slack,drive,integrations}.ts`). Why:
  the Slack connector and the shared claim address live in the server; no desktop or web change.
- Version impact: patch (a fix; no contract change, no migration; desktop apps since 0.6 already post every code to
  the claim address)

## Goal

"Sign in with Slack" (own app or the hosting service's app) and "Add to Slack" started in the desktop app open the
system browser, which has no session of the app. The return then sends that browser to `/login`: a dead end for people
who are not developers. Every other connector finishes in the app since #279 (MCP connectors such as Notion, GitHub,
own and template apps) and the Google ones since #98 / #205. Slack is the gap #279 listed.

## Scope

In: the desktop hand-off for Slack's three sign-ins, through #279's shared path: a return in a browser with no session,
for a flow a live desktop session started, is held with a one-time code in the app link's fragment; the app posts it to
the one claim address (`POST /api/integrations/google-drive/claim`), which tries Drive, the Google apps, connections,
then Slack. The return page is the connections' held page (shared helper, same words, same CSP).
Out: the phone app's in-app browser (still signs in first, as before); a browser signed in as someone else (still
refused and ended, as today).

## Steps

1. Shared return-page helper from `routes/integrations.ts` (held, handed pages), used by both routes.
2. Slack service: hold (Slack's code or the hosting service's handoff sealed in the flow, never exchanged until the
   claim; the code's hash), claim (this person and session only, once, 5 minutes), reopen says "waiting for the app",
   a finished flow says it is finished. The admin check of "Add to Slack" runs again at the claim (same finish path).
3. Claim route: Slack after connections.
4. Tests: unit (own sign-in, broker sign-in, Add to Slack: no session → code → claim → done; replay, reload, other
   session, other person, late code, admin demoted) and tests/security.
5. Decision file, changes/ note.

## Decisions

docs/decisions/20261122-slack-desktop-handoff.md

## Result

(filled in at the end)
