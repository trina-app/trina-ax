# Trina history rows look like the room list's: 30px, no gap, 14px names

- Date: 2026-11-21
- Status: accepted
- Supersedes: [20261120-sidebar-history-row-spacing](20261120-sidebar-history-row-spacing.md)
- Branch: fix/trina-history-dense (the owner, 2026-11-21)

- **Ask:** the owner, with a screenshot of 트리나 기록: "여기 칸 사이 빈공간은 없애고 폰트 조금만 키워줄래?", then "지금
  채팅방 목록이랑 너무 다르게 생겼음 비슷하게 가야하는데" (it should look like the room list in 대화). After seeing 15px
  names, one size down: 14px. No icon before every row.
- **Rule:** On a computer, every row of the Trina history (a chat's row `nav/ChatItem.tsx`, a task's folded runs
  `nav/TaskRunsRow.tsx`, a group's "N more" `history/HistoryGroups.tsx`) is the room row's 30px (`rowBox`,
  `--spacing-row-min`) with no gap between rows, the same padding, hover and selected fill and unread look (`rowName`).
  Its name is 14px / 20px (`--text-row-history`, `rowName({ history: true })`), one step under the other rows' 15px.
- **The "···":** as a room's row, it takes its room at the row's right only while it shows (a mouse on the row, the
  keyboard in it, its menu open: `rowMenuRoomOnHover` in `components/list/List.tsx`). At rest the title runs up to the
  tag and the tags end 12px in from the row's edge. Before, 36px stayed empty at every row's end and titles were cut
  early.
- **The marker** (a ring, "?", a new answer's dot) and a task's run mark sit at the row's end after the tag, as a room's
  unread pill, and give way to "···" on hover.
- **Phone:** unchanged: the phone list sizes (48px rows, 16px names); a touch screen keeps 44px or more.
- **Not done:** an icon before every history row, as rooms have (the owner chose none).
- **Tests:** `test/e2e/type-scale.spec.ts` (트리나's rows 30px, 14px, no gap, tags 12px in), `test/e2e/session-markers.spec.ts`
  (the marker at the row's end, hidden on hover), `test/unit/type-scale-source.test.ts` (the tokens).
- **Version impact:** patch (a look fix in the web app; no API change).
