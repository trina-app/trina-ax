# Trina history: my sections, foldable groups and one menu, as Claude Code's session sidebar

- Date (UTC): 2026-11-22 09:26
- Branch: `feat/history-sections`
- Status: done
- Where: web (`components/panels/TrinaList.tsx`, `panels/TrinaPanel.tsx`, `nav/HistoryList.tsx`, `nav/ChatItem.tsx`,
  `nav/SidebarSections.tsx`, `nav/NavFolders.tsx`, `phone/TrinaDrawer.tsx`, `store/navFolders.ts`), shared
  (`api/entities.ts` UserPrefs), server (`chat/nav-folders.ts`, one rule). Why: the Trina list is core, and the
  sections reuse the Chats sections code (docs/REPOSITORY-RULES.md).
- Version impact: minor (a new feature in the Trina list and a new preference on `/api/me`; nothing removed).

## Goal

The owner, with a screenshot of Claude Code desktop's session sidebar: "우리도 이런거 도입해야할듯?". There a person
makes their own sections at the top of the list (each folds with ▾ and holds the sessions they put there), then the
date groups (Today, Yesterday, Nov 18, Older) fold too, and one menu has Group by, Sort by, Show, New section, Reset to
defaults and View all.

For Trina: each person sorts their own Trina history into **sections** ("섹션"), the same concept, name, menus and
drag as the Chats sidebar's sections (docs/decisions/20261121-personal-sidebar-sections.md), and the one filter menu
that is already in the Trina header gets the same shape as Claude Code's. One concept, one name, everywhere.

## What we have and what is new

| Claude Code | Trina today | This change |
|---|---|---|
| User sections at the top | Chats (대화) has per-person sections (nav folders kind `rooms`). The Trina list had its own folders (kind `chats`, 11-13) and the owner dropped them from the screen on 11-13 (`TrinaList.tsx` header); the server still keeps them (tables, routes, `GET /api/chats/groups` `folders`, `fileChat`) | **New on screen**: kind `chats` comes back, drawn and named as **sections** with the Chats sections' UI |
| New section | Chats: in the Channels "+" menu and "New section…" in Move to section | In the history menu, and "New section…" at the end of Move to section |
| Drag / Move to section | Chats: drag (`dragRow`/`useDropTarget`) and the row's Move to section / Remove from section (`useSectionRowItems`) | Same on a Trina row (`ChatItem` "⋯", phone long-press sheet, the chat header "⋯"), toast with Undo |
| Collapse a section | Chats sections fold (`PanelSection` foldKey, kept in `prefs.listFolds` on every device) | Same, key `folder:<id>` |
| Group by Date / Folder / Status / Environment / None | Group by None (default since 11-14) / Date / Project; Status is a filter (Active, Answering or waiting for you, In a project, Not in a project, Confidential) | Keep None / Date / Project (our "Folder"). **No Status grouping, no Environment** (see cuts) |
| Date groups fold | Date and project headers in `HistoryList` do not fold | **New**: date headers fold, as project headers already do in `HistoryGroups` (fold kept in `listFolds`) |
| Sort by Last updated / Created | Last activity / Date created / Title | Unchanged |
| Show | Status (above) and Last activity (All, Today, 7 days, 30 days) | Unchanged; the two stay as they are, under the name they have. No "archived" (chats have no archive; deleted ones are in 삭제한 기록, which keeps its place in the "⋯") |
| Reset to defaults | the "×" on the filter line above the filtered list | **New**: a "Reset to defaults" row at the end of the menu (only while something differs), the "×" stays |
| View all | The panel caps a grouped view (5 projects × 3 rows, "Show all projects") | **Cut** (see cuts) |
| Settings on every device | the view is in localStorage per browser; folds already per person on the server | **New**: the view goes to `prefs.historyView` (per person, every device) |
| Phone | the drawer and 트리나 tab use the same `RecentsMenu` as bottom sheets | Same menu with New section and Reset to defaults; sections show in the 트리나 tab (it draws `TrinaList`) |

## Scope

Plan review (2026-11-22, approve with changes, 14 items) folded in below; the numbers in [R1]…[R14] are the review's.
Two PRs in the same batch: **A** (kind-generic sections + Trina sections) and **B** (menu rows, folding date groups,
`prefs.historyView`), B on top of A.

In, PR A:

