# The Trina history groups by date by default, its dates fold, and its view is kept per person on every device

- Date: 2026-11-22
- Status: accepted
- Supersedes: [Trina history: Group by defaults to None](../DECISIONS.md#trina-history-group-by-defaults-to-none-fixfullcheck-findings-2026-11-14-the-owner-qa-tc-10801089)
- Branch: feat/history-view (the owner, 2026-11-22)

Plan: docs/AGENTS/plan/20261122-0926-history-sections.md (PR B). The sections are
[20261122-trina-history-sections](20261122-trina-history-sections.md).

- **Ask (owner, 2026-11-22):** with Claude Code desktop's session sidebar (date groups Today, Yesterday, …, Older, each
  folding; a menu with Group by, Sort by, Reset to defaults): "우리도 이런거 도입해야할듯?". Asked for the default, the
  owner chose **Group by: Date** on the computer too, like Claude Code and the phone drawer.
- **Rule:**
  - **Group by defaults to Date** on every surface (the computer's Trina panel and the phone's ☰ drawer). This replaces
    2026-11-14's None (the flat 트리나 기록). None and Project stay one choice away.
  - **The dates fold** (Today, Yesterday, This week, This month, Older; by creation with Sort by: Date created), at rest
    and in the filtered list. A fold is kept in the account's folds (`section:trina-date:<bucket>`). A folded date keeps
    the chat on screen drawn and shows its strongest session marker.
  - **Reset to defaults** is the menu's last row, only while the view differs from that surface's default. It resets
    only the view (Status, Last activity, Group by, Sort by), never my sections or folds. The "×" beside the filter's
    words stays.
  - **Per person, every device:** the view is kept on the account as `prefs.historyView` (`panel`, `drawer`: only what
    differs from that surface's default; a value this version does not know reads as absent), written with
    `PATCH /api/me`. Another device picks it up on its next read of `/api/me`. This browser keeps a copy, read while the
    account has no choice for the surface; there is no one-time move of older browser choices.
- **Why:** the owner wants Claude Code's history; one menu shape on both surfaces; a choice made on the phone is there
  on the computer.
- **Left out:** Group by Status and Environment, View all, a "Show" menu (Status and Last activity are ours).
- **Tests:** web/test/unit/history-view.test.ts, web/test/e2e/history-view.spec.ts, web/test/e2e/trina-panel.spec.ts,
  web/test/e2e/account-settings.spec.ts.
- **Version impact:** minor (a new default and a new preference on `/api/me`).
