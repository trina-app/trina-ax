# Desktop browser pane: the app's theme, calm colours, a checked resize edge

- Date (UTC): 2026-11-13 10:54
- Branch: `fix/browser-pane-calm-colours`
- Status: in progress
- Where: desktop/ (pane toolbar), web/src/lib/theme.ts, shared/src/desktop-bridge.ts. Why: the desktop app's own
  screens live in desktop/; the page tells the app its look through the bridge (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a visual fix with no new feature or setting

## Goal

The owner's screenshot (11-13): beside a light chat, the browser pane was near-black, with an orange "AI is using the
browser" bar, a black Stop pill, a black site-question card with a thick orange border and an orange page wash. The pane
should look like the rest of the app in light and in dark.

## Scope

In:
- The pane follows the app's theme choice (Light / Dark / System), not only the computer's: the team page tells the
  desktop app its choice (optional bridge call `setTheme`), and the app sets Electron's `nativeTheme.themeSource`, so the
  toolbar's `prefers-color-scheme` (and the window's own colour) match the page.
- "AI is using the browser": regular text, small accent dot, Stop as a normal secondary button.
- Site question: a normal card (panel, 1px border); Allow once the only primary button, the others secondary.
- Empty pane: muted regular hint, centred, on the page background.
- Resize edge (added to scope by the owner): already on dev (common/pane-width.ts, PR #360); check it with its unit
  tests and e2e, and fill what is missing.

Out: new tokens; wording, test ids and focus order stay as they are.

## Steps

1. Bridge: `setTheme?(theme)` in shared/src/desktop-bridge.ts; preload; main sets `nativeTheme.themeSource`.
2. web/src/lib/theme.ts `applyTheme` calls it (older desktop apps do not have it).
3. ui.css: driving row, Stop, prompt card, empty state.
4. Unit and e2e checks, screenshots light/dark.

## Risks

`themeSource` also sets `prefers-color-scheme` for pages in the in-app browser: they follow the app's look, as a browser
follows its own theme. Older desktop apps ignore the call; older pages never send it (the pane follows the computer, as
before). No migration.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, desktop unit tests (pane, pane-width), desktop e2e
pane-look / pane-resize / quiet.

## Result

Filled in at the end.
