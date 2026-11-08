# First run, phase 2: a tapped link opens the app (`trina-ax://`, universal links, app links) behind screen ④

- Date (UTC): 2026-11-08 10:25
- Branch: `feat/first-run-open-links` (on top of `feat/first-run-one-box`, PR 1)
- Status: done
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
6. **Web**: one line "앱에서 열기" on the invite and team-link join pages, built from the page's own link (the team
   link's token from memory: the page has already taken it out of the address bar), only where our own app receives
   the token (review must-fix): an `intent://…;package=app.trina.ax;end` link on Android, `trina-ax://open?url=…` on
   Mac and Windows, none on an iPhone (any app can claim a custom scheme there), never inside the apps or elsewhere.

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

- Apple: the Associated Domains capability on the App ID `app.trina.ax` (and a refreshed profile) before the next
  signed iOS build; then a new iOS build.
- `trina.app` itself serves the same `/.well-known/apple-app-site-association` and `assetlinks.json` (Android verifies
  a wildcard host at its root; for Apple, serve both).
- Google Play: the app signing certificate's SHA-256 in `assetlinks.json` and in `shared/src/app-links.ts`; a new Play
  build.
- A new Mac App Store build (signing blocked on certificates, known) and Microsoft Store package (identity pending).
- account.trina.app: the signup's last page shows the team address and "앱에서 열기".
- From phase 1: block `acme`, `trina`, `trina-ax` in the live relay registry and the signup's name list.

## Tests

`bun run typecheck`, `bun run typecheck:mobile`, `bun run check:i18n`, `bun run check:docs`, `bun run docs:api`; unit:
the link reader (every crafted case), the ④ gate in both apps, the protocol argv/open-url handling, the `.well-known`
routes, the build configs declaring the scheme; web unit + e2e for "앱에서 열기"; Docker web unit; full web e2e.

## Result

Built as planned. An independent review's findings were fixed before the PR: ④ counts its 600 ms from when it is on
screen (it reports itself), not from when the link arrived (a cold start could show it late); each link offer has an id
and the phone's ④ keeps its state per offer and drops a stale answer; a team view taking over drops a waiting link; a
relay rename found after the yes is asked again with the new host; a cut-off universal link says so; the address inside
a scheme link must be the address alone; a bad link never covers a waiting ④. Walked in the built desktop app
(links handed over as macOS does, `open-url`, and as a second instance's argv) and on the iPhone simulator with
`simctl`/Maestro links, light and dark. Associated domains and app links cannot be checked without the store setup
above. After the first PR review: "앱에서 열기" carries a token only where our own app receives it (above); links from
outside never point the desktop app at this machine; ④'s [연결] is greyed until it counts.
