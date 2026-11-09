# Thread panel: drag its left edge to resize it

- Date (UTC): 2026-11-07 12:56
- Branch: `feat/thread-panel-resize`
- Status: done
- Where: trina-ax `web/src/` (components/SidePanelFrame.tsx, components/rooms/ThreadPanel.tsx, lib/panelWidth.ts).
  Why: a layout change in the web app's own components (see docs/REPOSITORY-RULES.md).
- Version impact: minor. A visible UI change (a new divider); no API or data change.

## Goal

On a computer a thread opens as a fixed column (400 px, 440 px from 1280 px) beside the room. People want to make it
wider or narrower. After this they drag the thread's left border, as they already can with the file preview's divider
(PR #145): same look, cursor, limits logic, remembered width, double-click reset and keyboard.

While there: the thread's right side looks cut (the header's ✕ and the reply box's send button touch the right edge).
Check at 1280/1440/1700 px and fix what clips.

## Scope

In:

- Move the divider's logic out of `SidePanelFrame` into one shared component (`PanelDivider`) that resizes its parent
  element, with per-panel sizing (storage key, panel minimum, minimum of the column beside it). The preview panel uses
  it unchanged in behaviour (same keys, limits, test ids).
- The thread panel uses it: panel at least 320 px, the room timeline at least 420 px; the width is remembered per
  browser as a share of the room row (as the preview does); double-click resets to the default (400 / 440 px);
  Left/Right (24 px, Shift 96 px), Home, End; `role="separator"` with `aria-valuenow/min/max`; no divider on phones.
- Pure helpers for limits, clamping, storage and keyboard targets in `lib/panelWidth.ts`, unit-tested.
- The clipping on the thread's right side.

Out: resizing the sidebar; changing the preview panel's default width or limits.

## Steps

1. Generalise `lib/panelWidth.ts` (sizing per panel, keyboard target helper); unit tests.
2. Extract `PanelDivider` from `SidePanelFrame`; `SidePanelFrame` uses it.
3. `ThreadPanel` uses them; its width from the CSS variable, the default clamped so the room keeps 420 px.
4. Screenshots at 1280/1440/1700 with the panel open; fix the clipping.
5. e2e: drag, double-click reset, keyboard on the thread divider; the preview spec still passes.
6. CHANGELOG, i18n label in five languages.

## Risks

No migration, no permission change. Phones: no divider, thread stays full screen. The five app languages get one new
label. Both panels open at once (a file preview from a room): each divider clamps within its own row.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run --cwd web build`, the web unit suite (in
Docker as CI), the thread / room / preview e2e specs.

## Result

Built as planned, with these differences:

- One component, `web/src/components/PanelDivider.tsx`, instead of a hook plus a component: it finds the panel as its
  parent element and the column as the panel's previous sibling, so both callers only place it inside the panel.
- Pure helpers in `web/src/lib/panelWidth.ts`: `SIDE_PANEL`, `THREAD_PANEL`, `SIDE_PANEL_BESIDE_THREAD`,
  `panelLimits`, `clampPanel`, `settlePanel`, `fitPanel`, `keyWidth`, `readPanelFraction`, `writePanelFraction`.
- The clipping on the thread's right side did not reproduce in the mock at 900/1280/1440/1700 px (light, dark, the
  largest text size, long unbroken text): no horizontal overflow. The header's ✕ had 8 px on its right against 16 px
  everywhere else; it now lines up with the replies and the reply box. A likely cause of the cut look was a file
  preview opened beside a thread: the fixed 400/440 px thread then slid under the preview. The preview now leaves the
  room 420 px and the thread 320 px where the window allows.
- From the review: a drag in a row with no room to choose keeps the width chosen before; a default wider than the
  limits shows at the largest width without being remembered; the divider watches nothing without a ResizeObserver
  (the room thread's unit tests render it in a small DOM).
- Tests: `web/test/unit/panel-width.test.ts`, `web/test/unit/panel-divider.test.tsx`,
  `web/test/e2e/thread-resize.spec.ts` (with `preview-resize.spec.ts` unchanged and passing).
