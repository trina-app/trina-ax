# Trina history: the filter on the list's header, New section out of the filter

- Date (UTC): 2026-11-23 12:16
- Branch: `fix/history-filter-place`
- Status: done
- Where: `web/` (Team AX core). Why: the Trina panel and the phone drawer are core UI (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a control moves on existing screens; no new feature and no API change

## Goal

The owner: the filter button sits on the "트리나" title row, above rows that are not a list, far from the list it
controls; and "새 섹션" inside a filter menu is odd. The filter moves to the list it filters, and the filter menu is
only about the view.

## Scope

In:
- The filter sits on the "트리나 기록" header, right side, on the computer's panel and the phone's drawer. Nothing stays
  on the "트리나" title row.
- "새 섹션" leaves the filter menu and is the first item of the header's "⋯" (the computer: above 삭제한 기록; the
  phone: its only item, 삭제한 기록 keeps its row at the drawer's foot). No third icon.
- The panel keeps one tree for both states, so the open menu survives a choice: sections above the header, the filtered
  list under it, as the drawer already has it.
- Folded: the filter hides while the view is at its default; with a filter on it stays, with its dot and the "filtered"
  line with its clear button, so a folded list never hides that a filter is on.
- The filtered line is its own line under the header on the phone too. Phone targets stay 44px.

Out: what the filter does, its options, the sections model, "Move to section" (unchanged, it keeps New section…).

## Steps

1. One `HistoryHeadActions` (filter + "⋯") in `nav/HistoryList.tsx`, used by both surfaces.
2. `panels/TrinaList.tsx` takes the view; `panels/TrinaPanel.tsx` drops the title-row action.
3. `phone/TrinaDrawer.tsx` uses the same actions; the filtered line moves under the header.
4. Tests, `changes/history-filter-place.md`, decision file update.

## Decisions

`docs/decisions/20261123-history-filter-place.md`, changing "Create" in
[20261122-trina-history-sections](../../decisions/20261122-trina-history-sections.md).

## Risks

- The menu must stay open through a choice although the list under it changes: one tree, no remount.
- A control that disappears (reset while folded) must not drop keyboard focus to the page.
- No migration, permission, API or new i18n string.

## Tests

`bun run typecheck`, `bun run check:prepush`, web unit tests, e2e: trina-panel, history-sections, history-view,
account-settings, phone-menus-tabs, phone-overlay-back. Screenshots at 1440 and 390, light and dark, ko and en: default,
menu open, filter active, folded.

## Result

Built as planned. The filter and a "⋯" with New section are on the 트리나 기록 header on the panel and the drawer
(`HistoryHeadActions`), and the filtered line is its own line under it (`HistoryFilterLine`). The panel's filtered list
now renders inside `TrinaList`, so the open menu survives a choice. Added to the plan: the drawer's clear button and
fold toggle are now 44px. PR: branch `fix/history-filter-place` into `dev`.
