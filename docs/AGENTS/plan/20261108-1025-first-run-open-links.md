# First run, phase 2: a tapped link opens the app (`trina-ax://`, universal links, app links) behind screen ④

- Date (UTC): 2026-11-08 10:25
- Branch: `feat/first-run-open-links` (on top of `feat/first-run-one-box`, PR 1)
- Status: in progress
- Where: trina-ax `shared/` (link reader, app ids), `desktop/` (protocol handler, store configs), `mobile/` (link
  handler, associated domains, app links), `server/` (`/.well-known` files), `web/` (join pages). Why: opening the
  team's link in the app is core; the store and domain setup outside the repository is listed below (see
  docs/REPOSITORY-RULES.md)
- Version impact: minor (a new link scheme in both apps, two public files on every team server, one web line)

## Goal

Phase 1 made the apps take a pasted link. Phase 2 lets a tapped link open the app: a team link or invite link on a
phone opens the phone app (universal link / app link on `*.trina.app`, or "앱에서 열기"), and "앱에서 열기" on a computer
opens the desktop app. Every link from outside goes through screen ④ before anything loads:
"{host}에 연결할까요? 직접 받은 링크가 맞을 때만 연결하세요." (plus "트리나가 운영하는 주소가 아니에요…" outside
`*.trina.app`) [취소] [연결].

## Scope

In:
1. **One link reader** in `shared/src/team-link.ts` (the phone's copy stays identical): `trina-ax://open?url=<encoded
   https URL>` and, on the phone, an `https://<name>.<teamDomain>/invite/<t>` or `/join#t=<t>` universal / app link.
   The inner URL goes through the phase-1 rules (https only; http only to this machine on the desktop; no
   user:password; no `javascript:`, `file:`, `data:`; one `url`, nothing else; ASCII hosts as the URL parser gives them,
   so an IP-literal trick such as `https://0x7f.1` shows as `127.0.0.1`). The scheme is `PRODUCT.linkScheme`
   (`trina-ax`, the scheme `editions/trina/branding/mobile.json` already declares; a test keeps them equal).
2. **Screen ④** in both apps for every outside link, with the canonical host, the outside note when it applies, and on
   the phone the switch line when another team is connected ("이제 {old} 알림은 이 휴대폰으로 오지 않아요." and
   [바꾸기]). Nothing is fetched or loaded before [연결]; [연결] runs the phase-1 path (health check, relay answers,
   then the link's page). [취소] returns to where the person was.
3. **Desktop**: `app.setAsDefaultProtocolClient` (packaged builds; development only with
   `MYCEL_DESKTOP_REGISTER_SCHEME=1`), `open-url` on macOS (registered before `ready`, a link that launches the app is
   kept until the window exists), the second instance's argv on Windows and Linux, and the first instance's argv. The
   scheme is declared in the base electron-builder config (`protocols`: the dmg's and Mac App Store's
   `CFBundleURLTypes`, the MSIX manifest's `windows.protocol` extension through the template's `${extensions}`).
4. **Phone**: `Linking.getInitialURL()` and the `url` event; the `trina-ax` scheme (already registered by `scheme`);
   iOS `associatedDomains: applinks:*.trina.app`; Android intent filters with `autoVerify` for `https://*.trina.app`
   `/invite/…` and `/join`.
5. **Team server**: `GET /.well-known/apple-app-site-association` (`applinks` details for `/invite/*` and `/join`,
   the app id `<appleTeamId>.<bundleId>` from the branding) and `GET /.well-known/assetlinks.json` (the package and
   the Play signing certificate's SHA-256; the file answers 404 until the fingerprint is known), JSON, no redirect, no
   cookie needed. Self-hosted servers serve them too (harmless); universal links cannot cover their domains, so for
   them "앱에서 열기" is the path (documented).
6. **Web**: one line "앱에서 열기" on the invite and team-link join pages, a `trina-ax://open?url=…` link built from
   the page's own address (the team link's token from memory: the page has already taken it out of the address bar),
   shown on iPhone, Android, Mac and Windows browsers, never inside the apps themselves or on other systems.

Out: deferred deep links (install, then open), opening a room or a chat from a link, links for self-hosted domains
other than the custom scheme.

## Steps

1. Plan (this file). 2. Link reader + tests (crafted links). 3. Desktop handler, ④, configs, tests. 4. Phone handler,
④, config, tests. 5. Server `.well-known` routes + tests. 6. Web line + unit and e2e tests. 7. DECISIONS, CHANGELOG,
docs. 8. Checks, screenshots, the walk.

## Risks

- **Phishing**: a link can name any server. ④ always shows the host the app will connect to (canonical, punycode),
  says when it is not run by Trina, and loads nothing before [연결]. On Android another app can claim the custom
  scheme; verified app links on `*.trina.app` do not have that problem.
- **Store review**: no new purchase links. The associated domains entitlement needs the App ID capability (outside).
- **Universal links in KakaoTalk's in-app browser**: untested; "앱에서 열기" and pasting stay.

## Outside this repository

(filled in with the PR)

## Tests

`bun run typecheck`, `bun run typecheck:mobile`, `bun run check:i18n`, `bun run check:docs`, `bun run docs:api`; unit:
the link reader (every crafted case), the ④ gate in both apps, the protocol argv/open-url handling, the `.well-known`
routes, the build configs declaring the scheme; web unit + e2e for "앱에서 열기"; Docker web unit; full web e2e.

## Result

(filled in at the end)
