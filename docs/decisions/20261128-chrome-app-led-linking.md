# The desktop app links the browser profiles of its computer, through a native helper used only to pair

- Date: 2026-11-28
- Status: accepted
- Supersedes: "no native host" in [20261128-trina-in-chrome](20261128-trina-in-chrome.md) ("Rule, the link"; the
  browser calls themselves still go over the team's WebSocket only)
- Branch: feat/chrome-profiles-easy (the owner, 2026-11-28: per profile install, sign in, Connect and type a name is
  too much; architecture review "GO WITH CHANGES": app-led linking; plan
  [20261128-0854-chrome-profiles-easy](../AGENTS/plan/20261128-0854-chrome-profiles-easy.md))

- **Ask:** Chrome installs and links the extension per profile. Linking every profile should take no sign-in in that
  profile, no code and no typed name, when the desktop app is on the same computer.
- **Rule, the list:** the desktop app reads each browser's own `Local State` (Chrome, Edge, Brave; `profile.info_cache`:
  folder, name, Google account) and Settings › Browser › "On this computer" lists every profile with Connect, and
  Connect all. A profile without the extension shows "Add to Chrome" (Edge: its store), which opens that profile on the
  store page. New profiles show up by themselves. A profile is named after the browser's own name for it, its account
  when that name is one the browser made up ("Person 1"); the account shows next to it, in Settings and to the AI.
- **Rule, pairing:** Connect opens that profile (`--profile-directory`) on the extension's own page
  `pair.html#nonce=<nonce>`; the nonce is 32 random bytes the app minted for that profile, single use, 2 minutes. The
  page makes its PKCE pair and hands nonce and challenge to the app's native helper (`com.mycel.chrome_host`), which
  Chrome starts only for the extension ids in its manifest (`allowed_origins`, no wildcard: the store ids; the public
  dev id only in a development run). The helper is a small signed Swift program in the app bundle (the app's fuses
  forbid running Electron as Node); it passes one line to the running app over a socket in a 0700 folder of the app's
  user data (socket 0600: another OS user cannot connect). Amended 2026-11-28 (manual QA, A): that folder only when the
  app runs from its default data folder (the path the release helper knows); any other user data folder (a development
  run, a test) gets `<this user's DARWIN_USER_TEMP_DIR>/mycel-chrome/<12 hex of its sha256>.sock`, short whatever the
  folder's length (a long path made no socket and no host manifest, silently), named to the helper by the start script.
  When nothing could answer a pair page, Connect answers `unavailable` (Settings says so; the app's log says why) and
  opens nothing. The app checks the origin again and the nonce, then asks
  the signed-in team page on its screen for a one-time pair code bound to the challenge (the same `POST /api/chrome/pair`
  as the in-profile Connect, with the page's own session). The extension spends it with its verifier (`POST
  /api/chrome/redeem`, answered cross-origin to extension origins only, never with cookies) and tells the app, which
  shows "Chrome profile 'Work' connected" with Undo (= Disconnect). No link token or session ever crosses the helper or
  the app; the server keeps only the token's sha256.
- **Rule, fallback:** the app not running (the helper answers `app_not_running`; `no_answer` when the app took the
  line but answered nothing in time), Chrome finding no helper or refusing our id (the pair page reads Chrome's own
  error: "cannot find the desktop app" / "does not accept this copy"), no helper (Windows and Linux for now,
  a Flatpak or Snap browser, a policy that blocks native hosts), the app signed out or on its team list (`no_team`), a
  guest: the pair page says what to do and the in-profile Connect works as before. A person links up to 5 profiles at
  once (5 live codes; 10 codes per 15 minutes).
- **Why not the device code or chrome.identity:** the architecture review: a typed code stays phishable both ways
  (#718 review), and `identity.email` adds an install warning for a name the app can read from Local State.
- **Why not External Extensions (install in every profile):** dropped by the review: Chrome shows each as a disabled
  "another program added an extension" prompt, Linux has no per-user path, and the store page in each profile is one
  click anyway.
- **Rule, checks on the way:** the nonce is also bound to the team on the app's screen when it opened the profile (a
  team switch in between: `no_team`, Connect again). A release helper (built with the Developer ID team) talks only to
  a socket served by a program signed by that team (the socket's peer pid, Security framework) and ignores the
  development socket override, so a program of this user that takes the socket's place gets nothing to answer. A
  profile is named after the browser's own profile name, never its email (the email shows next to it where only the
  person sees it, never in a shared chat's prompt).
- **Residual risk (security review finding 1, open for the owner):** a program running as the same OS user can rewrite
  the per-user host manifest to point at its own program, open the pair page itself and answer with a server of its
  own: the extension then links to that server with no click and its debugger permission drives that profile's tabs.
  The extension cannot tell the real app from such a program (the manifest folder is the user's). The pair page shows
  the team's name and address when it linked, and every link shows in Settings with Disconnect. The cure is one click
  in the pair page ("Connect to <team> (<address>)") for a team address the profile has not used before; it was not
  taken, because the owner asked for no click (Rule A). A program of the same user can already read that user's
  files; what it gains here is a lasting hold on a signed-in browser profile.
- **Residual risk, smaller:** the nonce is in the browser's command line for a moment (`ps`, this user only); the app
  cannot see which profile presents a nonce (Chrome does not tell the helper); a nonce is spent once and names the
  profile it was minted for. Every link through the app shows the notice with Undo (only for a link of this person
  made in the last 5 minutes) and is audited (`chrome.link`).
- **Left out:** the Windows and Linux helper (Windows: HKCU registry; the list and the store page could work there
  first), one install serving several teams, the store ids (filled in once the Chrome Web Store and Edge Add-ons gave
  them; until then a packaged app writes no host manifest, and its list offers only the store page).
- **Tests:** `tests/unit/e-desktop-chrome-profiles.test.ts`, `tests/unit/e-desktop-chrome-pair.test.ts`,
  `tests/unit/chrome-link.test.ts` ("app-led linking"), `web/test/unit/chrome-link.test.tsx`,
  `web/test/e2e/chrome-link.spec.ts`, `tests/e2e/chrome-app-link.test.ts` (two Chromium profiles, real helper, zero
  clicks), `tests/e2e/chrome-app-link-real.test.ts` (the real Google Chrome, a user data path past the socket limit,
  and the pair page's reasons).
- **Version impact:** minor (a new way to link, a new extension permission `nativeMessaging`, a migration).
