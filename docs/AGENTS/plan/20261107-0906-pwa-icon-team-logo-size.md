# The team logo is the installed app's icon only when it is square and at least 512 px

- Date (UTC): 2026-11-07 09:06
- Branch: `fix/pwa-icon-team-logo-size`
- Status: in progress
- Where: trina-ax core (`shared/src/team-icon.ts`, `server/src/routes/web-static.ts`, the web app's team settings).
  Why: the tab icon and the installed web app (PWA) are core features of every team server (see
  docs/REPOSITORY-RULES.md)
- Version impact: patch. A bug fix: a small team logo no longer replaces the sharp default app icon; no new setting,
  no API removed (one optional field in `GET /api/me`).

## Goal

An admin who installed the web app on a Mac saw a small icon in the Dock. An app installed before 11-06 keeps the old
icon (the mark at 0.56 of the square), but a fresh install is now worse when a team logo is set: the manifest's only
icon is the logo as uploaded, e.g. 100 × 100 with `purpose: any`. The Dock needs 256 px on a Retina screen, and Chrome
on macOS puts an icon that is not maskable small on a tile. So the logo becomes the app icon only when it is good enough
for it; otherwise installed apps and home screens keep the full-bleed default icons.

## Scope

In:
- One rule in `shared/src/team-icon.ts`: a logo is the app icon when it is square and at least 512 × 512 px.
- The manifest: the logo as its only icon (`purpose: any`, `/team-icon?v=<version>`) when it passes; else the built
  manifest unchanged (icon-192, icon-512, icon-maskable-512). Never a logo next to the default maskable icon (Chrome on
  macOS would take the maskable one and hide the logo).
- The apple-touch-icon link in index.html (server-written and switched by the web app after sign-in) and the
  well-known `/apple-touch-icon.png` addresses follow the same rule. The tab icon (`rel=icon`, `/favicon.ico`) stays the
  logo at any size.
- `GET /api/me` `team.appIcon: true` when the logo passes, so the open page and the settings preview know.
- Admin › Team settings: the hint recommends a 512 × 512 square and says a smaller or non-square logo shows only in tabs
  and the sidebar; the 180 px home-screen preview shows what a phone will really get. Five languages.
- Settings › Apps install pictures: the installed app's icon in them follows the same rule (added after review).
- The web client's mock server follows (it uses the real `serveWeb()`); e2e expectations updated.

Out: resizing or padding logos on the server (no image library, decided in "팀 로고"); native app icons; refreshing an
app someone already installed (browsers keep its icon until they re-read the manifest).

## Steps

1. Rule and constant in `shared/src/team-icon.ts` (`TEAM_ICON_APP_PX = 512` replaces the unused
   `TEAM_ICON_RECOMMENDED_PX = 180`); `iconLinks(version, appIcon)` and `manifestWithIcon` use it.
2. `routes/web-static.ts`: manifest and apple-touch-icon addresses by the rule.
3. `Me.team.appIcon` (shared schema, `auth/service.ts`, the mock server).
4. Web: `lib/team-icon.ts` / `store/session.ts` pass it; `TeamSettings.tsx` preview and hint; `InstallPictures.tsx`;
   i18n; the Korean team guide (`docs/guide/guide.html`) and the API reference summary.
5. Tests, CHANGELOG, DECISIONS "팀 로고" amendment.

## Risks

No migration. No permission change. The public `/team-icon` route is unchanged. Five languages for the hint. An older
web page with a newer server (or the reverse) only shows the default apple-touch-icon link until the next load.
A logo that passes is still `purpose: any`: Chrome on macOS draws such an icon inset on a tile, so it can still look
smaller in the Dock than the product's maskable icon. This change fixes the blur; padding a logo into a maskable icon
needs an image library (out of scope).

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`; `tests/unit/a-team-icon.test.ts`,
`tests/unit/d-web.test.ts`, `tests/unit/a-auth.test.ts`; `web/test/unit/team-icon.test.ts` and the web unit suite in
Docker; `web/test/e2e/team-icon.spec.ts`.

## Result

Filled in at the end.
