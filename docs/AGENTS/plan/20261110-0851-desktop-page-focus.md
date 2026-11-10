# Desktop app: the keyboard goes back to the page when the window gets focus

- Date (UTC): 2026-11-10 08:51
- Branch: `fix/desktop-page-focus`
- Status: done
- Where: trina-ax core (`desktop/src/main/app-window.ts`, the pane's focus hook, the team page preload, a small
  decision module in `desktop/src/common/`, the desktop e2e and `tests/unit/e-*`, docs/DECISIONS.md, CHANGELOG). Why:
  the window and its views belong to the desktop app (see docs/REPOSITORY-RULES.md).
- Version impact: patch. No API, bridge or data change; ships with the next desktop release.

## Goal

In the desktop app, coming back to the window (Cmd-Tab, a dock click, a notification click, the start or the relaunch
after an update) leaves the keyboard nowhere: typing does nothing until the person clicks into the team page. PR #317
worked around it for the room sound (the app's focus word instead of the page's own); this fixes the focus itself.

Cause, checked in the desktop e2e harness (Electron 44, macOS, Playwright's focus emulation off):
- The window is a `BaseWindow` holding several `WebContentsView`s (team page, the in-app browser's toolbar and tab,
  the host strip, the app's own welcome / team list screen). Unlike `BrowserWindow`, nothing gives one of them the
  keyboard: after a start with a team the window is focused and no view has it.
- After a minimize and a restore (a dock click) no view has it either.
- After the team list and [돌아가기] no view has it (the list had it and is taken out of the window).
- After the window was ordered out and back (Cmd-H then a dock click; `BaseWindow.blur()`), the page has the keyboard
  again but Chromium moved its focus to the page's first focusable element: the message box lost it.
- A plain switch to another window and back keeps the view and the element (macOS keeps the first responder).

## Scope

In:
- When the window gains the focus, and whenever its views change while it has the focus (the team page loaded, back
  from the team list or the offline screen, the in-app browser closed), and no view in it has the keyboard: the view
  that had it last gets it back if it is still on screen; else the in-app browser's tab if the keyboard was last there
  and the pane is open; else the team page; else the app's own screen. `webContents.focus()` keeps the element inside
  the page (the message box and its draft).
- Never while the window is not focused (focusing a view brings the window forward on macOS), while one of the app's
  dialogs or right-click menus is open, or while another view in the window has the keyboard.
- The team page's preload remembers the element that had the focus when the page lost it and puts the focus back there
  when the page gets it again, if Chromium moved it meanwhile and the element is still in the page. A conversation
  opened from a notification click (the page moves on its own) drops the memory.

Out: the element inside a site in the in-app browser after Cmd-H (the view gets the keyboard, the site's own element
is not restored); the web app and phones (no change).

## Steps

1. A pure decision (`desktop/src/common/window-focus.ts`): which view gets the keyboard, or none.
2. `AppWindow`: remember the view that last had the keyboard (its `focus` events; the pane reports its tabs), and call
   the decision on window focus and at the end of `layout()`.
3. The team page preload: keep the page's own element across a window that was hidden.
4. Desktop e2e (`page-focus.spec.ts`, after #317): start, blur and focus with a draft, minimize and restore, the team
   list and back, the in-app browser in front. Unit tests in `tests/unit/e-window-focus.test.ts`.
5. DECISIONS and CHANGELOG.

## Risks

- Taking the focus from something the person uses: guarded (window focused, no view has the keyboard, no dialog or
  menu of the app open).
- Bringing the window forward from the back: `webContents.focus()` focuses the window on macOS; only called while the
  window is focused.
- The preload restore undoing the page's own focus move made while the window was in the back: dropped on a
  notification's open; otherwise only an element the person had, still in the page.
- No user-facing text, no locale strings.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, every `tests/unit/e-*` file, the desktop e2e
`page-focus.spec.ts` plus the desktop specs that touch the window (`desktop.spec.ts`, `smoke.spec.ts`,
`offline.spec.ts`).

## Result

PR #327. Built as planned, with these changes found on the way:
- The order-out case also handed the keyboard to the team page when the person had been in the in-app browser, so on
  macOS the window's focus gives it back to the view that had it at the blur (`keyboardBack`), at once in the focus
  event; Windows and Linux keep their own (`settleKeys` only fills a gap there).
- A notification's click gives it to the team page. The team list and the offline screen take the keyboard only in a
  focused window (before, a network drop brought the app in front).
- The review: the page's element is not remembered when a frame inside the page takes the focus, untrusted events do
  nothing, a dialog the page opened keeps the focus, the element is held weakly.
- Left (pre-existing, checked on dev): a page load in a view takes the keyboard (the in-app browser loading while the
  person types in the team page; a team page reload). The e2e spec is a new file `desktop/e2e/keyboard-focus.spec.ts`;
  #317's `page-focus.spec.ts` expects no page focus after a start and needs one step changed when both are in (PR
  comment).
