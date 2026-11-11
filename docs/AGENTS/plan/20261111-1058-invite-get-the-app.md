# Invite and team links on a phone without the app: "Get the app"

- Date (UTC): 2026-11-11 10:58
- Branch: `feat/invite-get-the-app`
- Status: done (PR open)
- Where: trina-ax core (`web/src/pages/Auth.tsx`, `web/src/lib/team-link.ts`, `server/src/routes/web-static.ts`,
  i18n, tests). Why: the join pages and the web app's HTML are core; the store addresses stay the edition's
  `APP_DOWNLOADS` (`editions/trina/branding/apps.json`), so a neutral build shows nothing new.
- Version impact: minor; a visible change on the join pages for phones, no API or data change

## Goal

A tapped invite link (`/invite/<token>`) or team link (`/join#t=`) opens the phone app when it is installed. Without the
app the phone lands on the web join form, and the owner asks: "If it isn't installed, shouldn't it open the App Store?"
Phone browsers now lead with getting the app; computers stay as they are.

## Scope

In:
- iPhone (web browser, not our app): Apple's Smart App Banner on the invite and join pages only
  (`<meta name="apple-itunes-app" content="app-id=…">`, the id from `APP_DOWNLOADS.iphone`), and one primary
  "Get the app" button to the App Store listing.
- Android (web browser): one primary "Get the app" button to `APP_DOWNLOADS.android`, else the download page
  (`APP_DOWNLOADS.page`: the APK is on updates.trina.app, linked from that page, never the .apk itself). The existing
  `intent://` "Open in the app" stays and gains `S.browser_fallback_url=<that page>`.
- Changed after the owner's answer (2026-11-11): the button is "Copy invite & get the app". On the person's tap it
  copies this page's invite or team link, shows "Link copied", then opens the store. The line under it: "After
  installing, paste the link in the app's first screen." (the first screen's box takes an invite link as it is). No
  copying on load; the app never reads the clipboard by itself. The form moves behind a text link "Continue in the
  browser" on these phones; "Already joined? Sign in" stays.
- Five languages, English first.

Out: silent deferred deep links (no clipboard read by the app, no fingerprinting), Google Play (when it is live: set `android` in
`editions/trina/branding/apps.json` and run `bun scripts/edition-apps.ts … --apply`; a TODO names it), iPad layout
beyond what iOS detection already gives, desktop browsers (unchanged), our own apps' web views (never shown).

## Steps

1. `web/src/lib/team-link.ts`: `getAppOffer(platform, client, links)` → `{ href, androidFallback } | null`; the
   intent link takes an optional fallback page.
2. `Auth.tsx`: a `GetTheApp` block on both join pages; the form behind "Continue in the browser" when it shows.
3. `server/src/routes/web-static.ts`: the banner meta on `/invite/*` and `/join` HTML only, with no `app-argument`
   (an invite's token is in its path; the team link's token is in the fragment, which the server never sees, and the
   page's address without it tells the app nothing).
4. i18n in en, ko, ja, es, id; unit tests (who sees what, token never in a store URL, banner or fallback);
   Playwright at 390 with an iPhone and an Android user agent; screenshots light and dark.
5. `changes/invite-get-the-app.md`, DECISIONS.md.

## Risks

- Token leaks: store links are fixed edition constants with no query from the page; the banner has no app-argument;
  `Referrer-Policy: same-origin` (header and `<meta name="referrer">`) already sends no referrer cross-origin, and the
  links add `rel="noreferrer"`. No analytics on these pages.
- Smart App Banners show only in Safari on iOS, not in a WKWebView, so our iPhone app never shows it; the server adds the meta only for an
  iPhone/iPad/iPod user agent (`Vary: User-Agent`), so computers get the same HTML as before.
- No migration, no permission change.

## Result

- iPhone browser: Smart App Banner (`app-id=6829192435`, no `app-argument`) on `/invite/*` and `/join`; the button copies
  the link and opens the App Store listing. Android browser: the button copies and opens ax.trina.app/download; "Open in
  the app" keeps the intent with `S.browser_fallback_url` = that page. Computers and our apps: unchanged.
- Tests: `web/test/unit/get-the-app.test.ts`, `tests/unit/app-links.test.ts` (banner), `web/test/e2e/get-the-app.spec.ts`
  (390, iPhone and Android user agents, clipboard, Referer), `first-run.spec.ts` updated.
