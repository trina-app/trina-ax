# Connectors: "Get updates in a conversation" for services that also have a conversation app

- Date (UTC): 2026-11-16 03:08
- Branch: `feat/connector-card-room-apps`
- Status: done
- Where: trina-ax (Team AX core: shared room-apps list, server rooms list, web Connectors and Room). Why: conversation
  apps and Connectors are core screens (see docs/REPOSITORY-RULES.md)
- Version impact: minor, a new entry point on an existing screen and a new optional field on the rooms list

## Goal

Owner decision 2026-11-16 (QA TC-3515). People who want "connect Sentry" open Settings › Connectors, find Sentry's AI
connector and never find the conversation app, which is only in a conversation's ⋯ ("Add an app"). Give them one way
from the connector to the conversation app.

## Scope

In:
- One shared map from catalog ids (shared/src/service-catalog.ts) to conversation-app services (Sentry, Notion, Stripe,
  Atlassian → Jira), next to the presets in shared/src/api/room-apps.ts.
- Connectors (Your connectors rows and Discover cards): one small text action under the row for a mapped service, "Get
  updates in a conversation".
- A conversation picker (the shared Modal and ListRow) listing only conversations where the person may add apps. The
  rule is the server's `mayManageApps`, sent as a new optional field `Room.canManageApps` on the rooms list (and every
  room the server sends). The web's `mayManageApps` reads it first, older servers fall back to the old copy.
- Picking a conversation opens it with the Add an app guide already on that service: `?apps=add:<service>` (an older
  build opens the dialog's first screen). Nothing is added until Copy, as now.
- No conversation to pick: one plain line saying how to start one.
- Docs: docs/site/use/room-apps.md, features.ts name, docs:api, decision file, changes fragment.

Out: a composer "+" item, a sidebar "Apps" entry, admin buttons, services with no catalog entry (GitHub, Google Forms,
Typeform, ... are not AI connectors here).

## Steps

1. shared: `ROOM_APP_FOR_CATALOG` and `roomAppForCatalog(id)`; `Room.canManageApps` optional.
2. server: roomOut sets canManageApps from mayManageApps; unit test.
3. web: store reads the field; Room.tsx `?apps=add:<service>`; Connectors action + picker dialog; words in six tables.
4. e2e spec: member vs admin lists, guide opened on the service, empty line.
5. Screens at 1440/390, light/dark, member/admin/owner.

## Decisions

docs/decisions/20261116-connector-card-room-apps.md.

## Risks

No migration. roomOut runs one more indexed user lookup per room. Six app languages. Phone widths (the picker is a
bottom sheet).

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, features:check, docs:api, unit tests for room apps and
rooms, server rooms tests under Bun 1.3.12, targeted web e2e (room apps, connectors, the new spec).

## Result

Built as planned. The action is a text line under the row (ConnectionRow's children), so the row keeps one status on
its right. A new app's guide opened by the link has the picker under it, so Back offers the other services. Hidden
conversations and closed 1:1s are not offered; guests see no action.
