# The team logo shows only inside the page; the tab and app icons stay the product's

- Date (UTC): 2026-11-07 10:45
- Branch: `fix/tab-icon-stays-product`
- Status: done
- Where: trina-ax core (`shared/src/team-icon.ts`, `server/src/routes/web-static.ts`, the web app's team settings and
  install pictures). Why: the team logo and the app's icons are core features of every team server (see
  docs/REPOSITORY-RULES.md)
- Version impact: minor. A visible change: the browser tab, bookmarks and the installed app no longer take the team
  logo. No released API goes away (`Me.team.appIcon` was added after the last release and was optional).

## Goal

The owner (2026-11-07): changing the team logo should change the page's top-left, but not the favicon. New rule: the
team logo shows only inside the page, in the computer's sidebar header (and its preview in Admin › Team settings).
Everywhere the browser or the system shows the app's icon (the tab, `/favicon.ico`, bookmarks, the home-screen icon,
the installed app's manifest) it is always the product's icon. Native apps already keep the product's icon.

## Scope

In:
- Server: index.html is served as built (no icon links rewritten); `/favicon.ico`, `/apple-touch-icon.png`,
  `/apple-touch-icon-precomposed.png` and `/manifest.webmanifest` are the build's files even with a logo set. Kept:
  the public `GET /team-icon` (the sidebar's image), the upload checks, `PUT` / `DELETE /api/admin/team-icon`, the audit
  entries and the realtime `team_icon_changed` notice (the sidebar follows it through `/api/me`).
- Shared: remove what is dead: `iconLinks`, `iconLinksHtml`, `withIconLinks`, the `<!-- icons -->` markers,
  `IconLink`, `isAppIcon`, `TEAM_ICON_APP_PX`, `manifestWithIcon`, `DEFAULT_APPLE_TOUCH_ICON`, `Me.team.appIcon`.
- Web: remove `applyTeamIcon` / `nextIconLinks` and the call in `store/session.ts` (keep `checkIconFile`). Admin › Team
  settings previews only the sidebar header, light and dark, instead of the tab / home-screen sizes. Settings › Apps
  install pictures show the product's icon for the tab, the page and the installed app.
- Text in five languages: the logo row says it shows at the top-left of the sidebar and that the browser tab and the
  home-screen icon stay the {product} icon; keys that become unused go.
- Docs: DECISIONS entry (dated amendment, history kept), CHANGELOG Unreleased, the Korean guide, the API summary and
  the generated API reference.
- Tests: server unit, web unit, e2e, a11y audit, security cases, with assertions for the new rule.

Out: the phone drawer (keeps the product's mark, unchanged); native app icons; the sign-in page (it has no logo of its
own; it showed the logo only through the tab icon).

## Steps

1. Shared: delete the link and app-icon helpers; drop `appIcon` from `Me`; API summary.
2. Server: `web-static.ts` serves index.html, the well-known icons and the manifest as built; `teamIconOfMe` returns
   the version only; comments in `web.ts`, `admin.ts`.
3. Web: delete `applyTeamIcon`; `TeamSettings.tsx` sidebar preview; `InstallPictures.tsx` product icon; mock server.
4. i18n (5 languages), `bun run check:i18n`.
5. Tests and docs; regenerate the API reference if `check:docs` asks.
6. Checks, screenshots, Result.

## Risks

No migration, no permission change. An open page from before this change still swaps its own tab icon to the logo
until it reloads (its code reads `iconVersion`, which stays; `appIcon` was optional, so its absence means "no app
icon"). Browsers cache tab icons: a browser that saw the logo as the tab icon may keep it until it reads the page again.
An app installed with the logo as its icon keeps it until the browser re-reads the manifest (remove and install again
to see the product's icon at once). Five languages for the row's text.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`; `tests/unit/a-team-icon.test.ts`,
`tests/unit/a-auth.test.ts`, `tests/unit/d-web.test.ts`, the security matrix for the team-icon cases;
`bun run test:web`; `bun run build:web`; the full web e2e (with `web/test/e2e/team-icon.spec.ts` and the a11y audit).

## Result

Built as planned on `fix/tab-icon-stays-product` (PR link added when it is opened). Differences from the plan:

- `teamIcon.sizeTab` and `teamIcon.sizeHome` were removed; `desc`, `hint` and `removeBody` were rewritten in all five
  languages (the hint now says a non-square logo is cropped from its middle, as the sidebar draws it). The preview
  keeps "Show previews": two sidebar headers side by side, light and dark.
- index.html keeps one comment in place of the `<!-- icons -->` markers.
- The security case checks the tab and app icon addresses only when a web build exists (no CI job runs that suite;
  without a build the dev-mode instance answers every address with the same placeholder page); it warns and skips
  otherwise.
- After review: the CHANGELOG and DECISIONS say what released versions did (a logo of any size was the tab,
  home-screen and installed app's icon; the 512 px rule reached dev only), and docs/DESIGN-SYSTEM.md states the new
  rule.

Checks on this branch (macOS, bun 1.4.4, native built):

- `bun run typecheck`: pass. `bun run check:i18n`: 0 issues. `bun run check:docs`: pass (API reference regenerated).
- `tests/unit/a-team-icon.test.ts`, `a-auth.test.ts`, `d-web.test.ts`, `product-name.test.ts`: 70 pass, 0 fail
  (a-team-icon alone after review: 22 pass). `tests/unit/i18n-languages.test.ts`: 12 pass locally.
- `tests/security/permission-matrix.test.ts`: 2187 pass, 3 fail; the same 3 fail on a clean `origin/dev` (route
  coverage, `driveShareFolders` as owner and admin). The new icon check fails on a build whose index.html links
  `/team-icon` and skips with a warning without a build.
- `bun run test:web`: 1624 pass, 1 fail, 2 errors; clean `origin/dev` gives the same fail and errors (an unhandled
  error between tests reported at `download-only-actions.test.ts`; the file passes alone).
- `bun run build:web`: pass.
- Full web e2e (chromium): 757 passed, 12 failed, 9 skipped. The 12 are the known dev failures (a11y.spec.ts
  "team skills" light and dark, :403 on dev and :405 here, two lines moved; auth.spec.ts:165/:297/:359,
  offline.spec.ts:84, rankings.spec.ts:23, source-code.spec.ts:20/:65, states.spec.ts:164,
  upload-progress.spec.ts:181/:330). `team-icon.spec.ts` and the team logo a11y audits pass.
