# The in-app browser always has its toolbar (title, open in your browser, close)

- Date (UTC): 2026-11-18 10:58
- Branch: `fix/side-browser-close`
- Status: in progress
- Where: `desktop/` (main process window and pane, the pane toolbar page). Why: the in-app browser is the desktop app's
  own view; the team page only reserves its space (docs/REPOSITORY-RULES.md).
- Version impact: patch, a fix in the desktop app.

## Goal

A person saw a page the AI opened in the in-app browser with no toolbar above it: no title, no ✕, no way to close it
from the pane. The toolbar is a separate transparent view (pane.html) loaded once when the window opens. When its page
does not load or its renderer ends, nothing loads it again, so the page stands alone with an empty strip above it until
the app restarts. Fix that, and give the toolbar the one missing action: open the page in the person's own browser.

## Scope

In:
- The toolbar view loads again by itself after its renderer ends or its page fails to load, and gets back the state it
  had (tabs, the open question, sites, width). If it keeps failing, the browser closes and gives the space back to the
  team page instead of showing a page with no way to close it.
- One icon button "Open in your browser" (↗) next to reload: opens the active tab's address (http/https only) in the
  default browser.
- Unit test for the reload budget; desktop e2e: toolbar shows title and ✕, ✕ frees the space, the toolbar comes back
  after its renderer is killed, ↗ asks the system to open the address.

Out: a second header in the web app (the web app's Browser panel only exists outside the desktop app); Esc on the toolbar
(no other side panel closes on Esc while focus is in its header).

## Steps

1. `desktop/src/common/pane-chrome.ts`: the reload budget (pure, unit-tested).
2. `app-window.ts`: watch the toolbar view (`render-process-gone`, `did-fail-load`), reload it within the budget, close
   the browser when the budget is spent; on every load send the open questions again.
3. `pane.ts`: `openExternal()` for the active tab, `resendPrompts()`.
4. Toolbar page + preload + IPC: the ↗ button, strings in every language.
5. e2e spec, screenshots light/dark, changelog fragment.

## Decisions

- Closing while the AI works keeps today's rule: ✕ hides the browser, tabs keep running, the AI's call is not stopped
  (Stop does that), and the AI's next browser step shows the browser again.

## Result

(filled in at the end)