1. **One sections block** (`nav/HistorySections.tsx`) used by both surfaces [R1, R2]:
   - the computer's Trina panel at rest (`TrinaList.tsx`): between 고정 and 트리나 기록, rows from
     `GET /api/chats/groups` `folders` (`top`, 3), then 더 보기 reads `GET /api/chats?folderId=`;
   - the filtered panel and the phone drawer (`HistoryList.tsx`; the drawer is `phone/TrinaDrawer.tsx` → HistoryList,
     `DRAWER_VIEW`, Group by Date): sections are their own headers above the "트리나 기록" fold in the drawer, and on
     top of the filtered list on the panel; rows from the loaded chats by `folderId`, filtered by Status / Last activity
     and sorted by Sort by; an empty section is hidden while a filter is on; with Group by Date (or None) a chat in a
     section is not repeated in the date groups; with Group by Project the sections are not drawn.
   - each section is a `PanelSection` (name, ▸ fold kept in `listFolds` `folder:<id>`, count, "⋯"). Folded, it shows
     its strongest session marker (`strongestMark` of its chats and `marked`) and keeps the open chat drawn (`keep`)
     [R7].
2. **Fill**: Move to section / Remove from section in a chat's "⋯" (row, phone long-press sheet) and drag onto a
   section header (out: onto 트리나 기록). The item is off with the server's exact reason [R3]: a room's side chat has
   none; a chat someone shared with me (people-shared, not mine) says the shared-chat reason; a project chat or a chat
   shared through a project says the project reason; the creator of a people-shared chat may file it. A scheduled
   task's folded runs row has no section items [R12]. Toast with Undo.
3. **Add chats** [R8]: `AddConversationsDialog` made kind-generic (`AddChatsDialog` = the same dialog over my chats that
   can go in a section). Opens after New section, from an empty section's line and from the section's "⋯".
