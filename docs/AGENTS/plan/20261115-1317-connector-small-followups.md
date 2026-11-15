# Connector follow-ups: sign-in push opens the connection, API rows in the log, sign-in wording on a skipped run

- Date (UTC): 2026-11-15 13:17
- Branch: `fix/connector-small-followups`
- Status: done
- Where: server/src/notifications, web/pwa/sw.js, web/src (Inbox, Admin › Activity log), i18n. Why: three small
  follow-ups to connector work (tracking TC-3052, TC-3053, TC-3054)
- Version impact: minor: three new optional API fields (`needsKey.signIn`, `lastNeed.signIn`, `ScheduleRun.needSignIn`)
  and a new push tap target (docs/RELEASE-CI.md "Version numbers")

## Goal

1. TC-3053: a personal connection that now needs a sign-in sends a push; tapping it opens the Inbox. It should open
   that connection's own page (where "Sign in again" is), as its Inbox row already does. The push text stays generic
   (the gateway's privacy design): only the path changes, ids only.
2. TC-3054: Admin › Activity log calls an API connection "an MCP connection" when it is added, changed or deleted.
   Name it as the rest of the app does ("API"): "Added an API connection". Same for an API template.
3. TC-3052: a scheduled-task notice for a team template that members sign in to says "needs your own key for {name}".
   It should say they need to sign in to {name} with their own account. Key templates keep the key words.

## Scope

In: the native push path (server push-events.ts) and the Web Push click (sw.js) for `connection.reconnect`; the
Activity log label for `integration.*` and `integration_template.create/update/delete` rows whose detail says
`kind: http`; `needsKey.signIn` on the Inbox notice and its words.
Out: nothing else (the Scheduled page's lines were added after review, see Result).

## Steps

1. push-events.ts: a resolver for `connection.reconnect`: an own personal connection still the person's → its page
   (`/settings/connectors/<googleApp>` or `/settings/connectors/mcp/<id>`); a Google Drive notice whose Drive
   connection is the person's → `/settings/connectors/google-drive`; else the Inbox as before.
2. sw.js: keep the connection's id / app from the signed-in notice fetch and open the same page on click.
3. Audit.tsx actionLabel: `audit.act.<action>.http` when detail.kind is http and the key exists; 6 languages.
4. notifications service: `needsKey.signIn: true` when the template (still there) signs in; shared schema; Inbox
   words `notifications.event.schedule.needsSignIn(Named)`; 6 languages.

## Plain-words check

"Added an API connection", "sign in to {name} with your own account": no MCP, OAuth, token or path in the UI.

## Risks

No migration. Push path is ids only and checked by the existing PATH rule (app and gateway refuse anything else).

## Tests

Unit: push path resolver (personal, Google app, Drive, removed), Inbox notice signIn field, sw.js click, activity
label, Inbox line. typecheck, check:i18n, check:docs, notifications/push unit files, web unit, e2e of Inbox and
Activity log.

## Result

Built as planned. One difference: a Web Push click for Google Drive's notice stays on the Inbox, because the
signed-in notice does not say it is Drive's (the native push does open Drive's page). Activity log rows also cover API
templates. Added on review: the Scheduled page's card, run line, next step and link use the same sign-in words
(`Schedule.lastNeed.signIn`, `ScheduleRun.needSignIn`).
PR: see the PR that links this plan.
