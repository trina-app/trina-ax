# <app> in Chrome: every browser profile connects with (almost) no effort

- Date (UTC): 2026-11-28 08:54
- Branch: `feat/chrome-profiles-easy`
- Status: done
- Where: `chrome-extension/`, `server/src/chrome/`, `shared/src/api/chrome.ts`, `shared/src/chrome-native.ts`, the web
  app (Settings › Browser, `/connect-chrome/*`), the desktop app (native host, External Extensions). Why: the same
  feature as [Trina in Chrome](20261128-0526-trina-in-chrome.md); Chrome installs and links per profile.
- Version impact: **minor**. New endpoints, a migration, new extension permissions and a new desktop setting; nothing
  that worked before changes.

## Goal

Owner feedback after #718: per profile the person installs the extension, signs in to the team in that profile,
presses Connect and types a name. Make it effortless:

- A. The name fills itself: the profile's Google account email (`chrome.identity.getProfileUserInfo`, permission
  `identity.email`), else "Chrome on Mac". Editable later in the popup and in Settings › Browser. The AI's profile list
  shows the name and the email.
- B. Connect without signing in to the team in every profile. First choice, when the desktop app runs on the same
  computer: the extension asks the app over Chrome native messaging and links with no click (owner 2026-11-28). The
  app shows a quiet notice "Chrome · contact@… 연결했어요" with Undo. Fallbacks for computers without the app: the
  in-profile sign-in Connect (as now) and a device code confirmed where the person is signed in (desktop app or
  another browser's team tab).
- C. Installing in every profile: the desktop app (setting, default on, "모든 크롬 프로필에 <app> in Chrome 넣기")
  tells Chrome, Edge and Brave about the store extension (External Extensions), so every profile gets Chrome's own
  "extension added" prompt; enabling it pairs through B. Settings › Browser also says plainly that each profile
  connects once and has "Add another profile" with the Web Store link and steps. A profile where Chrome Sync installed
  the extension shows "Connect to <team>" at once (the team address is kept in `chrome.storage.sync`, never the token).
- D. Chrome Web Store: register the developer account up to the payment step (owner pays), then upload the zip from
  dev and submit the listing (en + ko).

## Scope

In:
1. **A, auto name** (no dependency on B):
   - manifest `identity` + `identity.email` (Chrome shows "Know your email address" at install; worth it: the name is
     the one thing the person had to type, and the AI needs the account to pick the profile).
   - the popup's name field starts with the email (else "Chrome on Mac"); redeem sends `email` and `browser`; each
     connection's `auth` frame sends them again (a profile signed in to Chrome later gets its email).
   - `chrome_links.email`, `chrome_links.browser` (migration `465_b_chrome_link_email.sql`, additive).
   - rename from the popup (`{type:'label'}` frame) and from Settings (already); the server tells the extension a new
     name (`{type:'label'}` server frame; `hello` carries it).
   - Settings row: name, then "email · Chrome on Mac" under it. AI: each profile row names its account (not in a shared
     chat, as sites); `profile` may be the email.
2. **B, connect without signing in** (on hold until the architecture review):
   - native messaging: host `com.mycel.chrome_host` (`shared/src/chrome-native.ts`), allowed_origins = our store id and
     the fixed dev id only; the desktop app writes the host manifest for Chrome, Edge and Brave per OS user (macOS
     `~/Library/Application Support/<browser>/NativeMessagingHosts`, Windows HKCU registry, Linux `~/.config/<browser>/
     NativeMessagingHosts`). The host is the app's own executable with `--chrome-native-host` behind a small script
     (the app's fuses forbid run-as-node); it relays to the running app over a socket in the app's user data folder
     (mode 0600; a Windows named pipe for the user). The app asks the signed-in page on screen for a pair code
     (bridge `chromeLink.onPairRequest` → `POST /api/chrome/pair`); the extension spends it with its verifier (CORS for
     extension origins on the redeem: no host permission and no click needed). Undo = Disconnect; a revoked link is not
     paired again automatically (the extension remembers it until the person presses Connect).
   - device code fallback: `POST /api/chrome/device` (extension: challenge, name, email, browser → user code, 10 min),
     `/connect-chrome/code` in any signed-in place (type the code; the screen names the profile, email, browser, when and
     whether it came from the same network) → Connect / Cancel; the extension's own page polls, shows "Use this browser
     for <name> (@user) in <team>?" and only then spends the code (both phishing directions stop at a human check).
     Rate limits per address and per person, single use, a wrong code counts.
3. **C, install everywhere** (on hold until the architecture review): External Extensions files/keys per browser once
   the store id exists; setting off removes them; a person's uninstall in one profile sticks (Chrome's own rule).
   Settings › Browser "Add another profile" steps and the store link.
4. **D**: registration to the payment step now; listing, privacy practices (now incl. the email), permission
   justifications and screenshots after the owner pays and this PR is on dev.

Out: one extension install serving several teams (still one team per install; another team = Disconnect, Connect),
Firefox and Safari.

## Steps

1. Plan (this file), decision file `docs/decisions/20261128-chrome-profiles-connect.md`.
2. A: migration, store, routes/links frames, prompt, extension identity + popup rename, Settings row, i18n (6
   languages, extension and web), privacy practices.
3. After the review's verdict: B (native host + desktop, device code), C.
4. UX review (ui-polish/impeccable) of popup, Settings › Browser, `/connect-chrome/code`; independent security review of
   the diff by a fresh agent; fixes.
5. Tests: unit (store, routes, prompt, extension helpers, web views), security cases, e2e with two profiles.
6. One PR into dev, `bun run queue <PR> <head SHA>`, watch until merged. Then D's upload.

## Decisions

`docs/decisions/20261128-chrome-profiles-connect.md` (new). It changes "No typed code" of
[20261128-trina-in-chrome](../../decisions/20261128-trina-in-chrome.md): a device code is allowed as a fallback because
both sides now show who and what before anything links.

## Risks

- Migration 465 (464 is the highest b on dev).
- New install-time warning "Know your email address" (and "Communicate with cooperating native applications" for B).
- B lets a process of the same OS user ask the app for a link (it can already read that user's files); every
  automatic link shows the notice with Undo and is audited.
- Five web languages + six extension languages.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `tests/unit/chrome-*.test.ts`,
`tests/security/chrome-link.test.ts`, `web/test/unit/chrome-link.test.tsx`, web e2e `chrome-link.spec.ts`,
`tests/e2e/chrome-extension.test.ts` with two profiles, `bun run check:prepush`.

## Changed after review

The architecture review (2026-11-28, "GO WITH CHANGES") replaced A–C above: no `identity.email`, no device code, no
External Extensions. Built instead: app-led linking (decision
[20261128-chrome-app-led-linking](../../decisions/20261128-chrome-app-led-linking.md)): the desktop app lists the
profiles from each browser's Local State, opens a profile on the extension's pair page with a single-use nonce, a small
signed Swift helper relays nonce + PKCE challenge to the app over native messaging, the app asks the signed-in page for
a pair code, the extension redeems it. Names come from Local State; the account shows next to them. macOS only for the
helper; Windows and Linux fall back to the in-profile Connect.

## Test cases

Every state and exit of app-led linking; QA sheet rows TC-9187..TC-9210. Automated = run in CI or by the command in
the decision's Tests line; manual = run on the developer's Mac with throwaway Chromium profiles (screenshots in the
session's scratchpad `trina-chrome/tc/`).

| Key | QA | Steps | Expected | How |
|---|---|---|---|---|
| A01 | TC-9187 | Settings > Browser > On this computer > Connect on the profile | The profile opens on the extension's pair page, links with no click, the tab closes by itself; the row shows Connected; app shows the notice "Connected your Chrome on Mac profile \"X\"." with Undo | e2e (tests/e2e/chrome-app-link.test.ts) + manual |
| A02 | TC-9188 | Press Connect all | Both profiles link with zero clicks, each named from the browser's profile name, with its Google email shown | e2e + manual |
| A03 | TC-9189 | Press Connect all | All five link (five live pair codes at once, rate limit 10 per 15 min not hit) | unit (several live codes) + manual |
| A04 | TC-9190 | Settings > Browser: the row's button | Button reads "Install"; pressing it opens that profile on the Web Store page; after install, Connect links it | unit (view) + manual |
| A05 | TC-9191 | Open Settings > Browser | Edge and Brave profiles are listed with their own names; Edge store link for Edge | unit (Local State parsing) + manual where installed |
| A06 | TC-9192 | Create a new Chrome profile, come back to the app | The new profile appears in the list by itself (next read or window focus) | unit + manual |
| A07 | TC-9193 | Rename it in Settings > Browser (pencil) | The extension popup shows the new name at once | unit (server label frame) + manual |
| A08 | TC-9194 | Popup > Rename > Save | Settings > Browser shows the new name; offline rename says it could not rename | unit + manual |
| A09 | TC-9195 | Disconnect one in Settings | Only that link ends (its socket closes 4401); the other stays online | unit (existing) |
| A10 | TC-9196 | Press Undo on the notice | That link is disconnected; the row shows Connect again | web e2e (chrome-link.spec.ts) |
| A11 | TC-9197 | Open the pair page (or Connect from a stale window) | Pair page says the desktop app is not running and points to the in-profile Connect; the popup's Connect still works | unit (helper app_not_running) + manual |
| A12 | TC-9198 | Pair with it | Refused (bad_nonce); pair page says the link expired, press Connect again | unit |
| A13 | TC-9199 | Pair with it again | Refused (bad_nonce); no second code | unit |
| A14 | TC-9200 | Present it from profile B | Single use: only one link is made, named after profile A; limitation documented (the app cannot see which profile asks) | unit |
| A15 | TC-9201 | Send it to the app socket / helper | Refused; Chrome's allowed_origins also refuse other extensions | unit |
| A16 | TC-9202 | Try to connect to the app's socket | Cannot (socket 0600 in the user's own data folder) | unit (permission check) |
| A17 | TC-9203 | Settings > Browser | No "On this computer" list; how-to text, "Each browser profile connects once", Web Store link; in-profile Connect works | unit + web e2e + manual |
| A18 | TC-9204 | Switch team on screen, Connect a profile | The profile links to the team on screen | manual |
| A19 | TC-9205 | Connect a profile | Pair page says to open the team in the desktop app and sign in (no_team) | unit + manual |
| A20 | TC-9206 | Look at Settings > Browser, popup, pair page in both languages | Plain wording, no jargon, no mixed languages, notices match reality | manual (screenshots) |
| A21 | TC-9207 | View at 1440 px and 390 px width | No clipping or overflow; buttons aligned; dark and light | manual (screenshots) |
| A22 | TC-9208 | OPTIONS/POST /api/chrome/redeem from an extension origin, a web origin, another path | CORS only for extension origins on redeem, never with credentials | unit |
| A23 | TC-9209 | A turn in the person's Chrome | The AI's profile list names each profile's account (not in a shared chat); profile may be given by email | unit |
| A24 | TC-9210 | App asks the page for a pair code | Refused (403), page answers null, pair page says the team did not allow it | unit (existing guest check) + unit |

## Result

Built app-led linking (see "Changed after review"). Independent security review: 2 medium, 4 low, 3 info; fixed: the
nonce bound to the team on screen, the release helper checks that the socket's program is signed by our Developer ID
team and ignores the dev socket override, a profile's name is never its email (shared-chat prompts), UTF-16-safe name
cut, no control characters in names, Undo only for a link made in the last 5 minutes, no host manifest from a disk
image or translocated app. Open for the owner: finding 1 (a program of the same OS user can rewrite the per-user host
manifest and link a profile to its own server with no click; the cure is one click on the pair page for a new team
address; decision "Residual risk"). UX review: 4 P1 and 6 P2 fixed (one list per state, row layout, wording, no red
text for expected states, keep-all for Korean). Manual QA on this Mac (real desktop dev app, two local teams, up to 6
throwaway Chromium profiles): A01–A24 Pass (A22/A23 unit only, A16 modes only: no second OS user; Edge/Brave from
Local State fixtures). QA findings fixed: the manifests are written again at Connect, the "can't connect now" text
says to try again in a few minutes. Not done: Windows/Linux helper, the store ids (filled in after the store upload).

