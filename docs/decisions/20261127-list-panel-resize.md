# The list panel beside the rail can be resized, one width for every place, kept in px

- Date: 2026-11-27
- Status: accepted
- Supersedes: none
- Branch: ui/list-panel-resize (the owner, 2026-11-27; plan
  [20261127-1338-activity-lean.md](../AGENTS/plan/20261127-1338-activity-lean.md) part 5)

- **Ask:** the owner: the list panel is fixed at about 288 px, so it looks wide on a 13" MacBook and narrow on a 16"
  one. Slack lets you drag its sidebar.
- **Rule:**
  - The list panel beside the rail (트리나, 대화, 활동, 프로젝트, 파일: `components/panels/PanelFrame.tsx`) has a divider
    on its right edge (`components/PanelDivider.tsx` with `lib/panelWidth.ts` `LIST_PANEL`).
  - Until it is dragged it keeps today's width (`clamp(240px, min(18rem, 20vw), 300px)`): someone who never drags sees
    no change.
  - 240 px at least, 400 px at most, and never so wide that the main area gets under 740 px (a room with its thread;
    the same 740 as `PANEL_ALWAYS_PX` = 72 + 240 + 740). At a 1052 px window there is nothing to drag.
  - One width for all five places, so switching places never makes the list jump.
  - Remembered per device in **px** (`localStorage` `mycel.listPanel.width`), not as a share of the row like the
    right-hand panels: the point is "my width on this screen". A narrower window clamps it for the time being and gives
    it back when the window is wider again.
  - A double-click on the divider puts the default back and forgets the width.
  - Keyboard: the divider is a focusable `role="separator"` named "Resize the list" (`rail.resizeList`) with its value
    and limits. Right widens, Left narrows (24 px; Shift 96 px), Home is the smallest, End the largest.
  - No divider on a phone (no panel there) or while the panel is folded or hidden.
  - A room with its thread and its ✦ side chat open folds the list below the rail (88) + **the list's real width** +
    1060 (`railPanel.ts` `panelAlwaysBothPx`): 1448 px with the default width, 1548 with a 400 px list. The width the
    person set is kept in the `useRailPanel` store as it changes.
  - The right-hand panels' divider also watches the column beside it, so a wider list that shrinks the chat makes the
    preview, artifact or thread fit again.
- **Why px, not a fraction:** a fraction of the window would make the list grow with every wider window, which is the
  thing the owner did not want; px keeps the width the person picked on that screen.
- **Left out:** per-place widths; a width that follows the person to another device; a divider on the phone.
- **Tests:** `web/test/unit/panel-width.test.ts`, `web/test/unit/panel-divider.test.tsx`,
  `web/test/unit/rail-badges.test.tsx`; e2e `web/test/e2e/list-panel-resize.spec.ts`.
- **Version impact:** minor (a new drag handle on a main surface; no API change).