4. **One code path** [R6]: `SidebarSections.tsx` takes a kind (`'rooms' | 'chats'`) through a small per-kind adapter
   (items, the item's current section, file, words): `useSections(kind)`, `useSectionActions(kind)`, `SectionMenu`,
   `SectionEmpty`, `useSectionDrop(kind, …)`, `undoMoves`, Add. `nameCheck` and `liveSection` go by kind. For chats the
   current section reads both the chats store and `groups.folders` (a chat not loaded yet), and the delete confirm
   counts from `groups.folders[].count`. The Chats sidebar calls it with `'rooms'`, unchanged.
5. **Refusals in section words** [R3]: `store/navFolders.ts` maps every `navFolder*` reason (`folder_project_chat`,
   `folder_shared_chat`, full, name taken, gone) to `sidebarSections.*` for both kinds. Move to project of a chat in a
   section: the toast says it left section X.
6. **Retire the old Trina folder words and paths** [R4]: `folderKindName`, `FoldersLabelWords`, `FolderMenu`,
   `useFolderRowItems`, `NewFolderRow`, `NewFolderButton`, `useFolderActions`, `FolderIcon`, the `navFolders.kind*`,
   `separate*`, `projectStays` words ("대화 폴더는 트리나 폴더와 따로 있어요").
7. **Paging** [R9]: the client keeps reading pages while a "더 보기" (or the first page) adds fewer than a page's worth
   of rows outside sections, up to 5 reads. No server change.
8. **New section** in the history menu (both surfaces), then Add chats.
9. **States** [R12]: a deleted chat leaves its section (the server drops the item) and a restored one is in 트리나 기록;
   a chat moved into or shared through a project drops out; a person with no sections sees no sections block; guests
   can use sections (their own chats).

In, PR B:

10. **Menu**: Status ▸ · Last activity ▸ | Group by ▸ · Sort by ▸ | New section | Reset to defaults. Reset [R10] resets
    only that surface's view (panel: Group by None; drawer: Date), never sections or folds, and shows only while the
    view differs.
11. **Folding date groups** in `HistoryList` (Today, Yesterday, This week, This month, Older), kept in `listFolds`
    `section:trina-date:<bucket>`.
12. **Per person on every device** [R11]: `UserPrefs.historyView = { panel?, drawer? }`, each field `.catch(undefined)`
    (what differs from that surface's default only), written with `PATCH /api/me`; another device picks it up on its
    next `/api/me` read. No localStorage migration (the old keys are read as today until the person changes the view
    once; then prefs win).
13. **Group by default** [R13]: unchanged (panel None, drawer Date) until the owner answers.

Out (cuts to stay lean):

- **Group by Status**: Status is already a filter ("Answering or waiting for you"); a group per state would show a
  near-empty header most of the time and the waiting row on top already gathers what needs me.
- **Environment**: Trina has no per-chat environment.
- **View all**: our grouped view's caps already end in "Show all projects"/"N more".
- **"Show" as a new menu name**: our Status and Last activity already are Claude Code's Show.
- Emoji on sections, sort inside a section, sections shared with the team, sections that mix chats and rooms.
- Project and shared chats in sections: asked of the owner; if allowed, a PR C (server + security review).

## Steps

1. This plan (first commit), then the review's changes (second commit).
2. PR A: `SidebarSections.tsx` kind-generic; `HistorySections.tsx`; `TrinaList.tsx`, `HistoryList.tsx`, `ChatItem.tsx`
   (row items, drag), Add chats; refusal words; retire the old folder parts; paging; New section in the menu; i18n;
   `changes/history-sections.md`; decision file; unit + e2e tests.
3. PR B: menu Reset row, folding date groups, `prefs.historyView`; i18n; tests.
4. Screenshots (1440 and 390, light and dark, the panel and the drawer: the menu, sections with chats, an empty
   section, a folded section with a marker, folded date groups) in `shots-histsections/`, checked by me [R14].
5. A subagent walks every exit [R14]: make a section from the menu, fill it on a phone, delete a section with chats,
   Undo after a move.
6. Tests, QA sheet rows, PRs into dev (no enqueue).

## Decisions

- New: `docs/decisions/20261122-trina-history-sections.md`.
- Supersedes [R5]: DECISIONS.md 2026-11-13 "The Trina list's own folders leave the screen" (nav-rail redesign) and
  docs/decisions/20261121-personal-sidebar-sections.md "Left out: … The Trina AI-chat folders, which are unchanged";
  both quoted in the decision. It says how a project and a section differ in one sentence.
- Keeps: "Trina history: Group by defaults to None" (11-14), and the flat 트리나 기록 under the sections.

## Open questions, each with a recommendation

1. **Project chats in a section?** Asked of the owner. Until then the server rule stays and the item says why
   (recommendation: keep). Allowed → PR C.
2. **Group by default** (panel None, drawer Date): asked of the owner; unchanged until then.
3. **Default fold of a new section?** Open, as Chats sections.
4. **Phone drag?** None; Move to section and Add chats are the phone's ways, as in Chats.
5. **"New section" on desktop**: only in the history menu, in Move to section and nowhere else.

## Risks

- Migration: none (prefs JSON, existing nav_folders tables). Highest on dev: 702.
- `PATCH /api/me` body grows: the security route coverage and the prefs size cap; `historyView` is bounded by the
  enum values.
- The Chats sections must not change: the kind-generic refactor is the risky part; their unit and e2e specs run.
- Five app languages (+ en): `check:i18n`.
- Phone and desktop: the 트리나 tab and the ☰ drawer.
- Mock server (`web/test/mock/server.ts`): `/api/nav-folders` for kind chats, `/api/chats/groups` folders,
  `/api/chats?folderId=`.

## Tests

`bun run typecheck`, `check:i18n`, `check:docs`, `check:prepush`; web unit: `sidebar-sections.test.tsx`,
`nav-folders.test.tsx`, new `history-sections.test.tsx` (one place per chat, fold keys, menu rows, reset, prefs
read/write and the localStorage move); server: `tests/unit/b-nav-folders.test.ts`, the `/api/me` prefs test; web e2e:
`sidebar-sections.spec.ts` (unchanged), new `history-sections.spec.ts` (make a section from the menu, move a chat by
the menu and by drag, fold, phone sheet), `type-scale.spec.ts` and `session-markers.spec.ts` (history rows).

## Result

Built as three PRs in one batch: #385 (A: kind-generic sections, Trina sections, Add chats, Move to section, drag,
paging), #386 (B: Group by Date default, folding dates, Reset to defaults, `prefs.historyView`) and #387 (C: the owner
chose to allow every chat my history shows; server rule in `server/src/chat/history-list.ts`, security-reviewed).

Differs from the plan:
- Open question 1 (project and shared chats): the owner allowed all chats visible in my history (C).
- Open question 2 (Group by default): the owner chose Date on the computer too (B), superseding 11-14's None.
- An independent UX review (ui-polish) at 1440/390, light/dark: fixed the phone section header level, the 44px section
  menu on phones, a one-line empty section on phones and the bare "None" on the filter line. Not taken, to keep one
  pattern with the Chats sections: removing Skip in Add chats, merging Move/Remove into one row, an inline New section
  field; merging Last activity into Sort by is out of scope.
