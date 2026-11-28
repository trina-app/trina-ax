# Chrome: desktop linking that pairs, true pair errors, profile names, a Stop that stops

- Date (UTC): 2026-11-28 15:26
- Branch: `fix/chrome-pair-and-run-stop`
- Status: in progress
- Where: desktop (pair socket, helper), chrome-extension (pair page, popup, stop), server (chat browser tools, Chrome
  links, MCP grants), web (Settings › Browser, Trina AX MCP, connect page), shared. Why: manual GUI QA in real Chrome 158
  found linking from the desktop app never paired and eight follow-ups (A–I).
- Version impact: patch — fixes and wording; the new frames and fields are optional, so old apps, servers and
  extensions keep working (the extension also gets `chrome:bump patch`).

## Goal

A: Settings › Browser › Connect in the desktop app links the profile with no click (the pair page said "the desktop app
is not running" while it ran). B: when it cannot, the pair page says the real reason. C–I: the site card and chat steps
name the browser profile, the connect page's site rule is true, a Stop in the popup stops the answer and the AI asks
what next, a stopped task's window and Chrome's debugging bar go away, Settings › Trina AX MCP updates live, and the
popup speaks the person's language.

## Scope

In:
- A: the pair socket's path no longer depends on the user data folder (a folder of this user's private temp dir with a
  short name, unless the app runs from its default folder, whose socket the release helper knows); the app says why it
  cannot pair (Connect answers `unavailable`, logged) instead of failing silently; a dev run finds the helper it built and
  registers it when the browser folders are overridden; re-listens if the socket file went away. Root cause found by an
  e2e with the real Google Chrome 158 (`tests/e2e/chrome-app-link-real.test.ts`): with a long user data path no socket
  and no host manifest were made, and every failure read as "not running".
- B: helper answers `no_answer` (app reached, no reply) apart from `app_not_running`; the pair page maps Chrome's own
  errors (host not found, forbidden, exited) to plain sentences.
- C: the address card in a Chrome call names the profile and says the Always is kept for that profile too.
- D: a Chrome step's label ends with the profile's name.
- E: connect page: "asks before each new site, except addresses you typed yourself" (six languages).
- F: the popup's Stop (and closing the task window or the debugging bar) marks the chat's running answer stopped: the
  rest of its tool calls are refused and the AI asks what to do next. The extension reports chat runs too when the
  server says it handles them (`hello.stops`); a stop holds only the stopped answer's calls, so the next message works.
- G: a stopped run's window closes (its tabs' debugger goes with it); Disconnect closes every run's window.
- H: a new or ended MCP connection publishes `integrations_changed`; Settings › Trina AX MCP reads again.
- I: the popup and pair page use the person's language the server sends (`hello.locale`), else the browser's; the
  extension's "Settings › Browser" words match the web menus in all six languages (test).

Out: Windows/Linux app-led linking (not built); store id changes.

## Steps

1. Real-Chrome e2e reproducing A; fix socket path, status, dev helper/registration.
2. Helper reasons + pair page mapping (B), extension messages.
3. Server: url-gate profile line (C), step suffix (D), stop handling (F), hello stops/locale (F, I), grant notices (H).
4. Extension: stop closes run (G), turn-scoped hold, popup locale (I). Web: connect page words (E), AiApps live (H),
   unavailable toast (A).
5. Unit tests for each, e2e real Chrome, review, GUI re-test with throwaway profiles.

## Decisions

none (follows docs/decisions/20261128-chrome-app-led-linking.md and 20261128-trina-in-chrome.md).

## Result

(filled in at the end)
