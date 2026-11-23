# The Trina history's filter sits on its list; New section is in that header's "⋯"

- Date: 2026-11-23
- Status: accepted
- Supersedes: "Create" in [20261122-trina-history-sections](20261122-trina-history-sections.md) (New section in the history's filter menu)
- Branch: fix/history-filter-place (the owner, 2026-11-23)

Plan: docs/AGENTS/plan/20261123-1216-history-filter-place.md.

- **Ask (owner, 2026-11-23):** "이 필터 버튼 위치가 애매한거 같음. 위에는 리스트뷰도 아닌데도 같이 있고. 그리고 새 섹션이
  저기서 나오는 것도 애매하지 않나?"
- **Rule:**
  - The filter is on the **트리나 기록** header, right side, on the computer's panel and the phone's drawer. Nothing stays
    on the "트리나" title row. It is always visible, like the other list headers' controls, and 44px to tap on a phone
    or touch screen.
  - The filter's menu is only about the view: Status, Last activity, Group by, Sort by, and Reset while changed.
  - **New section** is the first item of that header's existing "⋯" (the computer: above 삭제한 기록; the phone: its only
    item, 삭제한 기록 keeps its row at the drawer's foot). No third icon. "New section…" in every Move to section stays.
  - With a filter on, my sections stay above the header and the filtered list is under it, as the drawer already had it.
  - **Folded:** the filter hides while the view is at its default. With a filter on, the filter, its dot and the line
    saying what is filtered stay, so a folded list never hides that a filter is on.
- **Why:** a control belongs next to what it controls, and creating a section is not a way of viewing the list.
- **Tests:** web/test/e2e/history-sections.spec.ts, web/test/e2e/phone-menus-tabs.spec.ts.
- **Version impact:** patch (a control moves; no API change).
