# Connector lines and notices that keep their word

- Date (UTC): 2026-11-15 08:26
- Branch: `fix/connector-notices-truth`
- Status: done
- Where: server/src/integrations, server/src/notifications, web/src/components/integrations, i18n. Why: four QA
  findings where the connector pages or the notification setting promise something the server does not do.
- Version impact: patch: fixes wrong lines and adds missing notices; no new feature, no API removed.

## Goal

QA sheet TC-2939, TC-2944, TC-2945, TC-2946. A member or admin reads a line on a connector page or in Settings and it
must be true.

1. TC-2939: an address that answered but is not a connector, and an address that sends us elsewhere, say so in their
   own words instead of "Couldn't reach the service at its address".
2. TC-2944: "Always allow" lines on a connection's page and in the Google apps' policy dialog say that it also sends
   after reading something from outside. The server asks again there when the team turned Always allow off, and for a
   question from Slack. The lines follow the team's switch (a new `Me.team.alwaysAllowOff`); the server rule stays.
3. TC-2945: "A connection needs you to sign in again" was only sent for Google Drive. Every own connection (MCP, HTTP
   API, Gmail and the other Google apps) that turns to "needs sign-in" tells its owner once: one Inbox row naming it
   and one push (the generic lock-screen text), no second one while the first is unread.
4. TC-2946: a member who asked an admin for an app hears it when the admin dismisses the request or it expires after
   30 days: "The request for Notion was closed. You can ask again." (a quiet notice, like "is ready").

## Scope

In: the four items, their texts in all six languages, unit and web tests.
Out: team connections that need a sign-in (who to tell is an admin question: open question in the PR); the connector
catalog and address checks.

## Steps

1. ConnectionPage REASON_KIND: `not_mcp` -> notMcp, `redirect` -> redirect, each with its own line.
2. Me.team.alwaysAllowOff from TeamSettings.roomAlwaysAllow; AppDetail / ConnectionPage / Google policy dialog pick the
   line for the switch.
3. connections/service.ts setStatus: on the move into needs_auth of a personal connection that had a key or sign-in,
   notifyConnectionReconnect(owner, "<id>_<ms>"); the Inbox names it and opens its page.
4. service-requests.ts: dismiss and expiry send `service.closed` to each member (migration 353, its own notice table);
   the Inbox says it was closed and opens the app's page.

## Risks

Migration 353 (highest on dev: 352 for c). Shared files with other builders: connections/service.ts (setStatus only),
ConnectionPage.tsx (REASON_KIND only), GoogleAppConnector.tsx (one line). Old apps that do not know `service.closed`.

## Plain-words check

No "MCP", "OAuth", "token" in any new line. "connector", "sign in again", "ask again".

## Tests

typecheck, check:i18n, check:docs, unit tests of c-*/notifications, web unit tests, the connectors e2e specs.

## Result

Built as planned. Differences: a reconnect notice comes only on the move from connected (not from an error, an edit or
a connection that never worked), so a person fixing a key is not told what they are looking at. Team connections tell
nobody (open question). The expired line was shortened after the screenshots. "Dismissing tells nobody" (DECISIONS,
2026-11-12) is reversed on purpose (QA TC-2946). PR: see the branch's pull request.
