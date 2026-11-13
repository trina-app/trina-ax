# Fixes from the full screen check of combined dev (QA TC-1080..1089)

- Date (UTC): 2026-11-13 19:36
- Branch: `fix/fullcheck-findings`
- Status: done
- Where: Team AX core web (`web/src/`, `web/test/`). Why: every item is core UI (the Trina list, the chat, projects,
  files, activity) and the test mock (see docs/REPOSITORY-RULES.md)
- Version impact: patch (web only; no API, no migration)

## Goal

The full screen check of combined dev (every route, 1440/390, light/dark, owner/admin/member) found places where the
screen says one thing and does another, or says the same thing in two ways. Fix them so a person reads one word for
one thing and the default list matches its own menu.

## Scope

In:
1. TC-1080 (P1): the Trina panel's default view honours its menu's "Group by: Project": the history grouped by project
   (docs/DECISIONS.md "Trina history by project", owner 2026-11-12) with the caps of that decision: at most 3 chats
   per project, then "N more" in place; the chats outside projects as "Other chats"; no headers for a person with no
   project chats; a folded group keeps its strongest mark; + per project; at most 5 projects, then "Show all".
   Reuses `lib/historyGroups.ts` and `components/history/HistoryGroups.tsx` (the caps come back from #651).
   "Group by: None" shows the flat list (the filtered history, as now).
2. TC-1081: a phone's project chat row hides the author's name beside the face (kept for screen readers).
3. TC-1082: a section header with a link (Files' "Team folders") uses the same 24px ▸ slot as the others; the touch
   area comes from `touch-hit`.
4. TC-1083: the chat title menu uses the shared menu box and row (`menuBoxCls`, `menuRowCls`): as wide as its longest
   item.
5. TC-1084: one "You" (`projects.youTag`) for me in member pickers, on the name's line, so my row is as tall as others.
6. TC-1085: the Trina list's section is "Trina history" (`sidebar.aiChats`), not "Recent".
7. TC-1086: one way to say who sees a chat ("Only you can see this chat." / "N people can see this chat." / "Only you
   can see new chats." / chip "Only me"); the move dialog's title is the menu item that opened it ("Change project" or
   "Move to project").
8. TC-1087: one Trash countdown, "removed in 30 days", on phones and computers.
9. TC-1088: Activity's empty main area says only "No notifications yet."; the pick hint shows only when the list has
   notices.
10. TC-1089: the test mock's `listChatGroups` returns `projectActivity`, as the server does.
11. Cheap extras: the member's trashed-project note in one size without an orphan word; "Mentions & threads" in one
    form.

Out: page title x positions (Projects list and Team skills at the 1024px column, the project page at 1080px): a
shared column width decision, left for a design pass.

## Steps

1. Plan (this file).
2. Each item with its unit/e2e test.
3. Locales: en first, then ko, id, ja, es.
4. DECISIONS notes for the rules (the default grouping, the words), `changes/fullcheck-findings.md`.
5. Before/after screenshots at 1440/390, light/dark.

## Risks

- TC-1080 brings project groups back into the Trina panel, which "Projects: a place of their own" (2026-11-13) had
  made a flat 최근 기록. The QA row and the menu's own default ask for grouping by project; the owner reviews the
  screenshots before merging.
- Five languages for every changed string; e2e specs that name the old strings.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run features:check`, the web unit tests of the
touched areas, the e2e specs of the Trina panel, projects, files trash, activity and the chat menus.

## Result

Built as planned, all eleven items. Differences:
- TC-1080: the caps (`capGroups`, "N more", and a new "Show all projects (N more)") came back from #651 into the shared
  `HistoryGroups`; a task's runs count as one row (`newestRunsOnly`). The groups sit under the section's words.
- TC-1086: one new key, `chat.footerPrivate`, for a deleted or read-only chat of mine (Home's footer now says "Only you
  can see new chats."). The "Only me" chip did not change, so the server's refusal that names it still matches.
- TC-1084: the tags go on the name's line in the member pickers for people (groups keep their second line).
- Page title positions (Projects list, Team skills vs the project page) left for a design pass (a shared column width).
