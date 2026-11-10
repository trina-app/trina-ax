# Settings › Apps lists every app: phone and computer

- Date (UTC): 2026-11-10 08:59
- Branch: `feat/settings-apps-all`
- Status: in progress
- Where: trina-ax core (web Settings › Apps, shared module, edition script) and `editions/trina/branding/apps.json`.
  Why: the page is core UI; the store and download addresses are the Trina edition's (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a settings page shows more links; no server, API or data change

## Goal

Settings › Apps shows only the team address and one "Desktop app" paragraph in the Mac App Store build. The owner wants
every app there with a way to get it, as the website's download page has: iPhone, Android, Mac and Windows.

## Scope

In:
- `editions/trina/branding/apps.json`: the download page, the App Store listing (iPhone, Mac), Google Play and Microsoft
  Store (empty: not live yet). `scripts/edition-apps.ts` writes them into `shared/src/app-downloads.ts`
  (`APP_DOWNLOADS`), like `edition-service.ts`. An edition without them shows only what it has.
- Settings › Apps: team address on top; "Phone app" (iPhone and Android rows; on a computer one small QR code of the
  download page; on a phone only that phone's row; in the phone app one "This app" row); "Desktop app" (Mac and Windows
  rows: the team server's installer, else the store listing, else the download page; "This app" with how it updates in
  the desktop app; the existing store-build line stays); the install-as-an-app guide moves under them.
- Five languages, unit tests, the Apps e2e at 1440 and 390.

Out: a "latest" APK address on the feed, a Google Play link (not live), store badges as images, any server change.

## Steps

1. Plan (this file).
2. Branding file, edition script, shared module, test.
3. `web/src/lib/apps.ts` (which rows, which action) and `components/settings/AppList.tsx`; Settings.tsx uses them.
4. i18n in ko, en, id, ja, es; unit and e2e tests; CHANGELOG, DECISIONS.

## Risks

No migration. App Store guideline 2.3.10 (no other mobile platform's name in an Apple app): the Mac App Store build
shows no Android row (its QR code still leads to the page that has it); the iPhone app shows only "This app" for phones.
A store build still offers no installer file (guideline 2.4.5, Microsoft Store 10.2.4): the other computer's row links
to the download page, a web page.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `tests/unit/edition-*.test.ts`, `bun run test:web`,
`bun run build:web`, the settings e2e specs (apps-install, first-run, settings-ia, account-settings).

## Result

Filled in at the end.
