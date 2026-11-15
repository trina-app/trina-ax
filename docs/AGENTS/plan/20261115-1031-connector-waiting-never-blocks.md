# Connections that never signed in never block adding a connector

- Date (UTC): 2026-11-15 10:31
- Branch: `fix/connector-waiting-never-blocks`
- Status: done
- Where: server/src/integrations/connections, server/src/chat/connect-service.ts. Why: a connection limit bug in the open core (see docs/REPOSITORY-RULES.md)
- Version impact: patch: a bug fix, no new feature or API
- QA: TC-3048

## Goal

Connect saves a connection before its sign-in starts. A sign-in the service refuses (approved apps only: Canva, Figma,
Intercom, Square) or a window the person closed leaves that connection waiting. Since PR #734 waiting ones have their
own cap of 20. After 20 different tries the 21st Connect is refused with "You can have at most 20 connections", while
the person has no working connection. Waiting connections must never stop someone adding a connector, and the limit
message must say what it counts.

## Scope

In:
- At the waiting cap, Connect (Settings, an admin's request, the chat's card, a key changed to sign-in) removes the
  person's oldest waiting connection instead of refusing. Only one that never stored a sign-in or key, is not from a
  team template, has no own app, and had no sign-in try in the last hour. Removed through the same delete path as
  Delete (audit entry, cached client and tool lists dropped); its sign-in flows go with it (ON DELETE CASCADE).
- The hour rule keeps FLOWS_PER_HOUR exact: a removed connection's flows are all older than an hour, so they no
  longer count toward the 20 tries an hour anyway, and no sign-in that is still open (10 minutes) is cut off.
- Rows stay bounded: at most 20 waiting connections per person, as now.
- When none may go (all 20 tried in the last hour, or own apps), a message that says so, in six languages.
- The 20-connection refusal for a person's own connections says "working connections" (the team limit keeps its words).

Out: FLOWS_PER_HOUR (unchanged), the web screens (they show the server's message), not keeping a connection whose
first sign-in was refused (the list shows the refusal on it; a closed window needs the replacement anyway).

## Steps

1. service.ts: `personalRoom` (ok / working / waiting) and `makeRoom`, used by create and update; `remove`'s local
   part becomes `drop`, reused for the replacement.
2. connect-service.ts asks `personalRoom` instead of `personalFull` (removed).
3. text.ts: `tooManyWorking`, `tooManyWaiting` in ko/en/id/ja/es/zh.
4. Tests in c-integrations-approved-apps.test.ts; `changes/connector-waiting-never-blocks.md`.

## Risks

No migration. A waiting connection that an admin's request made can be replaced: the request stays and Connect from it
makes a new one (requests.ts already handles a missing connection). Only the person's own connections are touched.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, the c-integrations-* and connect-service unit tests.
New: 25 refused tries over time then a normal Connect works; the oldest is the one removed and its flow ends; a stored
sign-in, key, template or own app is never removed; the chat card the same; 20 working still block the 21st.

## Result

Built as planned. The audit entry of a replaced connection carries `replaced: "waiting"` (no name or address, as for
any member's own connection). The callback's `limit` check and FLOWS_PER_HOUR are unchanged. Tests: 25 tries over
100 minutes then a 26th Connect signs in; the oldest goes and its left-open sign-in cannot finish; one tried in the
last hour stays and still signs in; stored sign-in, key, template and own-app rows stay; a key changed to sign-in;
the chat card (connect-service.test.ts); 20 working still block the 21st with the "working connections" text.

