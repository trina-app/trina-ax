# Desktop app: Cmd/Ctrl+F opens a find bar on the screen in front

- Date (UTC): 2026-11-19 09:26
- Branch: `feat/desktop-find-in-page`
- Status: done
- Where: trina-ax `desktop/` (main process, the app's own screens, i18n). Why: find-in-page is the desktop shell's
  job (Electron `webContents.findInPage`); a browser keeps its own find, so the web app does not change.
- Version impact: minor: a new desktop feature (menu item, find bar); no server or web change.
- QA: TC-5364

## Goal

In the desktop app Cmd+F (Ctrl+F on Windows and Linux) does nothing today. People expect the browser's find. After
this, Cmd/Ctrl+F opens a small find bar over the screen in front (the team page, the in-app browser's tab, or the app's
own team list screen): the selected text fills it, matches are highlighted with "N of M", Enter / Cmd+G go to the next
match, Shift+Enter / Shift+Cmd+G to the one before, Esc closes it and clears the find.

## Scope

In:
- Edit › Find…, Find Next, Find Previous in the app menu (CmdOrCtrl+F, CmdOrCtrl+G, Shift+CmdOrCtrl+G).
- The find bar: its own small WebContentsView (`mycel-ui://app/findbar.html`) over the top-right corner of the view
  it searches, so the text typed into it is never in the searched page (no self-match).
- Which view it searches: where the keyboard is (team page, the in-app browser's tab; its toolbar means its tab), else
  the team page, else the app's own screen.
- Strings in en first, then ko, id, ja, es, zh (desktop/src/common/i18n.ts).
- Unit tests for the pure parts (desktop/src/common/find-bar.ts), a desktop e2e (desktop/e2e/find-bar.spec.ts).

Out:
- The web app in a browser: unchanged (the browser's own find).
- Match case / whole word options (Chrome's find has none either).

## Not stealing Cmd/Ctrl+F

The menu's accelerator only runs for a key the page did not take: Chromium sends the key to the page first and hands it
to the window (Electron's menu) only when the page did not call preventDefault (macOS performKeyEquivalent from
WebContents::HandleKeyboardEvent; Windows/Linux UnhandledKeyboardEventHandler). So a site in the in-app browser with
its own Cmd+F (Google Docs, Sheets, Figma) keeps it. The web app has no Cmd/Ctrl+F or Cmd/Ctrl+G of its own today
(its shortcuts: Cmd+K, Cmd+Shift+O; checked with grep).

## Steps

1. Pure helpers: target view choice, bar position and width, count text, selection prefill, the bar's own keys.
2. Main: FindBar (view, IPC, findInPage / stopFindInPage, found-in-page with request ids), AppWindow wiring (layout,
   keyboard, locale, close), menu items.
3. UI: findbar.html / findbar.ts / styles in ui.css (desktop tokens, light and dark).
4. Tests, screenshots at 1440 and a narrow team page, light and dark.

## Decisions

none (follows the browser's behaviour; no new rule).

## Risks

- The keyboard logic of the window (common/keyboard-focus.ts): the bar is one more view that can hold the keyboard;
  it must be in the window's shown views so the window does not take the keyboard back to the page.
- Windows/Linux not run by hand here (Mac only); the e2e drives the menu items.

## Tests

`bun run typecheck`, `bun run check:prepush`, tests/unit/e-find-bar.test.ts, desktop e2e find-bar.spec.ts.

## Result

Built as planned. The bar is its own WebContentsView (`mycel-ui://app/findbar.html`) over the searched view; the pane
learned about "overlays" so its toolbar and tab are not raised over the bar. A new search starts where the page's
selection is (Chromium's own behaviour, as in a browser), so the first count is not always "1 of M". Retyping the same
text keeps the place. Checked on macOS with the desktop e2e and the built app against a copy of the QA team; Windows
and Linux not run by hand. A page's own Cmd+F winning over the menu could not be driven by a test (made-up keys never
reach the macOS menu); it rests on Chromium's unhandled-key path.

