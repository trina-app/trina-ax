# A simple connector page, and Connect in the desktop app goes to Google at once

- Date (UTC): 2026-11-12 04:24
- Branch: `feat/connector-detail-simple`
- Status: done
- Where: `web/` (the Connectors pages and the Google sign-in flow). Why: both are the web app's own screens and code
  (see docs/REPOSITORY-RULES.md).
- Version impact: patch. A fix in the desktop app's Connect and a lighter page; no API, setting or data change.

## Goal

1. In the desktop (Mac) app, Connect on Google Drive or a Google app (Gmail, Calendar, Docs, Sheets) only showed
   "Waiting for Google… Continue with Google", and the person had to click the link. The page reserves a blank window
   during the click; the desktop app opens only http(s) addresses (in the system browser) and refuses a blank window,
   so nothing opened. Now the desktop app reserves nothing and opens Google's checked address once the server answers.
   The browser and the phone app keep what they do today; "Continue with Google" stays as the fallback.
2. A connector's page (Google Drive, Gmail, Calendar, Docs, Sheets) is simple, like Claude's connector page: the
   header with its one action and ⋯, the sign-in line under it, the About text, one line on what the AI may do, the
   tools as chips, and a small details block. Fewer boxes, the same facts.

## Scope

In:
- `useSignInFlow` (Drive and the Google apps) and the Drive team-share sign-in (`DriveShares.tsx`): in the desktop app
  no `about:blank` window; `window.open(url, '_blank')` with the checked `driveSignInUrl(...)` address once known.
  Small helpers in `web/src/lib/driveSignIn.ts`, unit tested.
- `AppDetail.tsx` laid out as:
  `Connectors › Google Drive` / logo, name, "By Trina AX · line" with [✓ Connected] [⋯] on the right / the sign-in
  line / About text (no heading) / one muted line on what the AI may do / "Tools" with every tool as a chip (a chip
  that changes things keeps its marker, the description as its tooltip) / details: Made by, Category, Sign-in, Privacy
  (and Terms) as a two-column block with small uppercase labels.
- Google apps' header: the one status or action (Connected ✓, Connect, Reconnect) and ⋯; Settings (ask first or
  Always allow) moves into ⋯.

What gets removed:
- The "Try asking" box (three examples) and its `examples` / `onExample` props.
- "Try in chat" on the connector pages (the approved header has only the status and ⋯). The example texts
  (`gapps.*.ex1-3`) and the page's start-a-chat helper go with them; examples elsewhere (the chat start screen) stay.
- The "What the AI can do" card, the "Information" table and "Show all tools / Hide tools".
- i18n keys no longer used, in all five language files.

Out: the listed MCP services' page (`ConnectorDetail`), which keeps its own layout.

## Plain words

Labels a non-developer reads: "Made by", "Category", "Sign-in", "Privacy", "Terms", "Tools", "Read only. It never
changes, moves or sends anything." No internal names: tool chips show the tool's plain title, not its code name.

## Steps

1. Plan (this file).
2. Sign-in helpers + `useSignInFlow` + `DriveShares.tsx`; unit tests.
3. `AppDetail.tsx` and its two callers (`pages/Connectors.tsx` Drive page, `GoogleAppConnector.tsx`); i18n keys.
4. Unit and e2e tests updated (connectors-page, google-apps, drive).
5. Screenshots at 1440 and 390, light and dark; changes fragment.

## Risks

- No migration. Phone layout: chips and the details block must wrap at 390 wide.
- The desktop window-open handler denies every window and returns null, so the page cannot tell whether the browser
  opened; "Continue with Google" stays visible as the fallback.
- e2e specs that used Try in chat, the examples or the tools toggle are updated.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, web unit tests for the touched files, and the
Playwright specs for connectors, Google apps and Drive.

## Result

- Desktop: `reserveSignInWindow` / `openSignInWindow` / `signInPlace` in `web/src/lib/driveSignIn.ts`, used by
  `useSignInFlow` and the Drive share sign-in. Unit tests for the helpers and a ConnectCard test in the desktop app.
- `AppDetail.tsx` as planned. The details block shows Privacy with the provider's name and Terms next to it. Tool
  chips show the plain tool title (not the code name); a chip that changes things has a pen marker; the description
  shows as the shared tooltip (`Tooltip`, the repo's icon-tooltip check refuses a native `title`).
- Google apps: Connected ✓ and ⋯; Settings is the first item of ⋯ while connected.
- Removed i18n keys (all five languages): `gapps.tryTitle`, `about`, `canDo`, `readOnly`, `readChange`, `info`,
  `privacyLink`, `termsLink`, `showTools`, `hideTools`, `tryInChat`, and `gapps.<app>.ex1-3`. New: `gapps.tools`,
  `gapps.signIn`. Changed wording: `gapps.readOnlyLine`, `developer` (Made by), `privacy`, `terms`.
- docs/GOOGLE-APPS.md "What members see" updated.
- Follow-up (review): the same desktop fix for every other service's sign-in (`IntegrationRow.tsx` `reserveSignInWindow`
  and `useSignIn`, used by the connector pages, the chat's connect card, the add/answer dialogs and the welcome steps),
  with a unit test. About texts no longer repeat the line under them: Drive's page has its own `gapps.drive.about`
  without the read-only sentence (Admin › Connectors keeps `connectors.drive.about`), and the four Google apps' About
  lost the "asks you first, unless Always allow" sentence, in all five languages.
