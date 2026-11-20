# Trina history rows: 36px, 14px, 2px apart

- Date: 2026-11-20
- Status: accepted
- Supersedes: part of [Lists: one set of rows and headers](../DECISIONS.md#lists-one-set-of-rows-and-headers-fixpanel-type-hierarchy-2026-11-13-product-owner)
  (only the rule that 트리나's rows read at the other panels' row size, on a computer)
- Branch: sidebar-history-row-spacing (QA, pras)

- **Ask:** QA (pras, 2026-11-20) compared the desktop sidebar on qa.trina.app with ChatGPT's. Trina's history rows were
  30px high with no gap between them, and a long history looked cramped. ChatGPT's rows are about 36px with 14px text.
- **Rule:** On a computer, every row of the Trina history is 36px high with a 14px name (20px line height), and the
  rows are 2px apart. This applies to a chat's row (`nav/ChatItem.tsx`), a task's folded runs (`nav/TaskRunsRow.tsx`)
  and a group's "N more" / "Show all" (`history/HistoryGroups.tsx`), in the Trina panel (`panels/TrinaList.tsx`) and
  in the filtered history (`nav/HistoryList.tsx`). They use `ListRow scale="history"` (`historyRowBox`,
  `text-row-history`, `historyRowsGap` in `components/list/List.tsx`).
- **Tokens:** `--spacing-row-history` (36px) and `--text-row-history` (14px / 20px) in `index.css`. On a phone they
  are the phone list sizes (`var(--spacing-row-min)`, `var(--text-row)`), so the phone and the 트리나 drawer do not
  change. A touch screen keeps 44px or more.
- **Not changed:** `--spacing-row-min` and `--text-row`. 대화, 프로젝트, 파일 and 활동 keep 30px rows and 15px names. The
  section headers keep their size. The "더 보기" button under the list keeps its size.
- **Why 14px and not `text-sm`:** in this theme `text-sm` is 15px (the body size), so the history has its own token.
- **Tests:** `test/e2e/type-scale.spec.ts` (the history's names are 14px on a computer and 16px on a phone; 트리나's
  rows are 36px and 2px apart; 파일's rows stay 30px), `test/unit/type-scale-source.test.ts` (the tokens).
- **Version impact:** none (web only, no API change).
