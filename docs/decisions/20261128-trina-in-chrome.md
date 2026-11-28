# The AI's browser can run in the person's own Chrome, through an extension linked to the team server

- Date: 2026-11-28
- Status: accepted
- Supersedes: none (adds a second place for the browser tools of [one site Always per person](20261125-one-site-always-desktop-browser.md); the desktop browser's rules stay)
- Branch: feat/trina-in-chrome (the owner, 2026-11-28: "빠르게 … 바로 기획 검수하고 개발하자"; plan
  [20261128-0526-trina-in-chrome](../AGENTS/plan/20261128-0526-trina-in-chrome.md))

- **Ask:** the AI's browser exists only in the desktop app. People on the web and hosted teams (the AI runs on a server)
  have none. Build our own "in Chrome" like Claude in Chrome, for every install type, with Claude Code / Claude in
  Chrome as the floor for tools and safety.
- **Rule, one browser, two places:** the AI sees the same browser tools (`shared/src/browser-tools.ts`). A turn's calls
  go either to the desktop window that sent it (as before) or to a Chrome the person linked. The person picks in the
  desktop app (Settings › Browser: this app or my Chrome, default this app); on the web, a linked Chrome that is online
  is used. A phone, a scheduled run, a guest and a restricted chat never use one.
- **Rule, the link:** the extension talks to the team server only (HTTPS and one WebSocket), so it works for hosted
  teams too; no native host, no relay of our own.
  - Pairing, signed in in that Chrome only: the popup opens `<team>/connect-chrome?challenge=<sha256(verifier)>`; the
    signed-in team page asks Connect / Cancel and puts a one-time code in the address **fragment** of
    `/connect-chrome/done`, which the extension reads from its own tab and redeems with its secret verifier (PKCE). A
    phishing link only makes a code in the victim's own tab, and a copied code is useless without the verifier.
  - No typed code: a code someone else made would link a Chrome to the wrong account either way (review).
  - One Chrome per person and one team per extension; a new link replaces the earlier one.
  - A link token (32 random bytes, sha256 only on the server) in `chrome.storage.local`, sent in the WebSocket's first
    frame (never a header or the address). The WebSocket `/api/chrome/ws` carries only browser calls and results; it
    is not a hub window (no chat, file or presence event; the person does not look online; it does not hold back
    notifications); a result counts only from the connection its call went to.
  - Revoked by Disconnect (Settings or the popup), the person's sessions all ending (sign out everywhere, password
    change, disabled, deleted) and 30 days unused; the socket closes at once.
- **Rule, who drives:** only the person who linked that Chrome, in their own turns. A desktop-app turn uses it only
  when the person turned on "Use my Chrome" (Settings › Browser). In a shared chat the browser's
  notice once per place and the change card where others wrote apply as for the desktop browser (#647, #662).
- **Rule, tabs:** the AI uses its own tab group; it reads and acts only on tabs in that group (those it opened and tabs
  the person drags in).
- **Rule, sites (Rule A):** the person's one Always per site holds (`user_allowed_sites`). The extension has no card:
  a call on a site nobody allowed comes back `site_needed`, the server shows the existing `browser_site` card in the
  chat, keeps an Always, and sends the call again. Hard blocks the extension applies whatever the server says (this
  browser has the person's real cookies, unlike the desktop pane's own session): every address of the team (requests
  to it from a driven tab are cancelled too), account-security and password pages, browser and extension pages,
  non-web schemes, this computer, and office addresses (also a page served from a private address) without the office
  card. It runs a fixed list of CDP methods and never reads cookies or storage.
- **Rule, safety:** the desktop browser's (no passwords or payment details typed, ask before buying, sending or
  deleting, the key guard, page content is data, addresses in scripts checked, a script's tab cannot send to sites not
  allowed). Visible: the extension badge, the group's title, Chrome's own debugging bar. Stop: the chat, the popup,
  or closing the debugging bar.
- **Why not a native host:** hosted teams' AI runs on a server with no way into the person's computer; an extension
  that connects out to the team works everywhere a page of the team works.
- **Why not reuse the person's team session in the extension:** a session token can do everything the person can; the
  link token can only receive browser calls and fetch file_upload tickets.
- **Not taken from the review:** a confirm card for buying, sending or deleting on an allowed site (the desktop browser
  has none; Rule A; the prompt rule and the refusal of payment fields stay).
- **Left out:** an e-mail when a Chrome is linked, the Web Store listing itself (needs the owner's $5 developer account), a phone driving Chrome,
  scheduled runs, the long-poll fallback, a chat side panel, Firefox and Safari.
- **Tests:** `tests/unit/chrome-*.test.ts`, `tests/security/chrome-link.test.ts`, `tests/e2e/chrome-extension.spec.ts`.
- **Version impact:** minor (a new client and endpoints, a migration).
