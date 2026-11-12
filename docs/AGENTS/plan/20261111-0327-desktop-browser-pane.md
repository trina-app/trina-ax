# Desktop app: a calmer "AI is in control" signal, no orange flash, and a browser pane you can resize

- Date (UTC): 2026-11-11 03:27
- Branch: `fix/desktop-browser-pane`
- Status: done
- Where: trina-ax core, the desktop app (`desktop/src/ui/pane.ts`, `ui.css`, `main/app-window.ts`, `main/pane/pane.ts`,
  `main/main.ts`, `preload/ui.ts`, `common/i18n.ts`, a new pure `common/pane-width.ts`), its unit and e2e tests,
  docs/DECISIONS.md, `changes/`. Why: the desktop app and its in-app browser are core (see docs/REPOSITORY-RULES.md).
- Version impact: minor. A visible change to the desktop app's browser pane (look of the AI-control signal, a
  resizable pane); no API, bridge or data change. Ships with the next desktop release.

## Goal

The owner, about the in-app browser pane:

1. "The orange is really bad." While the AI drives the browser the toolbar shows a thick orange bar ("● AI is using the
   browser" + Stop) and the page gets a 3 px orange frame. Before the first tab draws, the whole pane is solid orange
   for a moment: the toolbar view paints its body in the accent colour while the AI drives, and nothing covers it yet.
2. "It'd be nice to make the browser wider and narrower." There is a splitter in the toolbar view, but the tab view
   covers it below the toolbar: only the toolbar's left 6 px can be dragged, nobody finds it, it is not keyboard
   reachable, and the width is only saved when the window closes.

## Scope

In:
- The AI-control signal: the toolbar's own neutral surface, a small pulsing accent dot, short plain text ("Trina is
  using the browser" / "트리나가 브라우저를 쓰는 중"), the Stop button prominent by its shape (a solid ink button with a
  stop square), and a 2 px accent line at the top of the page area instead of the 3 px frame. Same visibility rule as
  today: shown while a browser call runs, gone when it ends or the person presses Stop. The page is no longer resized
  when a call starts or ends (the frame inset did that).
- No solid colour before the first paint: the toolbar view's body is the theme's neutral background with a subtle
  loading state; the toolbar view's own background colour follows the system theme (no light flash in dark mode); a
  new tab is put on screen once its first real page commits, not while it is an empty about:blank (white in dark mode).
- A drag handle on the edge between the team page and the browser, full height, like the web app's `PanelDivider`:
  col-resize cursor, a hover/focus/drag accent line, double-click resets, arrow keys on the focused handle (Shift: big
  step, Home/End: min/max). Limits: the team page keeps 360 px, the browser 400 px. Width remembered as a fraction of the
  window (window.json, saved when a drag ends, not only at close). Window resize keeps the fraction within the limits.
- Focus: a press on the handle moves the system keyboard to the toolbar view; when the drag ends the keyboard goes back
  to the view that had it, and the press does not count as "the person acted in the in-app browser"
  (common/keyboard-focus.ts keyboardTaken).

Out: the permission prompt card's accent border (a question to the person, not the AI-control signal); the team page's
own view background (window resize has the same exposed-area behaviour); phones and the web app.

## Steps

1. Pure width math `common/pane-width.ts` (limits, fit a remembered fraction, pointer → width, keys, settle, read a saved
   value) + unit tests `tests/unit/e-pane-width.test.ts`.
2. Main: the toolbar view spans a 6 px transparent grab strip over the team page's edge; the tab view is not inset while
   driving; drag start / move / end, key and reset IPC (sender checks as the other `ui:pane-*` channels); save on
   commit; keyboard back after a drag.
3. Toolbar UI: the handle (role=separator, aria values, keys, double-click), the calmer driving row, the 2 px line, the
   loading state; strings in ko / en / id / ja / es.
4. Tabs on screen after their first real page commits (a screenshot of a blank tab still draws it first).
5. e2e `desktop/e2e/pane-resize.spec.ts`: drag → both views' bounds, the width after a restart, keys, double-click,
   window resize, focus stays in the team page; AI-control indicator shows and hides; view background colours and no
   accent before the first paint. Screenshots before / after (light, dark), loading, narrow and wide.
6. DECISIONS entry (the signal's look is a safety indicator), `changes/desktop-browser-pane.md`, review, PR to dev.

## Risks

- Safety: the AI-control signal must stay unmistakable. Kept: text + pulsing dot + Stop + accent line, all in the
  desktop's own toolbar (a page cannot draw or hide it).
- Focus (#327): the handle's press moves the system keyboard; tested in the e2e with the message box.
- A transparent toolbar view strip over the team page: the team page loses 6 px of mouse hit area at its right edge
  (as the web's divider does to its neighbours).
- Five app languages; macOS and Windows (Electron views, no platform code).

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, every `tests/unit/e-*` file, the desktop e2e suite
(including `keyboard-focus` and `page-focus`).

## Result

Built as planned, PR #360. Differences from the plan:
- The AI-control row still takes its place in the toolbar while a call runs (the page moves down by it, as for the
  site question and the notice line); only the 3 px frame's resize of the page is gone.
- A tab is hidden (`setVisible(false)`) rather than detached until its first real page commits: it keeps its size, so
  the AI's reads and clicks see the same viewport as before.
- An empty tab is now called "New tab" instead of "about:blank" (it showed while the first page loaded).
- The keyboard goes back when the drag ends, not during it (a drag's pointer capture in a view that lost the focus is
  not something to rely on across systems); during the drag no other view takes it.
- Local desktop e2e on this Mac: Electron 44.7.2's `session.clearStorageData()` with no options never settles here
  (each storage type alone does), which stops every AI browser call in the e2e after the first signed-out page load.
  The runs for this PR used a build with an explicit storage list in the two clear calls (not in this PR); reported
  separately.
