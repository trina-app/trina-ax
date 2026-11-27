# Rail: the selected place's background covers the icon and the name

- Date (UTC): 2026-11-27 04:59
- Branch: `ui/rail-selected-block`
- Status: done
- Where: web/src/components/rail/Rail.tsx, web/test/unit/rail-badges.test.tsx (if it asserts classes)
- Version impact: patch, a look-only change of one component, no behaviour or data.

## Goal

Owner decision: in the left rail the pressed (selected) place shows its background behind the icon AND the name as one
block; today `bg-hover` sits on the icon span only. Hover does the same, so the whole block lights, not just the icon.

## Scope

In: the `Link` of each place carries the background (`bg-hover` when selected, `hover:bg-hover`), with even padding so the
background never touches the name. Same rail width. The name stays semibold ink when selected, the mark stays on the
icon, the focus-visible outline stays, names keep two lines (ja "プロジェクト").
Out: the phone's bottom tabs (BottomTabs.tsx, a different pattern), rail width, copy.
RailColumns.tsx only hosts Rail; no other place uses the rail item pattern.

## Steps

1. Move the background and radius from the icon span to the link; give the block `px-1 py-1.5`.
2. Screenshots before and after (1440 and 390, light and dark, ko and ja, owner and guest) in scratchpad/rail-sel/.
3. typecheck, check:prepush, rail unit and e2e tests.

## Result

The link carries the background (`bg-hover` selected, `hover:bg-hover`), `px-1 py-1.5`; the list's side padding went from 1.5 to 1 so the name keeps its width (ja ファイル stayed one line). Rail width unchanged. Screenshots: scratchpad rail-sel/before and after. The phone has no rail (bottom tabs), so 390 shows it unchanged.
