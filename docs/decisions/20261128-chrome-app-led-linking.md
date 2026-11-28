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
  user data (socket 0600: another OS user cannot connect). The app checks the origin again and the nonce, then asks
  the signed-in team page on its screen for a one-time pair code bound to the challenge (the same `POST /api/chrome/pair`
  as the in-profile Connect, with the page's own session). The extension spends it with its verifier (`POST
  /api/chrome/redeem`, answered cross-origin to extension origins only, never with cookies) and tells the app, which
  shows "Chrome profile 'Work' connected" with Undo (= Disconnect). No link token or session ever crosses the helper or
  the app; the server keeps only the token's sha256.
- **Rule, fallback:** the app not running (the helper answers `app_not_running`), no helper (Windows and Linux for now,
  a Flatpak or Snap browser, a policy that blocks native hosts), the app signed out or on its team list (`no_team`), a
  guest: the pair page says what to do and the in-profile Connect works as before. A person links up to 5 profiles at
  once (5 live codes; 10 codes per 15 minutes).
- **Why not the device code or chrome.identity:** the architecture review: a typed code stays phishable both ways
  (#718 review), and `identity.email` adds an install warning for a name the app can read from Local State.
- **Why not External Extensions (install in every profile):** dropped by the review: Chrome shows each as a disabled
  "another program added an extension" prompt, Linux has no per-user path, and the store page in each profile is one
  click anyway.
- **Residual risk:** a process of the same OS user can talk to the socket or start the helper; it still needs a live
  nonce, which is only in the browser's command line (visible to that user's `ps` for a moment). The app cannot see
  which profile presents a nonce (Chrome does not tell the helper); a nonce is spent once and names the profile it was
  minted for. Every link through the app shows the notice with Undo and is audited (`chrome.link`). The app cannot
  check the helper's signature by the socket's peer (Node has no peer pid, and any same-user process could run the
  signed helper itself).
- **Left out:** the Windows and Linux helper (Windows: HKCU registry; the list and the store page could work there
  first), one install serving several teams, the store ids (filled in once the Chrome Web Store and Edge Add-ons gave
  them; until then a packaged app writes no host manifest, and its list offers only the store page).
- **Tests:** `tests/unit/e-desktop-chrome-profiles.test.ts`, `tests/unit/e-desktop-chrome-pair.test.ts`,
  `tests/unit/chrome-link.test.ts` ("app-led linking"), `web/test/unit/chrome-link.test.tsx`,
  `web/test/e2e/chrome-link.spec.ts`, `tests/e2e/chrome-app-link.test.ts` (two Chromium profiles, real helper, zero
  clicks).
- **Version impact:** minor (a new way to link, a new extension permission `nativeMessaging`, a migration).
