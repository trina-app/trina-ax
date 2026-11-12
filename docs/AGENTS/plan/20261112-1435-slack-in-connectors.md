# Slack inside Admin › Connected apps, and English screenshots for the Slack guide

- Date (UTC): 2026-11-12 14:35
- Branch: `fix/slack-in-connectors`
- Status: in progress
- Where: the web app (`web/src/pages/admin/`), the server's Slack return address, the docs and the docs screenshot
  script. Why: the owner's correction of the Admin menu and of the docs images; every team gets it (see
  docs/REPOSITORY-RULES.md)
- Version impact: minor, a visible change: Slack moves from its own Admin menu item into Connected apps

## Goal

1. Slack is one service among many, not an Admin menu item of its own (owner, 2026-11-12). The owner finds it in
   **Admin › Connected apps** (`/admin/connectors`, "연결한 서비스") like Google Drive: a row in the list that opens
   Slack's page in place, with the same Add to Slack / own-app steps / status / Turn off / Remove as `/admin/slack` has
   today.
2. The Slack guide (`docs/site/use/slack.md`) shows the English app in the light theme, made with the repo's own
   screenshot script so the shots can be taken again, not Korean dark-theme QA crops.

## Scope

In:
- `AdminLayout.tsx`: the Slack menu item is gone. `/admin/slack` (with its query, such as `?slack=installed` from "Add
  to Slack") leads to `/admin/connectors/slack` with the same query. An admin who is not the owner never sees Slack
  (as today): its address leads to the Connected apps list.
- `Integrations.tsx`: for the owner, Slack is a row: in **Connected** once it is added (its state on the right: On,
  Off, Needs attention, Reconnect after it was removed in Slack), else a card in **Discover**. Its page
  (`/admin/connectors/slack`) has the same header as a Google connector's page (Connected apps › Slack, the logo, the
  name, one line) and today's Slack settings under it (`Slack.tsx`, now a page inside Connected apps).
- A Slack logo in `web/public/icons/connectors/` (recorded in `docs/THIRD-PARTY-NOTICES.md`).
- The server sends "Add to Slack" back to `/admin/connectors/slack?slack=…` (the old address still works).
- Every "Admin › Slack" text: the five locales (`slack.signin.off`), the server's text (`signin_off`), `docs/SLACK.md`,
  `docs/site/use/admin.md`, `docs/site/use/slack.md`, comments. New name: "Admin › Connected apps › Slack" (ko "관리자 ›
  연결한 서비스 › Slack", id "Admin › Aplikasi terhubung › Slack", es "Administración › Apps conectadas › Slack", ja "管理 ›
  連携サービス › Slack").
- Screenshots: Slack shots in `scripts/docs/screenshots.ts`. The states that need the hosting service (Add to Slack
  offered, added and connected, removed in Slack) cannot come from a dev server, so these shots run against the web e2e
  mock server (`web/test/mock/serve.ts`, made-up team, workspace "Acme"), which gets a test control to set Slack's
  state (`POST /__test/slack`). Shots: Connected apps with the Slack card, Slack's page with Add to Slack, Slack added
  and connected, Slack after the app was removed in Slack, and Connectors with the person's Slack account linked.
  Slack's own consent page is dropped (it cannot be shown in English without a real workspace); the step is text.
- `changes/slack-in-connectors.md`.

Out: Slack's other pages and flows (unchanged); a Slack line in Admin › Home.

## Steps

1. This plan.
2. Web: menu item out, redirect, Slack row and page in Connected apps, logo; server return address.
3. Texts: locales, server text, docs, changes file.
4. Tests: `web/test/unit/slack-screens.test.tsx` (the page inside Connected apps), admin layout redirect, menu lists in
   `admin-home.spec.ts` and `settings-ia.spec.ts`, phone e2e that opened `/admin/slack`.
5. Screenshot script + mock control; take the shots, look at each one, update `docs/site/use/slack.md`.

## Risks

- Old links: `/admin/slack?slack=…` from a server that is not updated yet, bookmarks, notices. Covered by the
  redirect, which keeps the query.
- Owner only: the Slack status is read only for the owner (the server refuses admins: tests/security). An admin's list
  must not call it or show the row.
- Phone: Slack's page opens under "‹ Team connected apps" like other connector pages; the phone list loses its Slack
  row.
- No migration. No API change.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun test` for `web/test/unit/slack-screens.test.tsx`,
`connectors.test.ts`, `back-stack.test.tsx`, the admin e2e specs that open Slack, the server's Slack route tests.

## Result

(filled in at the end)
