# Activity tabs stay put; an own app's refused secret is said in plain words

- Date (UTC): 2026-11-11 06:56
- Branch: `fix/activity-tabs-oauth-errors`
- Status: in progress
- Where: trina-ax core (`web/src/pages/Activity.tsx`; `server/src/integrations/connections/service.ts`, `text.ts`,
  `server/src/routes/integrations.ts`; `web/src/components/integrations/IntegrationRow.tsx`; i18n; tests)
- Version impact: patch; no API shape change (a flow's `reason` gains the code `client`), no data change

## Goal

1. Activity: switching to Mentions no longer moves the page sideways, and a tab's focus ring is shown whole.
2. TC-020 (QA fail): signing in with an own OAuth app whose Client ID or Secret the service refuses says so in plain
   words, on the connection's row and on the sign-in window's page, instead of the raw word "exchange" and "sign in to
   the same team account". Other failed sign-ins get plain words too; raw reason codes are never shown.
3. After a sign-in that worked, the row shows the connection's real state (connected) without a reload.

## Causes (to confirm)

- Mentions moves the page: the page's scroll box (`Activity.tsx`, `overflow-y-auto`) has a classic scroll bar where the
  system shows one (Windows, a Mac with a mouse). A short tab (Mentions) has none, so the centered column moves by half
  the bar. Fix: `scrollbar-gutter: stable`. The selected tab is also bold and wider, which nudges the tabs after it by a
  pixel: reserve the bold width.
- Focus ring cut: the tab list scrolls sideways (`overflow-x-auto`), which clips the outline drawn 2px outside the tab.
  Fix: an inset ring (`focus-visible:-outline-offset-2`, the repo's way for items in a clipped box); `:focus-visible`
  only, as everywhere (index.css).
- "exchange": `service.ts` callback stores every failed token exchange as `exchange`; the row prints `flow.reason`
  raw; the callback page always says "sign in to the same team account".
- Row says sign-in needed: the flow is marked `completed` before the connection check after it ends, so the row's
  reload reads `needs_auth`.

## Steps

1. Activity: gutter, bold-width reserve, inset focus ring. Web unit test of the classes; Playwright at 1440/390 with
   scroll bars that take room: the tab list, the tools and every tab start at the same x on every tab.
2. Server: `invalid_client` / `unauthorized_client` from an own app's token address -> reason `client`; the callback
   returns the reason and its page says it in plain words (never the secret, never the service's answer). The flow is
   `completed` only after the check.
3. Web: a flow's reason code in words (`integrations.signIn.reason.*`); unknown codes -> the plain "could not sign in".
4. Tests: server (fake token address answering `invalid_client`; the flow completes after the row is connected), web
   (reason words, never the raw code).
5. en.ts first, then ko/id/ja/es. `changes/activity-tabs-oauth-errors.md`. Checks: typecheck, i18n, docs, touched tests.

Out: Activity's links' tooltips (PR #368), other sign-in flows (Google Drive, Slack).
