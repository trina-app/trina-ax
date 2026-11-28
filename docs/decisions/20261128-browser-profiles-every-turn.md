# Every turn of a person gets their linked browser profiles; in the desktop app its own browser is one more

- Date: 2026-11-28
- Status: accepted
- Supersedes: "the desktop app when the person chose it (Settings › Browser: this app or my Chrome, default this app)"
  in [20261128-trina-in-chrome](20261128-trina-in-chrome.md)
- Branch: fix/chrome-profiles-every-turn (the owner, 0.21.0 on potenlab: the extension said "Potenlab에 dion(으)로
  연결됨 · 온라인", yet in the desktop app the AI said no Trina in Chrome was connected and used Gmail and Aside; plan
  [20261128-1854-chrome-profiles-every-turn](../AGENTS/plan/20261128-1854-chrome-profiles-every-turn.md))

- **Ask:** whoever linked a browser profile can use it from every chat of theirs, the desktop app included, without
  finding a switch. Claude Code is the floor: a tool that is connected is offered.
- **Rule:**
  - A turn of the person (the web, the desktop app, their own scheduled runs; never a phone, a guest or a restricted run)
    gets every browser profile they linked. The AI is told each one's name, account and whether it is open now.
  - In the desktop app the app's own browser is one more profile, `app`. The AI picks one per call (`profile`); nothing
    global decides. A call that names none goes to the profile the answer used last, else the one whose sites hold the
    address, else the one linked profile that is open (several open: the AI asks which), else the app's browser.
  - An explicit ask for the person's own browser, Chrome or "<app> in Chrome" wins over a memory or habit that says to
    browse with another tool (another browser app, a mail connection). When the profile is not open, the AI says so
    and how to connect it (open that browser; the extension connects by itself; Settings › Browser), on the web too,
    where there are then no browser tools: it never says none is linked and never switches tool quietly.
  - Settings › Browser has no "Use my Chrome" switch any more; in the desktop app one line says the AI uses the linked
    browsers and the app's own one, step by step, and that saying it in the chat picks one. `PUT /api/chrome/target`
    and `target` in `GET /api/chrome/links` are gone.
  - `user_browser_target` (migration 464) is no longer read. Its rows are kept, not deleted: a build rolled back to
    0.21 reads them again as they were; account deletion still clears them. No migration.
- **Why:** the switch defaulted to the app's browser, so a person who linked Chrome got it only on the web, and the AI
  in the desktop app was not even told the profile existed. A choice per call is what the AI already makes between
  profiles; the app's browser is one more of them.
- **Left out:** a phone turn (no browser there); the MCP apps' browser tools (already per profile, no app browser).
- **Tests:** `tests/unit/chrome-link.test.ts` "every turn gets the linked profiles" (a desktop turn with nothing
  toggled and an old `app` row uses the online Chrome, `app` reaches the desktop window, a closed profile is refused
  with how to open it, the web without an open profile is told how to connect, pickProfile order); the extension e2e in
  throwaway Chromium profiles. Version impact: patch (a fix; one settings switch removed).
