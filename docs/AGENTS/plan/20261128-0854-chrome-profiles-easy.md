# <app> in Chrome: every browser profile connects with (almost) no effort

- Date (UTC): 2026-11-28 08:54
- Branch: `feat/chrome-profiles-easy`
- Status: in progress (A building; B and C wait for the architecture review the coordinator started)
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

## Result

(at the end)
